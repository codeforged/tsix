import { UserLib } from "../lib/UserLib";

/**
 * SHUTDOWN Utility
 * 
 * Bring the system down.
 */
export default class Shutdown {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help")) {
            await lib.std.print("Usage: shutdown [options] [time]\n\n" +
                "Options:\n" +
                "  -r      Reboot after shutdown\n" +
                "  -h, -P  Power off (default)\n" +
                "  now     Immediate action\n");
            return 0;
        }
        const { uid } = await lib.shell.whoami();
        if (uid !== 0) {
            return "shutdown: Permission denied (must be root)\n";
        }

        const isReboot = args.includes("-r");
        const isHalt = args.includes("-h") || args.includes("-P");

        // Find time argument (ignore flags)
        const timeArg = args.find(a => !a.startsWith("-"));

        let waitMinutes = 0;
        if (timeArg && timeArg !== "now") {
            if (timeArg.startsWith("+")) {
                waitMinutes = parseInt(timeArg.substring(1));
            } else {
                waitMinutes = parseInt(timeArg);
            }
        }

        if (isNaN(waitMinutes)) {
            return "shutdown: Invalid time specification\n";
        }

        const actionName = isReboot ? "reboot" : "power off";
        const exitCode = isReboot ? 1 : 0;

        if (waitMinutes > 0) {
            await lib.std.log(`Shutdown scheduled for ${waitMinutes} minutes from now (${actionName})`, "shutdown");
            await lib.std.print(`Shutdown scheduled for ${waitMinutes} minutes. Press Ctrl+C to cancel.\n`);

            // Countdown loop
            for (let i = waitMinutes; i > 0; i--) {
                if (i === 1) {
                    await lib.std.print("The system is going down in 1 minute!\n");
                } else if (i % 5 === 0 || i < 5) {
                    await lib.std.print(`The system is going down in ${i} minutes!\n`);
                }

                // Sleep for 1 minute (or remaining time)
                await lib.std.sleep(60000);
            }
        }

        await lib.std.print(`System is going down for ${actionName} NOW!\n`);
        await lib.std.log(`System ${actionName} initiated.`, "shutdown");

        // Wait a tiny bit for logs to flush
        await lib.std.sleep(500);

        await lib.shell.shutdown(exitCode);
        return "";
    }
}
