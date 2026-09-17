import { IProgram, OSContext } from "@tsix/IProgram";
import { StdLib, FsLib, ShellLib } from "@tsix/UserLib";
import {
    findTopLevelOperator,
    findTopLevelOperators,
    isKnownShell,
    parseScriptLines,
    scriptShebang,
    splitRawWords,
    splitTopLevel,
    splitTrailingContinuation,
} from "@tsix/ShellScript";

interface CompletionState {
    active: boolean;
    matches: string[];
    selectedIdx: number;
    matchResult: { commonBase: string; originalParts: string[]; dirPath: string };
    linesUsed: number;
    numRows: number;
    numCols: number;
}

/** Hasil ekspansi satu kata shell. */
interface ExpandedWord {
    /** Nilai akhir (kutip sudah dibuang, escape & variabel sudah diproses). */
    value: string;
    /**
     * true bila kata memakai kutip atau escape — dipakai untuk memutuskan
     * apakah `~`/wildcard masih boleh di-expand (`"*"` ≠ `*`).
     */
    literal: boolean;
}

/**
 * Env yang dibaca shell untuk SETIAP perintah.
 *
 * `getenv` itu satu round-trip IPC ke kernel; memanggilnya 3–4× per perintah
 * membuat perintah cepat (builtin, `echo`) jadi lambat. Nilai di bawah ini
 * di-cache dan cache-nya dibuang setiap shell MENULIS env itu sendiri
 * (lihat `setEnv()`), jadi `export PATH=...` tetap langsung terasa.
 */
const CACHED_ENV = new Set(["PATH", "HOME", "TSH_WAIT_HINT_MS"]);

/**
 * SHELL (User Interface)
 */
export class main implements IProgram {
    private version: string = "1.1.4";
    private name: string = "tsh";
    private std!: StdLib;
    private fs!: FsLib;
    private shell!: ShellLib;
    private user: string = "root";
    private hostname: string = "dinawari";
    private isRunning: boolean = true;
    private history: string[] = [];

    // Argumen skrip: [$0=path, $1, $2, ...] — kosong saat mode interaktif.
    private scriptArgs: string[] = [];
    // Kedalaman skrip bersarang — pagar supaya skrip yang memanggil dirinya
    // sendiri tidak membuat shell berputar tanpa henti.
    private scriptDepth: number = 0;

    // Default env vars
    private rows: number = 24;
    private columns: number = 80;

    // Line Editor State (Class level so signal handler can redraw instantly)
    private lineBuffer: string = "";
    private cursor: number = 0;
    private currentPrompt: string = "";

    // PID proses foreground yang sedang dijalankan (atto, less, dll).
    // Dipakai buat skip redraw prompt saat resize biar tidak menimpa layar app.
    private foregroundPid: number | null = null;

    // >0 = output perintah sedang DITANGKAP (di dalam `$(...)`), jadi builtin
    // harus mengembalikan teksnya ke pemanggil, bukan mencetaknya sendiri.
    private captureDepth: number = 0;

    // Cache env (lihat CACHED_ENV) + memo hasil PATH lookup. Keduanya hanya
    // berisi nilai POSITIF supaya file yang baru dibuat selalu ketemu.
    private envCache: Map<string, string | null> = new Map();
    private binCache: Map<string, string> = new Map();

    // cwd & status root jarang berubah tapi dibaca terus oleh prompt/`pwd`:
    // tanpa cache, tiap prompt = 2 round-trip IPC tambahan.
    private cachedCwd: string | null = null;
    private isRoot: boolean = false;

    constructor() {}

    async execute(lib: OSContext, args: string[]): Promise<string> {
        this.std = lib.std;
        this.fs = lib.fs;
        this.shell = lib.shell;
        this.envCache.clear();
        this.binCache.clear();
        this.cachedCwd = null;
        const userInfo = await this.shell.whoami();
        this.user = userInfo.username;
        this.isRoot = userInfo.uid === 0;
        const hostnameEnv = await this.shell.getenv("HOSTNAME");
        if (hostnameEnv) this.hostname = hostnameEnv;

        // --- CLI ARGUMENT HANDLING ---
        if (args.includes("-v") || args.includes("--version")) {
            await lib.std.print(`TSIX Shell v${this.version} (Dinawari)\n`);
            return `Shell version ${this.version}`;
        }

        // --- MODE NON-INTERAKTIF: `tsh <skrip.sh> [args...]` ---
        // Menjalankan skrip lalu keluar (tanpa prompt). Dipakai juga saat skrip
        // dijalankan di background — shell men-spawn dirinya sendiri sebagai
        // subshell, bukan meniru fork/exec yang tidak ada di TSIX.
        const firstArg = args.find((a) => !a.startsWith("-"));
        if (firstArg) {
            const candidate = await this.resolveBinary(firstArg);
            if (candidate && (await this.detectScript(candidate)).isScript) {
                const rest = args.slice(args.indexOf(firstArg) + 1);
                const output = await this.runScriptCommand(candidate, rest, {
                    redirectPath: null,
                    isBackground: false,
                    isPipelinePart: false,
                });
                if (typeof output === "string" && output) {
                    await lib.std.print(output + "\n");
                }
                return `Script ${firstArg} finished.`;
            }
        }

        // --- CLI ARGUMENT HANDLING: shell <username> → login as that user ---
        const targetUser = args.find((a) => !a.startsWith("-"));
        if (targetUser && targetUser !== this.user) {
            // Delegate to login with username as argument
            // login is SetUID root, so it can authenticate and switch users
            const loginResult = await this.shell.exec("/bin/login.js", [targetUser]);
            if (loginResult && typeof loginResult === "object" && "pid" in loginResult) {
                await this.shell.waitpid((loginResult as any).pid);
            }
            return "Session closed.";
        }

        await this.loadHistory();

        // Source /etc/profile (system-wide env) and ~/.tsixrc (user env)
        await this.sourceProfile();

        //await this.std.print("\n--- SYSTEM READY ---\n");

        const linesStr = await this.shell.getenv("LINES");
        const colsStr = await this.shell.getenv("COLUMNS");
        this.rows = parseInt(linesStr || "24");
        this.columns = parseInt(colsStr || "80");

        (lib as any).onEvent("resize", async (data: { lines: number; columns: number }) => {
            this.rows = data.lines;
            this.columns = data.columns;
            await this.shell.setenv("LINES", data.lines.toString());
            await this.shell.setenv("COLUMNS", data.columns.toString());
        });

        // IPC resize from terminal emulator (e.g. pixelterm)
        (lib as any).onEvent("ipc_message", async (msg: any) => {
            const data = msg?.data || msg;
            if (data?.type === "RESIZE") {
                this.rows = data.lines || this.rows;
                this.columns = data.columns || this.columns;
                await this.shell.setenv("LINES", this.rows.toString());
                await this.shell.setenv("COLUMNS", this.columns.toString());
                // Jangan redraw prompt kalau ada foreground app (mis. atto) lagi jalan
                if (!this.foregroundPid) {
                    await this.redrawCurrentLine();
                }
            }
        });

        // --- TTY ACTIVATION / REDRAW HANDLER ---
        // Dipanggil saat Virtual Console ini dikembalikan ke foreground (Alt+F#)
        (lib as any).onEvent("signal", async (sig: any) => {
            if (sig === "SIGWINCH" && !this.foregroundPid) {
                await this.redrawCurrentLine();
            }
        });

        while (this.isRunning) {
            // Re-assert Raw Mode (Safety if a child process changed it)
            await this.std.setRawMode(true);

            const prompt = await this.renderPrompt();
            const input = await this.readLogicalLine(prompt);

            if (input && input.trim()) {
                await this.addToHistory(input.trim());

                // --- UNIVERSAL FIX: Switch to Cooked Mode before executing ---
                // This allows foreground commands to receive SIGINT from the kernel.
                // If the command is a TUI (like Atto), it will set Raw Mode itself.
                await this.std.setRawMode(false);

                const output = await this.handleCommand(input.trim());
                if (output) {
                    await this.std.print(output + "\n");
                }
            }
        }

        await this.std.setRawMode(false);
        return "Shell terminated.";
    }

    private async renderPrompt(): Promise<string> {
        let format = (await this.shell.getenv("PROMPT_FORMAT")) || "&username@&hostname:&cwd&usertype ";
        const cwd = await this.getCwd();
        const isRoot = this.isRoot;

        const userColor = "\u001b[36m"; // Cyan
        const hostColor = "\u001b[32m"; // Green
        const dirColor = "\u001b[33m"; // Yellow
        const accentColor = "\u001b[30m"; // Black
        const typeColor = isRoot ? "\u001b[31m" : "\u001b[32m"; // Red for root #, Black for others
        const reset = "\u001b[0m";

        const userType = isRoot ? `${typeColor}#${reset}` : `${typeColor}$${reset}`;

        let prompt = format
            .replace("&username", `${userColor}${this.user}${reset}`)
            .replace("@&hostname", `${accentColor}@${reset}${hostColor}${this.hostname}${reset}`)
            .replace("&hostname", `${hostColor}${this.hostname}${reset}`)
            .replace("&cwd", `${dirColor}${cwd}${reset}`)
            .replace("&usertype", userType);

        return prompt;
    }

