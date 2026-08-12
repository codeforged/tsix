import { Kernel } from "./kernel/Kernel";
import { Config } from "./common/Config";

import { Logger, LogLevel } from "./common/Logger";

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

    // 1. Booting Kernel (Persistent DB, Drivers, Registry)
    await kernel.boot();

    // 2. Jalankan Init (PID 1)
    kernel.runInit();

    // 3. Keep-alive: Jangan biarkan main thread mati
    // Kita perkecil intervalnya biar respon shutdown lebih cepet dan gak re-login.
    const keepAlive = setInterval(() => {
        const scheduler = kernel.getScheduler();
        const p1 = scheduler?.getProcess(1);
        if (!p1 || p1.state === "EXITED") {
            clearInterval(keepAlive);
            if (process.stdin.isTTY) {
                (process.stdin as any).setRawMode(false);
            }

            const exitCode = (kernel as any).wantedExitCode ?? (process.exitCode ?? 0);
            if (exitCode === 1) {
                console.log("\n[Kernel] System is rebooting...");
            } else {
                console.log("\n[Kernel] System halted. Powering off...");
            }
            process.exit(exitCode);
        }
    }, 100); // 100ms biar satset responnya

    // Dengerin signal exit biar rapi
    process.on("SIGINT", () => {
        const scheduler = kernel.getScheduler();
        const p1 = scheduler?.getProcess(1);
        if (!p1 || p1.state === "EXITED") {
            clearInterval(keepAlive);
            if (process.stdin.isTTY) {
                (process.stdin as any).setRawMode(false);
            }
            console.log("\n[Kernel] Powering off (SIGINT)...");
            process.exit(0);
        } else {
            // Jika shell masih ada, kita cuma kirim interrupt ke foreground
            kernel.handleHostInterrupt();
        }
    });
}

main().catch(err => {
    console.error("Kernel Panic during Main Initialization:", err);
    process.exit(1);
});
