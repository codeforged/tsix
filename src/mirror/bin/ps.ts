import { IProgram, OSContext } from "../lib/IProgram";

/**
 * PS Utility
 * 
 * Report a snapshot of the current processes.
 * 
 * Flags:
 * aux, -e, -a: Show all processes.
 */
export class main implements IProgram {
    async execute({ shell, std }: OSContext, args: string[]): Promise<string> {
        if (args.includes("--help") || args.includes("-h")) {
            return "Usage: ps [options]\n\n" +
                "Report process status.\n" +
                "Options:\n" +
                "  aux    Show all processes\n" +
                "  -a     Show all processes\n" +
                "  -e     Show all processes\n";
        }
        const processes = await shell.ps();
        const userInfo = await shell.whoami();

        // Detect flags like aux, -a, -ax, -e
        const showAll = args.some(arg =>
            arg.includes("a") || arg.includes("e") || arg === "aux" || arg === "-ax"
        );

        const p = (str: any, len: number) => String(str).padEnd(len);

        let output = `${p("PID", 8)}${p("PPID", 8)}${p("TTY", 8)}${p("UID", 8)}${p("NAME", 20)}${p("STATE", 12)}${p("USER", 10)}\n`;
        output += "------------------------------------------------------------------------------\n";

        const filtered = showAll
            ? processes
            : processes.filter((proc: any) => proc.uid === userInfo.uid);

        filtered.forEach((p_proc: any) => {
            const ttyStr = p_proc.ttyId ? `tty${p_proc.ttyId}` : "?";
            output += `${p(p_proc.pid, 8)}${p(p_proc.ppid ?? "-", 8)}${p(ttyStr, 8)}${p(p_proc.uid, 8)}${p(p_proc.name, 20)}${p(p_proc.state, 12)}${p(p_proc.user, 10)}\n`;
        });

        if (!showAll && processes.length > filtered.length) {
            output += `\n(Total ${processes.length} processes. Use 'ps aux' to see all)\n`;
        }

        return output;
    }
}
