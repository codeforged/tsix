import * as fs from "fs";
import * as path from "path";
import { formatSysConfigIni, parseSysConfigIni } from "./SysConfigIni";

export interface SysConfig {
    kernel: {
        version: string;
        database: string;
        rootHostPath: string;
        /** Backend filesystem untuk root `/`.
         *
         *  - `"bkfs"` (default) — root hidup di dalam SQLite `database`
         *    (`system.db`). Perubahan di dalam TSIX tidak terlihat di host
         *    sampai `npm run vfs:pull`.
         *  - `"host"` — root adalah FOLDER HOST: `rootHostPath` (di-resolve
         *    relatif ke `src/kernel`, sama seperti syscall `GET_SYSPATH`)
         *    di-mount lewat `HostVFS`. Berguna untuk ngoprek: edit file di
         *    VS Code → langsung terbaca kernel, tanpa bootstrap/pull.
         *
         *  Bisa juga dioverride tanpa menyentuh berkas ini:
         *  `TSIX_ROOTFS=host TSIX_ROOTFS_PATH=src/rootfs npm start`.
         *  Lihat `src/kernel/RootFilesystem.ts`.
         *
         *  POSISI DESAIN: BKFS tetap root yang DIMAKSUD oleh TSIX — model
         *  transaksi (`batch()`), WAL + checkpoint saat shutdown, isolasi ruang
         *  nama berkas, dan backup = 1 berkas image. `"host"` ada untuk
         *  menunjukkan kernel fleksibel (root bisa diganti backend apa pun —
         *  termasuk NetFS) dan untuk kerja harian yang butuh iterasi kilat;
         *  jangan dipakai untuk data yang harus aman/di-backup. */
        rootType?: "bkfs" | "host";
        bootLogPath: string;
        verbose: boolean;
        distroName: string;
        engineName: string;
    };
    logger: {
        defaultLevel: string;
        logFile: string;
        enableConsole?: boolean;
    };
    scheduler: {
        workerEntryPath: string;
        defaultPath: string;
        defaultCwd: string;
        bootEntry: string;
        defaultShell: string;
        /** Batas V8 old-generation per worker (MB). Pagar agar satu app nakal
         *  tidak membengkakkan RSS proses host. Heap idle TSIX hanya ~8-10 MB,
         *  jadi default 192 MB (~20x idle) sangat longgar untuk app GUI berat
         *  sekalipun. Ini BATAS ATAS saja — tidak mengubah pemakaian normal.
         *  Set 0 untuk menonaktifkan pagar (pakai default Node). */
        workerMaxOldGenMb?: number;
        /** Batas V8 young-generation per worker (MB) — ruang objek berumur
         *  pendek (tempat GC muda bekerja). Juga batas atas saja. */
        workerMaxYoungGenMb?: number;
    };
    shell: {
        defaultUser: string;
        defaultHostname: string;
        promptFormat: string;
        defaultRows: number;
        defaultColumns: number;
        historyPath: string;
        /** Jumlah total Virtual Console (TTY) yang dialokasikan kernel. */
        ttyCount: number;
        /** Jumlah proses login yang di-spawn init di TTY2..(1+loginCount). */
        loginCount: number;
    };
    network: {
        interfaces: {
            broker: string;
            deviceName: string;
            address: string;
            defaultPort: number;
        }[];
        defaultDevice: string;
    };
    devices?: {
        [deviceName: string]: {
            mode?: number;
            uid?: number;
            gid?: number;
        }
    };
}

export class Config {
    private static instance: SysConfig;

    /** Berkas konfigurasi AKTIF (format INI, key-value — lihat `SysConfigIni.ts`). */
    public static readonly FILE = "sysconfig.conf";

    /**
     * load(): Baca `src/sysconfig.conf`.
     *
     * MIGRASI sekali-jalan (pola sama seperti `/etc/fstab.json` → `/etc/fstab.conf`
     * di `Kernel.processFstab()`): kalau `.conf` belum ada tapi `sysconfig.json`
     * masih ada, isinya di-format ulang ke `.conf`, lalu hasil tulisannya dibaca
     * kembali (self-check) supaya migrasi yang cacat ketahuan saat itu juga.
     * Berkas `.json`-nya TIDAK dihapus — ia hanya berhenti dipakai.
     */
    public static load(): SysConfig {
        if (this.instance) return this.instance;

        const confPath = path.resolve(__dirname, `../${this.FILE}`);
        const legacyPath = path.resolve(__dirname, "../sysconfig.json");

        if (fs.existsSync(confPath)) {
            this.instance = this.parseOrThrow(fs.readFileSync(confPath, "utf8"), confPath);
            return this.instance;
        }

        if (fs.existsSync(legacyPath)) {
            const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as SysConfig;
            fs.writeFileSync(confPath, formatSysConfigIni(legacy, this.migrationHeader()), "utf8");
            console.log(
                `[Config] Migrated sysconfig.json → ${this.FILE} (${confPath}). ` +
                    `The .json file is left untouched and no longer used.`,
            );
            // Baca ULANG dari berkas hasil migrasi, bukan dari objek JSON-nya:
            // kalau formatter melewatkan satu nilai, error-nya muncul sekarang.
            this.instance = this.parseOrThrow(fs.readFileSync(confPath, "utf8"), confPath);
            return this.instance;
        }

        throw new Error(
            `Config file not found: ${confPath}\n` +
                `  • buat image baru dengan \`npm run install\` (menulis ${this.FILE}), atau\n` +
                `  • salin berkas dari node lain — formatnya key-value, lihat src/common/SysConfigIni.ts.`,
        );
    }

    /** Peringatan parser dilaporkan ke console — berkas ini dibaca saat boot. */
    private static parseOrThrow(content: string, confPath: string): SysConfig {
        const { config, warnings } = parseSysConfigIni(content);
        for (const message of warnings) {
            console.warn(`[Config] ${path.basename(confPath)}: ${message}`);
        }
        return config;
    }

    private static migrationHeader(): string {
        return (
            `src/${this.FILE} — konfigurasi node TSIX (format key-value, gaya /etc/fstab.conf).\n` +
            `Hasil migrasi otomatis dari sysconfig.json; silakan rapikan komentar/urutannya.\n` +
            `Aturan nilai: "teks" = string, a, b = array, true/false = boolean, 0o755 = oktal.\n` +
            `Pemilih backend root: kernel.rootType = bkfs | host (lihat wiki/Virtual-File-System.md).`
        );
    }

    public static get(): SysConfig {
        if (!this.instance) {
            return this.load();
        }
        return this.instance;
    }

    /**
     * tryGet(): Sama seperti `get()`, tapi `null` alih-alih melempar saat berkas
     * konfigurasi belum ada. Dipakai skrip/diagnostik yang memang bisa jalan tanpa
     * konfigurasi (mis. `npm run rootfs:modes` sebelum instalasi pertama).
     */
    public static tryGet(): SysConfig | null {
        try {
            return this.get();
        } catch {
            return null;
        }
    }
}
