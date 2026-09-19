import { IProgram, OSContext } from "../lib/IProgram";
import { CHARSETS, TABLE_THEMES, Table, type Align, type CharsetName } from "@tsix/tableLib";
import { detectColor, setColorEnabled, tone, wrap } from "@tsix/ansiLib";

/**
 * PS Utility
 *
 * Report a snapshot of the current processes.
 *
 * Output memakai `@tsix/tableLib` — lebar kolomnya mengikuti TTY (`SCREEN_INFO`
 * → `TIOCGWINSZ`) dan memakai `displayWidth()` yang setia ke `TTY.putChar()`,
 * jadi tabel tetap sejajar walau sel memuat ANSI/box-drawing.
 *
 * Flags:
 * aux, -e, -a: Show all processes.
 * --mem      : Show per-process memory (isolate heap).
 * --sort-mem : Sort by memory usage (implies --mem).
 * --charset  : box | rounded | double | compact | ascii | markdown | none.
 * --width N  : Paksa lebar tabel (default: lebar TTY - 1).
 * --no-color : Matikan seluruh warna ANSI.
 */
const HELP =
    "Usage: ps [options]\n\n" +
    "Report process status.\n" +
    "Options:\n" +
    "  aux, -a, -e   Show all processes\n" +
    "  --mem         Show per-process memory (isolate heap)\n" +
    "  --sort-mem    Sort by memory (implies --mem)\n" +
    "  --charset N   box | rounded | double | compact | ascii | markdown | none\n" +
    "  --width N     Force table width in cells (default: TTY width - 1)\n" +
    "  --no-color    Disable ANSI colors\n";

/** `--flag value` atau `--flag=value`. */
function flagValue(args: string[], name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
    const prefixed = args.find((a) => a.startsWith(name + "="));
    return prefixed ? prefixed.slice(name.length + 1) : undefined;
}

/** Negative ttyId = proses di PTY on-demand (pts/N, N = -(ttyId+1)). */
function ttyLabel(ttyId?: number): string {
    if (!ttyId) return "?";
    return ttyId > 0 ? `tty${ttyId}` : `pts/${-ttyId - 1}`;
}

function memTotal(proc: any): number {
    return proc?.mem ? proc.mem.heapUsed + proc.mem.external : 0;
}

/** Warna status: hijau jalan, kuning terblokir, merah keluar, redup lainnya. */
function stateCell(state: any): string {
    const s = String(state ?? "").toLowerCase();
    if (s.includes("run")) return tone.success(state);
    if (s.includes("block")) return tone.warning(state);
    if (s.includes("exit") || s.includes("zomb")) return tone.danger(state);
    return tone.muted(state);
}

