import { IProgram, OSContext } from "../lib/IProgram";

/**
 * UPTIME Utility
 * 
 * Tell how long the system has been running.
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, shell } = os;

        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: uptime\nDisplay system uptime.\n");
            return;
        }
        try {
            const uptimeMs = await shell.uptime();

            const seconds = Math.floor(uptimeMs / 1000);
            const minutes = Math.floor(seconds / 60);
            const hours = Math.floor(minutes / 60);
            const days = Math.floor(hours / 24);

            let output = "uptime: ";
            if (days > 0) output += `${days} days, `;

            const h = hours % 24;
            const m = minutes % 60;
            const s = seconds % 60;

            output += `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

            await std.print(output + "\n");
        } catch (e) {
            await std.print("uptime: failed to get system uptime\n");
        }
    }
}
