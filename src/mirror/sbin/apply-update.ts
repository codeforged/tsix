import { Program, std, fs, shell } from "@tsix/Application";
import { utf8ToVfsBytes, vfsBytesToUtf8 } from "@common/VfsText";
import { execModeForPath } from "@tsix/TpkgProtocol";

/**
 * APPLY-UPDATE — hook pasca-instalasi paket engine (`system-update`)
 *
 * KENAPA PERLU ADA:
 * setelah `tpkg install system-update`, file `.ts` di VFS sudah baru — TAPI yang
 * benar-benar dieksekusi bukan `.ts`:
 *   - `tsh` mencari command lewat PATH dengan urutan `.js` **sebelum** `.ts`
 *     (lihat `resolveCommand()` di `src/mirror/bin/tsh.ts`);
 *   - `sysconfig.conf` menyebut `bootEntry = init.js`;
 *   - `EXEC` juga mencoba `+.js` lebih dulu.
 * Jadi tanpa langkah ini, `/bin/init.js`, `/bin/ls.js`, dst. tetap versi LAMA dan
 * "engine update" seolah-olah tidak terjadi apa-apa. Skrip ini membangun ulang
 * seluruh sidecar `.js` dari `.ts` yang baru.
 *
 * Sebelumnya skrip ini bagian dari alur staging lama: `tpkg` menulis ke
 * `/tmp/system-updates/**`, lalu skrip ini menyinkronkannya ke host. Alur itu
 * dihapus karena menghitung path host dari `process.cwd()` (jadi mendarat di
 * `<repo>/bin/...`, bukan `src/mirror/bin/...`) dan cabang "VFS ROOT MIRRORING"-nya
 * menunjuk `src/root/` yang sudah tidak ada. Sekarang paket engine menulis langsung
 * ke path VFS aslinya, dan sinkronisasi ke host dilakukan `tpkg` sendiri lewat field
 * `hostDst` di manifest.
 *
 * WAJIB ROOT: menulis ke `/bin`, `/sbin`, `/usr/bin`, dan ke host (`syncToHost`).
 */

/** Direktori yang sidecar `.js`-nya HARUS dibangun ulang (dieksekusi lewat PATH/EXEC). */
const VFS_SIDECAR_DIRS = ["/bin", "/sbin", "/usr/bin"];

/** File host yang dimuat langsung oleh Node (bukan lewat worker) → butuh sidecar juga. */
const HOST_SIDECAR_SOURCES: Array<{ ts: string; hostDst: string }> = [
    { ts: "/tmp/tpkg-stage/userland/WorkerEntry.ts", hostDst: "src/userland/WorkerEntry.js" },
    // WorkerEntry.js me-require('./VfsModuleResolver') — kalau salah satu tidak
    // dibangun ulang, bootloader & resolusi import relatif jadi tidak sinkron.
    { ts: "/tmp/tpkg-stage/userland/VfsModuleResolver.ts", hostDst: "src/userland/VfsModuleResolver.js" },
];

/**
 * Direktori yang mode file-nya ditegakkan ulang. Mode-nya sendiri (SetUID,
 * `/sbin` 0744, sisanya 0755) diambil dari sumber tunggal `execModeForPath`.
 */
const MODE_ENFORCE_DIRS = ["/bin", "/sbin", "/usr/bin", "/usr/local/bin"];

