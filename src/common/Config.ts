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
    };
    shell: {
        defaultUser: string;
        defaultHostname: string;
        promptFormat: string;
        defaultRows: number;
        defaultColumns: number;
        historyPath: string;
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
