import { Program, std } from "@tsix/Application";

/**
 * UNAME Utility
 * 
 * Print system information.
 */
export const main = Program(async (args) => {
    if (args.includes("--help") || args.includes("-h")) {
        await std.print("Usage: uname [options]\n\n" +
            "Options:\n" +
            "  -a    Print all system information\n");
        return;
    }
    try {
        const info = await std.uname();
        const showAll = args.includes("-a");

        if (showAll) {
            // sysname distroname release version machine runtime engine
            const libVer = std.getLibVersion();
            await std.print(`${info.sysname} ${info.distroname}\nKernel: ${info.codename} ${info.version}\nMachine: ${info.machine}\n`);
            await std.print(`Runtime: ${info.runtime}\n`);
            await std.print(`Engine: ${info.engine}\n`);
            await std.print(`UserLib: ${libVer}\n`);
        } else {
            // Default as requested: only version field (which is kernel version)
            await std.print(`${info.codename}\n`);
        }
    } catch (e: any) {
        await std.print(`uname: error retrieving system info: ${e.message}\n`);
    }
});
