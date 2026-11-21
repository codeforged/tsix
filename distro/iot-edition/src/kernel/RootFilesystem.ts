import * as fs from "fs";
import * as path from "path";
import { IVFS } from "../vfs/IVFS";
import { BKFS } from "../vfs/BKFS";
import { HostVFS } from "../vfs/HostVFS";
import { SysConfig } from "../common/Config";

/**
 * ROOT FILESYSTEM FACTORY
 *
 * Root `/` TSIX bisa dilayani DUA backend (lihat IVFS):
 *
 *   - `bkfs` (default) — SQLite `system.db`. Root sebenarnya ada DI DALAM
 *     database; mengubah berkas dari host butuh `npm run vfs:bootstrap`
 *     (host → DB) dan menarik balik butuh `npm run vfs:pull` (DB → host).
 *   - `host` — FOLDER HOST nyata, diakses lewat `HostVFS`. Kernel membaca/menulis
 *     berkas apa adanya, jadi siklus bootstrap/pull tidak diperlukan: cukup edit
 *     di VS Code dan refresh dari shell TSIX.
 *
 * KENAPA FACTORY TERPISAH: pemilihan backend + resolusi path adalah logika murni
 * (tanpa boot), jadi bisa diuji sendiri — `Kernel.initializeSubsystems()` hanya
 * memanggil `createRootFilesystem()` lalu me-mount hasilnya di `/`.
 *
 *  BKFS ADALAH DEFAULT YANG DIMAKSUD DESAINNYA. Mode `host` ada untuk dua hal:
 *  (1) membuktikan kernel benar-benar fleksibel — root `/` hanyalah satu mount
 *      dari `MountManager`, jadi backend-nya bisa apa pun yang memenuhi IVFS
 *      (secara teori termasuk NetFS);
 *  (2) kerja harian yang butuh iterasi kilat (edit → jalankan, tanpa sync).
 *  Yang TIDAK didapat di mode host: transaksi, WAL + checkpoint, isolasi ruang
 *  nama berkas, dan backup satu berkas image — semuanya milik BKFS dan itulah
 *  alasan BKFS tetap default untuk data yang harus aman.
 *
 * ATURAN RESOLUSI PATH (sengaja SAMA dengan syscall `GET_SYSPATH` di Syscalls.ts):
 *   `rootHostPath` relatif terhadap `src/kernel`, mis. `"../rootfs"` → `src/rootfs`.
 *   Satu setting dipakai dua-duanya supaya userland dan kernel tidak pernah
 *   menunjuk folder yang berbeda.
 */

export type RootFsType = "bkfs" | "host";

/** Override tanpa menyentuh `sysconfig.conf` (enak untuk eksperimen). */
const ENV_TYPE = "TSIX_ROOTFS";
const ENV_PATH = "TSIX_ROOTFS_PATH";

export interface RootFilesystem {
    /** Driver yang siap di-mount di `/`. */
    driver: IVFS;
    type: RootFsType;
    /** Spec untuk `MountManager.mount()` — path DB atau direktori host. */
    source: string;
    /** Teks ringkas untuk boot log. */
    label: string;
}

/**
 * resolveRootType(): Tentukan backend root dari ENV (menang) atau `sysconfig.conf`.
 *
 * Nilai yang tidak dikenal DITOLAK (bukan diam-diam jatuh ke BKFS): root yang
 * salah bikin gejalanya bingung — mis. `rootType = "hostt"` akan tampak seperti
 * "data hilang" padahal kernel masih memakai database lama.
 */
export function resolveRootType(
    cfg?: SysConfig | null,
    env: NodeJS.ProcessEnv = process.env,
): RootFsType {
    const raw = String(env[ENV_TYPE] ?? cfg?.kernel?.rootType ?? "bkfs")
        .trim()
        .toLowerCase();

    if (raw === "" || raw === "bkfs" || raw === "sqlite") return "bkfs";
    if (raw === "host" || raw === "hostvfs" || raw === "dir") return "host";

    throw new Error(
        `Unknown rootType: "${raw}" — choose "bkfs" (SQLite) or "host" (host folder)`,
    );
}

/**
 * resolveRootHostPath(): Path absolut folder host yang menjadi root (mode `host`).
 * Relatif terhadap `src/kernel` agar identik dengan `GET_SYSPATH`.
 */
export function resolveRootHostPath(
    cfg?: SysConfig | null,
    kernelDir: string = __dirname,
): string {
    const relative = cfg?.kernel?.rootHostPath || "../.root";
    return path.resolve(kernelDir, relative);
}

/**
 * resolveHostRootDir(): Folder root host yang BENAR-BENAR dipakai — dengan
 * urutan prioritas yang sama seperti `createRootFilesystem()`:
 *
 *   1. `TSIX_ROOTFS_PATH` (env, absolut/pemanggilan dari cwd)
 *   2. `kernel.rootHostPath` di sysconfig (relatif `src/kernel`)
 *
 * Dipakai juga oleh skrip di luar kernel (`scripts/sync-vfs.ts`,
 * `scripts/rootfs-chmod.ts`) supaya alat-alat itu tidak pernah menunjuk folder
 * yang berbeda dari yang sedang dibaca kernel.
 */
export function resolveHostRootDir(
    cfg?: SysConfig | null,
    env: NodeJS.ProcessEnv = process.env,
    kernelDir: string = __dirname,
): string {
    const override = env[ENV_PATH];
    return override
        ? path.resolve(override)
        : resolveRootHostPath(cfg, kernelDir);
}

/**
 * createRootFilesystem(): Bangun driver root sesuai konfigurasi.
 *
 * Mode `host` SENGAJA GAGAL KERAS kalau direktorinya tidak ada. Kalau tidak,
 * `HostVFS` akan membuat folder kosong (constructor-nya memang begitu) dan boot
 * "berhasil" dengan root kosong — jauh lebih membingungkan daripada pesan error.
 */
export function createRootFilesystem(
    cfg: SysConfig,
    opts: { env?: NodeJS.ProcessEnv; kernelDir?: string } = {},
): RootFilesystem {
    const env = opts.env ?? process.env;
    const kernelDir = opts.kernelDir ?? __dirname;
    const type = resolveRootType(cfg, env);

    if (type === "host") {
        const hostDir = resolveHostRootDir(cfg, env, kernelDir);

        if (!fs.existsSync(hostDir)) {
            throw new Error(
                `HostVFS root not found: ${hostDir}\n` +
                    `  • point "kernel.rootHostPath" in src/sysconfig.conf at the host rootfs folder ` +
                    `(e.g. "../rootfs"), or\n` +
                    `  • set ${ENV_PATH} to a directory that exists.`,
            );
        }
        if (!fs.statSync(hostDir).isDirectory()) {
            throw new Error(`HostVFS root is not a directory: ${hostDir}`);
        }

        return {
            // uid/gid/mode sengaja TIDAK dipaksa (undefined): biarkan metadata host
            // apa adanya, sehingga permission userland (chmod/chown) dan tampilan
            // `ls -l` mencerminkan berkas asli di disk.
            driver: new HostVFS(hostDir, false),
            type: "host",
            source: hostDir,
            label: `HostVFS (${path.relative(process.cwd(), hostDir) || hostDir})`,
        };
    }

    return {
        driver: new BKFS(cfg.kernel.database),
        type: "bkfs",
        source: cfg.kernel.database,
        label: `BKFS/SQLite (${cfg.kernel.database})`,
    };
}
