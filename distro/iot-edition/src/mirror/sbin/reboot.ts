import { UserLib } from "../lib/UserLib";

/**
 * REBOOT Utility
 * 
 * Reboot the system.
 */
export default class Reboot {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: reboot\nReboot the system.\n");
            return 0;
        }
        const { uid } = await lib.shell.whoami();
        if (uid !== 0) {
            return "reboot: Permission denied (must be root)\n";
        }

        await lib.std.print("System is going down for reboot NOW!\n");
        // Exit with code 1 to signal reboot to bootstrap script
        await lib.shell.shutdown(1);
        return "";
    }
}
