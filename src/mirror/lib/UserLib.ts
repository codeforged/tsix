import { SyscallCode } from "../../common/SyscallCode";
import { parentPort } from "worker_threads";
import { SyscallRequest, SyscallResponse } from "../../common/IPCTypes";
import { v4 as uuidv4 } from "uuid";
import { DbLib } from "./DbLib";
import { NetworkLib } from "./NetworkLib";

/**
 * USER LIBRARY (lib) - WORKER VERSION
 *
 * Semacam 'libc' di Linux atau 'msvcrt' di Windows.
 * Gunanya membungkus Syscall yang ribet jadi fungsi yang manusiawi.
 */
export class UserLib {
  private version: string = "1.2.20260830.1";
  private pid: number;
  private responseMap: Map<string, (res: SyscallResponse) => void> = new Map();
  private eventListeners: Map<string, ((data: any) => void)[]> = new Map();
  private signalListeners: Map<string, (() => void)[]> = new Map();

  // Sub-Libraries
  public std: StdLib;
  public fs: FsLib;
  public shell: ShellLib;
  public net: NetworkLib;
  public db: DbLib;
  public pty: PtyLib;
  public keyboard: KeyboardLib;

  constructor(pid: number) {
    this.pid = pid;
    // Mendengarkan balasan dari Kernel via parentPort
    if (parentPort) {
      parentPort.on("message", (msg: any) => {
        // 1. Cek apakah ini Balasan Syscall
        if (msg.requestId && this.responseMap.has(msg.requestId)) {
          const resolve = this.responseMap.get(msg.requestId)!;
          resolve(msg as SyscallResponse);
          this.responseMap.delete(msg.requestId);
        }
        // 2. Cek apakah ini Event (Push Notification)
        else if (
          msg.type &&
          msg.type !== "signal" &&
          this.eventListeners.has(msg.type)
        ) {
          const callbacks = this.eventListeners.get(msg.type)!;
          callbacks.forEach((cb) => cb(msg.data));
        }
        // 3. Handling Signal (SIGINT/SIGTERM) dengan default action
        else if (msg.type === "signal") {
          const sig = msg.data;
          const listeners = this.signalListeners.get(sig);
          let handled = false;

          if (listeners && listeners.length > 0) {
            listeners.forEach((l) => l());
            handled = true;
          }

          // Backward compatibility untuk eventListeners "signal"
          if (this.eventListeners.has("signal")) {
            this.eventListeners.get("signal")!.forEach((cb) => cb(sig));
            handled = true;
          }

          if (!handled && (sig === "SIGINT" || sig === "SIGTERM")) {
            // Linux-style default behavior: Terminate
            // Kita kasih delay sangat kecil supaya onSignal punya kesempatan daftar
            setTimeout(() => this.shell.exit(sig === "SIGINT" ? 130 : 143), 10);
          }
        }
      });
    }

    // Inisialisasi Sub-Libraries
    this.std = new StdLib(this.dispatch.bind(this));
    this.fs = new FsLib(this.dispatch.bind(this));
    this.shell = new ShellLib(this.dispatch.bind(this), this.pid);
    this.net = new NetworkLib(this.dispatch.bind(this));
    this.db = new DbLib(this.dispatch.bind(this));
    this.pty = new PtyLib(this.dispatch.bind(this));
    this.keyboard = new KeyboardLib(this.std);

    // Inject parent reference
    (this.std as any)._lib = this;
    (this.fs as any)._lib = this;
    (this.shell as any)._lib = this;
    (this.net as any)._lib = this;
    (this.db as any)._lib = this;
    (this.pty as any)._lib = this;
    (this.keyboard as any)._lib = this;
  }

  /**
   * dispatch(): Jembatan utama untuk mengirim "Surat" ke Kernel.
   */
  private async dispatch(code: SyscallCode, args: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = uuidv4();
      const request: SyscallRequest = { requestId, pid: this.pid, code, args };

      this.responseMap.set(requestId, (response: SyscallResponse) => {
        if (response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response.error || "Syscall Failed"));
        }
      });

      if (parentPort) {
        parentPort.postMessage(request);
      } else {
        reject(new Error("No parentPort found! Are you running in a Worker?"));
      }
    });
  }

  public getPid(): number {
    return this.pid;
  }

  public async getParentPid(): Promise<number> {
    return await this.dispatch(SyscallCode.GET_PPID, null);
  }

  /**
   * onEvent(): Mendaftarkan listener untuk event asinkron dari kernel.
   */
  public onEvent(type: string, callback: (data: any) => void) {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, []);
    }
    this.eventListeners.get(type)!.push(callback);
  }

  /**
   * offEvent(): Hapus listener tertentu (dipakai request-response sekali-pakai).
   */
  public offEvent(type: string, callback: (data: any) => void) {
    const arr = this.eventListeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(callback);
    if (idx >= 0) arr.splice(idx, 1);
    if (arr.length === 0) this.eventListeners.delete(type);
  }

  public getLibVersion(): string {
    return this.version;
  }
}

/**
 * STANDARD I/O LIBRARY (std)
 */
export class StdLib {
  private inputBuffer: string = "";
  private stdinFd: number = 0; // Default stdin is FD 0

  constructor(
    private dispatch: (code: SyscallCode, args: any) => Promise<any>,
  ) {}

  public setStdin(fd: number) {
    this.stdinFd = fd;
    this.inputBuffer = ""; // Clear buffer when switching source
  }

