var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  FsLib: () => FsLib,
  KeyboardLib: () => KeyboardLib,
  NetworkLib: () => import_NetworkLib2.NetworkLib,
  PtyLib: () => PtyLib,
  ShellLib: () => ShellLib,
  StdLib: () => StdLib,
  UserLib: () => UserLib,
  WebLib: () => WebLib
});
module.exports = __toCommonJS(stdin_exports);
var import_SyscallCode = require("../../common/SyscallCode");
var import_worker_threads = require("worker_threads");
var import_uuid = require("uuid");
var import_DbLib = require("./DbLib");
var import_NetworkLib = require("./NetworkLib");
var import_NetworkLib2 = require("./NetworkLib");
const HTTPD_LISTEN = 20737;
const HTTPD_RESPOND = 20738;
const HTTPD_STATUS = 20739;
const WSD_LISTEN = 20993;
const WSD_ATTACH = 20994;
const WSD_SEND = 20995;
const WSD_BROADCAST = 20996;
const WSD_CLOSE = 20997;
const WSD_STATUS = 20998;
class UserLib {
  version = "1.2.20260830.1";
  pid;
  responseMap = /* @__PURE__ */ new Map();
  eventListeners = /* @__PURE__ */ new Map();
  signalListeners = /* @__PURE__ */ new Map();
  // Sub-Libraries
  std;
  fs;
  shell;
  net;
  db;
  pty;
  keyboard;
  web;
  constructor(pid) {
    this.pid = pid;
    if (import_worker_threads.parentPort) {
      import_worker_threads.parentPort.on("message", (msg) => {
        if (msg.requestId && this.responseMap.has(msg.requestId)) {
          const resolve = this.responseMap.get(msg.requestId);
          resolve(msg);
          this.responseMap.delete(msg.requestId);
        } else if (msg.type && msg.type !== "signal" && this.eventListeners.has(msg.type)) {
          const callbacks = this.eventListeners.get(msg.type);
          callbacks.forEach((cb) => cb(msg.data));
        } else if (msg.type === "signal") {
          const sig = msg.data;
          const listeners = this.signalListeners.get(sig);
          let handled = false;
          if (listeners && listeners.length > 0) {
            listeners.forEach((l) => l());
            handled = true;
          }
          if (this.eventListeners.has("signal")) {
            this.eventListeners.get("signal").forEach((cb) => cb(sig));
            handled = true;
          }
          if (!handled && (sig === "SIGINT" || sig === "SIGTERM")) {
            setTimeout(() => this.shell.exit(sig === "SIGINT" ? 130 : 143), 10);
          }
        }
      });
    }
    this.std = new StdLib(this.dispatch.bind(this));
    this.fs = new FsLib(this.dispatch.bind(this));
    this.shell = new ShellLib(this.dispatch.bind(this), this.pid);
    this.net = new import_NetworkLib.NetworkLib(this.dispatch.bind(this));
    this.db = new import_DbLib.DbLib(this.dispatch.bind(this));
    this.pty = new PtyLib(this.dispatch.bind(this));
    this.keyboard = new KeyboardLib(this.std);
    this.web = new WebLib(this);
    this.std._lib = this;
    this.fs._lib = this;
    this.shell._lib = this;
    this.net._lib = this;
    this.db._lib = this;
    this.pty._lib = this;
    this.keyboard._lib = this;
    this.web._lib = this;
  }
  /**
   * dispatch(): Jembatan utama untuk mengirim "Surat" ke Kernel.
   */
  async dispatch(code, args) {
    return new Promise((resolve, reject) => {
      const requestId = (0, import_uuid.v4)();
      const request = { requestId, pid: this.pid, code, args };
      this.responseMap.set(requestId, (response) => {
        if (response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response.error || "Syscall Failed"));
        }
      });
      if (import_worker_threads.parentPort) {
        import_worker_threads.parentPort.postMessage(request);
      } else {
        reject(new Error("No parentPort found! Are you running in a Worker?"));
      }
    });
  }
  getPid() {
    return this.pid;
  }
  async getParentPid() {
    return await this.dispatch(import_SyscallCode.SyscallCode.GET_PPID, null);
  }
  /**
   * onEvent(): Mendaftarkan listener untuk event asinkron dari kernel.
   */
  onEvent(type, callback) {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, []);
    }
    this.eventListeners.get(type).push(callback);
  }
  /**
   * offEvent(): Hapus listener tertentu (dipakai request-response sekali-pakai).
   */
  offEvent(type, callback) {
    const arr = this.eventListeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(callback);
    if (idx >= 0) arr.splice(idx, 1);
    if (arr.length === 0) this.eventListeners.delete(type);
  }
  getLibVersion() {
    return this.version;
  }
}
class StdLib {
  // Default stdin is FD 0
  constructor(dispatch) {
    this.dispatch = dispatch;
  }
  inputBuffer = "";
  stdinFd = 0;
  setStdin(fd) {
    this.stdinFd = fd;
    this.inputBuffer = "";
  }
  async sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  async millis() {
    return await this.dispatch(import_SyscallCode.SyscallCode.UPTIME, null);
  }
  async print(text) {
    return await this.dispatch(import_SyscallCode.SyscallCode.PRINT, text);
  }
  async println(text = "") {
    return await this.print(text + "\n");
  }
  async abc(text = "") {
    return await this.print("ABC " + text + "\n");
  }
  async readLine() {
    while (true) {
      const nlIdx = this.inputBuffer.indexOf("\n");
      const crIdx = this.inputBuffer.indexOf("\r");
      let termIdx = -1;
      if (nlIdx !== -1 && crIdx !== -1) termIdx = Math.min(nlIdx, crIdx);
      else if (nlIdx !== -1) termIdx = nlIdx;
      else if (crIdx !== -1) termIdx = crIdx;
      if (termIdx !== -1) {
        const line = this.inputBuffer.substring(0, termIdx);
        let consumeLen = 1;
        if (this.inputBuffer[termIdx] === "\r" && this.inputBuffer[termIdx + 1] === "\n") {
          consumeLen = 2;
        }
        this.inputBuffer = this.inputBuffer.substring(termIdx + consumeLen);
        return line;
      }
      const data = await this.dispatch(import_SyscallCode.SyscallCode.READ, this.stdinFd);
      if (data !== null && data !== "FD NOT FOUND") {
        if (data === "") return null;
        this.inputBuffer += data;
      } else {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }
  async getScreenInfo() {
    return await this.dispatch(import_SyscallCode.SyscallCode.SCREEN_INFO, null);
  }
  async ioctl(fd, cmd, arg) {
    return await this.dispatch(import_SyscallCode.SyscallCode.IOCTL, { fd, cmd, arg });
  }
  async uname() {
    return await this.dispatch(import_SyscallCode.SyscallCode.UNAME, null);
  }
  async setRawMode(enable) {
    return await this.ioctl(this.stdinFd, 10, enable);
  }
  /**
   * Standard centralized logging for TSIX applications.
   * Writes to /var/log/syslog (virtual FS).
   */
  async log(message, context) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").substring(0, 19);
    const prefix = context ? ` [${context}]` : "";
    const logLine = `[${timestamp}]${prefix} ${message.trim()} 
`;
    const logDir = "/var/log";
    const logFile = `${logDir}/syslog`;
    try {
      await this._lib.fs.mkdir(logDir);
    } catch (e) {
    }
    try {
      const fd = await this._lib.fs.open(logFile, "a");
      if (fd >= 0) {
        await this._lib.fs.write(fd, logLine);
        await this._lib.fs.close(fd);
      }
    } catch (e) {
    }
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
  async error(message, context, wid) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").substring(0, 19);
    const prefix = context ? ` [${context}]` : "";
    const logLine = `[${timestamp}] [ERROR]${prefix} ${message.trim()} 
`;
    try {
      await this._lib.fs.mkdir("/var/log");
      const fd = await this._lib.fs.open("/var/log/syslog", "a");
      if (fd >= 0) {
        await this._lib.fs.write(fd, logLine);
        await this._lib.fs.close(fd);
      }
    } catch (e) {
    }
    let fileHint = "";
    try {
      const stack = new Error().stack;
      if (stack) {
        const lines = stack.split("\n");
        const re = /[(\s]([^\s()]+\.(?:ts|js))(?::\d+){1,2}/;
        for (const l of lines) {
          const m = l.match(re);
          if (!m) continue;
          const p = m[1].replace(/\\/g, "/");
          if (p.includes("UserLib") || p.includes("Application") || p.includes("emerald"))
            continue;
          const clean = p.replace(/^[A-Za-z]:\//, "/");
          fileHint = clean.split("/").slice(-3).join("/");
          break;
        }
      }
    } catch (_) {
    }
    try {
      const lib = this._lib;
      const parentPid = await lib.getParentPid();
      if (parentPid) {
        await lib.shell.send(parentPid, {
          type: "GUI_WINDOW_ERROR",
          wid: wid || "",
          pid: lib.getPid(),
          file: fileHint,
          error: message,
          context: context || "",
          timestamp
        });
      }
    } catch (e) {
    }
    try {
      await this.print(`\x1B[31m[ERROR]\x1B[0m ${message}`);
      await this.print("\n");
    } catch (e) {
    }
  }
  /**
   * poll(): Non-destructive peek at the first character in the buffer.
   * Attempt to read from kernel if buffer is empty.
   */
  async poll() {
    if (this.inputBuffer.length > 0) return this.inputBuffer[0];
    const data = await this.dispatch(import_SyscallCode.SyscallCode.READ, this.stdinFd);
    if (data !== null && data !== "FD NOT FOUND") {
      if (data === "") return null;
      this.inputBuffer += data;
      return this.inputBuffer[0];
    }
    return null;
  }
  /**
   * getChar(): Destructive read of one character.
   */
  async getChar() {
    while (this.inputBuffer.length === 0) {
      const data = await this.dispatch(import_SyscallCode.SyscallCode.READ, this.stdinFd);
      if (data !== null && data !== "FD NOT FOUND") {
        if (data === "") return null;
        this.inputBuffer += data;
      } else {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const char = this.inputBuffer[0];
    this.inputBuffer = this.inputBuffer.substring(1);
    return char;
  }
  async readPassword(promptText) {
    await this.print(promptText);
    await this.setRawMode(true);
    let password = "";
    while (true) {
      const char = await this.getChar();
      if (char === null) break;
      if (char === "\r" || char === "\n") {
        await this.print("\n");
        break;
      }
      if (char === "\x7F" || char === "\b") {
        if (password.length > 0) {
          password = password.slice(0, -1);
        }
        continue;
      }
      if (char.length === 1 && char >= " ") {
        password += char;
      }
    }
    await this.setRawMode(false);
    return password;
  }
  async read(promptText) {
    await this.print(promptText);
    const line = await this.readLine();
    return line || "";
  }
  getLibVersion() {
    return this._lib.getLibVersion();
  }
}
class KeyboardLib {
  constructor(std) {
    this.std = std;
  }
  // Karakter yang "telat" datang setelah timeout (hasil getChar yang kita
  // tinggalkan) — ditampung di sini supaya TIDAK ada byte yang hilang.
  pendingChar;
  /** Masuk raw mode — wajib dipanggil sebelum readKey(). */
  async enable() {
    await this.std.setRawMode(true);
  }
  /** Kembali ke cooked mode (aman dipanggil berkali-kali). */
  async disable() {
    await this.std.setRawMode(false);
  }
  /**
   * readKey(): Baca satu penekanan tombol (blocking) dan decode.
   * Mengembalikan null saat EOF.
   */
  async readKey() {
    const c1 = await this.getChar();
    if (c1 === null || c1 === "") return null;
    const o1 = c1.charCodeAt(0);
    if (c1 === "\x1B") return this.readEscape();
    if (o1 < 32) return this.decodeControl(c1);
    if (c1 === "\x7F")
      return this.base({
        key: "Backspace",
        code: "Backspace",
        seq: "\\x7f"
      });
    const up = c1.toUpperCase();
    const code = /^[A-Za-z]$/.test(c1) ? "Key" + up : /^[0-9]$/.test(c1) ? "Digit" + c1 : "Char";
    return this.base({ key: c1, code, seq: this.esc(c1) });
  }
  // ───────────── internal ─────────────
  base(partial = {}) {
    return {
      key: "",
      code: "",
      ctrl: false,
      shift: false,
      alt: false,
      seq: "",
      ...partial
    };
  }
  /** Tampilkan byte non-printable sebagai \xNN (biar terlihat "mentah"). */
  esc(s) {
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
  decodeMod(n) {
    const m = n - 1 & 7;
    return { shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4) };
  }
  async getChar() {
    if (this.pendingChar !== void 0) {
      const c = this.pendingChar;
      this.pendingChar = void 0;
      return c;
    }
    return await this.std.getChar();
  }
  /**
   * Coba baca satu karakter dalam jangka `ms`. Kalau timeout, kembalikan null.
   * Jika karakter datang SETELAH timeout, hasilnya tetap ditangkap ke
   * pendingChar (tidak hilang) dan akan dibaca di iterasi berikutnya.
   */
  async peekCharTimeout(ms) {
    if (this.pendingChar !== void 0) {
      const c = this.pendingChar;
      this.pendingChar = void 0;
      return c;
    }
    const p = (async () => await this.std.getChar())();
    const t = this.std.sleep(ms).then(() => null);
    const result = await Promise.race([p, t]);
    if (result !== null && result !== void 0) return result;
    p.then((c) => {
      if (c !== null && c !== void 0) this.pendingChar = c;
    }).catch(() => {
    });
    return null;
  }
  decodeControl(c) {
    const o = c.charCodeAt(0);
    if (o === 9) return this.base({ key: "Tab", code: "Tab", seq: "\\t" });
    if (o === 13 || o === 10)
      return this.base({
        key: "Enter",
        code: "Enter",
        seq: o === 13 ? "\\r" : "\\n"
      });
    if (o === 0)
      return this.base({
        key: "Ctrl+Space",
        code: "Space",
        ctrl: true,
        seq: "\\x00"
      });
    if (o >= 1 && o <= 26) {
      const letter = String.fromCharCode(64 + o);
      return this.base({
        key: "Ctrl+" + letter,
        code: "Key" + letter,
        ctrl: true,
        seq: "\\x" + o.toString(16).padStart(2, "0")
      });
    }
    if (o === 28)
      return this.base({
        key: "Ctrl+\\",
        code: "Backslash",
        ctrl: true,
        seq: "\\x1c"
      });
    if (o === 29)
      return this.base({
        key: "Ctrl+]",
        code: "BracketRight",
        ctrl: true,
        seq: "\\x1d"
      });
    if (o === 30)
      return this.base({
        key: "Ctrl+^",
        code: "Caret",
        ctrl: true,
        seq: "\\x1e"
      });
    if (o === 31)
      return this.base({
        key: "Ctrl+_",
        code: "Minus",
        ctrl: true,
        seq: "\\x1f"
      });
    return this.base({
      key: "Ctrl",
      code: "Unknown",
      ctrl: true,
      seq: "\\x" + o.toString(16).padStart(2, "0")
    });
  }
  async readEscape() {
    const c2 = await this.peekCharTimeout(120);
    if (c2 === null || c2 === "") {
      return this.base({ key: "Escape", code: "Escape", seq: "\\x1b" });
    }
    if (c2 === "[") return this.readCsi();
    if (c2 === "O") return this.readSs3();
    if (c2 === "\x1B")
      return this.base({
        key: "Alt+Escape",
        code: "Escape",
        alt: true,
        seq: "\\x1b\\x1b"
      });
    if (c2 === "\x7F")
      return this.base({
        key: "Alt+Backspace",
        code: "Backspace",
        alt: true,
        seq: "\\x1b\\x7f"
      });
    return this.base({
      key: "Alt+" + c2,
      code: "Alt+" + c2,
      alt: true,
      seq: this.esc("\x1B" + c2)
    });
  }
  // ── CSI: ESC [ <param>;... <final> ──
  async readCsi() {
    let seq = "\x1B[";
    let params = [];
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
        continue;
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
  decodeCsi(params, final, seq) {
    let mod;
    if (params.length >= 2 && params[1] >= 2 && params[1] <= 8) {
      mod = this.decodeMod(params[1]);
    }
    if (final === "~" && params[0] === 27 && params.length >= 3) {
      const ch = String.fromCharCode(params[2]);
      const up = ch.toUpperCase();
      const code = /^[A-Za-z]$/.test(ch) ? "Key" + up : /^[0-9]$/.test(ch) ? "Digit" + ch : "Char";
      return this.base({ key: ch, code, seq: this.esc(seq), ...mod || {} });
    }
    const tilde = {
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
      24: ["F12", "F12"]
    };
    if (final === "~" && tilde[params[0]]) {
      const [key, code] = tilde[params[0]];
      return this.base({ key, code, seq: this.esc(seq), ...mod || {} });
    }
    const letter = {
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
      Z: ["Tab", "Tab"]
    };
    if (letter[final]) {
      const [key, code] = letter[final];
      const m = final === "Z" ? { shift: true, alt: false, ctrl: false } : mod || {};
      return this.base({ key, code, seq: this.esc(seq), ...m });
    }
    return this.base({
      key: "CSI[" + final + "]",
      code: "Unknown",
      seq: this.esc(seq),
      ...mod || {}
    });
  }
  // ── SS3: ESC O <final> (biasanya arrow/Home/End/F1..F4) ──
  async readSs3() {
    let seq = "\x1BO";
    let params = [];
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
    const map = {
      A: ["Up", "ArrowUp"],
      B: ["Down", "ArrowDown"],
      C: ["Right", "ArrowRight"],
      D: ["Left", "ArrowLeft"],
      H: ["Home", "Home"],
      F: ["End", "End"],
      P: ["F1", "F1"],
      Q: ["F2", "F2"],
      R: ["F3", "F3"],
      S: ["F4", "F4"]
    };
    let mod;
    if (params.length >= 1 && params[0] >= 2 && params[0] <= 8) {
      mod = this.decodeMod(params[0]);
    }
    if (map[final]) {
      const [key, code] = map[final];
      return this.base({ key, code, seq: this.esc(seq), ...mod || {} });
    }
    return this.base({
      key: "SS3",
      code: "Unknown",
      seq: this.esc(seq),
      ...mod || {}
    });
  }
}
class FsLib {
  constructor(dispatch) {
    this.dispatch = dispatch;
  }
  async open(path, flags = "r") {
    return await this.dispatch(import_SyscallCode.SyscallCode.OPEN, { path, flags });
  }
  async read(fd) {
    return await this.dispatch(import_SyscallCode.SyscallCode.READ, fd);
  }
  async write(fd, content) {
    return await this.dispatch(import_SyscallCode.SyscallCode.WRITE, { fd, content });
  }
  async close(fd) {
    return await this.dispatch(import_SyscallCode.SyscallCode.CLOSE, fd);
  }
  async mkdir(path) {
    return await this.dispatch(import_SyscallCode.SyscallCode.MKDIR, path);
  }
  async ls(path = "/") {
    return await this.dispatch(import_SyscallCode.SyscallCode.LS, path);
  }
  async stat(path) {
    return await this.dispatch(import_SyscallCode.SyscallCode.STAT, path);
  }
  async chmod(path, mode) {
    return await this.dispatch(import_SyscallCode.SyscallCode.CHMOD, { path, mode });
  }
  async chown(path, uid, gid) {
    return await this.dispatch(import_SyscallCode.SyscallCode.CHOWN, { path, uid, gid });
  }
  async unlink(path) {
    return await this.dispatch(import_SyscallCode.SyscallCode.UNLINK, path);
  }
  async rmdir(path) {
    return await this.dispatch(import_SyscallCode.SyscallCode.RMDIR, path);
  }
  async readFile(path) {
    const fd = await this.open(path, "r");
    if (fd < 0) return null;
    const content = await this.read(fd);
    await this.close(fd);
    return content;
  }
  async writeFile(path, content) {
    const fd = await this.open(path, "w");
    if (fd < 0) return false;
    await this.write(fd, content);
    await this.close(fd);
    return true;
  }
  async ioctl(fd, cmd, arg) {
    return await this.dispatch(import_SyscallCode.SyscallCode.IOCTL, { fd, cmd, arg });
  }
  async syncToHost(vfsPath, hostPath) {
    return await this.dispatch(import_SyscallCode.SyscallCode.SYNC_TO_HOST, { vfsPath, hostPath });
  }
  async syncFromHost(hostPath, vfsPath) {
    return await this.dispatch(import_SyscallCode.SyscallCode.SYNC_FROM_HOST, {
      vfsPath,
      hostPath
    });
  }
  async mount(vfsPath, hostPath, readOnly = false, type = "host", uid, gid) {
    return await this.dispatch(import_SyscallCode.SyscallCode.MOUNT, {
      vfsPath,
      hostPath,
      readOnly,
      type,
      uid,
      gid
    });
  }
  async umount(vfsPath) {
    return await this.dispatch(import_SyscallCode.SyscallCode.UMOUNT, vfsPath);
  }
  async getMounts() {
    return await this.dispatch(import_SyscallCode.SyscallCode.GET_MOUNTS, null);
  }
  async getUsage(path = "/") {
    return await this.dispatch(import_SyscallCode.SyscallCode.GET_USAGE, path);
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
  async readChunk(path, offset, length) {
    return await this.dispatch(import_SyscallCode.SyscallCode.READ_CHUNK, {
      path,
      offset,
      length
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
  async writeChunk(path, chunk, offset) {
    return await this.dispatch(import_SyscallCode.SyscallCode.WRITE_CHUNK, {
      path,
      chunk,
      offset
    });
  }
  /**
   * getSize(): Mendapatkan ukuran file dalam byte.
   * Return -1 jika file tidak ditemukan.
   */
  async getSize(path) {
    return await this.dispatch(import_SyscallCode.SyscallCode.GET_SIZE, path);
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
  async copyWithProgress(srcPath, dstPath, onProgress, chunkSize = 65536, reportIntervalMs = 200) {
    const totalSize = await this.getSize(srcPath);
    if (totalSize < 0) {
      throw new Error(`Source file not found: ${srcPath}`);
    }
    if (totalSize === 0) {
      await this.writeFile(dstPath, "");
      onProgress(100);
      return true;
    }
    let offset = 0;
    let lastReport = 0;
    const firstChunk = await this.readChunk(
      srcPath,
      0,
      Math.min(chunkSize, totalSize)
    );
    if (firstChunk === null) return false;
    const fd = await this.open(dstPath, "w");
    if (fd < 0) return false;
    await this.write(fd, firstChunk);
    await this.close(fd);
    offset = firstChunk.length;
    if (offset >= totalSize) {
      onProgress(100);
      return true;
    }
    while (offset < totalSize) {
      const readLen = Math.min(chunkSize, totalSize - offset);
      const chunk = await this.readChunk(srcPath, offset, readLen);
      if (chunk === null) return false;
      const ok = await this.writeChunk(dstPath, chunk, offset);
      if (!ok) return false;
      offset += chunk.length;
      const now = Date.now();
      const pct = Math.round(offset / totalSize * 100);
      if (pct >= 100 || now - lastReport >= reportIntervalMs) {
        onProgress(pct);
        lastReport = now;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    onProgress(100);
    return true;
  }
}
class WebLib {
  constructor(lib) {
    this.lib = lib;
  }
  httpFd = null;
  wsFd = null;
  dispatched = false;
  handlers = /* @__PURE__ */ new Map();
  get fs() {
    return this.lib.fs;
  }
  get pid() {
    return this.lib.getPid();
  }
  /** Daftarkan handler event (request/connection/message/close/listening/error). */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, /* @__PURE__ */ new Set());
    this.handlers.get(type).add(fn);
    this.ensureDispatch();
    return this;
  }
  fire(type, data) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        void fn(data);
      } catch (_) {
      }
    }
  }
  /** Pasang dispatcher dari raw channel kernel → event userland sekali saja. */
  ensureDispatch() {
    if (this.dispatched) return;
    this.dispatched = true;
    this.lib.onEvent("http_event", (p) => {
      if (!p) return;
      if (p.type === "HTTP_REQUEST") this.fire("request", p);
      else if (p.type === "LISTENING")
        this.fire("listening", { ...p, source: "http" });
      else if (p.type === "LISTEN_ERROR")
        this.fire("error", { ...p, source: "http" });
    });
    this.lib.onEvent("ws_event", (p) => {
      if (!p) return;
      if (p.type === "WS_CONNECT") this.fire("connection", p);
      else if (p.type === "WS_MESSAGE") this.fire("message", p);
      else if (p.type === "WS_CLOSE") this.fire("close", p);
      else if (p.type === "LISTENING")
        this.fire("listening", { ...p, source: "ws" });
      else if (p.type === "LISTEN_ERROR")
        this.fire("error", { ...p, source: "ws" });
    });
  }
  // ── buka device ──
  async openHttp() {
    if (this.httpFd !== null) return this.httpFd;
    try {
      const f = await this.fs.open("/dev/httpd", "r+");
      if (typeof f === "number" && f >= 0) {
        this.httpFd = f;
        return f;
      }
    } catch (_) {
    }
    return null;
  }
  async openWs() {
    if (this.wsFd !== null) return this.wsFd;
    try {
      const f = await this.fs.open("/dev/wsd", "r+");
      if (typeof f === "number" && f >= 0) {
        this.wsFd = f;
        return f;
      }
    } catch (_) {
    }
    return null;
  }
  ioHttp(cmd, arg) {
    return this.fs.ioctl(this.httpFd, cmd, {
      ownerPid: this.pid,
      ...arg
    });
  }
  ioWs(cmd, arg) {
    return this.fs.ioctl(this.wsFd, cmd, {
      ownerPid: this.pid,
      ...arg
    });
  }
  /** Tunggu event LISTENING/LISTEN_ERROR di satu channel (one-shot). */
  waitChannel(channel, timeoutMs = 5e3) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        this.lib.offEvent(channel, h);
        resolve(r);
      };
      const h = (p) => {
        if (!p) return;
        if (p.type === "LISTENING") finish({ ok: true });
        else if (p.type === "LISTEN_ERROR")
          finish({ ok: false, error: p.message || "listen failed" });
      };
      this.lib.onEvent(channel, h);
      setTimeout(
        () => finish({ ok: false, error: `timeout ${timeoutMs}ms (${channel})` }),
        timeoutMs
      );
    });
  }
  /**
   * start(): mulai server.
   * mode: "both" (HTTP+WS satu port, default) | "http" | "ws"
   */
  async start(port, mode = "both") {
    this.ensureDispatch();
    const wantsHttp = mode === "http" || mode === "both";
    const wantsWs = mode === "ws" || mode === "both";
    if (wantsHttp) {
      const fd = await this.openHttp();
      if (fd === null)
        return { ok: false, error: "/dev/httpd tidak tersedia", port };
      const ready = this.waitChannel("http_event");
      await this.ioHttp(HTTPD_LISTEN, { port });
      const r = await ready;
      if (!r.ok) return { ok: false, error: r.error, port };
    }
    if (wantsWs) {
      const fd = await this.openWs();
      if (fd === null)
        return { ok: false, error: "/dev/wsd tidak tersedia", port };
      if (wantsHttp) {
        const ready = this.waitChannel("ws_event");
        await this.ioWs(WSD_ATTACH, {});
        const r = await ready;
        if (!r.ok) return { ok: false, error: r.error, port };
      } else {
        const ready = this.waitChannel("ws_event");
        await this.ioWs(WSD_LISTEN, { port });
        const r = await ready;
        if (!r.ok) return { ok: false, error: r.error, port };
      }
    }
    return { ok: true, port };
  }
  /** Balas satu request HTTP. body string (utf8); binary pakai encoding di sini? */
  async respond(reqId, status, contentType, body, extraHeaders) {
    if (this.httpFd === null) return null;
    return this.ioHttp(HTTPD_RESPOND, {
      reqId,
      status,
      contentType,
      body: body ?? "",
      extraHeaders
    });
  }
  /** Kirim pesan ke satu client WS (objek otomatis di-JSON-kan). */
  async send(clientId, data) {
    if (this.wsFd === null) return false;
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    return this.ioWs(WSD_SEND, { clientId, data: payload });
  }
  /** Broadcast pesan ke semua client WS. */
  async broadcast(data) {
    if (this.wsFd === null) return 0;
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    return this.ioWs(WSD_BROADCAST, { data: payload });
  }
  /** Tutup satu client WS. */
  async closeClient(clientId) {
    if (this.wsFd === null) return false;
    return this.ioWs(WSD_CLOSE, { clientId });
  }
  /** Status server (http & ws). */
  async status() {
    let http = null;
    let ws = null;
    if (this.httpFd !== null) {
      http = await this.ioHttp(HTTPD_STATUS, {});
    }
    if (this.wsFd !== null) {
      ws = await this.ioWs(WSD_STATUS, {});
    }
    return { http, ws, wsClients: ws?.clients ?? 0 };
  }
}
class ShellLib {
  constructor(dispatch, pid) {
    this.dispatch = dispatch;
    this.pid = pid;
  }
  getPid() {
    return this.pid;
  }
  async ps() {
    return await this.dispatch(import_SyscallCode.SyscallCode.PS, null);
  }
  async kill(targetPid, sig = 9) {
    return await this.dispatch(import_SyscallCode.SyscallCode.SIGNAL, { pid: targetPid, sig });
  }
  async reparent(pid, newPpid) {
    return await this.dispatch(import_SyscallCode.SyscallCode.REPARENT, { pid, newPpid });
  }
  async waitpid(targetPid) {
    return await this.dispatch(import_SyscallCode.SyscallCode.WAITPID, targetPid);
  }
  async pipe() {
    return await this.dispatch(import_SyscallCode.SyscallCode.PIPE, null);
  }
  async exec(path, args = [], stdoutFd, stdinFd, ttyId, ptyId) {
    return await this.dispatch(import_SyscallCode.SyscallCode.EXEC, {
      path,
      args,
      stdoutFd,
      stdinFd,
      ttyId,
      ptyId
    });
  }
  async read(pid) {
    return await this.dispatch(import_SyscallCode.SyscallCode.READ, {
      pid,
      stream: "stdout"
    });
  }
  async write(pid, data) {
    return await this.dispatch(import_SyscallCode.SyscallCode.WRITE, {
      pid,
      content: data,
      stream: "stdin"
    });
  }
  /**
   * send(): Kirim pesan ke PID lain (Horizontal IPC).
   * target bisa berupa PID (number) atau UUID (string).
   */
  async send(target, data) {
    return await this.dispatch(import_SyscallCode.SyscallCode.SEND_MSG, {
      targetPid: target,
      data
    });
  }
  /**
   * registerIdentity(): Menetapkan UUID permanen untuk aplikasi ini di Kernel.
   */
  async registerIdentity(uuid) {
    return await this.dispatch(import_SyscallCode.SyscallCode.SET_IDENTITY, uuid);
  }
  /**
   * netSnifferRegister(): Daftarkan proses ini sebagai network sniffer (bitshark).
   * iface: "smqtnl0" | "smqtnl1" | "*" (semua interface).
   * decrypt: true = MINTA hasil dekripsi (plaintext) — hanya dikabulkan jika ROOT.
   * Paket diterima via lib.onEvent("ipc_message") → msg.data.type === "NET_SNIFF".
   */
  async netSnifferRegister(iface = "*", decrypt = false) {
    return await this.dispatch(import_SyscallCode.SyscallCode.NET_SNIFFER_REGISTER, {
      iface,
      decrypt
    });
  }
  /** netSnifferUnregister(): Hentikan sniffing interface. */
  async netSnifferUnregister(iface = "*") {
    return await this.dispatch(import_SyscallCode.SyscallCode.NET_SNIFFER_UNREGISTER, iface);
  }
  async chdir(path) {
    return await this.dispatch(import_SyscallCode.SyscallCode.CHDIR, path);
  }
  async getcwd() {
    return await this.dispatch(import_SyscallCode.SyscallCode.GETCWD, null);
  }
  async whoami() {
    return await this.dispatch(import_SyscallCode.SyscallCode.WHOAMI, null);
  }
  async getenv(name) {
    return await this.dispatch(import_SyscallCode.SyscallCode.GETENV, name);
  }
  async setenv(name, value) {
    return await this.dispatch(import_SyscallCode.SyscallCode.SETENV, { name, value });
  }
  async setuid(uid) {
    return await this.dispatch(import_SyscallCode.SyscallCode.SETUID, uid);
  }
  async setgid(gid) {
    return await this.dispatch(import_SyscallCode.SyscallCode.SETGID, gid);
  }
  async setgroups(groups) {
    return await this.dispatch(import_SyscallCode.SyscallCode.SETGROUPS, groups);
  }
  async shutdown(exitCode = 0) {
    return await this.dispatch(import_SyscallCode.SyscallCode.SHUTDOWN, exitCode);
  }
  async uptime() {
    return await this.dispatch(import_SyscallCode.SyscallCode.UPTIME, null);
  }
  async getSysPath() {
    return await this.dispatch(import_SyscallCode.SyscallCode.GET_SYSPATH, null);
  }
  async onSignal(signal, callback) {
    const UserLibInstance = this._lib;
    if (!UserLibInstance.signalListeners.has(signal)) {
      UserLibInstance.signalListeners.set(signal, []);
    }
    UserLibInstance.signalListeners.get(signal).push(callback);
  }
  async detach() {
    return await this.dispatch(import_SyscallCode.SyscallCode.DETACH, null);
  }
  async daemonize(serviceName) {
    const ok = await this.detach();
    if (ok) {
      const name = serviceName || "Process";
      await this._lib.std.log(
        `${name} (${this.pid}) started in background.`,
        "system"
      );
    }
    return ok;
  }
  async exit(code = 0) {
    return await this.dispatch(import_SyscallCode.SyscallCode.EXIT, code);
  }
  async reexec(path, args = []) {
    return await this.dispatch(import_SyscallCode.SyscallCode.REEXEC, { path, args });
  }
  /**
   * registerDbService(): Daemon DB mendaftarkan diri sebagai transport service.
   * Setelah ini, kernel me-route DB_* (connect/query/disconnect) ke daemon ini,
   * bukan ke /dev/mysql device. (Transport alternatif DbLib.)
   */
  async registerDbService() {
    return await this.dispatch(import_SyscallCode.SyscallCode.DB_SERVICE_REGISTER, null);
  }
  /**
   * dbServiceReply(): Daemon DB mengirim hasil request kembali ke kernel.
   * Dipanggil setelah memproses event "db_request" (requestId → result).
   */
  async dbServiceReply(requestId, result) {
    return await this.dispatch(import_SyscallCode.SyscallCode.DB_SERVICE_REPLY, {
      requestId,
      result
    });
  }
  /**
   * getFingerprint(): Get the SHA256 fingerprint of the local system's RSA public key.
   * Returns null if the key file doesn't exist.
   */
  async getFingerprint() {
    const keyPath = "/etc/keys/rsa/id_rsa.pub";
    try {
      const pubKey = await this._lib.fs.readFile(keyPath);
      if (!pubKey) return null;
      const crypto = require("crypto");
      const fingerprint = crypto.createHash("sha256").update(pubKey).digest("hex");
      return fingerprint;
    } catch (e) {
      return null;
    }
  }
}
class PtyLib {
  constructor(dispatch) {
    this.dispatch = dispatch;
  }
  /** alloc(): Buat PTY baru. Returns { id, slavePath, masterPath }. */
  async alloc(rows, cols) {
    return await this.dispatch(import_SyscallCode.SyscallCode.PTY_ALLOC, { rows, cols });
  }
  /** free(): Bebaskan PTY. */
  async free(id) {
    return await this.dispatch(import_SyscallCode.SyscallCode.PTY_FREE, id);
  }
  /** execOnPty(): Jalankan proses di slave PTY tertentu. */
  async execOnPty(path, args = [], ptyId) {
    return await this.dispatch(import_SyscallCode.SyscallCode.EXEC, {
      path,
      args,
      ptyId
    });
  }
}
