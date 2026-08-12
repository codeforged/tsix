import { IProgram, OSContext } from "../lib/IProgram";

/**
 * KILL Utility
 * 
 * Send a signal to a process.
 */
export class main implements IProgram {
    async execute({ shell }: OSContext, args: string[]): Promise<string> {
        let sig: number = 15; // Default SIGTERM (15)
        let pidArgs: string[] = [];

        if (args.length === 0 || args.includes("--help")) {
            let usage = "Usage: kill [-sig] <pid> [pid...]\n\n";
            usage += "Options:\n";
            usage += "  -sig    Signal to send (number or name)\n\n";
            usage += "Standard signals:\n";
            usage += "  -1,  HUP     Hangup\n";
            usage += "  -2,  INT     Interrupt (Ctrl+C)\n";
            usage += "  -9,  KILL    Kill (Immediate)\n";
            usage += "  -15, TERM    Terminate (Default, Graceful)\n";
            usage += "  -18, CONT    Continue (Resume)\n";
            usage += "  -19, STOP    Stop (Pause)\n";
            return usage;
        }

        const signalMap: Record<string, number> = {
            "HUP": 1, "INT": 2, "KILL": 9, "TERM": 15,
            "USR1": 10, "USR2": 12, "STOP": 19, "CONT": 18
        };

        if (args[0].startsWith("-")) {
            const rawSig = args[0].substring(1).toUpperCase();
            if (signalMap[rawSig]) sig = signalMap[rawSig];
            else if (rawSig.startsWith("SIG") && signalMap[rawSig.substring(3)]) sig = signalMap[rawSig.substring(3)];
            else sig = parseInt(rawSig);
            pidArgs = args.slice(1);
        } else {
            pidArgs = args;
        }

        let result = "";
        for (const pidStr of pidArgs) {
            const pid = parseInt(pidStr);
            if (isNaN(pid)) {
                result += `kill: invalid pid '${pidStr}'\n`;
                continue;
            }
            const success = await shell.kill(pid, sig);
            if (!success) result += `kill: (${pid}) - No such process\n`;
        }
        return result;
    }
}