export const main = Program(async () => {
    const user = await shell.whoami();
    if (user.uid !== 0) {
        await std.println("❌ Error: apply-update must be run as root. Use sudo.");
        return;
    }

    // Prasyarat: transpiler. `tbuild` memakai jalur yang sama, jadi tidak ada
    // mekanisme baru yang diperkenalkan di sini.
    let esbuild: any;
    try {
        esbuild = (global as any).require("esbuild");
    } catch (e: any) {
        await std.println(`❌ Error: apply-update requires esbuild on the host (${e.message}).`);
        return;
    }

    await std.println("\n[ENGINE UPDATE] Rebuilding .js sidecars + enforcing file modes...\n");

    let compiled = 0;
    let failed = 0;

    // ---------------------------------------------------------------- VFS
    for (const dir of VFS_SIDECAR_DIRS) {
        let entries: any[] = [];
        try {
            entries = await fs.ls(dir);
        } catch (e) {
            continue; // direktori tidak ada → lewati, jangan gagalkan update
        }

        const sources = entries.filter((e) => e.type === "FILE" && e.name.endsWith(".ts"));

        for (const entry of sources) {
            const tsPath = `${dir}/${entry.name}`;
            const jsPath = tsPath.replace(/\.ts$/, ".js");
            try {
                // Isi VFS = BYTE (latin1, 1 char/byte). esbuild butuh TEKS UTF-8 yang
                // sudah didekode; kalau tidak, karakter non-ASCII jadi mojibake.
                const raw = await fs.readFile(tsPath);
                if (raw === null) continue;
                const out = esbuild.transformSync(vfsBytesToUtf8(raw), {
                    loader: "ts",
                    format: "cjs",
                    target: "node18",
                    sourcemap: "inline",
                    sourcefile: entry.name,
                });
                if (!out?.code) throw new Error("esbuild produced no output");
                // Kembalikan ke byte sebelum ditulis ke VFS (kebalikan latin1).
                await fs.writeFile(jsPath, utf8ToVfsBytes(out.code));
                compiled++;
            } catch (e: any) {
                failed++;
                await std.println(`   ⚠️  failed to transpile ${tsPath}: ${e.message}`);
            }
        }

        await std.println(`   ✅ ${dir} — ${sources.length} .js sidecar(s) rebuilt`);
    }

    // ----------------------------------------------------------------- HOST
    for (const src of HOST_SIDECAR_SOURCES) {
        try {
            const raw = await fs.readFile(src.ts);
            if (raw === null) continue; // file tidak ikut paket ini → lewati

            const baseName = src.ts.split("/").pop() as string;
            const out = esbuild.transformSync(vfsBytesToUtf8(raw), {
                loader: "ts",
                format: "cjs",
                target: "node18",
                sourcemap: "inline",
                sourcefile: baseName,
            });
            if (!out?.code) throw new Error("esbuild produced no output");

            // syncToHost membaca isi dari VFS → tulis dulu ke staging, baru salin keluar.
            // Direktori staging WAJIB dibuat dulu: writeFile ke folder yang tidak ada
            // gagal diam-diam (return false) dan syncToHost lalu melapor "not found".
            const stageDir = "/tmp/tpkg-host-sidecar";
            await fs.mkdir(stageDir);
            const stage = `${stageDir}/${baseName.replace(/\.ts$/, ".js")}`;
            const wrote = await fs.writeFile(stage, utf8ToVfsBytes(out.code));
            if (!wrote) throw new Error(`failed to write staging file ${stage}`);
            const ok = await fs.syncToHost(stage, src.hostDst);
            await fs.unlink(stage).catch(() => false);
            if (!ok) throw new Error("syncToHost failed");
            await std.println(`   ✅ host: ${src.hostDst} (loaded directly by Node)`);
        } catch (e: any) {
            failed++;
            await std.println(`   ⚠️  failed to build host sidecar ${src.hostDst}: ${e.message}`);
        }
    }

    // ----------------------------------------------------------------- MODE
    // File baru sudah diberi mode lewat manifest; ini jaring pengaman kalau mode-nya
    // hilang (mis. file hasil pemulihan backup).
    let chmodded = 0;
    for (const dir of MODE_ENFORCE_DIRS) {
        let entries: any[] = [];
        try {
            entries = await fs.ls(dir);
        } catch (e) {
            continue;
        }
        for (const entry of entries) {
            if (entry.type !== "FILE" || !/\.(ts|js)$/.test(entry.name)) continue;
            const full = `${dir}/${entry.name}`;
            // `/lib` di-cache kernel saat boot: tepat setelah base-system dipasang,
            // proses ini masih memakai TpkgProtocol LAMA (bisa tanpa
            // `execModeForPath`). Lewati penegakan mode daripada crash — sidecar
            // di atas sudah dibangun, dan setelah reboot aturan baru berlaku.
            if (typeof execModeForPath !== "function") break;
            const wanted = execModeForPath(full);
            if (wanted === null || entry.mode === wanted) continue;
            if (await fs.chmod(full, wanted)) chmodded++;
        }
    }

    await std.println(
        `\n[ENGINE UPDATE] ${compiled} sidecar(s) built, ${chmodded} mode(s) fixed` +
            `${failed > 0 ? `, ${failed} failed` : ""}.`,
    );
    await std.println("🚀 System updated — REBOOT to load the new kernel & init.\n");
    return "Engine update applied. Reboot required.";
});
