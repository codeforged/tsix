import { IProgram, OSContext } from "../lib/IProgram";

/**
 * PS Utility
 * 
 * Report a snapshot of the current processes.
 * 
 * Flags:
 * aux, -e, -a: Show all processes.
 * --mem      : Show per-process memory (isolate heap).
 * --sort-mem : Sort by memory usage (implies --mem).
 */
export class main implements IProgram {
    async execute({ shell, std }: OSContext, args: string[]): Promise<string> {
        if (args.includes("--help") || args.includes("-h")) {
            return "Usage: ps [options]\n\n" +
                "Report process status.\n" +
                "Options:\n" +
                "  aux        Show all processes\n" +
                "  -a, -e     Show all processes\n" +
                "  --mem      Show per-process memory (isolate heap)\n" +
                "  --sort-mem Sort by memory (implies --mem)\n";
        }

        // --sort-mem implies --mem (convenient when hunting a memory leak).
        const sortMem = args.includes("--sort-mem");
        const showMem = sortMem || args.includes("--mem");

        const processes = await shell.ps(showMem ? { includeMemory: true } : undefined);
        const userInfo = await shell.whoami();

        // Detect flags like aux, -a, -ax, -e
        const showAll = args.some(arg =>
            arg.includes("a") || arg.includes("e") || arg === "aux" || arg === "-ax"
        );

        const p = (str: any, len: number) => String(str).padEnd(len);
        const mb = (bytes: number) => (bytes / 1048576).toFixed(1);

        let header = `${p("PID", 8)}${p("PPID", 8)}${p("TTY", 8)}${p("UID", 8)}${p("NAME", 20)}${p("STATE", 12)}${p("USER", 10)}`;
        if (showMem) header += p("HEAP+EXT(MB)", 14);
        let output = header + "\n";
        output += "-".repeat(showMem ? 92 : 78) + "\n";

        const filtered = showAll
            ? processes
            : processes.filter((proc: any) => proc.uid === userInfo.uid);

        // Sort when requested so the largest consumer shows up first.
        const ordered = sortMem
            ? [...filtered].sort((a: any, b: any) => {
                const am = a.mem ? a.mem.heapUsed + a.mem.external : 0;
                const bm = b.mem ? b.mem.heapUsed + b.mem.external : 0;
                return bm - am;
            })
            : filtered;

        ordered.forEach((p_proc: any) => {
            // Negative ttyId = process on an on-demand PTY (pts/N, N = -(ttyId+1))
            let ttyStr = "?";
            if (p_proc.ttyId && p_proc.ttyId > 0) {
                ttyStr = `tty${p_proc.ttyId}`;
            } else if (p_proc.ttyId && p_proc.ttyId < 0) {
                ttyStr = `pts/${-(p_proc.ttyId) - 1}`;
            }
            output += `${p(p_proc.pid, 8)}${p(p_proc.ppid ?? "-", 8)}${p(ttyStr, 8)}${p(p_proc.uid, 8)}${p(p_proc.name, 20)}${p(p_proc.state, 12)}${p(p_proc.user, 10)}`;
            if (showMem) {
                output += p(p_proc.mem ? `${mb(p_proc.mem.heapUsed)}+${mb(p_proc.mem.external)}` : "-", 14);
            }
            output += "\n";
        });

        if (showMem) {
            // Total measured heap across all workers — separates worker load from
            // main-thread load (the main thread carries its own native libraries:
            // esbuild, mqtt, mysql2, sqlite, serial/usb drivers).
            let sumHeap = 0, sumExt = 0, counted = 0;
            for (const proc of processes as any[]) {
                if (proc.mem) { sumHeap += proc.mem.heapUsed; sumExt += proc.mem.external; counted++; }
            }
            output += "-".repeat(92) + "\n";
            output += `Total (${counted}/${processes.length} processes read): heap ${mb(sumHeap)} MB + external ${mb(sumExt)} MB\n`;
            output += `Note: these are per-isolate figures (heapTotal may include non-resident pages).\n`;
            output += `      'rss' in \`mem\` is process-wide (main thread + all workers).\n`;
        } else if (!showAll && processes.length > filtered.length) {
            output += `\n(Total ${processes.length} processes. Use 'ps aux' to see all)\n`;
        }

        return output;
    }
}