export class main implements IProgram {
    async execute({ shell, std }: OSContext, args: string[]): Promise<string> {
        if (args.includes("--help") || args.includes("-h")) return HELP;

        // --sort-mem implies --mem (convenient when hunting a memory leak).
        const sortMem = args.includes("--sort-mem");
        const showMem = sortMem || args.includes("--mem");

        // ── Warna: --no-color → NO_COLOR → TERM; default ON (lihat detectColor) ──
        const colorOn =
            !args.includes("--no-color") &&
            detectColor({
                TERM: (await shell.getenv("TERM")) ?? "xterm",
                NO_COLOR: await shell.getenv("NO_COLOR"),
                FORCE_COLOR: await shell.getenv("FORCE_COLOR"),
            });
        setColorEnabled(colorOn);

        // ── Charset bingkai ──
        const charsetArg = flagValue(args, "--charset") as CharsetName | undefined;
        const charset: CharsetName = charsetArg && CHARSETS[charsetArg] ? charsetArg : "box";

        // ── Lebar: --width → COLUMNS TTY - 1 → biarkan tableLib memutuskan ──
        const screen = await std.getScreenInfo().catch(() => null);
        const ttyColumns = Number((screen as any)?.columns) || 0;
        const widthArg = Number(flagValue(args, "--width"));
        const width =
            Number.isFinite(widthArg) && widthArg > 0
                ? Math.floor(widthArg)
                : ttyColumns > 0
                  ? ttyColumns - 1
                  : undefined;

        const processes = (await shell.ps(showMem ? { includeMemory: true } : undefined)) as any[];
        const userInfo = await shell.whoami();

        // Deteksi argumen gaya `ps aux` / `ps -ef` / `ps -a`.
        //
        // Sengaja hanya pola flag pendek yang cocok, bukan `arg.includes("e")`
        // seperti sebelumnya — cara lama membuat `ps --mem` (ada huruf "e") dan
        // `ps --charset box` (ada huruf "a") diam-diam menampilkan SEMUA proses.
        const showAll = args.some((a) => a === "aux" || a === "-aux" || /^-[aefx]+$/.test(a));

        const filtered = showAll ? processes : processes.filter((proc) => proc.uid === userInfo.uid);

        // Sort when requested so the largest consumer shows up first.
        const ordered = sortMem ? [...filtered].sort((a, b) => memTotal(b) - memTotal(a)) : filtered;

        // ── Tabel ──
        const head = ["PID", "PPID", "TTY", "UID", "NAME", "STATE", "USER"];
        const align: Align[] = ["right", "right", "left", "right", "left", "left", "left"];
        if (showMem) {
            head.push("HEAP(MB)", "EXT(MB)");
            align.push("right", "right");
        }

        const table = new Table({
            head,
            charset,
            align,
            width,
            style: colorOn ? TABLE_THEMES.accent : TABLE_THEMES.plain,
        });

        for (const proc of ordered) {
            const row: Array<string | number> = [
                proc.pid,
                proc.ppid ?? "-",
                tone.muted(ttyLabel(proc.ttyId)),
                proc.uid,
                proc.name,
                stateCell(proc.state),
                proc.user,
            ];
            if (showMem) {
                row.push(
                    proc.mem ? (proc.mem.heapUsed / 1048576).toFixed(1) : "-",
                    proc.mem ? (proc.mem.external / 1048576).toFixed(1) : "-",
                );
            }
            table.addRow(row);
        }

        const out: string[] = [table.render()];

        /** Catatan kaki — dibungkus agar tidak melewati tepi layar. */
        const note = (text: string): void => {
            for (const line of width ? wrap(text, width) : [text]) out.push(tone.muted(line));
        };

        if (showMem) {
            // Total measured heap across all workers — separates worker load from
            // main-thread load (the main thread carries its own native libraries:
            // esbuild, mqtt, mysql2, sqlite, serial/usb drivers).
            let sumHeap = 0,
                sumExt = 0,
                counted = 0;
            for (const proc of processes) {
                if (proc.mem) {
                    sumHeap += proc.mem.heapUsed;
                    sumExt += proc.mem.external;
                    counted++;
                }
            }
            const mb = (bytes: number) => (bytes / 1048576).toFixed(1);
            note(
                `Total (${counted}/${processes.length} processes read): ${mb(sumHeap)} MB heap + ${mb(sumExt)} MB external.`,
            );
            note("Per-isolate figures (heapTotal may include non-resident pages); 'rss' is process-wide.");

            // Sumber angka penting: 'pull' itu bebas-blocking, 'ipc' bergantung pada
            // worker sempat memutar event loop (lihat Scheduler.getProcessMemory).
            const viaIpc = processes.filter((proc) => proc.mem?.source === "ipc").length;
            if (counted > 0 && viaIpc > 0) {
                note(
                    `Read via worker reply (IPC): ${viaIpc}/${counted} — 'pull' (Node >= 22.16) is more reliable on busy workers.`,
                );
            }

            // Jangan biarkan kolom kosong tanpa penjelasan: inilah yang bikin
            // 'ps --mem' tampak rusak di macOS/Ubuntu yang memakai Node < 22.16.
            if (counted === 0) {
                out.push("");
                out.push("No memory figures available for any process. Why:");
                out.push("  * Node >= 22.16 lets the kernel pull stats straight from each isolate");
                out.push("    (worker.getHeapStatistics). On older Node it must ASK the worker,");
                out.push("    and a worker busy in synchronous code never answers in time.");
                out.push("  * Processes that just spawned may not have their worker online yet.");
                const nodeVer = (globalThis as any).process?.version;
                if (nodeVer) out.push(`  Host Node: ${nodeVer}`);
                out.push("Try again, or check the kernel log for worker errors.");
            }
        } else if (!showAll && processes.length > filtered.length) {
            note(`Total ${processes.length} processes. Use 'ps aux' to see all.`);
        }

        return out.join("\n");
    }
}
