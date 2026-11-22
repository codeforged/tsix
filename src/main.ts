import { Kernel } from "./kernel/Kernel";
import { Config } from "./common/Config";

import { Logger, LogLevel } from "./common/Logger";

/**
 * releaseTty(): Lepaskan stdin/TTY dari event loop SEBELUM proses keluar.
 *
 * KENAPA PERLU (bug operasional nyata — hanya menggigit di Windows):
 * `KeyboardDevice` memanggil `process.stdin.setRawMode(true)` + `resume()` dan
 * memasang listener `data`, jadi SELALU ada read request yang tertunda di console
 * handle. Setelah `process.exit()` dipanggil, teardown Node harus menunggu read itu
 * selesai — padahal di Windows read console dijalankan threadpool secara blocking
 * dan tidak bisa dibatalkan. Akibatnya proses Node TIDAK PERNAH mengembalikan
 * kendali ke `bootstrap.bat`: checkpoint WAL sudah sukses ("2 filesystem(s) closed
 * cleanly") tapi banner "System halted." tidak muncul dan prompt host tidak balik.
 * Di Linux/macOS read TTY bisa dibatalkan, jadi gejalanya tidak terasa — sistem
 * "hang" hanya di Windows, padahal storage sudah ditutup dengan benar.
 *
 * Urutannya penting: buang listener dulu (supaya tidak ada handler yang berebut),
 * baru `pause()` (membatalkan read yang tertunda), lalu kembalikan mode konsol ke
 * cooked supaya terminal host tidak ditinggal dalam raw mode.
 */
function releaseTty(): void {
    try {
        const stdin: any = process.stdin;
        if (!stdin) return;

        if (typeof stdin.removeAllListeners === "function") stdin.removeAllListeners("data");
        if (typeof stdin.pause === "function") stdin.pause();
        if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
        if (typeof stdin.unref === "function") stdin.unref();
    } catch (_) {
        /* jangan pernah menghalangi proses keluar */
    }
}

/**
 * MAIN.TS
 * 
 * Titik masuk utama (Entry Point) Simulator TSIX.
 */
async function main() {
    Config.load();
    console.log("--- POWER ON ---");

    // Inisialisasi Kernel
    const kernel = new Kernel();

    /** Sudah masuk jalur keluar? Menjaga powerOff() agar tidak jalan dua kali. */
    let exiting = false;

    // 1. Booting Kernel (Persistent DB, Drivers, Registry)
    await kernel.boot();

    // 2. Jalankan Init (PID 1)
    await kernel.runInit();

    /**
     * powerOff(): Jalur keluar TUNGGAL. Semua pintu (halt, reboot, SIGINT) lewat
     * sini supaya urutannya konsisten dan tidak ada jalur yang lupa melepas TTY:
     *   releaseTty() → checkpoint + tutup storage → hentikan worker → process.exit().
     *
     * KENAPA WORKER HARUS DIHENTIKAN DULU (bug operasional nyata — hanya Windows):
     * `process.exit()` mem-join setiap worker thread. Worker yang macet di kode
     * native tidak bisa di-join, jadi `process.exit()` menggantung tanpa batas:
     * WAL sudah di-checkpoint tapi proses tidak pernah kembali ke `bootstrap.bat`
     * (prompt host tidak balik, tidak ada banner "System halted."). Di Linux
     * join-nya tetap selesai — itulah kenapa gejalanya cuma muncul di Windows.
     */
    const powerOff = (exitCode: number): void => {
        if (exiting) return;
        exiting = true;

        releaseTty();
        kernel.closeFilesystems();

        const scheduler = kernel.getScheduler();
        const stopped = scheduler?.terminateAllWorkers?.(1200) ?? Promise.resolve(0);

        stopped
            .then(async () => {
                // Service esbuild juga memakai worker thread; hentikan agar tidak
                // ada thread tersisa yang perlu di-join.
                try {
                    await (require("esbuild") as any).stop();
                } catch (_) {
                    /* esbuild belum dimuat / tidak punya service — abaikan */
                }
                process.exit(exitCode);
            })
            .catch(() => process.exit(exitCode));
    };

    // 3. Keep-alive: Jangan biarkan main thread mati
    // Kita perkecil intervalnya biar respon shutdown lebih cepet dan gak re-login.
    const keepAlive = setInterval(() => {
        const scheduler = kernel.getScheduler();
        const p1 = scheduler?.getProcess(1);
        if (!p1 || p1.state === "EXITED") {
            clearInterval(keepAlive);

            const exitCode = (kernel as any).wantedExitCode ?? (process.exitCode ?? 0);
            if (exitCode === 1) {
                console.log("\n[Kernel] System is rebooting...");
            } else {
                console.log("\n[Kernel] System halted. Powering off...");
            }
            // Tutup storage SEBELUM keluar: checkpoint WAL supaya `system.db`
            // lengkap sebagai satu file (tanpa `-wal`/`-shm`). Habis reboot pun
            // tidak perlu recovery dari WAL lagi.
            powerOff(exitCode);
        }
    }, 100); // 100ms biar satset responnya

    // Dengerin signal exit biar rapi
    process.on("SIGINT", () => {
        const scheduler = kernel.getScheduler();
        const p1 = scheduler?.getProcess(1);
        if (!p1 || p1.state === "EXITED") {
            clearInterval(keepAlive);
            console.log("\n[Kernel] Powering off (SIGINT)...");
            powerOff(0);
        } else {
            // Jika shell masih ada, kita cuma kirim interrupt ke foreground
            kernel.handleHostInterrupt();
        }
    });

    // JARING PENGAMAN terakhir: apa pun jalur keluarnya (termasuk yang belum
    // terpikirkan, mis. handler error), storage tetap ditutup. `process.on("exit")`
    // dijalankan SINKRON oleh Node — jadi operasi `close()` BKFS (checkpoint +
    // close) aman di sini. Idempotent, jadi tidak menutup dua kali.
    process.on("exit", () => {
        try {
            kernel.closeFilesystems();
        } catch (_) {
            /* jangan pernah menghalangi proses keluar */
        }
    });
}

main().catch(err => {
    console.error("Kernel Panic during Main Initialization:", err);
    // Panic juga harus melepas TTY — kalau tidak, terminal host ditinggal dalam
    // raw mode dan proses bisa menggantung (lihat releaseTty()).
    releaseTty();
    process.exit(1);
});
