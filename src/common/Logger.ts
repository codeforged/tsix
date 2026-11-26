/**
 * LogLevel: Menentukan tingkat kepentingan sebuah log.
 * Di Linux, ini mirip dengan 'printk' priority (KERN_INFO, KERN_ERR, dll).
 */
export enum LogLevel {
    OFF = -1,
    INFO = "INFO",
    WARN = "WARN",
    ERROR = "ERROR",
    DEBUG = "DEBUG"
}

/**
 * isLogFileDisabled(): `logger.logFile` = `none` / `off` / kosong → TIDAK menulis
 * file log host (mis. `jsix.log`). Dipakai image produksi
 * (`twrapper --no-mirror` menulis `logFile = none`): log debug host tidak
 * seharusnya tumbuh tanpa batas di node produksi.
 */
export function isLogFileDisabled(logFile: unknown): boolean {
    const value = String(logFile ?? "").trim().toLowerCase();
    return value === "" || value === "none" || value === "off";
}

/**
 * Logger: Kelas untuk membantu kita (pengembang) melihat apa yang terjadi di dalam OS.
 */
export class Logger {
    private prefix: string;

    public static currentLevel: LogLevel = LogLevel.OFF;

    constructor(context: string) {
        this.prefix = `[${context}]`;

        // Auto-load config to set level if not already set manually
        try {
            const cfg = require("./Config").Config.get();
            if (cfg?.logger?.defaultLevel) {
                Logger.currentLevel = LogLevel[cfg.logger.defaultLevel as keyof typeof LogLevel] ?? LogLevel.INFO;
            }
        } catch (_) {
            // Config not available (e.g., test environment) — use defaults
        }
    }

    public log(level: LogLevel, message: string) {
        if (Logger.currentLevel === LogLevel.OFF) return;

        // Cek apakah level log saat ini cukup penting untuk ditampilkan
        const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
        const currentIdx = levels.indexOf(Logger.currentLevel);
        const logIdx = levels.indexOf(level);

        // Jika level log ini di bawah level minimal, abaikan (filter)
        if (logIdx < currentIdx && currentIdx !== -1) return;

        const timestamp = new Date().toLocaleTimeString();
        const logLine = `[${timestamp}] [${level}] ${this.prefix} ${message}`;

        // Logging TIDAK BOLEH membuat pemanggil crash. Config dimuat malas (hindari
        // import melingkar) dan bisa tidak tersedia (lingkungan test, proses tanpa
        // sysconfig) — dulu `require` di sini melempar dan setiap `logger.info()`
        // ikut melempar. Tanpa config: tidak ada output (default enableConsole=false,
        // dan tidak ada path log file).
        let cfg: any;
        try {
            cfg = require("./Config").Config.get();
        } catch (_) {
            return;
        }
        if (!cfg?.logger) return;

        // Cetak ke layar host (Hanya jika diaktifkan di config)
        if (cfg.logger.enableConsole) {
            console.log(logLine);
        }

        // Simpan ke file log (selalu taat pada filter tingkat kepentingan di atas),
        // kecuali dimatikan lewat `logFile = none` (image produksi).
        if (isLogFileDisabled(cfg.logger.logFile)) return;
        try {
            const fs = require("fs");
            fs.appendFileSync(cfg.logger.logFile, logLine + "\n");
        } catch (e) { }
    }

    public info(msg: string) { this.log(LogLevel.INFO, msg); }
    public warn(msg: string) { this.log(LogLevel.WARN, msg); }
    public error(msg: string) { this.log(LogLevel.ERROR, msg); }
    public debug(msg: string) { this.log(LogLevel.DEBUG, msg); }
}
