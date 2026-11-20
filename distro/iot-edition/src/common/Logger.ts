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

        const cfg = require("./Config").Config.get();

        // Cetak ke layar host (Hanya jika diaktifkan di config)
        if (cfg.logger.enableConsole) {
            console.log(logLine);
        }

        // Simpan ke file log (selalu taat pada filter tingkat kepentingan di atas)
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
