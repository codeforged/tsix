import { IProgram, OSContext } from "@tsix/IProgram";
import { StdLib, FsLib, ShellLib } from "@tsix/UserLib";

interface CompletionState {
  active: boolean;
  matches: string[];
  selectedIdx: number;
  matchResult: { commonBase: string; originalParts: string[]; dirPath: string };
  linesUsed: number;
  numRows: number;
  numCols: number;
}

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

  constructor() {}

  async execute(lib: OSContext, args: string[]): Promise<string> {
    this.std = lib.std;
    this.fs = lib.fs;
    this.shell = lib.shell;
    const userInfo = await this.shell.whoami();
    this.user = userInfo.username;
    const hostnameEnv = await this.shell.getenv("HOSTNAME");
    if (hostnameEnv) this.hostname = hostnameEnv;

    // --- CLI ARGUMENT HANDLING ---
    if (args.includes("-v") || args.includes("--version")) {
      await lib.std.print(`TSIX Shell v${this.version} (Dinawari)\n`);
      return `Shell version ${this.version}`;
    }

    // --- CLI ARGUMENT HANDLING: shell <username> → login as that user ---
    const targetUser = args.find((a) => !a.startsWith("-"));
    if (targetUser && targetUser !== this.user) {
      // Delegate to login with username as argument
      // login is SetUID root, so it can authenticate and switch users
      const loginResult = await this.shell.exec("/bin/login.js", [targetUser]);
      if (
        loginResult &&
        typeof loginResult === "object" &&
        "pid" in loginResult
      ) {
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

    (lib as any).onEvent(
      "resize",
      async (data: { lines: number; columns: number }) => {
        this.rows = data.lines;
        this.columns = data.columns;
        await this.shell.setenv("LINES", data.lines.toString());
        await this.shell.setenv("COLUMNS", data.columns.toString());
      },
    );

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
      const input = await this.readLine(prompt);

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
    let format =
      (await this.shell.getenv("PROMPT_FORMAT")) ||
      "&username@&hostname:&cwd&usertype ";
    const cwd = await this.shell.getcwd();
    const userInfo = await this.shell.whoami();
    const isRoot = userInfo.uid === 0;

    const userColor = "\u001b[36m"; // Cyan
    const hostColor = "\u001b[32m"; // Green
    const dirColor = "\u001b[33m"; // Yellow
    const accentColor = "\u001b[30m"; // Black
    const typeColor = isRoot ? "\u001b[31m" : "\u001b[32m"; // Red for root #, Black for others
    const reset = "\u001b[0m";

    const userType = isRoot ? `${typeColor}#${reset}` : `${typeColor}$${reset}`;

    let prompt = format
      .replace("&username", `${userColor}${this.user}${reset}`)
      .replace(
        "@&hostname",
        `${accentColor}@${reset}${hostColor}${this.hostname}${reset}`,
      )
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
          compState.selectedIdx =
            (compState.selectedIdx + 1) % compState.matches.length;
          await this.renderCandidatesInPlace(
            compState,
            this.lineBuffer.length - this.cursor,
          );
          continue;
        } else if (char === "\u001b") {
          const next1 = await this.std.getChar();
          if (next1 === "[") {
            const next2 = await this.std.getChar();
            if (next2 === "A") {
              // Up
              compState.selectedIdx =
                (compState.selectedIdx - 1 + compState.matches.length) %
                compState.matches.length;
              await this.renderCandidatesInPlace(
                compState,
                this.lineBuffer.length - this.cursor,
              );
              continue;
            } else if (next2 === "B") {
              // Down
              compState.selectedIdx =
                (compState.selectedIdx + 1) % compState.matches.length;
              await this.renderCandidatesInPlace(
                compState,
                this.lineBuffer.length - this.cursor,
              );
              continue;
            } else if (next2 === "C") {
              // Right
              const { numRows, matches } = compState;
              compState.selectedIdx =
                (compState.selectedIdx + numRows) % matches.length;
              await this.renderCandidatesInPlace(
                compState,
                this.lineBuffer.length - this.cursor,
              );
              continue;
            } else if (next2 === "D") {
              // Left
              const { numRows, matches } = compState;
              compState.selectedIdx =
                (compState.selectedIdx - numRows + matches.length) %
                matches.length;
              // Handle wrap around from first chunk to last if needed, though simple modulo usually suffices for column-major
              if (compState.selectedIdx < 0) {
                compState.selectedIdx =
                  (compState.selectedIdx +
                    Math.ceil(matches.length / numRows) * numRows) %
                  matches.length;
              }
              await this.renderCandidatesInPlace(
                compState,
                this.lineBuffer.length - this.cursor,
              );
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
          const newLastPart =
            (result.dirPath === "." ? "" : result.dirPath) + selection;
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
      if (char === "\r" || char === "\n") {
        // Enter
        await this.std.print("\n");
        return this.lineBuffer;
      } else if (char === "\u007f" || char === "\b") {
        // Backspace
        if (this.cursor > 0) {
          // Remove char at cursor-1
          this.lineBuffer =
            this.lineBuffer.slice(0, this.cursor - 1) +
            this.lineBuffer.slice(this.cursor);
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
                  this.lineBuffer.slice(0, this.cursor) +
                  this.lineBuffer.slice(this.cursor + 1);
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
          const newLastPart =
            (result.dirPath === "." ? "" : result.dirPath) + completion;
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
            const newLastPart =
              (result.dirPath === "." ? "" : result.dirPath) + commonPrefix;
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
            await this.renderCandidatesInPlace(
              compState!,
              this.lineBuffer.length - this.cursor,
            );
          }
        }
      } else if (char && char >= " ") {
        // Insert at cursor
        this.lineBuffer =
          this.lineBuffer.slice(0, this.cursor) +
          char +
          this.lineBuffer.slice(this.cursor);
        this.cursor++;
        await this.redrawCurrentLine();
      }
    }
  }

  private async redrawCurrentLine() {
    if (!this.std) return;
    await this.std.print(
      "\r" + this.currentPrompt + this.lineBuffer + "\x1b[K",
    );

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

  private async renderCandidatesInPlace(
    state: CompletionState,
    distFromEnd: number = 0,
  ) {
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

  private async getCompletionMatches(
    partial: string,
  ): Promise<{
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
      (["sudo", "which"].includes(cmd) &&
        parts.length === 2 &&
        lastSlash === -1);

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
    const builtIns = [
      "cd",
      "exit",
      "help",
      "version",
      "export",
      "echo",
      "history",
    ];
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
        this.history = fileContent
          .split("\n")
          .filter((line) => line.trim().length > 0);
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
    let trimmedInput = input.trim();
    if (!trimmedInput) return "";

    // Multi-command support: Split by ; but respect double quotes
    // This regex matches chunks of non-separator/non-quote characters AND quoted strings
    const commands = trimmedInput.match(/(?:[^;"]+|"[^"]*")+/g) || [];
    let finalOutput = "";
    for (const rawCmd of commands) {
      let cmd = rawCmd.trim();
      if (!cmd) continue;

      let isTimed = false;
      // Handle timing modifier per command
      if (cmd.startsWith("*")) {
        isTimed = true;
        cmd = cmd.substring(1).trim();
      }
      // Ensure we don't execute empty command after stripping *
      if (!cmd) continue;

      const start = Date.now();
      let result = "";
      await this.shell.setenv("LAST_COMMAND", cmd);
      // 0. Deteksi Pipeline (|)
      // Note: Simple split. Doesn't handle pipes inside quotes for now.
      if (cmd.includes("|")) {
        result = await this.executePipeline(cmd);
      } else {
        const execResult = await this.executeSingleCommand(cmd);
        result = typeof execResult === "string" ? execResult : "";
      }

      // Append result
      if (result) {
        if (finalOutput) finalOutput += "\n";
        finalOutput += result;
      }

      if (isTimed) {
        const end = Date.now();
        const timing = `\nTime execution: ${end - start}ms.`;
        finalOutput += timing;
      }
    }

    return finalOutput;
  }

  private async executePipeline(input: string): Promise<string> {
    const stages = input.split("|").map((s) => s.trim());
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
      const result = await this.executeSingleCommand(
        stages[i],
        lastStdinFd,
        currentStdoutFd,
        false,
        true,
      );

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

    // 1. Deteksi Background (&)
    let isBackground = forceBackground || false;
    if (trimmedInput.endsWith("&")) {
      isBackground = true;
      trimmedInput = trimmedInput.slice(0, -1).trim();
    }

    // 2. Deteksi Redirection (>) - Redirection overrides pipeline pipe
    let stdoutFd: number | undefined = externalStdoutFd;
    let redirectPath: string | null = null;
    if (trimmedInput.includes(">")) {
      const redirParts = trimmedInput.split(">");
      trimmedInput = redirParts[0].trim();
      redirectPath = redirParts[1].trim();

      try {
        // If we already had a pipeline pipe, close it as we are overriding it
        if (stdoutFd !== undefined) await this.fs.close(stdoutFd);

        // Buka/buat file tujuan redirection dengan flag "w" (Write)
        stdoutFd = await this.fs.open(redirectPath, "w");
      } catch (e: any) {
        return `-${this.name}: ${redirectPath}: ${e.message}`;
      }
    }

    // 3. Parse Command and Arguments (handle double AND single quotes)
    const parts = trimmedInput.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const cmd = parts[0];
    if (!cmd) return "";

    const rawArgs = parts.slice(1).map((arg) => {
      const isDoubleQuoted = arg.startsWith('"') && arg.endsWith('"');
      const isSingleQuoted = arg.startsWith("'") && arg.endsWith("'");
      return {
        text: isDoubleQuoted
          ? arg.substring(1, arg.length - 1)
          : isSingleQuoted
            ? arg.substring(1, arg.length - 1)
            : arg,
        quoted: isDoubleQuoted || isSingleQuoted,
      };
    });
    const args = await this.expandArguments(rawArgs);

    let result = "";
    let commandFound = true;

    let exitCode = 0;
    // 4. Handle Built-ins
    if (cmd === "help") {
      result =
        "Available commands: cd, exit, export, version, help, history, ps, whoami";
      exitCode = 0;
    } else if (cmd === "cd") {
      const target = args[0] || "/";
      try {
        const success = await this.shell.chdir(target);
        if (!success) {
          result = `-${this.name}: cd: ${target}: No such file or directory`;
          exitCode = 1;
        } else {
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
          await this.shell.setenv(pair[0], pair[1]);
          exitCode = 0;
        } else {
          exitCode = 1;
        }
      }
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
      if (stdoutFd !== undefined) {
        if (result) await this.fs.write(stdoutFd, result + "\n");
        // Only close if it was a redirection or we are NOT in a pipeline
        // (pipeline handles its own FD management)
        if (redirectPath || !isPipelinePart) {
          await this.fs.close(stdoutFd);
        }
        return "";
      }
      return result;
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
        if (redirectPath && stdoutFd !== undefined)
          await this.fs.close(stdoutFd);
        await this.shell.setenv("ERROR_LEVEL", "126");
        await this.shell.setenv("?", "126");
        return `-${this.name}: ${binPath}: Permission denied`;
      }

      // Jalankan binary dengan meneruskan stdinFd dan stdoutFd
      const execResult = await this.shell.exec(
        binPath,
        args,
        stdoutFd,
        externalStdinFd,
      );

      if (execResult && typeof execResult === "object" && "pid" in execResult) {
        const { pid } = execResult as { pid: number };

        if (isBackground) {
          await this.std.print(`[${pid}] Execution started &\n`);
          if (redirectPath && stdoutFd !== undefined)
            await this.fs.close(stdoutFd);
          return `[1] ${pid}`;
        }

        if (isPipelinePart) {
          return { pid, name: cmd };
        }

        // Foreground: Wait for process
        this.foregroundPid = pid;
        const exitCode = await this.shell.waitpid(pid);
        this.foregroundPid = null;
        await this.shell.setenv("ERROR_LEVEL", exitCode.toString());
        await this.shell.setenv("?", exitCode.toString());

        if (redirectPath && stdoutFd !== undefined)
          await this.fs.close(stdoutFd);
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

  private async expandArguments(
    rawArgs: { text: string; quoted: boolean }[],
  ): Promise<string[]> {
    let expanded: string[] = [];
    const home = (await this.shell.getenv("HOME")) || "/root";

    for (const arg of rawArgs) {
      let processed = arg.text;

      if (!arg.quoted) {
        processed = await this.expandVariables(arg.text);
      }

      if (arg.quoted) {
        expanded.push(processed);
        continue;
      }

      if (processed === "~") processed = home;
      else if (processed.startsWith("~/"))
        processed = home + processed.substring(1);

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

  private async expandVariables(text: string): Promise<string> {
    const regex = /\$([a-zA-Z0-9_]+|\?)/g;
    let result = text;
    const matches = text.matchAll(regex);
    for (const match of matches) {
      const varName = match[1];
      const value = (await this.shell.getenv(varName)) || "";
      result = result.replace(match[0], value);
    }
    return result;
  }

  private async resolveBinary(cmd: string): Promise<string | null> {
    // If it contains a slash, it's a direct path
    if (cmd.includes("/")) {
      try {
        const info = await this.fs.stat(cmd);
        if (info && info.type === "FILE") return cmd;
      } catch (e) {}

      try {
        const tsPath = cmd + ".ts";
        const infoTs = await this.fs.stat(tsPath);
        if (infoTs && infoTs.type === "FILE") return tsPath;
      } catch (e) {}
      return null;
    }

    // Otherwise search ONLY in PATH
    const pathVal = (await this.shell.getenv("PATH")) || "/bin";
    const dirs = pathVal.split(":");

    for (const dir of dirs) {
      const baseFullPath = (
        dir.endsWith("/") ? dir + cmd : dir + "/" + cmd
      ).replace(/\/+/g, "/");
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
    const absolutePattern = isAbsolute
      ? pattern
      : cwd === "/"
        ? "/" + pattern
        : cwd + "/" + pattern;

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

      const regexStr =
        "^" + fileNamePattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
      const regex = new RegExp(regexStr);

      const matches = files
        .filter((f: any) => regex.test(f.name))
        .sort((a: any, b: any) => a.name.localeCompare(b.name))
        .map((f: any) => {
          if (isAbsolute) {
            return (
              dirPath.endsWith("/") ? dirPath + f.name : dirPath + "/" + f.name
            ).replace(/\/+/g, "/");
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
