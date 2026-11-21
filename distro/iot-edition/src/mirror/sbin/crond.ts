// CROND — TSIX Cron Daemon
//
// Membaca /etc/crontab, eksekusi perintah sesuai jadwal.
// Berjalan sebagai background daemon (auto-daemonize, detach dari TTY).
//
// Crontab format (standar cron):
//   m h dom mon dow command
//   * = setiap, n = tiap n, a, b = daftar
//
// Juga support @reboot:
//   @reboot /bin/echo.ts hello         → jalan sekali pas boot
//
// Contoh:
//   * * * * * /bin/echo.ts hello         → tiap menit
//   */5 * * * * /bin/iot-scan.ts         → tiap 5 menit
//   0 6 * * * /bin/ota-check.ts          → jam 6 pagi tiap hari
//   30 4 * * 0 /bin/maintenance.ts       → minggu jam 4:30
//   @reboot /bin/wallpaper-rotate.ts     → ganti wallpaper pas login
//
// Usage:
//   crond               → jalan sebagai background daemon (default)
//   crond --foreground  → tetap di TTY (debug)
//   crond --test        → cek crontab tanpa menjalankan

import { IProgram, OSContext } from "../lib/IProgram";

export class main implements IProgram {
    private std!: any;
    private shell!: any;
    private fs!: any;
    private timer: any = null;
    private isRunning = true;

    async execute({ shell, std, fs }: OSContext, args: string[]): Promise<string> {
        this.std = std;
        this.shell = shell;
        this.fs = fs;

        if (args.includes("--help") || args.includes("-h")) {
            return "crond — TSIX Cron Daemon\n\n" +
                "Usage:\n" +
                "  crond               Jalankan sebagai background daemon (default)\n" +
                "  crond --foreground  Tetap di TTY (debug, jangan di-daemonize)\n" +
                "  crond --test        Cek crontab tanpa menjalankan\n";
        }

        // Cek crontab
        let entries = await this.parseCrontab();
        if (entries.length === 0) {
            // Debug: cek apakah file-nya ada
            try {
                const raw = await this.fs.readFile("/etc/crontab");
                await std.log(`[crond] /etc/crontab exists (${raw?.length || 0} chars), but parsed 0 entries`);
            } catch (e: any) {
                await std.log(`[crond] /etc/crontab not found: ${e.message}`);
            }
        }
        if (args.includes("--test")) {
            let out = `Crontab (/etc/crontab): ${entries.length} entries\n`;
            for (const e of entries) {
                out += `  ${e.raw} → ${e.command}\n`;
            }
            return out;
        }

        if (entries.length === 0) {
            await std.log("[crond] No entries in /etc/crontab, idling...");
            // Tetap hidup — biar task bisa ditambah nanti tanpa restart
            await std.log("[crond] Daemon running (idle)");
            // Daemonize by default — --foreground untuk tetap di TTY (debug)
            if (!args.includes("--foreground") && !args.includes("-f")) {
                await shell.daemonize("Cron Daemon");
                await std.log("[crond] Detached from TTY, running as daemon");
            }
            // Keep-alive: loop timer biar worker tetap hidup (promise kosong tak cukup)
            while (true) {
                await new Promise((r) => setTimeout(r, 5000));
            }
            return "crond terminated";
        }

        await std.log(`[crond] Started with ${entries.length} entries`);

        // Eksekusi @reboot entries
        const rebootEntries = entries.filter(e => e.isReboot);
        for (const entry of rebootEntries) {
            await std.log(`[crond] @reboot: ${entry.command}`);
            this.execInBackground(entry.command).catch(() => { });
        }

        // Daemonize by default — --foreground untuk tetap di TTY (debug)
        if (!args.includes("--foreground") && !args.includes("-f")) {
            await shell.daemonize("Cron Daemon");
            await std.log("[crond] Detached from TTY, running as daemon");
        }

        // Cron loop: cek tiap menit
        entries = await this.parseCrontab();
        let lastCheck = 0;

        const tick = async () => {
            if (!this.isRunning) return;

            // Reload crontab tiap 30 detik (biar perubahan langsung kepake)
            if (Date.now() - lastCheck > 30000) {
                const newEntries = await this.parseCrontab();
                if (newEntries.length !== entries.length) {
                    await std.log(`[crond] Crontab changed: ${entries.length} → ${newEntries.length} entries`);
                    // Eksekusi @reboot entries yang baru
                    const newReboots = newEntries.filter(e => e.isReboot &&
                        !entries.some(old => old.command === e.command));
                    for (const entry of newReboots) {
                        await std.log(`[crond] @reboot (new): ${entry.command}`);
                        this.execInBackground(entry.command).catch(() => { });
                    }
                }
                entries = newEntries;
                lastCheck = Date.now();
            }
            if (!this.isRunning) return;
            const now = new Date();
            const min = now.getMinutes();
            const hr = now.getHours();
            const dom = now.getDate();
            const mon = now.getMonth() + 1;   // 1-12
            const dow = now.getDay();          // 0=Sun

            for (const entry of entries) {
                if (this.matchCron(entry, min, hr, dom, mon, dow)) {
                    await std.log(`[crond] Exec: ${entry.command}`);
                    // Jalankan di background — gak nunggu selesai
                    this.execInBackground(entry.command).catch(() => { });
                }
            }

            // Jadwalin tick berikutnya pas detik :00 biar akurat
            const msToNextMin = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
            this.timer = setTimeout(tick, msToNextMin);
        };

        // Tick pertama pas detik :00
        const msToNextMin = (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds();
        setTimeout(tick, msToNextMin);

        // Keep-alive: loop timer biar worker tetap hidup
        while (true) {
            await new Promise((r) => setTimeout(r, 5000));
        }
        return "crond terminated";
    }

    private async parseCrontab(): Promise<CronEntry[]> {
        const entries: CronEntry[] = [];
        try {
            const content = await this.fs.readFile("/etc/crontab");
            if (!content) return entries;

            for (const line of content.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) continue;

                // Handle @reboot
                if (trimmed.startsWith("@reboot")) {
                    const command = trimmed.substring(7).trim();
                    if (command) {
                        entries.push({
                            raw: "@reboot",
                            command,
                            minute: "@reboot",
                            hour: "*",
                            dayOfMonth: "*",
                            month: "*",
                            dayOfWeek: "*",
                            isReboot: true,
                        });
                    }
                    continue;
                }

                // Format: m h dom mon dow command
                const parts = trimmed.split(/\s+/);
                if (parts.length < 6) continue;

                const raw = parts.slice(0, 5).join(" ");
                const command = parts.slice(5).join(" ");
                entries.push({
                    raw, command,
                    minute: parts[0],
                    hour: parts[1],
                    dayOfMonth: parts[2],
                    month: parts[3],
                    dayOfWeek: parts[4],
                });
            }
        } catch (e) {
            // /etc/crontab might not exist
        }
        return entries;
    }