  public async sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
  public async millis(): Promise<number> {
    return await this.dispatch(SyscallCode.UPTIME, null);
  }

  public async print(text: string) {
    return await this.dispatch(SyscallCode.PRINT, text);
  }

  public async println(text: string = "") {
    return await this.print(text + "\n");
  }

  public async abc(text: string = "") {
    return await this.print("ABC " + text + "\n");
  }

  public async readLine(): Promise<string | null> {
    // Standard line reading logic - handle both \n and \r
    while (true) {
      const nlIdx = this.inputBuffer.indexOf("\n");
      const crIdx = this.inputBuffer.indexOf("\r");

      // Find the earliest terminator
      let termIdx = -1;
      if (nlIdx !== -1 && crIdx !== -1) termIdx = Math.min(nlIdx, crIdx);
      else if (nlIdx !== -1) termIdx = nlIdx;
      else if (crIdx !== -1) termIdx = crIdx;

      if (termIdx !== -1) {
        const line = this.inputBuffer.substring(0, termIdx);
        // Consume the terminator (and the next char if it's \n after \r)
        let consumeLen = 1;
        if (
          this.inputBuffer[termIdx] === "\r" &&
          this.inputBuffer[termIdx + 1] === "\n"
        ) {
          consumeLen = 2;
        }
        this.inputBuffer = this.inputBuffer.substring(termIdx + consumeLen);
        return line;
      }

      const data = await this.dispatch(SyscallCode.READ, this.stdinFd);
      if (data !== null && data !== "FD NOT FOUND") {
        if (data === "") return null; // EOF
        this.inputBuffer += data;
      } else {
        // Idle poll: 150ms (~7x/detik) — nilai tervalidasi (CPU ~0.4%).
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }

  public async getScreenInfo() {
    return await this.dispatch(SyscallCode.SCREEN_INFO, null);
  }

  public async ioctl(fd: number, cmd: number, arg: any) {
    return await this.dispatch(SyscallCode.IOCTL, { fd, cmd, arg });
  }

  public async uname(): Promise<{
    sysname: string;
    distroname: string;
    codename: string;
    version: string;
    machine: string;
    runtime: string;
    engine: string;
  }> {
    return await this.dispatch(SyscallCode.UNAME, null);
  }

  public async setRawMode(enable: boolean) {
    // Use the currently active stdin FD
    return await this.ioctl(this.stdinFd, 10, enable); // 10 = SET_RAW_MODE
  }

  /**
   * Standard centralized logging for TSIX applications.
   * Writes to /var/log/syslog (virtual FS).
   */
  public async log(message: string, context?: string) {
    const timestamp = new Date()
      .toISOString()
      .replace("T", " ")
      .substring(0, 19);
    const prefix = context ? ` [${context}]` : "";
    const logLine = `[${timestamp}]${prefix} ${message.trim()} \n`;
    const logDir = "/var/log";
    const logFile = `${logDir}/syslog`;

    try {
      await (this as any)._lib.fs.mkdir(logDir);
    } catch (e) {}

    try {
      const fd = await (this as any)._lib.fs.open(logFile, "a");
      if (fd >= 0) {
        await (this as any)._lib.fs.write(fd, logLine);
        await (this as any)._lib.fs.close(fd);
      }
    } catch (e) {}
  }

  /**
   * error(): Standard centralized error logging untuk TSIX applications.
   *
   * Selain nge-log ke /var/log/syslog (spt log()), error()
   * juga broadcast pesan ke parent process (Window Manager) via IPC
   * agar WM bisa menampilkan error popup di layar desktop.
   *
   * Usage:
   *   await std.error("Disk full", "myapp");
   *   await std.error("Connection timeout", "net", app.wid);
   *
   * @param message - Pesan error
   * @param context - Konteks (opsional, untuk syslog tag)
   * @param wid     - Window ID (opsional, dikirim ke WM untuk identifikasi)
   */
  public async error(message: string, context?: string, wid?: string) {
    const timestamp = new Date()
      .toISOString()
      .replace("T", " ")
      .substring(0, 19);
    const prefix = context ? ` [${context}]` : "";
    const logLine = `[${timestamp}] [ERROR]${prefix} ${message.trim()} \n`;

    // 1. Log ke /var/log/syslog
    try {
      await (this as any)._lib.fs.mkdir("/var/log");
      const fd = await (this as any)._lib.fs.open("/var/log/syslog", "a");
      if (fd >= 0) {
        await (this as any)._lib.fs.write(fd, logLine);
        await (this as any)._lib.fs.close(fd);
      }
    } catch (e) {
      /* syslog write failure is non-fatal */
    }

    // 2. Cari fileHint dari stack trace untuk identifikasi sumber error
    let fileHint = "";
    try {
      const stack = new Error().stack;
      if (stack) {
        const lines = stack.split("\n");
        // Cari baris pertama yg bukan library internal
        const re = /[(\s]([^\s()]+\.(?:ts|js))(?::\d+){1,2}/;
        for (const l of lines) {
          const m = l.match(re);
          if (!m) continue;
          const p = m[1].replace(/\\/g, "/");
          if (
            p.includes("UserLib") ||
            p.includes("Application") ||
            p.includes("emerald")
          )
            continue;
          // Hapus drive letter Windows (D:/ → /)
          const clean = p.replace(/^[A-Za-z]:\//, "/");
          fileHint = clean.split("/").slice(-3).join("/");
          break;
        }
      }
    } catch (_) {
      /* ignore */
    }

    // 3. Broadcast ke parent process (WM) via IPC — dengan fileHint
    try {
      const lib = (this as any)._lib as UserLib;
      const parentPid = await lib.getParentPid();
      if (parentPid) {
        await lib.shell.send(parentPid, {
          type: "GUI_WINDOW_ERROR",
          wid: wid || "",
          pid: lib.getPid(),
          file: fileHint,
          error: message,
          context: context || "",
          timestamp,
        });
      }
    } catch (e) {
      /* IPC send failure is non-fatal */
    }

    // 4. Print ke TTY (stderr style)
    try {
      await this.print(`\x1b[31m[ERROR]\x1b[0m ${message}`);
      await this.print("\n");
    } catch (e) {
      /* TTY print failure is non-fatal */
    }
  }

  /**
   * poll(): Non-destructive peek at the first character in the buffer.
   * Attempt to read from kernel if buffer is empty.
   */
  public async poll(): Promise<string | null> {
    if (this.inputBuffer.length > 0) return this.inputBuffer[0];

    const data = await this.dispatch(SyscallCode.READ, this.stdinFd);
    if (data !== null && data !== "FD NOT FOUND") {
      if (data === "") return null; // EOF
      this.inputBuffer += data;
      return this.inputBuffer[0];
    }
    return null;
  }

  /**
   * getChar(): Destructive read of one character.
   */
  public async getChar(): Promise<string | null> {
    while (this.inputBuffer.length === 0) {
      const data = await this.dispatch(SyscallCode.READ, this.stdinFd);
      if (data !== null && data !== "FD NOT FOUND") {
        if (data === "") return null; // EOF
        this.inputBuffer += data;
      } else {
        // Idle poll: 50ms (20x/detik) — nilai tervalidasi (CPU ~0.4%).
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    const char = this.inputBuffer[0];
    this.inputBuffer = this.inputBuffer.substring(1);
    return char;
  }

  public async readPassword(promptText: string): Promise<string> {
    await this.print(promptText);
    await this.setRawMode(true);
    let password = "";
    while (true) {
      const char = await this.getChar();
      if (char === null) break; // EOF

      if (char === "\r" || char === "\n") {
        await this.print("\n");
        break;
      }
      if (char === "\u007f" || char === "\b") {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
        }
        continue;
      }
      // Filter out control chars if any
      if (char.length === 1 && char >= " ") {
        password += char;
      }
    }
    await this.setRawMode(false);
    return password;
  }

  public async read(promptText: string): Promise<string> {
    await this.print(promptText);
    const line = await this.readLine();
    return line || "";
  }

  public getLibVersion(): string {
    return (this as any)._lib.getLibVersion();
  }
}

// ============================================================
// KEY EVENT (decoder keyboard CLI)
// ============================================================

export interface KeyEvent {
  /** Nama tampilan: "a", "Up", "Ctrl+X", "F5", "Alt+b", dst. */
  key: string;
  /** Kode logis ala DOM: "KeyX", "ArrowUp", "Digit5", "F5", dst. */
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Byte mentah yang di-escape untuk tampilan, mis. "\\x1b[1;5A". */
  seq: string;
}

/**
 * KEYBOARD LIBRARY (keyboard)
 *
 * Padanan CLI dari komponen TKeyboard (Cashew) / Keyboard (Emerald):
 * decoder penekanan tombol dari byte stream terminal (pixelterm / TTY).
 *
 * Terminal HANYA mengirim byte stream — TIDAK ada event keyup & auto-repeat.
 * Jadi setiap `readKey()` = satu "down". Decode yang didukung:
 *   - printable chars
 *   - control chars (Ctrl+A..Ctrl+Z, Tab, Enter, Backspace, dll.)
 *   - escape sequence CSI/SS3 (Arrow, Home/End, PageUp/PageDown, Del,
 *     Insert, F1..F12) + modifier Shift/Alt/Ctrl (param `;N`)
 *   - Alt+<char> (dan Alt+Escape, Alt+Backspace)
 *   - ESC tunggal dideteksi via timeout 120ms (tidak hang; byte yang telat
 *     tidak hilang — ditampung di pendingChar).
 *
 * Usage:
 *   await keyboard.enable();   // raw mode
 *   try {
 *     while (true) {
 *       const ev = await keyboard.readKey();
 *       if (!ev) break;        // EOF
 *       std.print(ev.key + "\n");
 *     }
 *   } finally {
 *     await keyboard.disable(); // cooked mode
 *   }
 */
export class KeyboardLib {
  // Karakter yang "telat" datang setelah timeout (hasil getChar yang kita
  // tinggalkan) — ditampung di sini supaya TIDAK ada byte yang hilang.
  private pendingChar: string | null | undefined;

  constructor(private std: StdLib) {}

  /** Masuk raw mode — wajib dipanggil sebelum readKey(). */
  public async enable(): Promise<void> {
    await this.std.setRawMode(true);
  }

  /** Kembali ke cooked mode (aman dipanggil berkali-kali). */
  public async disable(): Promise<void> {
    await this.std.setRawMode(false);
  }

  /**
   * readKey(): Baca satu penekanan tombol (blocking) dan decode.
   * Mengembalikan null saat EOF.
   */
  public async readKey(): Promise<KeyEvent | null> {
    const c1 = await this.getChar();
    if (c1 === null || c1 === "") return null;
    const o1 = c1.charCodeAt(0);

    if (c1 === "\x1b") return this.readEscape();
    if (o1 < 32) return this.decodeControl(c1);
    if (c1 === "\x7f")
      return this.base({
        key: "Backspace",
        code: "Backspace",
        seq: "\\x7f",
      });

    // Printable
    const up = c1.toUpperCase();
    const code = /^[A-Za-z]$/.test(c1)
      ? "Key" + up
      : /^[0-9]$/.test(c1)
        ? "Digit" + c1
        : "Char";
    return this.base({ key: c1, code, seq: this.esc(c1) });
  }

  // ───────────── internal ─────────────

  private base(partial: Partial<KeyEvent> = {}): KeyEvent {
    return {
      key: "",
      code: "",
      ctrl: false,
      shift: false,
      alt: false,
      seq: "",
      ...partial,
    };
  }

  /** Tampilkan byte non-printable sebagai \xNN (biar terlihat "mentah"). */
  private esc(s: string): string {
    let out = "";
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      if (c === 27) out += "\\x1b";
      else if (c < 32 || c === 127)
        out += "\\x" + c.toString(16).padStart(2, "0");
      else out += ch;
    }
    return out;
  }

  /** Decode angka modifier xterm (2=Shift,3=Alt,4=Shift+Alt,5=Ctrl,...). */
  private decodeMod(n: number): {
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
  } {
    const m = (n - 1) & 7;
    return { shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4) };
  }

  private async getChar(): Promise<string | null> {
    if (this.pendingChar !== undefined) {
      const c = this.pendingChar;
      this.pendingChar = undefined;
      return c;
    }
    return await this.std.getChar();
  }

  /**
   * Coba baca satu karakter dalam jangka `ms`. Kalau timeout, kembalikan null.
   * Jika karakter datang SETELAH timeout, hasilnya tetap ditangkap ke
   * pendingChar (tidak hilang) dan akan dibaca di iterasi berikutnya.
   */
  private async peekCharTimeout(ms: number): Promise<string | null> {
    if (this.pendingChar !== undefined) {
      const c = this.pendingChar;
      this.pendingChar = undefined;
      return c;
    }
    const p = (async () => await this.std.getChar())();
    const t = this.std.sleep(ms).then(() => null);
    const result = await Promise.race([p, t]);
    if (result !== null && result !== undefined) return result;
    // Timeout menang — tangkap hasil getChar yang mungkin datang belakangan.
    p.then((c) => {
      if (c !== null && c !== undefined) this.pendingChar = c;
    }).catch(() => {});
    return null;
  }

  private decodeControl(c: string): KeyEvent {
    const o = c.charCodeAt(0);
    if (o === 9) return this.base({ key: "Tab", code: "Tab", seq: "\\t" });
    if (o === 13 || o === 10)
      return this.base({
        key: "Enter",
        code: "Enter",
        seq: o === 13 ? "\\r" : "\\n",
      });
    if (o === 0)
      return this.base({
        key: "Ctrl+Space",
        code: "Space",
        ctrl: true,
        seq: "\\x00",
      });
    if (o >= 1 && o <= 26) {
      const letter = String.fromCharCode(64 + o); // 1→A ... 26→Z
      return this.base({
        key: "Ctrl+" + letter,
        code: "Key" + letter,
        ctrl: true,
        seq: "\\x" + o.toString(16).padStart(2, "0"),
      });
    }
    if (o === 28)
      return this.base({
        key: "Ctrl+\\",
        code: "Backslash",
        ctrl: true,
        seq: "\\x1c",
      });
    if (o === 29)
      return this.base({
        key: "Ctrl+]",
        code: "BracketRight",
        ctrl: true,
        seq: "\\x1d",
      });
    if (o === 30)
      return this.base({
        key: "Ctrl+^",
        code: "Caret",
        ctrl: true,
        seq: "\\x1e",
      });
    if (o === 31)
      return this.base({
        key: "Ctrl+_",
        code: "Minus",
        ctrl: true,
        seq: "\\x1f",
      });
    return this.base({
      key: "Ctrl",
      code: "Unknown",
      ctrl: true,
      seq: "\\x" + o.toString(16).padStart(2, "0"),
    });
  }

  private async readEscape(): Promise<KeyEvent> {
    const c2 = await this.peekCharTimeout(120);
    if (c2 === null || c2 === "") {
      return this.base({ key: "Escape", code: "Escape", seq: "\\x1b" });
    }
    if (c2 === "[") return this.readCsi();
    if (c2 === "O") return this.readSs3();
    // Alt + char (atau ESC lalu karakter cepat — ambigu, dianggap Alt+char)
    if (c2 === "\x1b")
      return this.base({
        key: "Alt+Escape",
        code: "Escape",
        alt: true,
        seq: "\\x1b\\x1b",
      });
    if (c2 === "\x7f")
      return this.base({
        key: "Alt+Backspace",
        code: "Backspace",
        alt: true,
        seq: "\\x1b\\x7f",
      });
    return this.base({
      key: "Alt+" + c2,
      code: "Alt+" + c2,
      alt: true,
      seq: this.esc("\x1b" + c2),
    });
  }

  // ── CSI: ESC [ <param>;... <final> ──
  private async readCsi(): Promise<KeyEvent> {
    let seq = "\x1b[";
    let params: number[] = [];
    let num = "";
    let final = "";
    while (true) {
      const ch = await this.getChar();
      if (ch === null || ch === "") break;
      seq += ch;
      const o = ch.charCodeAt(0);
      if (o >= 48 && o <= 57) {
        num += ch;
        continue;
      }
      if (ch === ";") {
        params.push(num === "" ? 0 : parseInt(num, 10));
        num = "";
        continue;
      }
      if (ch === "?") {
        num = "";
        continue; // CSI privat, abaikan prefix
      }
      if (num !== "") {
        params.push(parseInt(num, 10));
        num = "";
      }
      final = ch;
      break;
    }
    return this.decodeCsi(params, final, seq);
  }

  private decodeCsi(params: number[], final: string, seq: string): KeyEvent {
    // Modifier: umumnya param kedua bernilai 2..8 → Shift/Alt/Ctrl
    let mod: { shift: boolean; alt: boolean; ctrl: boolean } | undefined;
    if (params.length >= 2 && params[1] >= 2 && params[1] <= 8) {
      mod = this.decodeMod(params[1]);
    }

    // CSI 27;mod;code~ → tombol printable dengan modifier (mis. Ctrl+Enter)
    if (final === "~" && params[0] === 27 && params.length >= 3) {
      const ch = String.fromCharCode(params[2]);
      const up = ch.toUpperCase();
      const code = /^[A-Za-z]$/.test(ch)
        ? "Key" + up
        : /^[0-9]$/.test(ch)
          ? "Digit" + ch
          : "Char";
      return this.base({ key: ch, code, seq: this.esc(seq), ...(mod || {}) });
    }

    // CSI <code>~ (Home/End/PgUp/PgDn/Del/Insert/F1..F12)
    const tilde: Record<number, [string, string]> = {
      1: ["Home", "Home"],
      2: ["Insert", "Insert"],
      3: ["Delete", "Delete"],
      4: ["End", "End"],
      5: ["PageUp", "PageUp"],
      6: ["PageDown", "PageDown"],
      7: ["Home", "Home"],
      8: ["End", "End"],
      11: ["F1", "F1"],
      12: ["F2", "F2"],
      13: ["F3", "F3"],
      14: ["F4", "F4"],
      15: ["F5", "F5"],
      17: ["F6", "F6"],
      18: ["F7", "F7"],
      19: ["F8", "F8"],
      20: ["F9", "F9"],
      21: ["F10", "F10"],
      23: ["F11", "F11"],
      24: ["F12", "F12"],
    };
    if (final === "~" && tilde[params[0]]) {
      const [key, code] = tilde[params[0]];
      return this.base({ key, code, seq: this.esc(seq), ...(mod || {}) });
    }

    // Arrow / Home / End / F1..F4 / Shift+Tab (final letter)
    const letter: Record<string, [string, string]> = {
      A: ["Up", "ArrowUp"],
      B: ["Down", "ArrowDown"],
      C: ["Right", "ArrowRight"],
      D: ["Left", "ArrowLeft"],
      H: ["Home", "Home"],
      F: ["End", "End"],
      P: ["F1", "F1"],
      Q: ["F2", "F2"],
      R: ["F3", "F3"],
      S: ["F4", "F4"],
      Z: ["Tab", "Tab"],
    };
    if (letter[final]) {
      const [key, code] = letter[final];
      const m =
        final === "Z" ? { shift: true, alt: false, ctrl: false } : mod || {};
      return this.base({ key, code, seq: this.esc(seq), ...m });
    }

    // CSI tidak dikenal — tampilkan apa adanya
    return this.base({
      key: "CSI[" + final + "]",
      code: "Unknown",
      seq: this.esc(seq),
      ...(mod || {}),
    });
  }

  // ── SS3: ESC O <final> (biasanya arrow/Home/End/F1..F4) ──
  private async readSs3(): Promise<KeyEvent> {
    let seq = "\x1bO";
    let params: number[] = [];
    let num = "";
    let final = "";
    while (true) {
      const ch = await this.getChar();
      if (ch === null || ch === "") break;
      seq += ch;
      const o = ch.charCodeAt(0);
      if (o >= 48 && o <= 57) {
        num += ch;
        continue;
      }
      if (ch === ";") {
        params.push(num === "" ? 0 : parseInt(num, 10));
        num = "";
        continue;
      }
      if (num !== "") {
        params.push(parseInt(num, 10));
        num = "";
      }
      final = ch;
      break;
    }
    const map: Record<string, [string, string]> = {
      A: ["Up", "ArrowUp"],
      B: ["Down", "ArrowDown"],
      C: ["Right", "ArrowRight"],
      D: ["Left", "ArrowLeft"],
      H: ["Home", "Home"],
      F: ["End", "End"],
      P: ["F1", "F1"],
      Q: ["F2", "F2"],
      R: ["F3", "F3"],
      S: ["F4", "F4"],
    };
    let mod: { shift: boolean; alt: boolean; ctrl: boolean } | undefined;
    if (params.length >= 1 && params[0] >= 2 && params[0] <= 8) {
      mod = this.decodeMod(params[0]);
    }
    if (map[final]) {
      const [key, code] = map[final];
      return this.base({ key, code, seq: this.esc(seq), ...(mod || {}) });
    }
    return this.base({
      key: "SS3",
      code: "Unknown",
      seq: this.esc(seq),
      ...(mod || {}),
    });
  }
}

/**
 * FILESYSTEM LIBRARY (fs)
 */
export class FsLib {
  constructor(
    private dispatch: (code: SyscallCode, args: any) => Promise<any>,
  ) {}

  public async open(path: string, flags: string = "r") {
    return await this.dispatch(SyscallCode.OPEN, { path, flags });
  }

  public async read(fd: number): Promise<any> {
    return await this.dispatch(SyscallCode.READ, fd);
  }

  public async write(fd: number, content: string) {
    return await this.dispatch(SyscallCode.WRITE, { fd, content });
  }

  public async close(fd: number) {
    return await this.dispatch(SyscallCode.CLOSE, fd);
  }

  public async mkdir(path: string) {
    return await this.dispatch(SyscallCode.MKDIR, path);
  }

  public async ls(path: string = "/") {
    return await this.dispatch(SyscallCode.LS, path);
  }

  public async stat(path: string) {
    return await this.dispatch(SyscallCode.STAT, path);
  }

  public async chmod(path: string, mode: number) {
    return await this.dispatch(SyscallCode.CHMOD, { path, mode });
  }

  public async chown(path: string, uid: number, gid: number) {
    return await this.dispatch(SyscallCode.CHOWN, { path, uid, gid });
  }

  public async unlink(path: string): Promise<boolean> {
    return await this.dispatch(SyscallCode.UNLINK, path);
  }

  public async rmdir(path: string): Promise<boolean> {
    return await this.dispatch(SyscallCode.RMDIR, path);
  }

  public async readFile(path: string): Promise<string | null> {
    const fd = await this.open(path, "r");
    if (fd < 0) return null;
    const content = await this.read(fd);
    await this.close(fd);
    return content;
  }

  public async writeFile(path: string, content: string): Promise<boolean> {
    const fd = await this.open(path, "w");
    if (fd < 0) return false;
    await this.write(fd, content);
    await this.close(fd);
    return true;
  }

  public async ioctl(fd: number, cmd: number, arg: any): Promise<any> {
    return await this.dispatch(SyscallCode.IOCTL, { fd, cmd, arg });
  }

  public async syncToHost(vfsPath: string, hostPath: string): Promise<boolean> {
    return await this.dispatch(SyscallCode.SYNC_TO_HOST, { vfsPath, hostPath });
  }

  public async syncFromHost(
    hostPath: string,
    vfsPath: string,
  ): Promise<boolean> {
    return await this.dispatch(SyscallCode.SYNC_FROM_HOST, {
      vfsPath,
      hostPath,
    });
  }

  public async mount(
    vfsPath: string,
    hostPath: string,
    readOnly: boolean = false,
    type: string = "host",
    uid?: number,
    gid?: number,
  ): Promise<boolean> {
    return await this.dispatch(SyscallCode.MOUNT, {
      vfsPath,
      hostPath,
      readOnly,
      type,
      uid,
      gid,
    });
  }

  public async umount(vfsPath: string): Promise<boolean> {
    return await this.dispatch(SyscallCode.UMOUNT, vfsPath);
  }

  public async getMounts(): Promise<
    { vfsPath: string; type: string; source: string; readOnly: boolean }[]
  > {
    return await this.dispatch(SyscallCode.GET_MOUNTS, null);
  }

  public async getUsage(
    path: string = "/",
  ): Promise<{ size: number; files: number; dirs: number; diskSize?: number }> {
    return await this.dispatch(SyscallCode.GET_USAGE, path);
  }

  // ==================== CHUNKED I/O (Progress-aware) ====================

  /**
   * readChunk(): Membaca potongan konten file dari offset tertentu.
   *
   * @param path   Path file di VFS
   * @param offset Posisi mulai baca (0-based, byte)
   * @param length Jumlah karakter/byte yang dibaca
   * @returns      Potongan konten, atau null jika offset di luar jangkauan
   */
  public async readChunk(
    path: string,
    offset: number,
    length: number,
  ): Promise<string | null> {
    return await this.dispatch(SyscallCode.READ_CHUNK, {
      path,
      offset,
      length,
    });
  }

  /**
   * writeChunk(): Menulis potongan konten ke file di offset tertentu.
   * Jika file belum ada, akan dibuat otomatis.
   *
   * @param path   Path file di VFS
   * @param chunk  Data yang ditulis
   * @param offset Posisi mulai tulis (0-based, byte)
   */
  public async writeChunk(
    path: string,
    chunk: string,
    offset: number,
  ): Promise<boolean> {
    return await this.dispatch(SyscallCode.WRITE_CHUNK, {
      path,
      chunk,
      offset,
    });
  }

  /**
   * getSize(): Mendapatkan ukuran file dalam byte.
   * Return -1 jika file tidak ditemukan.
   */
  public async getSize(path: string): Promise<number> {
    return await this.dispatch(SyscallCode.GET_SIZE, path);
  }

  /**
   * copyWithProgress(): Menyalin file besar dengan laporan progress via callback.
   *
   * Membaca source per chunk, menulis ke destination, dan memanggil
   * `onProgress` setiap chunk selesai. Cocok untuk file >500MB
   * agar UI bisa menampilkan progress bar.
   *
   * Usage:
   *   await lib.fs.copyWithProgress(
   *       "/mnt/host/bigfile.iso",
   *       "/home/user/bigfile.iso",
   *       (pct) => console.log(`${pct}%`),
   *       65536  // chunk 64KB (opsional)
   *   );
   *
   * @param srcPath    Path file sumber
   * @param dstPath    Path file tujuan
   * @param onProgress Callback progress (0-100), dipanggil tiap chunk selesai
   * @param chunkSize  Ukuran chunk dalam byte (default: 64KB)
   * @param reportIntervalMs  Interval minimum antar laporan progress (default: 200ms)
   */
  public async copyWithProgress(
    srcPath: string,
    dstPath: string,
    onProgress: (percent: number) => void,
    chunkSize: number = 65536,
    reportIntervalMs: number = 200,
  ): Promise<boolean> {
    const totalSize = await this.getSize(srcPath);
    if (totalSize < 0) {
      throw new Error(`Source file not found: ${srcPath}`);
    }
    if (totalSize === 0) {
      // File kosong — tetap buat di destination
      await this.writeFile(dstPath, "");
      onProgress(100);
      return true;
    }

    let offset = 0;
    let lastReport = 0;

    // Tulis chunk pertama sebagai overwrite, sisanya pakai writeChunk
    const firstChunk = await this.readChunk(
      srcPath,
      0,
      Math.min(chunkSize, totalSize),
    );
    if (firstChunk === null) return false;

    // Buat file tujuan dengan chunk pertama
    const fd = await this.open(dstPath, "w");
    if (fd < 0) return false;
    await this.write(fd, firstChunk);
    await this.close(fd);

    offset = firstChunk.length;
    if (offset >= totalSize) {
      onProgress(100);
      return true;
    }

    // Lanjutkan chunk berikutnya
    while (offset < totalSize) {
      const readLen = Math.min(chunkSize, totalSize - offset);
      const chunk = await this.readChunk(srcPath, offset, readLen);
      if (chunk === null) return false;

      const ok = await this.writeChunk(dstPath, chunk, offset);
      if (!ok) return false;

      offset += chunk.length;

      // Throttle progress report agar tidak membanjiri IPC
      const now = Date.now();
      const pct = Math.round((offset / totalSize) * 100);
      if (pct >= 100 || now - lastReport >= reportIntervalMs) {
        onProgress(pct);
        lastReport = now;
      }

      // Kasih napas ke event loop (jangan blocking)
      await new Promise((r) => setTimeout(r, 0));
    }

    onProgress(100);
    return true;
  }
}

/**
 * SHELL & SYSTEM LIBRARY (shell)
 */
export class ShellLib {
  constructor(
    private dispatch: (code: SyscallCode, args: any) => Promise<any>,
    private pid: number,
  ) {}

  public getPid(): number {
    return this.pid;
  }

  public async ps() {
    return await this.dispatch(SyscallCode.PS, null);
  }

  public async kill(targetPid: number, sig: number = 9) {
    return await this.dispatch(SyscallCode.SIGNAL, { pid: targetPid, sig });
  }

  public async reparent(pid: number, newPpid: number) {
    return await this.dispatch(SyscallCode.REPARENT, { pid, newPpid });
  }

  public async waitpid(targetPid: number): Promise<number> {
    return await this.dispatch(SyscallCode.WAITPID, targetPid);
  }

  public async pipe(): Promise<[number, number]> {
    return await this.dispatch(SyscallCode.PIPE, null);
  }

  public async exec(
    path: string,
    args: string[] = [],
    stdoutFd?: number,
    stdinFd?: number,
    ttyId?: number,
    ptyId?: number,
  ): Promise<{ pid: number; stdout: number; stdin: number }> {
    return await this.dispatch(SyscallCode.EXEC, {
      path,
      args,
      stdoutFd,
      stdinFd,
      ttyId,
      ptyId,
    });
  }

  public async read(pid: number): Promise<string | null> {
    // In a real Linux, this would be reading from a PTY master
    // Here, we'll use a special IOCTL or a READ variant
    return await this.dispatch(SyscallCode.READ, {
      pid,
      stream: "stdout",
    } as any);
  }

  public async write(pid: number, data: string): Promise<boolean> {
    return await this.dispatch(SyscallCode.WRITE, {
      pid,
      content: data,
      stream: "stdin",
    } as any);
  }

  /**
   * send(): Kirim pesan ke PID lain (Horizontal IPC).
   * target bisa berupa PID (number) atau UUID (string).
   */
  public async send(target: number | string, data: any) {
    return await this.dispatch(SyscallCode.SEND_MSG, {
      targetPid: target,
      data,
    });
  }

  /**
   * registerIdentity(): Menetapkan UUID permanen untuk aplikasi ini di Kernel.
   */
  public async registerIdentity(uuid: string): Promise<boolean> {
    return await this.dispatch(SyscallCode.SET_IDENTITY, uuid);
  }

  /**
   * netSnifferRegister(): Daftarkan proses ini sebagai network sniffer (bitshark).
   * iface: "smqtnl0" | "smqtnl1" | "*" (semua interface).
   * decrypt: true = MINTA hasil dekripsi (plaintext) — hanya dikabulkan jika ROOT.
   * Paket diterima via lib.onEvent("ipc_message") → msg.data.type === "NET_SNIFF".
   */
  public async netSnifferRegister(
    iface: string = "*",
    decrypt: boolean = false,
  ): Promise<boolean> {
    return await this.dispatch(SyscallCode.NET_SNIFFER_REGISTER, {
      iface,
      decrypt,
    });
  }

  /** netSnifferUnregister(): Hentikan sniffing interface. */
  public async netSnifferUnregister(iface: string = "*"): Promise<boolean> {
    return await this.dispatch(SyscallCode.NET_SNIFFER_UNREGISTER, iface);
  }

  public async chdir(path: string) {
    return await this.dispatch(SyscallCode.CHDIR, path);
  }

  public async getcwd() {
    return await this.dispatch(SyscallCode.GETCWD, null);
  }

  public async whoami(): Promise<{
    uid: number;
    gid: number;
    ruid: number;
    groups: number[];
    username: string;
  }> {
    return await this.dispatch(SyscallCode.WHOAMI, null);
  }

  public async getenv(name: string): Promise<string | null> {
    return await this.dispatch(SyscallCode.GETENV, name);
  }

  public async setenv(name: string, value: string) {
    return await this.dispatch(SyscallCode.SETENV, { name, value });
  }

  public async setuid(uid: number) {
    return await this.dispatch(SyscallCode.SETUID, uid);
  }

  public async setgid(gid: number) {
    return await this.dispatch(SyscallCode.SETGID, gid);
  }

  public async setgroups(groups: number[]) {
    return await this.dispatch(SyscallCode.SETGROUPS, groups);
  }

  public async shutdown(exitCode: number = 0) {
    return await this.dispatch(SyscallCode.SHUTDOWN, exitCode);
  }

  public async uptime(): Promise<number> {
    return await this.dispatch(SyscallCode.UPTIME, null);
  }

  public async getSysPath(): Promise<{
    rootHostPath: string;
    projectRoot: string;
  }> {
    return await this.dispatch(SyscallCode.GET_SYSPATH, null);
  }

  public async onSignal(signal: string, callback: () => void) {
    const UserLibInstance = (this as any)._lib as UserLib;
    if (!(UserLibInstance as any).signalListeners.has(signal)) {
      (UserLibInstance as any).signalListeners.set(signal, []);
    }
    (UserLibInstance as any).signalListeners.get(signal)!.push(callback);
  }

  public async detach(): Promise<boolean> {
    return await this.dispatch(SyscallCode.DETACH, null);
  }

  public async daemonize(serviceName?: string): Promise<boolean> {
    const ok = await this.detach();
    if (ok) {
      const name = serviceName || "Process";
      await (this as any)._lib.std.log(
        `${name} (${this.pid}) started in background.`,
        "system",
      );
    }
    return ok;
  }

  public async exit(code: number = 0) {
    //await this.setenv("EXIT_CODE", code.toString());
    return await this.dispatch(SyscallCode.EXIT, code);
  }

  public async reexec(path: string, args: string[] = []) {
    return await this.dispatch(SyscallCode.REEXEC, { path, args });
  }

  /**
   * registerDbService(): Daemon DB mendaftarkan diri sebagai transport service.
   * Setelah ini, kernel me-route DB_* (connect/query/disconnect) ke daemon ini,
   * bukan ke /dev/mysql device. (Transport alternatif DbLib.)
   */
  public async registerDbService(): Promise<boolean> {
    return await this.dispatch(SyscallCode.DB_SERVICE_REGISTER, null);
  }

  /**
   * dbServiceReply(): Daemon DB mengirim hasil request kembali ke kernel.
   * Dipanggil setelah memproses event "db_request" (requestId → result).
   */
  public async dbServiceReply(
    requestId: string,
    result: any,
  ): Promise<boolean> {
    return await this.dispatch(SyscallCode.DB_SERVICE_REPLY, {
      requestId,
      result,
    });
  }

  /**
   * getFingerprint(): Get the SHA256 fingerprint of the local system's RSA public key.
   * Returns null if the key file doesn't exist.
   */
  public async getFingerprint(): Promise<string | null> {
    const keyPath = "/etc/keys/rsa/id_rsa.pub";
    try {
      const pubKey = await (this as any)._lib.fs.readFile(keyPath);
      if (!pubKey) return null;

      // Calculate SHA256 fingerprint
      const crypto = require("crypto");
      const fingerprint = crypto
        .createHash("sha256")
        .update(pubKey)
        .digest("hex");
      return fingerprint;
    } catch (e) {
      return null;
    }
  }
}

// NetworkLib dipindah ke ./NetworkLib.ts (single source of truth) dan di-re-export
// supaya `import { NetworkLib } from "./UserLib"` (dipakai Application.ts) tetap jalan.
export { NetworkLib } from "./NetworkLib";

/**
 * PTY LIB (Pseudo Terminal, on-demand)
 *
 * Alokasi pseudo-terminal dinamis untuk daemon terminal remote
 * (tsshd, airtermd, pixelterm). Setiap PTY = pasangan master (dipegang daemon)
 * + slave (dipakai proses login/shell).
 */
export class PtyLib {
  constructor(
    private dispatch: (code: SyscallCode, args: any) => Promise<any>,
  ) {}

  /** alloc(): Buat PTY baru. Returns { id, slavePath, masterPath }. */
  public async alloc(
    rows?: number,
    cols?: number,
  ): Promise<{
    id: number;
    slavePath: string;
    masterPath: string;
  }> {
    return await this.dispatch(SyscallCode.PTY_ALLOC, { rows, cols });
  }

  /** free(): Bebaskan PTY. */
  public async free(id: number): Promise<boolean> {
    return await this.dispatch(SyscallCode.PTY_FREE, id);
  }

  /** execOnPty(): Jalankan proses di slave PTY tertentu. */
  public async execOnPty(
    path: string,
    args: string[] = [],
    ptyId: number,
  ): Promise<{ pid: number; stdout: number; stdin: number }> {
    return await this.dispatch(SyscallCode.EXEC, {
      path,
      args,
      ptyId,
    });
  }
}