    private async readLine(prompt: string): Promise<string> {
        this.currentPrompt = prompt;
        await this.std.print(prompt);

        this.lineBuffer = "";
        this.cursor = 0;
        let historyPos = this.history.length;

        let compState: CompletionState | null = null;

        // Helper to strip ANSI for length calc
        const promptLength = (str: string) => {
            return str.replace(/\x1b\[[0-9;]*m/g, "").length;
        };

        const redrawLine = async () => {
            await this.redrawCurrentLine();
        };

        const clearMenu = async () => {
            if (compState && compState.linesUsed > 0) {
                const lines = compState.linesUsed;
                await this.std.print("\x1b[B");
                for (let i = 0; i < lines; i++) {
                    await this.std.print("\x1b[2K");
                    if (i < lines - 1) await this.std.print("\x1b[B");
                }
                await this.std.print(`\x1b[${lines}A`);
            }
        };

        while (true) {
            const char = await this.std.getChar();

            // --- INTERACTIVE COMPLETION HANDLING ---
            if (compState && compState.active) {
                if (char === "\t") {
                    compState.selectedIdx = (compState.selectedIdx + 1) % compState.matches.length;
                    await this.renderCandidatesInPlace(compState, this.lineBuffer.length - this.cursor);
                    continue;
                } else if (char === "\u001b") {
                    const next1 = await this.std.getChar();
                    if (next1 === "[") {
                        const next2 = await this.std.getChar();
                        if (next2 === "A") {
                            // Up
                            compState.selectedIdx =
                                (compState.selectedIdx - 1 + compState.matches.length) % compState.matches.length;
                            await this.renderCandidatesInPlace(compState, this.lineBuffer.length - this.cursor);
                            continue;
                        } else if (next2 === "B") {
                            // Down
                            compState.selectedIdx = (compState.selectedIdx + 1) % compState.matches.length;
                            await this.renderCandidatesInPlace(compState, this.lineBuffer.length - this.cursor);
                            continue;
                        } else if (next2 === "C") {
                            // Right
                            const { numRows, matches } = compState;
                            compState.selectedIdx = (compState.selectedIdx + numRows) % matches.length;
                            await this.renderCandidatesInPlace(compState, this.lineBuffer.length - this.cursor);
                            continue;
                        } else if (next2 === "D") {
                            // Left
                            const { numRows, matches } = compState;
                            compState.selectedIdx = (compState.selectedIdx - numRows + matches.length) % matches.length;
                            // Handle wrap around from first chunk to last if needed, though simple modulo usually suffices for column-major
                            if (compState.selectedIdx < 0) {
                                compState.selectedIdx =
                                    (compState.selectedIdx + Math.ceil(matches.length / numRows) * numRows) %
                                    matches.length;
                            }
                            await this.renderCandidatesInPlace(compState, this.lineBuffer.length - this.cursor);
                            continue;
                        }
                    } else {
                        // ESC (Cancel)
                        await clearMenu();
                        compState = null;
                        await redrawLine();
                        continue;
                    }
                } else if (char === "\r" || char === "\n") {
                    // Confirm selection
                    await clearMenu();
                    const selection = compState.matches[compState.selectedIdx];
                    const result = compState.matchResult;

                    const parts = result.originalParts;
                    const newLastPart = (result.dirPath === "." ? "" : result.dirPath) + selection;
                    parts[parts.length - 1] = newLastPart;

                    this.lineBuffer = parts.join(" ");
                    this.cursor = this.lineBuffer.length;

                    compState = null;
                    await redrawLine();
                    continue;
                } else {
                    // Other key -> Cancel menu, handle key normally
                    await clearMenu();
                    compState = null;
                    await redrawLine();
                    // Fallthrough
                }
            }

            // Normal Processing
            if (!char) {
                // EOF (null / empty string dari getChar) — kembalikan buffer apa adanya.
                // Terjadi di mode non-interaktif (harness, pipe) sehingga `read` builtin
                // tidak berputar selamanya.
                return this.lineBuffer;
            } else if (char === "\r" || char === "\n") {
                // Enter
                await this.std.print("\n");
                return this.lineBuffer;
            } else if (char === "\u007f" || char === "\b") {
                // Backspace
                if (this.cursor > 0) {
                    // Remove char at cursor-1
                    this.lineBuffer = this.lineBuffer.slice(0, this.cursor - 1) + this.lineBuffer.slice(this.cursor);
                    this.cursor--;
                    await redrawLine();
                }
            } else if (char === "\u0015") {
                // Ctrl+U
                this.lineBuffer = "";
                this.cursor = 0;
                await redrawLine();
            } else if (char === "\u0003") {
                // Ctrl+C
                await this.std.print("^C\n");
                return ""; // Clear buffer and return empty string
            } else if (char === "\u001b") {
                // ESC Sequence
                const next1 = await this.std.getChar();

                if (next1 === "[") {
                    const next2 = await this.std.getChar();
                    if (next2 === "A") {
                        // Up (History)
                        if (historyPos > 0) {
                            historyPos--;
                            this.lineBuffer = this.history[historyPos];
                            this.cursor = this.lineBuffer.length;
                            await redrawLine();
                        }
                    } else if (next2 === "B") {
                        // Down (History)
                        if (historyPos < this.history.length) {
                            historyPos++;
                            if (historyPos < this.history.length) {
                                this.lineBuffer = this.history[historyPos];
                                this.cursor = this.lineBuffer.length;
                            } else {
                                this.lineBuffer = "";
                                this.cursor = 0;
                            }
                            await redrawLine();
                        }
                    } else if (next2 === "C") {
                        // Right
                        if (this.cursor < this.lineBuffer.length) {
                            this.cursor++;
                            await this.std.print("\x1b[C");
                        }
                    } else if (next2 === "D") {
                        // Left
                        if (this.cursor > 0) {
                            this.cursor--;
                            await this.std.print("\x1b[D");
                        }
                    } else if (next2 === "H") {
                        // Home
                        this.cursor = 0;
                        await redrawLine();
                    } else if (next2 === "F") {
                        // End
                        this.cursor = this.lineBuffer.length;
                        await redrawLine();
                    } else if (next2 === "1") {
                        // Home (some terminals)
                        if ((await this.std.getChar()) === "~") {
                            this.cursor = 0;
                            await redrawLine();
                        }
                    } else if (next2 === "4") {
                        // End (some terminals)
                        if ((await this.std.getChar()) === "~") {
                            this.cursor = this.lineBuffer.length;
                            await redrawLine();
                        }
                    } else if (next2 === "3") {
                        // Delete
                        if ((await this.std.getChar()) === "~") {
                            if (this.cursor < this.lineBuffer.length) {
                                this.lineBuffer =
                                    this.lineBuffer.slice(0, this.cursor) + this.lineBuffer.slice(this.cursor + 1);
                                await redrawLine();
                            }
                        }
                    }
                } else if (next1 === "O") {
                    // ESC O sequence (some terminals)
                    const next2 = await this.std.getChar();
                    if (next2 === "H") {
                        // Home
                        this.cursor = 0;
                        await redrawLine();
                    } else if (next2 === "F") {
                        // End
                        this.cursor = this.lineBuffer.length;
                        await redrawLine();
                    }
                }
            } else if (char === "\t") {
                // TAB (Trigger Completion)
                const result = await this.getCompletionMatches(this.lineBuffer);

                if (result.matches.length === 1) {
                    // Single match
                    const completion = result.matches[0];
                    const parts = result.originalParts;
                    const newLastPart = (result.dirPath === "." ? "" : result.dirPath) + completion;
                    parts[parts.length - 1] = newLastPart;
                    this.lineBuffer = parts.join(" ");
                    this.cursor = this.lineBuffer.length;
                    await redrawLine();
                } else if (result.matches.length > 1) {
                    const commonPrefix = this.getCommonPrefix(result.matches);
                    const lastPart = this.lineBuffer.split(" ").pop() || "";
                    const fileNamePart = lastPart.includes("/")
                        ? lastPart.substring(lastPart.lastIndexOf("/") + 1)
                        : lastPart;

                    if (commonPrefix.length > fileNamePart.length) {
                        // Auto-complete to Common Prefix
                        const parts = result.originalParts;
                        const newLastPart = (result.dirPath === "." ? "" : result.dirPath) + commonPrefix;
                        parts[parts.length - 1] = newLastPart;
                        this.lineBuffer = parts.join(" ");
                        this.cursor = this.lineBuffer.length;
                        await redrawLine();
                    } else {
                        // Activate Interactive Mode
                        compState = {
                            active: true,
                            matches: result.matches,
                            selectedIdx: 0,
                            matchResult: result,
                            linesUsed: 0,
                            numRows: 0,
                            numCols: 0,
                        };

                        // Initial Render
                        await this.renderCandidatesInPlace(compState!, this.lineBuffer.length - this.cursor);
                    }
                }
            } else if (char && char >= " ") {
                // Insert at cursor
                this.lineBuffer = this.lineBuffer.slice(0, this.cursor) + char + this.lineBuffer.slice(this.cursor);
                this.cursor++;
                await this.redrawCurrentLine();
            }
        }
    }

    /**
     * readLogicalLine(): Baca satu PERINTAH LOGIS — mendukung sambung baris (`\`).
     *
     *   root@tsix# netfsd --export /mnt/sbak/ \
     *   > --label databank --port 7777 \
     *   > --key c50f...
     *
     * Semantiknya sama seperti shell Unix: `\` + Enter membuang backslash DAN
     * newline-nya, jadi potongan-potongan itu menjadi SATU perintah (karena itu
     * biasakan menulis spasi SEBELUM `\`). Hanya backslash tunggal di akhir baris
     * yang menyambung; `\\` berarti backslash literal. Prompt lanjutan bisa
     * diubah lewat env `PROMPT2`.
     */
    private async readLogicalLine(prompt: string): Promise<string> {
        const ps2 = (await this.shell.getenv("PROMPT2")) || "\u001b[90m> \u001b[0m";
        let logical = "";
        let depth = 0;

        for (;;) {
            const line = await this.readLine(logical === "" ? prompt : ps2);

            // Baris kosong (Enter polos) atau Ctrl+C → batalkan perintah logis.
            if (line === "") return "";

            const { text, continues } = splitTrailingContinuation(line);
            logical += text;

            if (!continues) return logical;

            depth++;
            if (depth > 128) {
                await this.std.print(`${this.name}: sambung baris terlalu panjang — dibatalkan\n`);
                return "";
            }
        }
    }

    /**
     * detectScript(): Apakah file ini SKRIP SHELL (bukan aplikasi TSIX)?
     *
     *   - `.ts`/`.js` → aplikasi (jalur lama, tidak diubah)
     *   - punya shebang (`#!/bin/tsh`, `#!/bin/sh`) → skrip
     *   - berakhiran `.sh` → skrip (walau tanpa shebang)
     *
     * Sisanya bukan skrip → biarkan kernel yang menentukan (bisa jadi app).
     */
    private async detectScript(path: string): Promise<{ isScript: boolean; interpreter: string | null }> {
        if (/\.(ts|js)$/i.test(path)) return { isScript: false, interpreter: null };

        const content = await this.fs.readFile(path).catch(() => null);
        if (content === null || content === undefined) {
            return { isScript: false, interpreter: null };
        }

        const interpreter = scriptShebang(content);
        if (interpreter) return { isScript: true, interpreter };
        if (/\.sh$/i.test(path)) return { isScript: true, interpreter: null };
        return { isScript: false, interpreter: null };
    }

    /**
     * runScriptCommand(): Jalankan skrip shell dari sebuah perintah.
     *
     * Background (`./skrip.sh &`) di-spawn sebagai subshell `tsh <skrip>` supaya
     * shell tetap responsif; foreground dijalankan di shell yang sama (seperti
     * `source`) agar `cd`/`export`/variabel benar-benar terasa efeknya.
     */
    private async runScriptCommand(
        path: string,
        args: string[],
        opts: {
            stdoutFd?: number;
            redirectPath: string | null;
            isBackground: boolean;
            isPipelinePart: boolean;
        },
    ): Promise<string | { pid: number; name: string }> {
        // Bit eksekusi WAJIB dimiliki skrip — sama seperti Linux. Pemeriksaan
        // ditaruh di sini (bukan hanya di executeSingleCommand) supaya jalur
        // non-interaktif `tsh skrip.sh` juga tidak bisa menembusnya.
        const info = await this.fs.stat(path).catch(() => null);
        if (info && (info.mode & 0o111) === 0) {
            await this.shell.setenv("ERROR_LEVEL", "126");
            await this.shell.setenv("?", "126");
            return `-${this.name}: ${path}: Permission denied (butuh bit x: chmod +x ${path})`;
        }

        if (opts.isBackground) {
            const execResult = await this.shell.exec("/bin/tsh.js", [path, ...args], opts.stdoutFd);
            if (execResult && typeof execResult === "object" && "pid" in execResult) {
                const { pid } = execResult as { pid: number };
                await this.std.print(`[${pid}] ${path} &\n`);
                return { pid, name: path };
            }
            return typeof execResult === "string" ? execResult : "";
        }

        if (this.scriptDepth >= 16) {
            return `-${this.name}: ${path}: skrip bersarang terlalu dalam (maksimum 16)`;
        }

        const savedArgs = this.scriptArgs;
        this.scriptArgs = [path, ...args];

        try {
            return await this.runScriptFile(path);
        } catch (e: any) {
            return `-${this.name}: ${path}: ${e?.message ?? e}`;
        } finally {
            this.scriptArgs = savedArgs;
        }
    }

    /**
     * runScriptFile(): Eksekusi isi skrip di shell yang sedang berjalan.
     *
     * Tiap baris dikirim ke `handleCommand()` — jadi skrip otomatis mewarisi
     * seluruh kemampuan shell (builtin, pipeline, redirection, wildcard, `;`).
     * `exit` di dalam skrip menghentikan sisa barisnya.
     */
    private async runScriptFile(path: string): Promise<string> {
        const content = await this.fs.readFile(path);
        if (content === null || content === undefined) {
            throw new Error("skrip tidak bisa dibaca");
        }

        const commands = parseScriptLines(content);
        if (commands.length === 0) return "";

        this.scriptDepth++;
        const outputs: string[] = [];

        // Evaluator kondisi [ ... ] atau test
        const evaluateCondition = async (condCmd: string): Promise<boolean> => {
            const trimmed = condCmd.trim();

            // Kondisi majemuk: `[ -d /x ] && [ -f /y ]` — dievaluasi rekursif
            // dengan short-circuit, jadi tidak perlu binary `[` untuk `&&`.
            const logicHits = findTopLevelOperators(trimmed, ["&&", "||"]);
            if (logicHits.length > 0) {
                const parts: { text: string; join: "&&" | "||" | null }[] = [];
                let cursor = 0;
                let join: "&&" | "||" | null = null;

                for (const hit of logicHits) {
                    parts.push({ text: trimmed.slice(cursor, hit.index).trim(), join });
                    join = hit.operator as "&&" | "||";
                    cursor = hit.index + hit.operator.length;
                }
                parts.push({ text: trimmed.slice(cursor).trim(), join });

                let value = true;
                for (const part of parts) {
                    const skip = part.join === "&&" ? !value : part.join === "||" ? value : false;
                    if (skip) continue;
                    value = part.text ? await evaluateCondition(part.text) : true;
                }
                return value;
            }

            let body = trimmed;
            let isTest = false;

            if (body.startsWith("[") && body.endsWith("]")) {
                body = body.substring(1, body.length - 1).trim();
                isTest = true;
            } else if (body.startsWith("test ")) {
                body = body.substring(5).trim();
                isTest = true;
            }

            // Tiap operand di-expand SENDIRI (bukan satu string lalu dipecah
            // ulang) supaya `[ "$1" = "" ]` benar-benar membandingkan string
            // kosong, dan `[ "$1" = 'a b' ]` tidak pecah di tengah kutip.
            const rawWords = splitRawWords(body);
            const values: string[] = [];
            for (const raw of rawWords) values.push((await this.expandWord(raw)).value);
            const op = values[1] ?? "";

            if (values.length === 3 && (op === "=" || op === "==")) {
                return values[0] === values[2];
            }
            if (values.length === 3 && op === "!=") {
                return values[0] !== values[2];
            }

            if (values.length === 3 && op.startsWith("-")) {
                const num1 = parseInt(values[0], 10);
                const num2 = parseInt(values[2], 10);
                if (!isNaN(num1) && !isNaN(num2)) {
                    if (op === "-gt") return num1 > num2;
                    if (op === "-lt") return num1 < num2;
                    if (op === "-ge") return num1 >= num2;
                    if (op === "-le") return num1 <= num2;
                    if (op === "-eq") return num1 === num2;
                    if (op === "-ne") return num1 !== num2;
                }
                // Operator aritmetika dengan operand bukan angka → false,
                // jangan jatuh ke `handleCommand()` (hasilnya menyesatkan).
                if (/^-(gt|lt|ge|le|eq|ne)$/.test(op)) return false;
            }

            if (values.length === 2 && (op === "-z" || op === "-n")) {
                return op === "-z" ? values[1] === "" : values[1] !== "";
            }

            if (values.length === 2 && ["-e", "-f", "-d", "-r", "-w", "-x"].includes(op)) {
                const info = await this.fs.stat(values[1]).catch(() => null);
                if (!info) return false;
                if (op === "-e") return true;
                if (op === "-f") return info.type === "FILE";
                if (op === "-d") return info.type === "DIRECTORY";
                if (op === "-r") return (info.mode & 0o444) !== 0;
                if (op === "-w") return (info.mode & 0o222) !== 0;
                return (info.mode & 0o111) !== 0; // -x
            }

            // `[ "$X" ]` → benar bila tidak kosong (hanya untuk test bracket).
            if (isTest && values.length === 1) return values[0] !== "";

            await this.handleCommand(condCmd);
            const exitCode = await this.shell.getenv("?");
            return exitCode === "0";
        };

        const executeBlock = async (cmds: string[]): Promise<void> => {
            let i = 0;
            while (i < cmds.length) {
                if (!this.isRunning) break;
                const cmdStr = cmds[i].trim();

                if (cmdStr === "then" || cmdStr === "do") {
                    i++;
                    continue;
                }

                // 1. BLOK IF / ELIF / ELSE / FI
                if (cmdStr.startsWith("if ") || cmdStr === "if") {
                    let depth = 1;
                    const branches: { conditionCmd: string | null; body: string[] }[] = [];
                    let currentBody: string[] = [];
                    let currentCondition: string | null = cmdStr
                        .replace(/^if\s*/, "")
                        .replace(/;\s*then$/, "")
                        .replace(/\s+then$/, "")
                        .trim();

                    i++;
                    while (i < cmds.length && depth > 0) {
                        const innerCmd = cmds[i].trim();
                        if (innerCmd.startsWith("if ") || innerCmd === "if") depth++;
                        if (innerCmd === "fi") depth--;

                        if (depth === 0) {
                            branches.push({ conditionCmd: currentCondition, body: currentBody });
                            break;
                        }

                        if (depth === 1) {
                            if (innerCmd === "else") {
                                branches.push({ conditionCmd: currentCondition, body: currentBody });
                                currentCondition = null;
                                currentBody = [];
                                i++;
                                continue;
                            } else if (innerCmd.startsWith("elif ")) {
                                branches.push({ conditionCmd: currentCondition, body: currentBody });
                                currentCondition = innerCmd
                                    .substring(5)
                                    .replace(/;\s*then$/, "")
                                    .replace(/\s+then$/, "")
                                    .trim();
                                currentBody = [];
                                i++;
                                continue;
                            }
                        }

                        if (innerCmd !== "then") currentBody.push(innerCmd);
                        i++;
                    }

                    for (const branch of branches) {
                        let isTrue = false;
                        if (branch.conditionCmd === null) {
                            isTrue = true;
                        } else {
                            isTrue = await evaluateCondition(branch.conditionCmd);
                        }

                        if (isTrue) {
                            await executeBlock(branch.body);
                            break;
                        }
                    }
                }
                // 2. BLOK WHILE & FOR
                else if (cmdStr.startsWith("while ") || cmdStr.startsWith("for ")) {
                    const isWhile = cmdStr.startsWith("while ");
                    let depth = 1;
                    const loopBody: string[] = [];

                    i++;
                    while (i < cmds.length && depth > 0) {
                        const innerCmd = cmds[i].trim();

                        // Abaikan baris "do" terpisah agar tidak masuk ke loopBody
                        if (innerCmd === "do") {
                            i++;
                            continue;
                        }

                        if (innerCmd.startsWith("while ") || innerCmd.startsWith("for ")) {
                            depth++;
                        } else if (innerCmd === "done") {
                            depth--;
                        }

                        if (depth === 0) break;

                        loopBody.push(innerCmd);
                        i++;
                    }

                    if (isWhile) {
                        const conditionCmd = cmdStr
                            .substring(6)
                            .replace(/;\s*do$/, "")
                            .replace(/\s+do$/, "")
                            .trim();

                        while (this.isRunning) {
                            const isTrue = await evaluateCondition(conditionCmd);
                            if (!isTrue) break;
                            await executeBlock(loopBody);
                        }
                    } else {
                        // Parsing untuk `for VAR in ITEM1 ITEM2 ...`
                        const cleanFor = cmdStr
                            .replace(/;\s*do$/, "")
                            .replace(/\s+do$/, "")
                            .replace(/;$/, "")
                            .trim();

                        const forWords = splitRawWords(cleanFor);

                        if (forWords.length >= 4 && forWords[2] === "in") {
                            const varName = (await this.expandWord(forWords[1])).value;
                            const items = await this.expandForItems(forWords.slice(3));

                            for (const item of items) {
                                if (!this.isRunning) break;

                                // Pastikan environment tereset untuk variabel loop
                                await this.setEnv(varName, item);

                                // Jalankan isi blok perulangan
                                await executeBlock(loopBody);
                            }
                        }
                    }
                }
                // 3. BLOK CASE ... ESAC
                else if (cmdStr.startsWith("case ") || cmdStr === "case") {
                    const header = cmdStr
                        .replace(/^case\s+/, "")
                        .replace(/;\s*in$/, "")
                        .replace(/\s+in$/, "")
                        .trim();
                    const targetVal = (await this.expandWord(header)).value;

                    let depth = 1;
                    const caseLines: string[] = [];

                    i++;
                    while (i < cmds.length && depth > 0) {
                        const innerCmd = cmds[i].trim();
                        if (innerCmd.startsWith("case ") || innerCmd === "case") {
                            depth++;
                        } else if (innerCmd === "esac") {
                            depth--;
                        }

                        if (depth === 0) break;
                        caseLines.push(innerCmd);
                        i++;
                    }

                    const branches: { patterns: string[]; body: string[] }[] = [];
                    let currentPatterns: string[] | null = null;
                    let currentBody: string[] = [];

                    // Helper: deteksi apakah sebuah baris adalah awalan pola baru `pat)`
                    const isPatternLine = (line: string): boolean => {
                        const t = line.trim();
                        // Pastikan ada ")" dan bagian sebelum ")" tidak mengandung spasi
                        // yang menunjukkan ini adalah perintah biasa, bukan awal pola.
                        const closeIdx = t.indexOf(")");
                        if (closeIdx === -1) return false;
                        const patPart = t.slice(0, closeIdx).trim().replace(/^\(/, "");
                        // Pola tidak boleh mengandung spasi kecuali di antara alternatif `|`
                        return /^[^\s(]+(\s*\|\s*[^\s(]+)*$/.test(patPart);
                    };

                    for (const line of caseLines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed === "in") continue;

                        // `;;` berdiri sendiri → tutup branch saat ini
                        if (trimmed === ";;") {
                            if (currentPatterns !== null) {
                                branches.push({ patterns: currentPatterns, body: currentBody });
                                currentPatterns = null;
                                currentBody = [];
                            }
                            continue;
                        }

                        // Baris berakhir dengan `;;` (inline, misal `echo "x";;`)
                        if (trimmed.endsWith(";;")) {
                            const cmd = trimmed.slice(0, -2).trim();
                            if (currentPatterns !== null) {
                                if (cmd) currentBody.push(cmd);
                                branches.push({ patterns: currentPatterns, body: currentBody });
                                currentPatterns = null;
                                currentBody = [];
                            } else if (isPatternLine(cmd + ")")) {
                                // Edge case: pola inline sekaligus `;;`
                            }
                            continue;
                        }

                        // Deteksi baris pola baru: `N)` atau `pat1 | pat2)`
                        if (isPatternLine(trimmed)) {
                            const closeIdx = trimmed.indexOf(")");
                            // Tutup branch sebelumnya secara implisit (tanpa `;;`)
                            if (currentPatterns !== null) {
                                branches.push({ patterns: currentPatterns, body: currentBody });
                            }
                            const patPart = trimmed.slice(0, closeIdx).trim().replace(/^\(/, "");
                            currentPatterns = patPart.split("|").map((p) => p.trim());
                            currentBody = [];

                            // Ada perintah inline setelah `)` → tambahkan ke body
                            const rest = trimmed.slice(closeIdx + 1).trim();
                            if (rest) {
                                if (rest.endsWith(";;")) {
                                    const cmd = rest.slice(0, -2).trim();
                                    if (cmd) currentBody.push(cmd);
                                    branches.push({ patterns: currentPatterns, body: currentBody });
                                    currentPatterns = null;
                                    currentBody = [];
                                } else {
                                    currentBody.push(rest);
                                }
                            }
                        } else {
                            // Baris biasa → tambahkan ke body branch saat ini
                            if (currentPatterns !== null) {
                                currentBody.push(trimmed);
                            }
                        }
                    }

                    // Flush branch terakhir yang belum ditutup (tanpa `;;`)
                    if (currentPatterns !== null) {
                        branches.push({ patterns: currentPatterns, body: currentBody });
                    }

                    for (const branch of branches) {
                        let matched = false;
                        for (const pat of branch.patterns) {
                            const expandedPat = (await this.expandWord(pat)).value;
                            if (this.matchCasePattern(targetVal, expandedPat)) {
                                matched = true;
                                break;
                            }
                        }
                        if (matched) {
                            await executeBlock(branch.body);
                            break;
                        }
                    }
                }
                // 4. PERINTAH REGULER
                else {
                    const result = await this.handleCommand(cmdStr);
                    if (result) outputs.push(result);
                }
                i++;
            }
        };

        try {
            await executeBlock(commands.map((c) => c.text));
        } finally {
            this.scriptDepth--;
        }

        return outputs.join("\n");
    }

    /**
     * matchCasePattern(): Pencocokan pola shell (wildcard * dan ? atau string persis)
     * untuk pernyataan `case`.
     */
    private matchCasePattern(target: string, pattern: string): boolean {
        if (pattern === "*" || pattern === target) return true;
        if (/[\*\?\[\]]/.test(pattern)) {
            let regStr = "^";
            let inClass = false;
            for (let k = 0; k < pattern.length; k++) {
                const ch = pattern[k];
                if (ch === "*" && !inClass) {
                    regStr += ".*";
                } else if (ch === "?" && !inClass) {
                    regStr += ".";
                } else if (ch === "[" && !inClass) {
                    inClass = true;
                    regStr += "[";
                } else if (ch === "]" && inClass) {
                    inClass = false;
                    regStr += "]";
                } else {
                    regStr += ch.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
                }
            }
            regStr += "$";
            try {
                return new RegExp(regStr).test(target);
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    /**
     * startScriptWaitHint(): Peringatan SEKALI kalau sebuah perintah di dalam
     * SKRIP berjalan lama.
     *
     * Menutup jebakan paling mahal saat boot: perintah interaktif (mis.
     * `/bin/login.js`) atau daemon yang belum selesai start membuat skrip
     * menggantung — dan semua baris SESUDAHNYA tidak pernah dijalankan, tanpa
     * pesan apa pun. Dengan peringatan ini, penyebabnya kelihatan di layar.
     *
     * Hanya aktif di dalam skrip (`scriptDepth > 0`) supaya console interaktif
     * tidak berisik. Ambang bisa diatur lewat env `TSH_WAIT_HINT_MS`
     * (default 15000 ms; 0 = matikan).
     */
    private async startScriptWaitHint(cmd: string): Promise<any> {
        if (this.scriptDepth === 0) return undefined;

        const envMs = await this.env("TSH_WAIT_HINT_MS");
        const timeoutMs = envMs === null || envMs === undefined || envMs === "" ? 15000 : parseInt(envMs, 10);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;

        const timer = setTimeout(() => {
            void this.std.print(
                `\n${this.name}: '${cmd}' masih berjalan setelah ${Math.round(timeoutMs / 1000)}s — ` +
                    `kalau ini daemon, pastikan ia men-daemonize sendiri atau jalankan dengan '&'; ` +
                    `kalau perintah interaktif (mis. /bin/login.js), jangan dipakai di dalam skrip.\n`,
            );
        }, timeoutMs);
        (timer as any)?.unref?.();
        return timer;
    }

    private async redrawCurrentLine() {
        if (!this.std) return;
        await this.std.print("\r" + this.currentPrompt + this.lineBuffer + "\x1b[K");

        if (this.lineBuffer.length > this.cursor) {
            await this.std.print(`\x1b[${this.lineBuffer.length - this.cursor}D`);
        }
    }

    private async redrawPrompt(prompt: string, buffer: string) {
        await this.std.print(prompt + buffer);
    }

    private getCommonPrefix(strings: string[]): string {
        if (!strings.length) return "";
        let prefix = strings[0];
        for (let i = 1; i < strings.length; i++) {
            while (strings[i].indexOf(prefix) !== 0) {
                prefix = prefix.substring(0, prefix.length - 1);
                if (prefix === "") return "";
            }
        }
        return prefix;
    }

    private async renderCandidatesInPlace(state: CompletionState, distFromEnd: number = 0) {
        if (state.linesUsed > 0) {
            await this.std.print("\x1b[B");
            for (let i = 0; i < state.linesUsed; i++) {
                await this.std.print("\x1b[2K");
                if (i < state.linesUsed - 1) await this.std.print("\x1b[B");
            }
            await this.std.print(`\x1b[${state.linesUsed}A`);
        }

        const matches = state.matches;
        const maxLen = Math.max(...matches.map((m) => m.length)) + 2;
        const numCols = Math.max(1, Math.floor(this.columns / maxLen));
        const numRows = Math.ceil(matches.length / numCols);

        state.numRows = numRows;
        state.numCols = numCols;

        let output = "";
        for (let r = 0; r < numRows; r++) {
            let line = "";
            for (let c = 0; c < numCols; c++) {
                const idx = c * numRows + r;
                if (idx < matches.length) {
                    let item = matches[idx].padEnd(maxLen);
                    if (idx === state.selectedIdx) {
                        item = `\x1b[7m${item}\x1b[0m`; // Inverse Video
                    }
                    line += item;
                }
            }
            output += "\n\r" + line.trimEnd();
        }

        await this.std.print(output);
        state.linesUsed = numRows;

        // Return to position
        await this.std.print(`\r\x1b[${numRows}A`);

        await this.std.print("\x1b[999C");
        if (distFromEnd > 0) {
            await this.std.print(`\x1b[${distFromEnd}D`);
        }
    }

    private async getCompletionMatches(partial: string): Promise<{
        matches: string[];
        commonBase: string;
        originalParts: string[];
        dirPath: string;
    }> {
        const parts = partial.split(" ");
        const cmd = parts[0];
        const lastWord = parts[parts.length - 1];
        const lastSlash = lastWord.lastIndexOf("/");
        const isCD = cmd === "cd";

        // --- COMMAND NAME COMPLETION ---
        // Kata dianggap sebagai nama command (bukan file) ketika:
        //   1. Kata pertama (perintah utama), kecuali `cd`
        //   2. Argumen kedua untuk command yang menerima nama command,
        //      mis. `sudo euc<TAB>` atau `which euc<TAB>`
        const isCommandSlot =
            (parts.length === 1 && !isCD && lastSlash === -1) ||
            (["sudo", "which"].includes(cmd) && parts.length === 2 && lastSlash === -1);

        // Directory lookup + prefix tampilan untuk rebuild line.
        // `displayDir` dipakai menyusun ulang line (biar `~` tetap `~`),
        // `searchDir` dipakai untuk fs.ls (sudah di-expand $HOME).
        let searchDir = ".";
        let filePrefix = lastWord;
        let displayDir = ".";
        if (lastSlash !== -1) {
            const rawDir = lastWord.substring(0, lastSlash + 1);
            filePrefix = lastWord.substring(lastSlash + 1);
            displayDir = rawDir;
            searchDir = await this.expandTilde(rawDir);
        } else if (lastWord === "~" && !isCommandSlot) {
            // `cd ~<TAB>` → tampilkan isi home
            const home = (await this.shell.getenv("HOME")) || "/root";
            displayDir = "~/";
            searchDir = home + "/";
            filePrefix = "";
        }

        let candidates: string[] = [];
        if (isCommandSlot) {
            candidates.push(...(await this.completeCommandName(lastWord)));
        }

        try {
            const files = await this.fs.ls(searchDir);
            files.forEach((f: any) => {
                const name = f.name;
                const isDir = f.type === "DIRECTORY";
                if (isCD && !isDir) return;
                if (name.startsWith(filePrefix)) {
                    // Do NOT strip extensions for direct file lookups (Argument mode or Local Command)
                    // This allows disambiguation between .ts and .js files
                    const cleanName = name;
                    let suffix = isDir ? "/" : " ";
                    candidates.push(cleanName + suffix);
                }
            });
        } catch (e) {}
        candidates = [...new Set(candidates)];
        candidates.sort();
        return {
            matches: candidates,
            commonBase: displayDir,
            originalParts: parts,
            dirPath: displayDir,
        };
    }

    /**
     * Expand `~` atau `~/...` ke $HOME untuk lookup file system.
     * (Prefix `~/` tetap dipertahankan di sisi tampilan oleh displayDir.)
     */
    private async expandTilde(p: string): Promise<string> {
        const home = (await this.shell.getenv("HOME")) || "/root";
        if (p === "~") return home + "/";
        if (p.startsWith("~/")) return home + p.substring(1);
        return p;
    }

    /**
     * Kumpulkan kandidat nama command yang cocok dengan prefix:
     * builtin shell + semua executable di direktori PATH.
     * Ekstensi .js/.ts di-strip supaya completion bersih (mis. `eucalyptus`).
     */
    private async completeCommandName(lastWord: string): Promise<string[]> {
        const result: string[] = [];
        const builtIns = ["cd", "exit", "help", "version", "export", "echo", "history", "read"];
        builtIns.forEach((b) => {
            if (b.startsWith(lastWord)) result.push(b + " ");
        });
        const pathEnv = (await this.shell.getenv("PATH")) || "/bin";
        const dirs = pathEnv.split(":");
        for (const dir of dirs) {
            try {
                const files = await this.fs.ls(dir);
                files.forEach((f: any) => {
                    if (f.name.startsWith(lastWord) && f.type === "FILE") {
                        // Strip .js and .ts for clean command completion
                        const cleanName = f.name.replace(/\.(js|ts)$/, "");
                        result.push(cleanName + " ");
                    }
                });
            } catch (e) {}
        }
        return result;
    }

    private async loadHistory() {
        const home = (await this.shell.getenv("HOME")) || "/root";
        const historyPath = home + "/.sh_history";

        try {
            const fileContent = await this.fs.readFile(historyPath);
            if (fileContent && typeof fileContent === "string") {
                this.history = fileContent.split("\n").filter((line) => line.trim().length > 0);
            }
        } catch (e) {
            // History file might not exist yet, ignore.
        }
    }

    private async sourceProfile() {
        // Source system-wide profile
        try {
            const profile = await this.fs.readFile("/etc/profile");
            if (profile) {
                const lines = profile
                    .split("\n")
                    .map((l) => l.trim())
                    .filter((l) => l && !l.startsWith("#"));
                for (const line of lines) {
                    if (line.startsWith("export ")) {
                        const rest = line.substring(7); // remove "export "
                        const eqIdx = rest.indexOf("=");
                        if (eqIdx > 0) {
                            const name = rest.substring(0, eqIdx).trim();
                            const value = rest.substring(eqIdx + 1).trim();
                            await this.shell.setenv(name, value);
                        }
                    } else if (line.startsWith("echo ")) {
                        const msg = line.substring(5).replace(/^["']|["']$/g, "");
                        await this.std.print(msg + "\n");
                    }
                }
            }
        } catch (e) {
            /* no /etc/profile */
        }

        // Source user profile (~/.tsixrc)
        try {
            const home = (await this.shell.getenv("HOME")) || "/root";
            const rcFile = await this.fs.readFile(home + "/.tsixrc");
            if (rcFile) {
                const lines = rcFile
                    .split("\n")
                    .map((l) => l.trim())
                    .filter((l) => l && !l.startsWith("#"));
                for (const line of lines) {
                    if (line.startsWith("export ")) {
                        const rest = line.substring(7);
                        const eqIdx = rest.indexOf("=");
                        if (eqIdx > 0) {
                            const name = rest.substring(0, eqIdx).trim();
                            const value = rest.substring(eqIdx + 1).trim();
                            await this.shell.setenv(name, value);
                        }
                    } else if (line.startsWith("echo ")) {
                        const msg = line.substring(5).replace(/^["']|["']$/g, "");
                        await this.std.print(msg + "\n");
                    }
                }
            }
        } catch (e) {
            /* no ~/.tsixrc */
        }
    }

    private async addToHistory(cmd: string) {
        if (!cmd) return;

        // Strict Dedupe (erasedups): Remove ALL previous occurrences
        this.history = this.history.filter((h) => h !== cmd);

        this.history.push(cmd);
        await this.saveHistory();
    }

    private async saveHistory(newCmd?: string) {
        const home = (await this.shell.getenv("HOME")) || "/root";
        const historyPath = home + "/.sh_history";

        try {
            // Rewrite the entire file to ensure it matches our clean, deduped memory buffer
            const newContent = this.history.join("\n") + "\n";
            await this.fs.writeFile(historyPath, newContent);
        } catch (e) {
            // Fail silently
        }
    }

    private async handleBuiltinHistory(args: string[]): Promise<string> {
        if (args[0] === "--clear" || args[0] === "-c") {
            this.history = [];
            await this.saveHistory();
            return "";
        }

        if (this.history.length === 0) return "";
        return this.history.map((line, i) => `  ${i + 1}  ${line}`).join("\n");
    }

    private async handleCommand(input: string): Promise<string> {
        const trimmedInput = input.trim();
        if (!trimmedInput) return "";

        // Multi-command: pisah `;` TAPI hormati tanda kutip & escape —
        // `echo "a; b"` harus tetap satu perintah.
        const commands = splitTopLevel(trimmedInput, [";"]);
        let finalOutput = "";

        for (const rawCmd of commands) {
            const output = await this.runConditionalChain(rawCmd);
            if (output) {
                if (finalOutput) finalOutput += "\n";
                finalOutput += output;
            }
        }

        return finalOutput;
    }

    /**
     * runConditionalChain(): Rantai `&&` / `||` dengan short-circuit seperti
     * shell Unix.
     *
     * Dipisah dari `;` karena prioritasnya berbeda: `a | b && c` berarti
     * `(a | b) && c` — pipeline dievaluasi lebih dulu. `cmd1 || cmd2` hanya
     * menjalankan `cmd2` kalau `cmd1` gagal, dan sebaliknya untuk `&&`.
     */
    private async runConditionalChain(chain: string): Promise<string> {
        const hits = findTopLevelOperators(chain, ["&&", "||"]);
        const segments: { cmd: string; join: "&&" | "||" | null }[] = [];
        let cursor = 0;
        let join: "&&" | "||" | null = null;

        for (const hit of hits) {
            segments.push({ cmd: chain.slice(cursor, hit.index).trim(), join });
            join = hit.operator as "&&" | "||";
            cursor = hit.index + hit.operator.length;
        }
        segments.push({ cmd: chain.slice(cursor).trim(), join });

        let exitCode = 0;
        let output = "";

        for (let index = 0; index < segments.length; index++) {
            const segment = segments[index];
            const skip = segment.join === "&&" ? exitCode !== 0 : segment.join === "||" ? exitCode === 0 : false;
            // Yang di-skip tidak mengubah `$?` — sama seperti shell Unix.
            if (skip) continue;
            if (!segment.cmd) {
                exitCode = 0;
                continue;
            }

            const result = await this.runSimpleCommand(segment.cmd);
            if (result) {
                if (output) output += "\n";
                output += result;
            }

            // `$?` hanya perlu dibaca kalau masih ada segmen lanjutan yang
            // keputusannya bergantung padanya — menghemat 1 round-trip IPC
            // untuk perintah biasa (tanpa `&&`/`||`).
            if (index < segments.length - 1) {
                const code = parseInt((await this.shell.getenv("?")) ?? "0", 10);
                exitCode = Number.isFinite(code) ? code : 0;
            }
        }

        return output;
    }

    /** Satu perintah: modifier `*` (timing), pipeline `|`, atau perintah tunggal. */
    private async runSimpleCommand(input: string): Promise<string> {
        let cmd = input.trim();
        if (!cmd) return "";

        let isTimed = false;
        // Handle timing modifier per command
        if (cmd.startsWith("*")) {
            isTimed = true;
            cmd = cmd.substring(1).trim();
        }
        // Ensure we don't execute empty command after stripping *
        if (!cmd) return "";

        const start = Date.now();
        await this.shell.setenv("LAST_COMMAND", cmd);

        let result = "";
        // Deteksi Pipeline (|) — hanya `|` di luar tanda kutip.
        if (splitTopLevel(cmd, ["|"]).length > 1) {
            result = await this.executePipeline(cmd);
        } else {
            const execResult = await this.executeSingleCommand(cmd);
            result = typeof execResult === "string" ? execResult : "";
        }

        if (isTimed) {
            const end = Date.now();
            result += `\nTime execution: ${end - start}ms.`;
        }

        return result;
    }

    private async executePipeline(input: string): Promise<string> {
        // `|` di dalam tanda kutip bukan pemisah (`echo "a|b"` satu perintah).
        const stages = splitTopLevel(input, ["|"]);
        if (stages.length < 2) return "";
        let lastStdinFd: number | undefined = undefined;
        let lastPid: number | undefined = undefined;
        const pipelinePids: number[] = [];

        for (let i = 0; i < stages.length; i++) {
            const isLast = i === stages.length - 1;
            let currentStdoutFd: number | undefined = undefined;
            let nextReadFd: number | undefined = undefined;

            if (!isLast) {
                // Create pipe
                const [readFd, writeFd] = await this.shell.pipe();
                currentStdoutFd = writeFd;
                nextReadFd = readFd;
            }

            // Execute command part
            const result = await this.executeSingleCommand(stages[i], lastStdinFd, currentStdoutFd, false, true);

            // Cleanup FDs in shell process
            if (lastStdinFd !== undefined) await this.fs.close(lastStdinFd);
            if (currentStdoutFd !== undefined) await this.fs.close(currentStdoutFd);

            // If it returned a PID (as a string or object), track it
            if (typeof result === "object" && "pid" in result) {
                lastPid = (result as any).pid;
            }

            lastStdinFd = nextReadFd;
            if (lastPid) pipelinePids.push(lastPid);
        }

        // Wait for ALL processes in the pipeline
        let lastExitCode = 0;
        for (const pid of pipelinePids) {
            lastExitCode = await this.shell.waitpid(pid);
        }
        await this.shell.setenv("ERROR_LEVEL", lastExitCode.toString());
        await this.shell.setenv("?", lastExitCode.toString());

        return "";
    }

    private async executeSingleCommand(
        input: string,
        externalStdinFd?: number,
        externalStdoutFd?: number,
        forceBackground?: boolean,
        isPipelinePart: boolean = false,
    ): Promise<string | { pid: number; name: string }> {
        let trimmedInput = input.trim();
        if (!trimmedInput) return "";

        // 1. Deteksi Background (&) — hanya `&` di luar tanda kutip & di akhir.
        let isBackground = forceBackground || false;
        const ampHits = findTopLevelOperators(trimmedInput, ["&"]);
        if (ampHits.length > 0 && ampHits[ampHits.length - 1].index === trimmedInput.length - 1) {
            isBackground = true;
            trimmedInput = trimmedInput.slice(0, -1).trim();
        }

        // 2. Deteksi Redirection (> dan >>) — `>` di dalam kutipan adalah teks
        //    biasa, jadi `echo "a > b"` TIDAK menulis file (dulu tertukar).
        let stdoutFd: number | undefined = externalStdoutFd;
        let redirectPath: string | null = null;

        const redir = findTopLevelOperator(trimmedInput, [">>", ">"]);
        if (redir) {
            const isAppend = redir.operator === ">>";
            const rawPath = trimmedInput.slice(redir.index + redir.operator.length).trim();
            trimmedInput = trimmedInput.slice(0, redir.index).trim();

            if (!rawPath) {
                await this.shell.setenv("ERROR_LEVEL", "2");
                await this.shell.setenv("?", "2");
                return `-${this.name}: syntax error: redirection tanpa nama file`;
            }

            const target = await this.expandWord(rawPath);
            redirectPath = await this.expandTildeOnly(target.value);

            try {
                if (stdoutFd !== undefined) await this.fs.close(stdoutFd);
                // "a" untuk append (>>), "w" untuk write/overwrite (>)
                stdoutFd = await this.fs.open(redirectPath, isAppend ? "a" : "w");
            } catch (e: any) {
                return `-${this.name}: ${redirectPath}: ${e.message}`;
            }
        }

        // 3. Parse Command and Arguments — tokenizer yang paham kutip & escape
        //    (`splitRawWords`), lalu tiap kata di-expand satu pass.
        let rawWords = splitRawWords(trimmedInput);
        if (rawWords.length === 0) {
            // `> file` tanpa perintah: file sudah di-truncate, tutup fd-nya.
            if (redirectPath && stdoutFd !== undefined) await this.fs.close(stdoutFd);
            return "";
        }

        // 3a. Penugasan variabel tanpa `export`: `VAR=nilai` dan bentuk prefix
        //     `VAR=nilai perintah`. Tanpa ini, `i=0` dicari sebagai binary dan
        //     gagal dengan "command not found" — padahal gaya ini dipakai di
        //     hampir semua skrip (penghitung loop, dsb.).
        const assignment = rawWords[0].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
        if (assignment) {
            await this.setEnv(assignment[1], (await this.expandWord(assignment[2])).value);

            if (rawWords.length === 1) {
                await this.shell.setenv("ERROR_LEVEL", "0");
                await this.shell.setenv("?", "0");
                if (stdoutFd !== undefined && (redirectPath || !isPipelinePart)) await this.fs.close(stdoutFd);
                return "";
            }

            // Sisa kata setelah `VAR=nilai` dijalankan sebagai perintah biasa
            // (`VAR=nilai perintah arg`), jadi buang kata penugasan itu.
            rawWords = rawWords.slice(1);
        }

        const cmd = (await this.expandWord(rawWords[0])).value;
        if (!cmd) return "";

        const args = await this.expandWords(rawWords.slice(1));

        let result = "";
        let commandFound = true;

        let exitCode = 0;
        // Output builtin yang istimewa: `echo -n` (tanpa newline) dan output
        // kosong yang tetap harus dicetak (`echo ""` → satu baris kosong).
        let emitNoNewline = false;
        let alwaysEmit = false;
        // 4. Handle Built-ins
        if (cmd === "help") {
            result =
                "Available commands: cd, exit, export, version, help, history, read, ps, whoami\n" +
                "Skrip    : ./skrip.sh [args]        — butuh bit x (`chmod +x skrip.sh`)\n" +
                "           tsh skrip.sh [args]     — non-interaktif (cron/rc.local/background)\n" +
                "           di skrip: $0, $1..$9, $@, $#, komentar '#', '\\' untuk sambung baris\n" +
                "           kontrol: if/elif/else, for, while, case, $(...), &&/||, VAR=nilai\n" +
                "Builtin  : waitfile <path> [ms]     — tunggu file muncul (kesiapan daemon)\n" +
                "           read [-p prompt] [VAR]   — baca input dari TTY/user\n" +
                "Console  : akhiri baris dengan '\\' lalu Enter untuk menyambung perintah";
            exitCode = 0;
        } else if (cmd === "cd") {
            const target = args[0] || "/";
            try {
                const success = await this.shell.chdir(target);
                if (!success) {
                    result = `-${this.name}: cd: ${target}: No such file or directory`;
                    exitCode = 1;
                } else {
                    this.cachedCwd = null; // cwd berubah → cache prompt dibuang
                    exitCode = 0;
                }
            } catch (e: any) {
                result = `-${this.name}: cd: ${target}: ${e.message || "Permission denied"}`;
                exitCode = 1;
            }
        } else if (cmd === "version") {
            result = "TSIX v0.1.0 (Dinawari)";
            exitCode = 0;
        } else if (cmd === "export") {
            if (args.length === 0) {
                result = "Usage: export NAME=VALUE";
                exitCode = 1;
            } else {
                const pair = args[0].split("=");
                if (pair.length === 2) {
                    await this.setEnv(pair[0], pair[1]);
                    exitCode = 0;
                } else {
                    exitCode = 1;
                }
            }
        } else if (cmd === "waitfile") {
            // Tunggu sampai sebuah file muncul — pengganti polling manual di skrip
            // (mis. DOME menulis /var/run/dome.ready sebelum Asteracea boleh start).
            if (args.length === 0) {
                result = "Usage: waitfile <path> [timeout_ms]";
                exitCode = 1;
            } else {
                const waitTarget = args[0];
                const parsedTimeout = args[1] ? parseInt(args[1], 10) : 10000;
                const waitMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 10000;
                const deadline = Date.now() + waitMs;
                let appeared = false;

                for (;;) {
                    const found = await this.fs.stat(waitTarget).catch(() => null);
                    if (found) {
                        appeared = true;
                        break;
                    }
                    if (Date.now() >= deadline) break;
                    await new Promise((r) => setTimeout(r, 200));
                }

                if (appeared) {
                    exitCode = 0;
                } else {
                    result = `-${this.name}: waitfile: ${waitTarget} tidak muncul dalam ${waitMs}ms`;
                    exitCode = 1;
                }
            }
        } else if (cmd === "echo") {
            // ECHO adalah builtin, bukan /bin/echo.js.
            //
            // Di TSIX tiap binary eksternal = satu Worker + V8 isolate baru
            // (puluhan milidetik, belasan MB). `echo` adalah perintah paling
            // sering ada di skrip (puluhan kali di satu skrip saja), jadi
            // men-spawn proses untuk mencetak satu baris adalah pemborosan
            // terbesar di jalur skrip. Perilakunya sama dengan /bin/echo:
            // `-n` tanpa newline, tanpa argumen → satu baris kosong.
            let noNewline = false;
            const words: string[] = [];
            for (const arg of args) {
                if (arg === "-n") noNewline = true;
                else words.push(arg);
            }
            result = words.join(" ");
            emitNoNewline = noNewline;
            alwaysEmit = true;
            exitCode = 0;
        } else if (cmd === "pwd") {
            result = await this.getCwd();
            exitCode = 0;
        } else if (cmd === "expr" || cmd === "true" || cmd === "false" || cmd === ":") {
            if (cmd === "true" || cmd === ":") {
                exitCode = 0;
            } else if (cmd === "false") {
                exitCode = 1;
            } else if (args.length === 3) {
                // `expr` bukan binary di TSIX; dulu hanya jalan di dalam `$(...)`.
                const computed = this.evalExpr(args[1], parseInt(args[0], 10), parseInt(args[2], 10));
                if (computed === null) {
                    result = `-${this.name}: expr: ekspresi tidak didukung`;
                    exitCode = 2;
                } else {
                    result = computed;
                    // Sama seperti `expr` Unix: hasil 0 atau kosong → exit 1.
                    exitCode = computed === "0" || computed === "" ? 1 : 0;
                }
            } else {
                result = `-${this.name}: expr: gunakan: expr <angka> <op> <angka>`;
                exitCode = 2;
            }
        } else if (cmd === "read") {
            let promptStr = "";
            const varNames: string[] = [];
            let idx = 0;
            while (idx < args.length) {
                const arg = args[idx];
                if (arg === "-p" && idx + 1 < args.length) {
                    promptStr = args[idx + 1];
                    idx += 2;
                } else if (arg.startsWith("-p")) {
                    promptStr = arg.substring(2);
                    idx++;
                } else if (arg.startsWith("-")) {
                    idx++;
                } else {
                    varNames.push(arg);
                    idx++;
                }
            }
            if (varNames.length === 0) {
                varNames.push("REPLY");
            }

            if (promptStr) {
                await this.std.print(promptStr);
            }
            const inputLine = await this.std.readLine();
            const lineVal = inputLine ?? "";
            if (varNames.length === 1) {
                await this.setEnv(varNames[0], lineVal);
            } else {
                const words = lineVal.trim().split(/\s+/);
                for (let vIdx = 0; vIdx < varNames.length; vIdx++) {
                    if (vIdx === varNames.length - 1) {
                        const rest = words.slice(vIdx).join(" ");
                        await this.setEnv(varNames[vIdx], rest);
                    } else {
                        await this.setEnv(varNames[vIdx], words[vIdx] || "");
                    }
                }
            }
            exitCode = 0;
        } else if (cmd === "history") {
            result = await this.handleBuiltinHistory(args);
            exitCode = 0;
        } else if (cmd === "exit") {
            result = "Goodbye!";
            this.isRunning = false;
            await this.shell.exit();
            exitCode = 0;
        } else {
            commandFound = false;
        }

        // Jika built-in dijalankan dan ada redirection/pipe
        if (commandFound) {
            await this.shell.setenv("ERROR_LEVEL", exitCode.toString());
            await this.shell.setenv("?", exitCode.toString());

            const hasOutput = result !== "" || alwaysEmit;
            const payload = result + (emitNoNewline ? "" : "\n");

            if (stdoutFd !== undefined) {
                if (hasOutput) await this.fs.write(stdoutFd, payload);
                // Only close if it was a redirection or we are NOT in a pipeline
                // (pipeline handles its own FD management)
                if (redirectPath || !isPipelinePart) {
                    await this.fs.close(stdoutFd);
                }
                return "";
            }

            // Di dalam `$(...)` output harus DIKEMBALIKAN (ditangkap pemanggil).
            if (this.captureDepth > 0) return result;

            // Di luar itu output ditulis SEKARANG, bukan dikembalikan ke
            // pemanggil: kalau dibuffer, output builtin baru muncul di akhir
            // skrip dan urutannya kacau terhadap binary eksternal yang
            // mencetak langsung ke TTY.
            if (hasOutput) await this.std.print(payload);
            return "";
        }

        // 5. Handle External Binaries
        const binPath = await this.resolveBinary(cmd);
        if (!binPath) {
            if (redirectPath && stdoutFd !== undefined) await this.fs.close(stdoutFd);
            await this.shell.setenv("ERROR_LEVEL", "127");
            await this.shell.setenv("?", "127");
            return `-${this.name}: ${cmd}: command not found`;
        }

        try {
            // Check execution permission
            const stat = await this.fs.stat(binPath);
            if (stat && (stat.mode & 0x49) === 0) {
                if (redirectPath && stdoutFd !== undefined) await this.fs.close(stdoutFd);
                await this.shell.setenv("ERROR_LEVEL", "126");
                await this.shell.setenv("?", "126");
                return `-${this.name}: ${binPath}: Permission denied`;
            }

            // --- SKRIP SHELL (.sh / ber-shebang) ---
            // Dijalankan di shell yang sama (seperti `source`) supaya `cd`, `export`,
            // dan variabel tetap terasa — inilah yang membuat perintah panjang cukup
            // disimpan sekali lalu dipanggil `./start-netfs.sh`.
            const script = await this.detectScript(binPath);
            if (script.isScript) {
                if (script.interpreter && !isKnownShell(script.interpreter)) {
                    if (redirectPath && stdoutFd !== undefined) await this.fs.close(stdoutFd);
                    await this.shell.setenv("ERROR_LEVEL", "126");
                    await this.shell.setenv("?", "126");
                    return `-${this.name}: ${binPath}: interpreter tidak didukung: ${script.interpreter}`;
                }

                const scriptOutput = await this.runScriptCommand(binPath, args, {
                    stdoutFd,
                    redirectPath,
                    isBackground: !!isBackground,
                    isPipelinePart,
                });

                // Skrip di background sudah di-spawn sebagai subshell → kembalikan
                // { pid } apa adanya supaya pemanggil bisa waitpid.
                if (typeof scriptOutput !== "string") return scriptOutput;

                // Foreground: output diperlakukan sama seperti output builtin —
                // ditulis ke fd bila ada redirection/pipe, kalau tidak ke pemanggil.
                if (stdoutFd !== undefined) {
                    if (scriptOutput) await this.fs.write(stdoutFd, scriptOutput + "\n");
                    if (redirectPath || !isPipelinePart) await this.fs.close(stdoutFd);
                    return "";
                }
                return scriptOutput;
            }

            // Jalankan binary dengan meneruskan stdinFd dan stdoutFd
            const execResult = await this.shell.exec(binPath, args, stdoutFd, externalStdinFd);

            if (execResult && typeof execResult === "object" && "pid" in execResult) {
                const { pid } = execResult as { pid: number };

                if (isBackground) {
                    await this.std.print(`[${pid}] Execution started &\n`);
                    if (redirectPath && stdoutFd !== undefined) await this.fs.close(stdoutFd);
                    return `[1] ${pid}`;
                }

                if (isPipelinePart) {
                    return { pid, name: cmd };
                }

                // Foreground: Wait for process
                this.foregroundPid = pid;
                const waitHint = await this.startScriptWaitHint(cmd);
                const exitCode = await this.shell.waitpid(pid);
                if (waitHint) clearTimeout(waitHint);
                this.foregroundPid = null;
                await this.shell.setenv("ERROR_LEVEL", exitCode.toString());
                await this.shell.setenv("?", exitCode.toString());

                if (redirectPath && stdoutFd !== undefined) await this.fs.close(stdoutFd);
                return "";
            }

            if (redirectPath && stdoutFd !== undefined) await this.fs.close(stdoutFd);
            return typeof execResult === "string" ? execResult : "";
        } catch (e: any) {
            if (redirectPath && stdoutFd !== undefined) await this.fs.close(stdoutFd);
            await this.shell.setenv("ERROR_LEVEL", "1");
            await this.shell.setenv("?", "1");
            return `-${this.name}: ${cmd}: ${e.message}`;
        }
    }

    /**
     * expandWord(): Ekspansi SATU kata shell dalam satu pass — kutip, escape,
     * variabel, dan `$(...)`.
     *
     * Satu pass itu penting: `\$VAR` harus jadi literal `$VAR`, sedangkan
     * `\\$VAR` harus jadi `\` diikuti NILAI VAR. Kalau escape dan ekspansi
     * dipisah jadi dua langkah, keduanya sudah tidak bisa dibedakan lagi.
     */
    private async expandWord(raw: string): Promise<ExpandedWord> {
        // Jalur cepat: tanpa karakter istimewa → apa adanya (shell itu hot path).
        if (!/[$'"\\]/.test(raw)) return { value: raw, literal: false };

        let out = "";
        let quote: string | null = null;
        let literal = false;

        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i];

            // Di dalam '...' tidak ada yang istimewa: `$`, `\`, dan `"` semuanya teks.
            if (quote === "'") {
                if (ch === "'") quote = null;
                else out += ch;
                continue;
            }

            if (ch === "\\") {
                const next = raw[i + 1];
                if (next === undefined) {
                    out += ch;
                    continue;
                }
                if (quote === '"') {
                    // Di dalam "..." hanya `$`, `` ` ``, `"`, dan `\` yang di-escape.
                    if ('$`"\\'.includes(next)) {
                        out += next;
                        i++;
                        literal = true;
                    } else {
                        out += ch;
                    }
                    continue;
                }
                out += next;
                i++;
                literal = true;
                continue;
            }

            if (ch === '"' || ch === "'") {
                if (quote === ch) {
                    quote = null;
                } else if (quote === null) {
                    quote = ch;
                    literal = true;
                } else {
                    out += ch;
                }
                continue;
            }

            if (ch === "$") {
                const dollar = await this.expandDollar(raw, i);
                if (dollar) {
                    out += dollar.value;
                    i += dollar.length - 1;
                    continue;
                }
            }

            out += ch;
        }

        return { value: out, literal };
    }

    /**
     * expandWords(): Ekspansi daftar kata MENTAH (hasil `splitRawWords`) menjadi
     * argumen final. Tilde & wildcard hanya berlaku untuk kata yang tidak
     * dikutip/di-escape — `"*"` dan `'~'` dibiarkan apa adanya.
     */
    private async expandWords(rawWords: string[]): Promise<string[]> {
        const expanded: string[] = [];
        let home: string | null = null;

        for (const raw of rawWords) {
            const word = await this.expandWord(raw);

            if (word.literal) {
                expanded.push(word.value);
                continue;
            }

            let processed = word.value;
            if (processed === "~" || processed.startsWith("~/")) {
                // `getenv` = 1 round-trip IPC: ambil HOME hanya saat ada `~`.
                if (home === null) home = (await this.env("HOME")) || "/root";
                processed = processed === "~" ? home : home + processed.substring(1);
            }

            if (processed.includes("*")) {
                const matches = await this.expandWildcard(processed);
                if (matches.length > 0) {
                    expanded.push(...matches);
                    continue;
                }
            }
            expanded.push(processed);
        }

        return expanded;
    }

    /**
     * expandForItems(): Daftar item untuk `for VAR in ...`.
     *
     * `$@`/`$*` dipecah menjadi satu item per argumen skrip (seperti Unix),
     * dan wildcard yang tidak dikutip di-glob — jadi `for f in /bin/*.js`
     * dan `for a in $@` benar-benar mengulang.
     */
    private async expandForItems(rawWords: string[]): Promise<string[]> {
        const items: string[] = [];

        for (const raw of rawWords) {
            if (raw === "$@" || raw === "$*" || raw === '"$@"' || raw === '"$*"') {
                items.push(...this.scriptArgs.slice(1));
                continue;
            }

            // 1. Jalankan ekspansi kata bawaan kamu terlebih dahulu
            const expandedWords = await this.expandWords([raw]);

            // 2. Lakukan pengecekan pola range {start..end} untuk setiap hasil ekspansi
            for (const word of expandedWords) {
                // Regex untuk mendeteksi pola {angka..angka} atau {huruf..huruf}
                const match = word.match(/^\{(-?\d+)\.\.(-?\d+)\}$|^\{([a-zA-Z])\.\.([a-zA-Z])\}$/);

                if (match) {
                    if (match[1] !== undefined && match[2] !== undefined) {
                        // Kasus Range Angka: contoh {1..5} atau {5..1}
                        const start = parseInt(match[1], 10);
                        const end = parseInt(match[2], 10);
                        const step = start <= end ? 1 : -1;

                        for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
                            items.push(n.toString());
                        }
                    } else if (match[3] !== undefined && match[4] !== undefined) {
                        // Kasus Range Huruf: contoh {a..e} atau {Z..A}
                        const startCharCode = match[3].charCodeAt(0);
                        const endCharCode = match[4].charCodeAt(0);
                        const step = startCharCode <= endCharCode ? 1 : -1;

                        for (
                            let code = startCharCode;
                            step > 0 ? code <= endCharCode : code >= endCharCode;
                            code += step
                        ) {
                            items.push(String.fromCharCode(code));
                        }
                    }
                } else {
                    // Jika bukan pola range, masukkan kata normal seperti biasa
                    items.push(word);
                }
            }
        }

        return items;
    }

    // private async expandForItems(rawWords: string[]): Promise<string[]> {
    //     const items: string[] = [];

    //     for (const raw of rawWords) {
    //         if (raw === "$@" || raw === "$*" || raw === '"$@"' || raw === '"$*"') {
    //             items.push(...this.scriptArgs.slice(1));
    //             continue;
    //         }
    //         items.push(...(await this.expandWords([raw])));
    //     }

    //     return items;
    // }

    /**
     * expandDollar(): Ekspansi satu token `$...` mulai dari indeks `start`.
     * Return null kalau `$` bukan awal ekspansi yang dikenal (`$` literal).
     */
    private async expandDollar(text: string, start: number): Promise<{ value: string; length: number } | null> {
        const rest = text.slice(start);

        // $(perintah) — substitusi perintah, boleh bersarang.
        if (rest.startsWith("$(")) {
            const end = this.findClosingParen(rest, 2);
            if (end === -1) return null;
            return { value: await this.runCommandSubstitution(rest.slice(2, end)), length: end + 1 };
        }

        // ${VAR}
        const braced = rest.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/);
        if (braced) {
            return { value: await this.lookupVariable(braced[1]), length: braced[0].length };
        }

        // $VAR, $1, $@, $#, $?, $*
        const plain = rest.match(/^\$([a-zA-Z_][a-zA-Z0-9_]*|[0-9]+|[@#?*])/);
        if (plain) {
            return { value: await this.lookupVariable(plain[1]), length: plain[0].length };
        }

        return null;
    }

    /** Cari indeks `)` pasangan untuk `$(` (sadar sarang & tanda kutip). */
    private findClosingParen(text: string, start: number): number {
        let depth = 1;
        let quote: string | null = null;

        for (let i = start; i < text.length; i++) {
            const ch = text[i];

            if (ch === "\\" && quote !== "'") {
                i++;
                continue;
            }
            if (quote) {
                if (ch === quote) quote = null;
                continue;
            }
            if (ch === "'" || ch === '"') {
                quote = ch;
                continue;
            }
            if (ch === "(") depth++;
            else if (ch === ")") {
                depth--;
                if (depth === 0) return i;
            }
        }

        return -1;
    }

    /**
     * runCommandSubstitution(): Jalankan isi `$(...)` dan kembalikan outputnya.
     *
     * Catatan: hanya perintah yang output-nya DIKEMBALIKAN ke shell (builtin
     * seperti `version`/`history`, atau `expr` di bawah) yang bisa ditangkap;
     * binary eksternal mencetak langsung ke TTY sehingga hasilnya kosong.
     */
    private async runCommandSubstitution(inner: string): Promise<string> {
        const cmd = inner.trim();
        if (!cmd) return "";

        const words = splitRawWords(cmd);

        // `expr` sering dipakai di skrip dan bukan binary di TSIX → hitung langsung.
        if (words[0] === "expr") {
            const exprParts = await this.expandWords(words.slice(1));
            if (exprParts.length === 3) {
                const n1 = parseInt(exprParts[0], 10);
                const n2 = parseInt(exprParts[2], 10);
                const op = exprParts[1];
                if (!isNaN(n1) && !isNaN(n2)) {
                    if (op === "-") return String(n1 - n2);
                    if (op === "+") return String(n1 + n2);
                    if (op === "*") return String(n1 * n2);
                    if (op === "/") return n2 === 0 ? "" : String(Math.trunc(n1 / n2));
                    if (op === "%") return n2 === 0 ? "" : String(n1 % n2);
                }
            }
        }

        const output = await this.handleCommand(cmd);
        return typeof output === "string" ? output.trim() : "";
    }

    /** Nilai variabel shell: argumen posisional, `$@`, `$#`, `$?`, atau env. */
    private async lookupVariable(name: string): Promise<string> {
        if (/^[0-9]+$/.test(name)) return this.scriptArgs[Number(name)] ?? "";
        if (name === "@" || name === "*") return this.scriptArgs.slice(1).join(" ");
        if (name === "#") return String(Math.max(this.scriptArgs.length - 1, 0));
        return (await this.env(name)) ?? "";
    }

    /** Expand `~` / `~/...` untuk path yang bukan argumen biasa (mis. target `>`). */
    private async expandTildeOnly(value: string): Promise<string> {
        const home = (await this.env("HOME")) || "/root";
        if (value === "~") return home;
        if (value.startsWith("~/")) return home + value.substring(1);
        return value;
    }

    /**
     * env(): Baca env dengan cache untuk nama yang dibaca ULANG tiap perintah
     * (PATH/HOME/TSH_WAIT_HINT_MS). `?`, `ERROR_LEVEL`, dan nama lain selalu
     * dibaca langsung — nilai itu harus selalu segar.
     */
    private async env(name: string): Promise<string | null> {
        if (!CACHED_ENV.has(name)) return await this.shell.getenv(name);

        if (!this.envCache.has(name)) {
            this.envCache.set(name, await this.shell.getenv(name));
        }
        return this.envCache.get(name) ?? null;
    }

    /** setEnv(): jalur tulis env milik shell — sekaligus membuang cache-nya. */
    private async setEnv(name: string, value: string): Promise<void> {
        await this.shell.setenv(name, value);
        this.envCache.delete(name);
    }

    /** getCwd(): cwd di-cache; satu-satunya pengubahnya adalah builtin `cd`. */
    private async getCwd(): Promise<string> {
        if (this.cachedCwd === null) this.cachedCwd = await this.shell.getcwd();
        return this.cachedCwd;
    }

    /**
     * resolveBinary(): Cari binary/skrip untuk sebuah kata perintah.
     *
     * Hasil POSITIF di-memo (`binCache`): satu lookup = 1–3 syscall `stat`
     * (round-trip IPC), padahal perintah yang sama dipanggil berulang di skrip
     * dan di prompt. Kegagalan TIDAK di-cache supaya file yang baru dibuat
     * langsung ketemu; cache dibuang saat `PATH` diubah.
     */
    private async resolveBinary(cmd: string): Promise<string | null> {
        const cached = this.binCache.get(cmd);
        if (cached !== undefined) return cached;

        const found = await this.resolveBinaryUncached(cmd);
        if (found !== null) this.binCache.set(cmd, found);
        return found;
    }

    private async resolveBinaryUncached(cmd: string): Promise<string | null> {
        // If it contains a slash, it's a direct path
        if (cmd.includes("/")) {
            try {
                const info = await this.fs.stat(cmd);
                if (info && info.type === "FILE") return cmd;
            } catch (e) {}

            // Bila user menulis path TANPA ekstensi atau berakhiran .ts, utamakan
            // sidecar .js yang sudah ter-transpile — worker target jadi tidak perlu
            // preload transpiler (+14.4 MB RSS). Fallback .ts tetap ada.
            const baseNoExt = cmd.replace(/\.ts$/, "");
            for (const candidate of [baseNoExt + ".js", baseNoExt + ".ts"]) {
                if (candidate === cmd) continue;
                try {
                    const info = await this.fs.stat(candidate);
                    if (info && info.type === "FILE") return candidate;
                } catch (e) {}
            }
            return null;
        }

        // Otherwise search ONLY in PATH
        const pathVal = (await this.env("PATH")) || "/bin";
        const dirs = pathVal.split(":");

        for (const dir of dirs) {
            const baseFullPath = (dir.endsWith("/") ? dir + cmd : dir + "/" + cmd).replace(/\/+/g, "/");
            try {
                const info = await this.fs.stat(baseFullPath);
                if (info && info.type === "FILE") return baseFullPath;
            } catch (e) {}

            // Priority: .js (Direct) > .ts (Transpile)
            const extensions = [".js", ".ts"];
            for (const ext of extensions) {
                try {
                    const altPath = baseFullPath + ext;
                    if (baseFullPath.endsWith(ext)) continue;
                    const infoAlt = await this.fs.stat(altPath);
                    if (infoAlt && infoAlt.type === "FILE") return altPath;
                } catch (e) {}
            }
        }
        return null;
    }

    private async expandWildcard(pattern: string): Promise<string[]> {
        const cwd = await this.shell.getcwd();
        const isAbsolute = pattern.startsWith("/");
        const absolutePattern = isAbsolute ? pattern : cwd === "/" ? "/" + pattern : cwd + "/" + pattern;

        const parts = absolutePattern.split("/");
        const fileNamePattern = parts.pop() || "";
        const dirPath = parts.join("/") || "/";

        // Calculate relative prefix from the pattern if not absolute
        let relativePrefix = "";
        if (!isAbsolute) {
            const patternParts = pattern.split("/");
            patternParts.pop();
            relativePrefix = patternParts.join("/");
        }

        try {
            const files = await this.fs.ls(dirPath);
            if (!files || files.length === 0) return [];

            const regexStr = "^" + fileNamePattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
            const regex = new RegExp(regexStr);

            const matches = files
                .filter((f: any) => regex.test(f.name))
                .sort((a: any, b: any) => a.name.localeCompare(b.name))
                .map((f: any) => {
                    if (isAbsolute) {
                        return (dirPath.endsWith("/") ? dirPath + f.name : dirPath + "/" + f.name).replace(/\/+/g, "/");
                    } else {
                        return relativePrefix
                            ? relativePrefix.endsWith("/")
                                ? relativePrefix + f.name
                                : relativePrefix + "/" + f.name
                            : f.name;
                    }
                });

            return matches;
        } catch (e) {
            return [];
        }
    }
}
