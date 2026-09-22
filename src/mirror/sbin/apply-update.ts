import { Program, std, fs, shell } from "@tsix/Application";

/**
 * APPLY-UPDATE — hook pasca-instalasi paket engine (`system-update`)
 *
 * KENAPA PERLU ADA:
 * setelah `tpkg install system-update`, file `.ts` di VFS sudah baru — TAPI yang
 * benar-benar dieksekusi bukan `.ts`:
 *   - `tsh` mencari command lewat PATH dengan urutan `.js` **sebelum** `.ts`
 *     (lihat `resolveCommand()` di `src/mirror/bin/tsh.ts`);
 *   - `sysconfig.json` menyebut `bootEntry: "init.js"`;
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
];

/** Direktori eksekusi + mode-nya — salinan aturan `scripts/vfs-bootstrap.ts`. */
const EXEC_MODE_DIRS: Array<{ dir: string; mode: number }> = [
    { dir: "/bin", mode: 0o755 },
    { dir: "/sbin", mode: 0o744 },
    { dir: "/usr/bin", mode: 0o755 },
    { dir: "/usr/local/bin", mode: 0o755 },
];

/** Binary yang wajib SetUID (baca /etc/shadow). */
const SETUID_FILES = ["/bin/login", "/bin/passwd", "/bin/sudo"];

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
        await std.println(`❌ Error: apply-update butuh esbuild di host (${e.message}).`);
        return;
    }

    await std.println("\n[ENGINE UPDATE] Membangun ulang sidecar .js + menegakkan mode...\n");

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
                const code = await fs.readFile(tsPath);
                if (code === null) continue;
                const out = esbuild.transformSync(code, {
                    loader: "ts",
                    format: "cjs",
                    target: "node18",
                    sourcemap: "inline",
                    sourcefile: entry.name,
                });
                if (!out?.code) throw new Error("esbuild tidak menghasilkan kode");
                await fs.writeFile(jsPath, out.code);
                compiled++;
            } catch (e: any) {
                failed++;
                await std.println(`   ⚠️  gagal transpile ${tsPath}: ${e.message}`);
            }
        }

        await std.println(`   ✅ ${dir} — ${sources.length} sidecar .js dibangun ulang`);
    }

    // ----------------------------------------------------------------- HOST
    for (const src of HOST_SIDECAR_SOURCES) {
        try {
            const code = await fs.readFile(src.ts);
            if (code === null) continue; // file tidak ikut paket ini → lewati

            const out = esbuild.transformSync(code, {
                loader: "ts",
                format: "cjs",
                target: "node18",
                sourcemap: "inline",
                sourcefile: "WorkerEntry.ts",
            });
            if (!out?.code) throw new Error("esbuild tidak menghasilkan kode");

            // syncToHost membaca isi dari VFS → tulis dulu ke staging, baru salin keluar.
            const stage = "/tmp/tpkg-host-sidecar/WorkerEntry.js";
            await fs.writeFile(stage, out.code);
            const ok = await fs.syncToHost(stage, src.hostDst);
            if (!ok) throw new Error("syncToHost gagal");
            await std.println(`   ✅ host: ${src.hostDst} (dimuat langsung oleh Node)`);
        } catch (e: any) {
            failed++;
            await std.println(`   ⚠️  gagal sidecar host ${src.hostDst}: ${e.message}`);
        }
    }

    // ----------------------------------------------------------------- MODE
    // File baru sudah diberi mode lewat manifest; ini jaring pengaman kalau mode-nya
    // hilang (mis. file hasil pemulihan backup).
    let chmodded = 0;
    for (const { dir, mode } of EXEC_MODE_DIRS) {
        let entries: any[] = [];
        try {
            entries = await fs.ls(dir);
        } catch (e) {
            continue;
        }
        for (const entry of entries) {
            if (entry.type !== "FILE" || !/\.(ts|js)$/.test(entry.name)) continue;
            const full = `${dir}/${entry.name}`;
            const base = full.replace(/\.(ts|js)$/, "");
            const wanted = SETUID_FILES.includes(base) ? 0o4755 : mode;
            if (entry.mode === wanted) continue;
            if (await fs.chmod(full, wanted)) chmodded++;
        }
    }

    await std.println(
        `\n[ENGINE UPDATE] ${compiled} sidecar dibangun, ${chmodded} mode disesuaikan` +
            `${failed > 0 ? `, ${failed} gagal` : ""}.`,
    );
    await std.println("🚀 Sistem sudah versi baru — REBOOT untuk memuat kernel & init yang baru.\n");
    return "Engine update applied. Reboot required.";
});