    private matchCron(entry: CronEntry, min: number, hr: number, dom: number, mon: number, dow: number): boolean {
        // @reboot entries are matched separately, not here
        if (entry.isReboot) return false;
        return (
            this.matchField(entry.minute, min) &&
            this.matchField(entry.hour, hr) &&
            this.matchField(entry.dayOfMonth, dom) &&
            this.matchField(entry.month, mon) &&
            this.matchField(entry.dayOfWeek, dow)
        );
    }

    private matchField(pattern: string, value: number): boolean {
        if (pattern === "*") return true;

        // */n — tiap n
        if (pattern.startsWith("*/")) {
            const step = parseInt(pattern.substring(2));
            return !isNaN(step) && step > 0 && value % step === 0;
        }

        // a,b,c — daftar
        if (pattern.includes(",")) {
            return pattern.split(",").some(p => this.matchField(p.trim(), value));
        }

        // a-b — range
        if (pattern.includes("-")) {
            const [a, b] = pattern.split("-").map(Number);
            return value >= a && value <= b;
        }

        // Angka tunggal
        return parseInt(pattern) === value;
    }

    private async execInBackground(cmd: string) {
        try {
            // Pisah command + args (sederhana, handle quotes)
            const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
            if (parts.length === 0) return;
            const prog = parts[0];
            const args = parts.slice(1).map((a: string) =>
                (a.startsWith('"') && a.endsWith('"')) ? a.slice(1, -1) :
                    (a.startsWith("'") && a.endsWith("'")) ? a.slice(1, -1) : a
            );
            await this.shell.exec(prog, args);
        } catch (e: any) {
            await this.std.log(`[crond] Failed: ${cmd}: ${e.message}`);
        }
    }
}

interface CronEntry {
    raw: string;
    command: string;
    minute: string;
    hour: string;
    dayOfMonth: string;
    month: string;
    dayOfWeek: string;
    /** true untuk entri @reboot (dieksekusi sekali saat boot, bukan dijadwalkan) */
    isReboot?: boolean;
}
