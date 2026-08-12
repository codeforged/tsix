import { IProgram, OSContext } from "../lib/IProgram";

/**
 * AWK-like filter utility for TSIX shell pipeline.
 *
 * Usage:
 *   ps | awk "/pixel/"
 *   ps | awk "/pixel/ && /RUNNING/"
 *   ps | awk "/pixel/" | awk "/RUNNING/"
 *   ps | awk "/pixel/" "{ print \\$1 }"
 *
 * Supports:
 *   /pattern/        — filter lines matching regex
 *   !/pattern/       — filter lines NOT matching regex
 *   { print $N }     — print column N (1-based)
 *   &&               — AND two conditions
 *   -v pattern       — alternative way to specify pattern
 */

export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, fs, shell } = os;

        if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
            await std.print(
                "Usage: awk '/pattern/' [file]\n" +
                "       awk '!/pattern/'\n" +
                "       awk '/pattern/ {print $N}'\n" +
                "       ps | awk '/pixel/'\n" +
                "       ps | awk '/pixel/ && /RUNNING/'\n" +
                "\n" +
                "Examples:\n" +
                "  awk '/pixel/'               Filter lines containing 'pixel'\n" +
                "  awk '!/pixel/'              Filter lines NOT containing 'pixel'\n" +
                "  awk '/pixel/ {print $1}'    Print column 1 of matching lines\n" +
                "  awk '/pixel/ && /RUNNING/'  Lines matching BOTH patterns\n" +
                "  ps | awk '/pixel/'          Piped from ps output\n"
            );
            return;
        }

        // Parse arguments into matchers and actions
        let patterns: RegExp[] = [];
        let notPatterns: RegExp[] = [];
        let printCols: number[] | null = null;

        // Join all args — shell splits tokens AND may expand $1 to empty
        const fullExpr = args.join(" ").replace(/^['"]|['"]$/g, "");

        // Check various patterns for {print N} (shell may have eaten $)
        // 1. Full pattern: { print $1 } or { print 1 }
        let pm = fullExpr.match(/\{\s*print\s+\$?(\d+)\s*\}/);
        if (pm) {
            printCols = [parseInt(pm[1])];
        } else {
            // 2. Shell split: "{print" "$1}" → check pairs
            for (let i = 0; i < args.length; i++) {
                // Single arg contains "print" and a digit
                let dm = args[i].match(/print\s+\$?(\d+)/i);
                if (dm) { printCols = [parseInt(dm[1])]; break; }
                // Fragment: "}" after "print"  
                // (shell expanded $1 to empty, so "$1}" became "}")
            }
            if (!printCols) {
                // 3. Adjacent args: args[i]="print" args[i+1]="$1}" or "1}"
                for (let i = 0; i < args.length - 1; i++) {
                    let j = args[i] + " " + args[i + 1];
                    let dm = j.match(/print\s+\$?(\d+)/i);
                    if (dm) { printCols = [parseInt(dm[1])]; break; }
                }
            }
        }

        // Check for && separated patterns
        const andParts = fullExpr.split("&&").map(s => s.trim());

        for (const part of andParts) {
            const trimmed = part.replace(/\{[^}]*\}/g, "").trim(); // remove { print ... }
            if (!trimmed) continue;

            // /pattern/
            const pMatch = trimmed.match(/^\/([^\/]+)\/$/);
            if (pMatch) {
                patterns.push(new RegExp(pMatch[1], "i"));
                continue;
            }

            // !/pattern/
            const npMatch = trimmed.match(/^!\/([^\/]+)\/$/);
            if (npMatch) {
                notPatterns.push(new RegExp(npMatch[1], "i"));
                continue;
            }

            // -v pattern
            const vMatch = trimmed.match(/^-v\s+(.+)$/);
            if (vMatch) {
                patterns.push(new RegExp(vMatch[1], "i"));
                continue;
            }

            // Treat as raw pattern
            if (trimmed.length > 0 && !trimmed.startsWith("{")) {
                patterns.push(new RegExp(trimmed, "i"));
            }
        }

        // Read all lines from stdin (FD 0 — pipe atau TTY)
        let input = "";
        while (true) {
            const chunk = await fs.read(0);
            if (chunk === null) {
                await new Promise(r => setTimeout(r, 10));
                continue;
            }
            if (chunk === "" || chunk === "FD NOT FOUND") break;
            input += chunk;
        }

        if (!input) return;

        // Split by newlines
        const lines = input.split("\n").filter(l => l.trim());

        // If {print $N} was detected from args but we still got no match,
        // fall back to extracting column from spec in args
        if (!printCols) {
            // Check if user asked for {print $N} but shell expanded $N
            // Look for "print" followed by a digit anywhere in args
            for (const a of args) {
                const dm = a.match(/print\s+\$?(\d+)/i);
                if (dm) { printCols = [parseInt(dm[1])]; break; }
            }
        }
        // Also check fragments: if shell split "{print" "$1}" → "$1}" becomes "}"
        // or "{print" "$1}" → fragments end up as separate tokens
        if (!printCols) {
            for (let i = 0; i < args.length - 1; i++) {
                const joined = args[i] + " " + args[i + 1];
                const dm = joined.match(/print\s+\$?(\d+)/i);
                if (dm) { printCols = [parseInt(dm[1])]; break; }
            }
        }

        let output = "";
        for (const line of lines) {
            // Apply positive patterns (ALL must match for &&)
            let allMatched = true;
            for (const re of patterns) {
                if (!re.test(line)) {
                    allMatched = false;
                    break;
                }
            }
            if (!allMatched) continue;

            // Apply negative patterns (NONE must match)
            let excluded = false;
            for (const re of notPatterns) {
                if (re.test(line)) {
                    excluded = true;
                    break;
                }
            }
            if (excluded) continue;

            // Print
            if (printCols !== null) {
                const parts = line.split(/\s+/);
                for (const ci of printCols) {
                    if (ci <= parts.length) output += parts[ci - 1] + " ";
                }
                output = output.trimEnd() + "\n";
            } else {
                output += line + "\n";
            }
        }

        if (output) await std.print(output);
    }
}
