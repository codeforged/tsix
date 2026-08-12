/**
 * CRONTAB — TSIX Crontab Manager
 *
 * Melihat dan mengedit cron jobs.
 * Format mirip crontab di Linux.
 *
 * Usage:
 *   crontab -l           Lihat cron jobs saat ini
 *   crontab -e           Edit cron jobs (via editor $EDITOR atau eucalyptus)
 *   crontab /etc/crontab Gunakan file tertentu
 *   crontab --help       Bantuan
 */

import { IProgram, OSContext } from "../../lib/IProgram";

export class main implements IProgram {
    async execute({ shell, std, fs }: OSContext, args: string[]): Promise<string> {
        if (args.includes("--help") || args.includes("-h") || args.length === 0) {
            return "crontab — TSIX Crontab Manager\n\n" +
                "Melihat, mengedit, dan memasang jadwal cron.\n" +
                "File schedule disimpan di: /etc/crontab (BKFS)\n\n" +
                "Usage:\n" +
                "  crontab -l              Lihat jadwal saat ini\n" +
                "  crontab -e              Edit jadwal (via editor)\n" +
                "  crontab [file]          Pasang file sebagai jadwal baru\n" +
                "  crontab --help          Bantuan ini\n\n" +
                "Format crontab (/etc/crontab):\n" +
                "  # m h dom mon dow command\n" +
                "  * * * * * /bin/echo.ts tick        → tiap menit\n" +
                "  */5 * * * * /bin/iot-scan.ts        → tiap 5 menit\n" +
                "  0 6 * * * /bin/ota-check.ts         → jam 6 pagi\n" +
                "  30 4 * * 0 /bin/maintenance.ts      → minggu jam 4:30\n" +
                "  0 */2 * * * /bin/sync-log.ts        → tiap 2 jam\n" +
                "  @reboot /bin/start-daemon.ts        → pas boot\n\n" +
                "Contoh:\n" +
                "  crontab -l                    # Lihat jadwal\n" +
                "  crontab -e                    # Edit jadwal\n" +
                "  crontab /tmp/my-cron.txt      # Pasang jadwal baru\n" +
                "  echo \"* * * * * /bin/echo.ts hi\" | crontab -\n\n" +
                "Catatan:\n" +
                "  - Daemon: crond --detach (jalankan sebagai background daemon)\n" +
                "  - @reboot: jalan sekali saat daemon pertama kali dijalankan\n" +
                "  - Environment: Gunakan export di /etc/profile untuk custom PATH\n";
        }

        const crontabPath = "/etc/crontab";

        if (args.includes("-l")) {
            // Lihat isi crontab
            try {
                const content = await fs.readFile(crontabPath);
                return content ? `# Crontab (${crontabPath})\n${content}` : "(empty)";
            } catch {
                return "(no crontab)";
            }
        }

        if (args.includes("-e")) {
            // Edit crontab — buka editor
            let editor = await shell.getenv("EDITOR");
            if (!editor) {
                // Prioritas: atto → eucalyptus
                const editors = ["atto", "eucalyptus"];
                for (const name of editors) {
                    try {
                        await fs.stat(`/bin/${name}`);
                        editor = `/bin/${name}`;
                        break;
                    } catch { /* not available */ }
                }
            }
            if (!editor) {
                return "No editor found. Set $EDITOR (e.g. export EDITOR=/bin/atto)";
            }
            try {
                const proc = await shell.exec(editor, [crontabPath]);
                if (proc?.pid) {
                    await shell.waitpid(proc.pid);
                }
            } catch (e: any) {
                return `Error running editor: ${e.message}`;
            }
            return "Crontab updated.";
        }

        // Jika argumen adalah path file, gunakan file itu
        if (args.length > 0 && !args[0].startsWith("-")) {
            const srcPath = args[0];
            try {
                const content = await fs.readFile(srcPath);
                if (!content) return `Cannot read ${srcPath}`;
                await fs.writeFile(crontabPath, content);
                return `Crontab installed from ${srcPath}`;
            } catch (e: any) {
                return `Error: ${e.message}`;
            }
        }

        return `Usage: crontab -l | -e | <file>`;
    }
}
