import * as fs from "fs";
import * as path from "path";
import { Config } from "../src/common/Config";
import { resolveHostRootDir, resolveRootType } from "../src/kernel/RootFilesystem";
import { applyHostBinaryMode, binaryModeFor } from "./lib/binary-mode";

/**
 * ROOTFS-CHMOD.TS
 *
 * Memasang bit eksekusi yang benar pada ROOT HOST (folder yang dipakai kernel
 * saat `kernel.rootType = "host"`).
 *
 * KENAPA PERLU (bug operasional nyata): folder host sering tidak punya bit `x`
 * pada berkas di `/bin`, `/sbin`, `/usr/bin`, `/opt` — mis. hasil `vfs-pull`
 * sebelum perbaikan, hasil `git clone`/`git restore`, atau `cp` tanpa
 * `--preserve=mode`. Akibatnya SEMUA perintah eksternal ditolak:
 *
 *     root@tsix# ls
 *     -tsh: /bin/ls.js: Permission denied
 *
 * Penegakannya ada di SHELL (`tsh.ts` memeriksa `mode & 0o111`, `$?` = 126 —
 * paritas Linux), jadi root pun tidak menembusnya. Kernel sendiri tidak bisa
 * memperbaikinya: mengubah mode berkas milik user saat boot = efek samping
 * diam-diam pada tree kerja user. Karena itu perbaikan disediakan sebagai
 * perintah yang dijalankan sadar-sadar:
 *
 *     npm run rootfs:modes            # perbaiki folder root host
 *     npm run rootfs:modes -- --dry-run
 *
 * Aturan mode = SATU sumber dengan bootstrap/install/sync-vfs
 * (`scripts/lib/binary-mode.ts`): 0o755, `/sbin` 0o744, SetUID untuk
 * login/passwd/sudo. Sejak vfs-pull diperbaiki, tarikan baru sudah benar —
 * skrip ini untuk folder yang sudah telanjur ada.
 */

/** Folder yang tidak pernah dipakai sebagai tempat executable / bukan milik image. */
const SKIP_DIRS = new Set([
    "proc", "sys", "dev", "tmp", "run", "var", "logs", "node_modules", ".git",
]);

interface Options {
    dryRun: boolean;
    root: string | null;
}

function parseArgs(argv: string[]): Options {
    const opts: Options = { dryRun: false, root: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--dry-run") opts.dryRun = true;
        else if (a === "--root") opts.root = argv[++i] || null;
        else if (a === "--help" || a === "-h") {
            console.log(`Usage: npm run rootfs:modes -- [options]

  --root <dir>   Host root to repair (default: kernel.rootHostPath in
                 sysconfig.conf, or env TSIX_ROOTFS_PATH)
  --dry-run      Only list the files that would change`,
            process.exit(0);
        }
    }
    return opts;
}

/**
 * resolveRootHostPath(): Folder root host — aturan resolusi DISAMAKAN dengan
 * kernel (`src/kernel/RootFilesystem.ts`): `TSIX_ROOTFS_PATH` menang, lalu
 * `rootHostPath` (relatif `src/kernel`) dan syscall GET_SYSPATH.
 */
function resolveRootHostPath(override: string | null): string {
    if (override) return path.resolve(override);
    return resolveHostRootDir(Config.tryGet());
}

function main(): void {
    const opts = parseArgs(process.argv.slice(2));
    const root = resolveRootHostPath(opts.root);

    console.log(`🔧 Root host: ${root}`);
    if (!fs.existsSync(root)) {
        console.error(`❌ Directory not found: ${root}`);
        process.exit(1);
    }

    // Pemberitahuan, bukan larangan: folder ini tetap berguna disiapkan lebih dulu
    // meski kernel belum diarahkan ke sana.
    let rootType = "bkfs";
    try {
        rootType = resolveRootType(Config.tryGet());
    } catch {
        /* diabaikan — sysconfig.conf belum ada */
    }
    if (rootType !== "host") {
        console.log(`ℹ️  Note: kernel.rootType = "${rootType}" — this folder is not the active root yet.`);
    }

    let fixed = 0;
    let checked = 0;
    const failures: string[] = [];

    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                walk(full);
                continue;
            }
            if (!entry.isFile()) continue;

            const vfsPath = "/" + path.relative(root, full).split(path.sep).join("/");
            const target = binaryModeFor(vfsPath);
            if (target === null) continue;

            checked++;
            const current = fs.statSync(full).mode & 0o7777;
            if (current === target) continue;

            if (opts.dryRun) {
                console.log(`   ${vfsPath}  ${current.toString(8)} → ${target.toString(8)}`);
                fixed++;
                continue;
            }
            if (applyHostBinaryMode(full, vfsPath)) {
                fixed++;
            } else {
                failures.push(vfsPath);
            }
        }
    };

    try {
        walk(root);
    } catch (e: any) {
        console.error(`❌ Failed to walk ${root}: ${e.message}`);
        process.exit(1);
    }

    console.log(
        `\n${opts.dryRun ? "🔎 Needs fixing" : "✅ Fixed"}: ${fixed} of ${checked} executable files.`,
    );
    if (failures.length > 0) {
        console.log(`⚠️  ${failures.length} file(s) could not be chmod'ed (not owned by this user?):`);
        for (const p of failures.slice(0, 10)) console.log(`   ${p}`);
    }
    console.log("   Run `npm start` and try `ls` in the TSIX shell.");
}

main();
