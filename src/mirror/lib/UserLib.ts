import { SyscallCode } from "../../common/SyscallCode";
import { parentPort } from "worker_threads";
import { SyscallRequest, SyscallResponse } from "../../common/IPCTypes";
import { v4 as uuidv4 } from "uuid";
import { DbLib } from "./DbLib";

/**
 * USER LIBRARY (lib) - WORKER VERSION
 *
 * Semacam 'libc' di Linux atau 'msvcrt' di Windows.
 * Gunanya membungkus Syscall yang ribet jadi fungsi yang manusiawi.
 */
export class UserLib {
  private version: string = "1.05.20260214";
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

    // Inject parent reference
    (this.std as any)._lib = this;
    (this.fs as any)._lib = this;
    (this.shell as any)._lib = this;
    (this.net as any)._lib = this;
    (this.db as any)._lib = this;
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
  ): Promise<{ pid: number; stdout: number; stdin: number }> {
    return await this.dispatch(SyscallCode.EXEC, {
      path,
      args,
      stdoutFd,
      stdinFd,
      ttyId,
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

/**
 * NETWORK LIBRARY (net)
 */
export class NetworkLib {
  constructor(
    private dispatch: (code: SyscallCode, args: any) => Promise<any>,
  ) {}

  public async socket(): Promise<number> {
    return await this.dispatch(SyscallCode.SOCKET, null);
  }

  public async bind(
    fd: number,
    port: number,
    address?: string,
  ): Promise<boolean> {
    return await this.dispatch(SyscallCode.BIND, { fd, port, address });
  }

  public async listen(port: number): Promise<number> {
    const fd = await this.socket();
    const ok = await this.bind(fd, port);
    return ok ? fd : -1;
  }

  public async accept(serverFd: number): Promise<any> {
    // Simple accept: wait for any data on port, then return pseudo-socket
    // In this simple architecture, we poll for the first packet to identify client
    while (true) {
      const pkt = await this.recv(serverFd);
      if (pkt) {
        return {
          fd: serverFd,
          src: pkt.src,
          port: pkt.port,
          localPort: pkt.localPort || 0, // Now populated by driver
          firstPkt: pkt,
        };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  public async sendto(
    fd: number,
    address: string,
    port: number,
    data: any,
    flag: number = 0,
    srcPort: number = 0,
  ): Promise<boolean> {
    return await this.dispatch(SyscallCode.SENDTO, {
      fd,
      address,
      port,
      data,
      flag,
      srcPort,
    });
  }

  public async recv(fd: number): Promise<any> {
    return await this.dispatch(SyscallCode.RECVFROM, fd);
  }

  public async close(fd: number): Promise<boolean> {
    return await this.dispatch(SyscallCode.CLOSE, fd);
  }

  public async cha20P1305Agent(
    fd: number,
    port: number,
    key: any,
  ): Promise<any> {
    return await this.dispatch(SyscallCode.IOCTL, {
      fd,
      cmd: 0x1001,
      arg: { port, sessionKey: key },
    });
  }

  public async ioctl(fd: number, cmd: number, arg: any): Promise<any> {
    return await this.dispatch(SyscallCode.IOCTL, { fd, cmd, arg });
  }
}
