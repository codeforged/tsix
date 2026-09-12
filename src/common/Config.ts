import * as fs from "fs";
import * as path from "path";

export interface SysConfig {
    kernel: {
        version: string;
        database: string;
        rootHostPath: string;
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

    public static load(): SysConfig {
        if (!this.instance) {
            const configPath = path.resolve(__dirname, "../sysconfig.json");
            const rawData = fs.readFileSync(configPath, "utf8");
            this.instance = JSON.parse(rawData);
        }
        return this.instance;
    }

    public static get(): SysConfig {
        if (!this.instance) {
            return this.load();
        }
        return this.instance;
    }
}
