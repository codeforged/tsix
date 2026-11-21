import { IProgram, OSContext } from "../lib/IProgram";

/**
 * CHVT Utility
 * 
 * Change foreground virtual terminal.
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, fs, shell } = os;

        const ttyCount = parseInt((await shell.getenv("TSIX_TTY_COUNT")) || "6");
        if (args.includes("--help") || args.includes("-h")) {
            await std.print(`Usage: chvt <number>\nChange to virtual terminal <number> (1-${ttyCount}).\n`);
            return;
        }

        if (args.length < 1) {
            await std.print("Usage: chvt <terminal_number>\n");
            await std.print("Example: chvt 2\n");
            return;
        }

        const ttyId = parseInt(args[0]);
        if (isNaN(ttyId) || ttyId < 1 || ttyId > ttyCount) {
            await std.print(`Invalid TTY number. Must be 1-${ttyCount}.\n`);
            return;
        }

        try {
            // Kita buka device TTY saat ini (canonical console)
            const fd = await fs.open("/dev/tty", "r");
            if (fd < 0) {
                await std.print(`Error: Could not open /dev/tty\n`);
                return;
            }

            // Dan panggil SWITCH_TTY (IOCTL 2) dengan ID target sebagai argumen
            await std.ioctl(fd, 2, ttyId);

            // Tutup FD (penting!)
            await fs.close(fd);
        } catch (e: any) {
            await std.print(`Error: ${e.message}\n`);
        }
    }
}
