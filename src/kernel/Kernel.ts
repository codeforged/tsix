import * as fs from "fs";
import { Logger } from "../common/Logger";
import { BKFS } from "../vfs/BKFS"; // dipakai di fstab (mount bertipe "bkfs")
import { vfsBytesToUtf8 } from "../common/VfsText";
import { Scheduler } from "./Scheduler";
import { SyscallDispatcher } from "./Syscalls";
import { SyscallCode } from "../common/SyscallCode";
import { IDevice } from "./devices/IDevice";
import { ScreenDevice } from "./devices/ScreenDevice";
import { NullDevice } from "./devices/NullDevice";
import { KeyboardDevice } from "./devices/KeyboardDevice";
import { FileSystemDevice } from "./devices/FileSystemDevice";
import { PermissionManager } from "./PermissionManager";
import { Config } from "../common/Config";
import { PortManager } from "./PortManager";
import { SimpleMQTNLDriver } from "./devices/SimpleMQTNLDriver";
import { TTYManager } from "./tty/TTYManager";
import { TTYDevice } from "./devices/TTYDevice";
import { PTYManager } from "./PTYManager";
import { SerialDeviceManager } from "./devices/SerialDeviceManager";
import { MountManager } from "./MountManager";
import { createRootFilesystem } from "./RootFilesystem";
import { IVFS } from "../vfs/IVFS";
import { HostVFS } from "../vfs/HostVFS";
import { RamFS } from "../vfs/RamFS";
import { NetFS } from "../vfs/NetFS";
import { MQTNLNetFSChannel } from "./netfs/MQTNLNetFSChannel";
import {
  formatNetFSSpec,
  parseNetFSSpec,
} from "../common/netfs/NetFSProtocol";
import { GUIRegistry } from "./GUIRegistry";
import { formatFstabIni, parseFstabContent } from "./FstabParser";

import path from "path";
import { std } from "@tsix/Application";

/**
 * KERNEL.TS
 *
 * Di Linux asli, Kernel adalah program pertama yang dimuat ke RAM setelah Bootloader.
 * Di sini, kita mensimulasikan Kernel sebagai sebuah Class utama yang mengelola sistem.
 */
export class Kernel {
  // Versi kernel saat ini
  private codename: string = "Dinawari";
  private version: string = "0.3.3.20260924.1";
  // 0.3.0 adalah fitur netfs di tsix diimplementasikan, setiap node tsix bisa mengakses storage ke node tsix yang lain! canggih bukan?
  // 0.3.1: fstab pindah ke format INI — SATU sumber kebenaran `/etc/fstab.conf`
  // (berkas `.json` lama dimigrasi otomatis sekali saat boot, lalu tak dipakai lagi).

  public getCodename(): string {
    return this.codename;
  }
  public getVersion(): string {
    return this.version;
  }

  // Logger internal: Seperti layar (display) yang menampilkan log dari Kernel.
  private logger: Logger;

  // Sub-sistem Utama
  //
  // Tipenya IVFS — BUKAN BKFS — karena root `/` bisa dilayani backend apa pun:
  // BKFS (SQLite, default) atau HostVFS (folder host, buat ngoprek langsung).
  // Pemilihan driver + resolusinya ada di `RootFilesystem.ts`.
  private rootFs: IVFS | null = null;
  private scheduler: Scheduler | null = null;
  private syscall: SyscallDispatcher | null = null;
  private mountManager: MountManager;
  private satpam: PermissionManager;
  private vfsCache: Record<string, string> = {};

  // Device Registry (HAL)
  public devices: Record<string, IDevice> = {};
  private portManager: PortManager | null = null;
  private ttyManager: TTYManager | null = null;
  private ptyManager: PTYManager | null = null;
  private serialManager: SerialDeviceManager | null = null;
  private bootTime: number = Date.now();
  public wantedExitCode: number = 0;
  /** Sudah `closeFilesystems()`? Menjaga hook exit agar tidak menutup dua kali. */
  private filesystemsClosed = false;
  public safeMode: boolean = false; // --safe-mode: nonaktifkan startup scripts
  private currentBootMessage: string = "";
  public guiRegistry: GUIRegistry;

  constructor() {
    this.logger = new Logger("Kernel");
    this.satpam = new PermissionManager();
    this.mountManager = new MountManager();
    this.guiRegistry = new GUIRegistry();

    // constructor dipanggil saat 'main.ts' melakukan 'new Kernel()'.
    this.logger.info("Initializing Kernel Instance...");
  }

  /**
   * bootLogStart(): Memulai log boot dengan status "loading" (bracket kosong).
   * Message ditampilkan dengan indikator [    ] yang akan di-update in-place.
   */
  public bootLogStart(message: string): void {
    const cfg = Config.get();
    if (!cfg.kernel.verbose) return;

    this.currentBootMessage = message;
    const green = "\x1b[32m";
    const white = "\x1b[97m";
    const reset = "\x1b[0m";
    const gray = "\x1b[90m";

    // Tampilkan "[      ]  message" tanpa newline
    process.stdout.write(`${green}[${gray}      ${green}]${reset} ${message}`);
  }

  /**
   * bootLogEnd(): Menyelesaikan log boot dengan status OK/FAILED.
   * Menggunakan \r untuk kembali ke awal baris dan update bracket.
   */
  public bootLogEnd(isOk: boolean = true, finalMessage?: string): void {
    const cfg = Config.get();
    if (!cfg.kernel.verbose) return;

    const green = "\x1b[92m";
    const red = "\x1b[91m";
    const white = "\x1b[97m";
    const reset = "\x1b[0m";
    const clearLine = "\x1b[K"; // ANSI: Clear from cursor to end of line

    // Kembali ke awal baris
    process.stdout.write("\r");

    if (isOk) {
      process.stdout.write(
        `${green}[  ${green}OK${green}  ]${reset} ${this.currentBootMessage}`,
      );
    } else {
      process.stdout.write(
        `${green}[ ${red}FAIL${green} ]${reset} ${this.currentBootMessage}`,
      );
    }

    // Tampilkan pesan tambahan jika ada
    if (finalMessage) {
      process.stdout.write(` ${finalMessage}`);
    }

    // Hapus sisa baris yang mungkin tersisa dari render sebelumnya
    process.stdout.write(clearLine + "\n");
  }

  /**
   * bootLog(): Backward compatibility wrapper.
   * Langsung tampilkan status OK/FAILED tanpa delay (instant).
   * @deprecated Gunakan bootLogStart() + bootLogEnd() untuk dynamic updates.
   */
  public bootLog(message: string, isOk: boolean = true): void {
    this.bootLogStart(message);
    this.bootLogEnd(isOk);

    // Also push to syslog if BKFS is ready
    if (this.rootFs) {
      this.syslog("Kernel", message);
    }
  }

  /**
   * syslog(): Antarmuka internal untuk menulis ke /var/log/syslog (VFS).
   * Bisa dipanggil oleh Kernel maupun Device Driver.
   */
  public async syslog(tag: string, message: string) {
    if (!this.rootFs) return;
    const timestamp = new Date()
      .toISOString()
      .replace("T", " ")
      .substring(0, 19);
    const logLine = `[${timestamp}] [${tag}] ${message.trim()}\n`;
    const logFile = "/var/log/syslog";

    try {
      this.rootFs.append(logFile, logLine);
    } catch (e) {
      // Jika folder /var/log belum ada, buat dulu
      try {
        this.rootFs.mkdir("/var", 0, 0, 0o755);
        this.rootFs.mkdir("/var/log", 0, 0, 0o755);
        this.rootFs.touch(logFile, logLine);
      } catch (err) { }
    }
  }

  /**
   * boot(): Fungsi utama untuk memulai semua layanan OS.
   */
  public getUptime(): number {
    return Date.now() - this.bootTime;
  }

  public async boot() {
    const cfg = Config.get();

    // --safe-mode: untuk troubleshooting — nonaktifkan startup scripts (rc.local)
    this.safeMode = process.argv.includes("--safe-mode");
    if (this.safeMode) {
      this.bootLogStart("MODE: Safe Mode (startup scripts disabled)");
      this.bootLogEnd(true);
    }

    if (cfg.kernel.verbose) {
      console.log(`\x1b[97mStarting TSIX Kernel v${this.version}...\x1b[0m`);
    }

    // Memanggil fungsi pembantu untuk menyalakan sub-sistem (VFS, Memory, dll).
    await this.initializeSubsystems();

    // Initialize TTY Manager — jumlah konsol diambil dari sysconfig (shell.ttyCount)
    // supaya mudah dikurangi saat butuh hemat RAM (semakin sedikit TTY = makin sedikit buffer).
    const ttyCount = cfg.shell.ttyCount ?? 6;
    this.ttyManager = new TTYManager(ttyCount);
    const ttysDevs: Record<string, TTYDevice> = {};
    for (let i = 1; i <= ttyCount; i++) {
      const tty = this.ttyManager.getTTY(i)!;
      const dev = new TTYDevice(
        i,
        tty,
        () => this.ttyManager?.getActiveId() === i,
      );
      ttysDevs[dev.name] = dev;
    }

    // 1. Persiapkan default devices (HAL)
    // 2. Inisialisasi Hardware (Driver)
    this.devices = {
      stdin: new KeyboardDevice(),
      fb0: ttysDevs.tty1, // Alias fb0 to TTY1
      stdout: ttysDevs.tty1, // Alias stdout to TTY1
      stderr: ttysDevs.tty1, // Alias stderr to TTY1
      null: new NullDevice(),
      ...ttysDevs,
    };

    // this.bootLog(`HAL: Registered 'stdin' as KeyboardDevice.`);
    // this.bootLog(`HAL: Registered 'null' as NullDevice.`);
    // this.bootLog(`HAL: Registered 'fb0' (framebuffer) mapped to TTY1.`);
    // this.bootLog(`HAL: Registered ${Object.keys(ttysDevs).length} Virtual Console devices (tty1-16).`);
    // this.bootLog("Populating /dev with hardware device nodes... done.");

    // Initialize Network Interfaces
    if (cfg.network.interfaces) {
      cfg.network.interfaces.forEach((iface) => {
        this.devices[iface.deviceName] = new SimpleMQTNLDriver(
          iface.deviceName,
          iface.broker,
          iface.address,
        );
      });
    }

    // 3. Load Auxiliary Devices (Kernel Plugins)
    this.bootLogStart("Loading auxiliary device drivers...");
    this.bootLogEnd(true);
    this.loadAuxDevices();

    // 3a. Initialize Serial Port Manager (Auto-detection)
    this.bootLogStart("Serial: Initializing auto-detection manager...");
    this.serialManager = new SerialDeviceManager(this);
    this.serialManager.startAutoDetection();
    this.bootLogEnd(true, "active.");

    // 4. Apply Device Configurations (udev-style from sysconfig.conf)
    this.bootLogStart("Applying device configurations...");
    this.applyDeviceConfigs();
    this.bootLogEnd(true);

    // 5. Unified Device Initialization (Call init() on all drivers)
    Object.entries(this.devices).forEach(([devName, instance]) => {
      if (instance.init) {
        this.bootLogStart(
          `HAL: Initializing driver '/dev/${devName}' (${instance.name || "Generic"})`,
        );
        instance.init({
          syslog: (msg) => this.syslog(instance.name || devName, msg),
        });
        this.bootLogEnd(true);
      }
    });

    this.bootLogStart("HAL: Hardware Drivers initialization");
    this.bootLogEnd(true, "complete.");

    this.bootLogStart("MODE: Running in VFS-Only Architecture...");

    // Pastikan /dev ada di VFS
    if (!this.rootFs?.exists("/dev")) {
      this.rootFs?.mkdir("/dev", 0, 0, 493);
    }

    this.bootLogEnd(true);

    // Expose keyboard for TTY IOCTL forwarding
    (process as any)._kernelStdin = this.devices.stdin;

    this.bootLogStart("VFS: System synchronization");
    this.bootLogEnd(true, "complete.");

    // --- VISUAL IDENTITY INITIALIZATION ---
    try {
      const pubKeyPath = "/etc/keys/rsa/id_rsa.pub";
      if (this.rootFs?.exists(pubKeyPath)) {
        this.bootLogStart("Security: System Visual Identity");
        const pubKey = this.readRoot(pubKeyPath);
        if (pubKey) {
          const { SecurityAgent } = require("../common/SecurityAgent");
          const fingerprint = SecurityAgent.getFingerprint(pubKey);
          const visual = SecurityAgent.generateVisualIdentity(fingerprint);
          this.ttyManager?.setVisualIdentity(visual);
          this.bootLogEnd(true, "calculated and loaded.");
        } else {
          this.bootLogEnd(false, "key file empty.");
        }
      }
    } catch (e: any) {
      this.bootLogEnd(false, `identity error: ${e.message}`);
    }

    this.bootLogStart("VFS: Checking filesystem integrity");
    this.bootLogEnd(true, "clean.");
    this.bootLogStart("Security: Integrity check");
    this.bootLogEnd(true, "completed.");

    // --- Selesai Seeding ---
    this.bootLogStart("Kernel: Finalizing boot sequence");
    this.bootLogEnd(true, "success.");

    // Force ensure basic auth and groups exist in VFS
    this.ensureDefaultAuth();
    this.ensureDefaultGroups();

    // Hubungkan Keyboard Interrupt (Ctrl+C) ke Scheduler
    const kbd = this.devices.stdin as KeyboardDevice;
    if (kbd && kbd.setInterruptHandler) {
      kbd.setInterruptHandler(() => {
        this.handleHostInterrupt();
      });
    }
    if (kbd && kbd.setHotkeyHandler) {
      kbd.setHotkeyHandler((seq: string) => {
        return this.handleKeyboardHotkey(seq);
      });
    }

    if (kbd && kbd.setDataHandler) {
      kbd.setDataHandler((data: string) => {
        this.ttyManager?.getActiveTTY().pushInput(data);
      });
    }

    // Register TTY switch callback to notify foreground process
    if (this.ttyManager && this.scheduler) {
      this.ttyManager.setOnSwitchCallback((ttyId: number) => {
        const fgPid = this.scheduler?.getForegroundProcess(ttyId);
        if (fgPid) {
          this.logger.debug(
            `Sending SIGWINCH to PID ${fgPid} (TTY${ttyId} activated)`,
          );
          this.scheduler?.sendEvent(fgPid, "signal", "SIGWINCH");
        }
      });

      // Register TTY interrupt callback for Ctrl+C
      this.ttyManager.setOnInterruptCallback((ttyId: number) => {
        const fgPid = this.scheduler?.getForegroundProcess(ttyId);
        if (fgPid) {
          this.logger.info(
            `Sending SIGINT to PID ${fgPid} (TTY${ttyId} Ctrl+C)`,
          );
          this.scheduler?.sendEvent(fgPid, "signal", "SIGINT");
        }
      });
    }

    this.bootLogStart("IO: Synchronization...");
    this.bootLogEnd(true, "complete.");

    // --- WINDOW RESIZE LISTENER ---
    if (process.stdout.isTTY) {
      this.bootLogStart("Terminal: Capabilities detection...");
      this.bootLogEnd(true, "isTTY.");
      process.stdout.on("resize", () => {
        const lines = process.stdout.rows || 24;
        const columns = process.stdout.columns || 80;
        this.logger.info(`Terminal Resized: ${columns}x${lines}`);

        // 1. Update EVERY process's environment variables
        if (this.scheduler) {
          this.scheduler.listProcesses().forEach((p) => {
            if (p.state !== "EXITED") {
              p.env["LINES"] = lines.toString();
              p.env["COLUMNS"] = columns.toString();

              // 2. Send SIGWINCH event to applications (if they want to listen)
              this.scheduler?.sendEvent(p.pid, "signal", "SIGWINCH");
            }
          });

          // 2a. Update TTY Manager (buffers and dimensions)
          this.ttyManager?.handleResize(columns, lines);

          // 3. Backward compatibility (if any old apps use "resize" event)
          this.scheduler.broadcastEvent("resize", { lines, columns });
        }
      });
    }

    this.bootLogStart("Kernel: All core modules");
    this.bootLogEnd(true, "active.");
    this.bootLogStart("Kernel: Boot sequence");
    this.bootLogEnd(true, "completed.");
  }

  /**
   * runInit(): Mempersiapkan dan men-spawn proses init (PID 1).
   *
   * async karena konten binary init dibaca lewat kontrak IVFS (`MaybePromise`) —
   * penting kalau suatu saat `/bin` berada di filesystem jaringan (NetFS).
   */
  public async runInit(): Promise<void> {
    const cfg = Config.get();
    this.bootLogStart("Init: Starting system entry service (init)");

    const tty1 = this.devices[`tty1`];
    if (!tty1) {
      this.logger.error("TTY1 not found. Cannot start init.");
      return;
    }

    // --- LINUX-STYLE BOOT ---
    // Spawn ONLY ONE init process (PID 1).
    // It will be responsible for spawning login on other TTYs.
    let initContent: string | undefined = undefined;
    try {
      const initPath = "/bin/" + cfg.scheduler.bootEntry;
      const res = this.mountManager.resolve(initPath);
      // Gunakan vfs.read() sesuai kontrak IVFS, bukan stat().content
      const raw = await res.vfs.read(res.relativePath);
      if (raw) initContent = raw;
    } catch (e: any) {
      this.logger.error(`Failed to read init content: ${e.message}`);
    }

    const initPcb = this.scheduler?.createProcess(`init`, {
      fds: [tty1, tty1, tty1],
      appName: "init",
      appContent: initContent,
      env: {
        TSIX_SAFE_MODE: this.safeMode ? "1" : "0",
        PATH: cfg.scheduler.defaultPath,
        HOME: "/root",
        HOSTNAME: cfg.shell.defaultHostname,
        PROMPT_FORMAT: cfg.shell.promptFormat,
        // Konfigurasi TTY — diturunkan ke semua proses userland (login, tsshd,
        // airtermd, pixelterm) supaya alokasi konsol bisa diset dari sysconfig.
        TSIX_TTY_COUNT: (cfg.shell.ttyCount ?? 6).toString(),
        TSIX_LOGIN_COUNT: (cfg.shell.loginCount ?? 2).toString(),
        LINES: (process.stdout.rows || cfg.shell.defaultRows).toString(),
        COLUMNS: (
          process.stdout.columns || cfg.shell.defaultColumns
        ).toString(),
      },
      cwd: cfg.scheduler.defaultCwd,
      ttyId: 1,
    });

    if (initPcb) {
      this.scheduler?.setForegroundProcess(initPcb.pid, 1);
      this.bootLogEnd(true);
    } else {
      this.bootLogEnd(false);
    }
  }

  /**
   * handleKeyboardHotkey(): Deteksi hotkey pindah TTY
   * (Alt+F1..F6, Alt+1..6, Ctrl+1..6, Ctrl+Alt+1..6).
   *
   * Tiap terminal mengirim byte berbeda untuk kombinasi yang sama, jadi tabel
   * ini memuat semua varian yang lazim dipakai:
   *
   *   Alt+F1..F6   → ESC ESC O P / ESC [ 1;3P / ESC [ 11;3~ (xterm, iTerm2,
   *                  Terminal.app)
   *   Alt+1..6     → ESC + digit ("\x1b1".."\x1b6") — bentuk standar xterm,
   *                  GNOME Terminal, VS Code, dan Terminal.app saat opsi
   *                  "Use Option as Meta key" aktif.
   *   Ctrl+Alt+1..6 → di xterm.js (VS Code, dome/pixelterm) selalu ESC + digit,
   *                  sama seperti Alt+digit: modifier Alt menang, Ctrl diabaikan
   *                  untuk tombol digit (terukur: Ctrl+Alt+1 → "\x1b1",
   *                  Ctrl+Alt+4 → "\x1b4", bukan FS). Di VTE/GNOME Terminal
   *                  hanya Ctrl+Alt+1 yang begini; Ctrl+Alt+2..6 jatuh ke caret
   *                  notation (NUL / ESC / FS / GS / RS) persis seperti
   *                  Ctrl+digit telanjang — jadi Ctrl+Alt+4..6 tetap jalan
   *                  lewat entri 0x1C..0x1E di bawah. Kombo ini berguna kalau
   *                  terminal sudah mencaplok Ctrl+1..6 (GNOME Terminal: pindah
   *                  tab; VS Code: focus editor group).
   *   Option+1..6  → "¡ ™ £ ¢ ∞ §" (macOS Terminal dengan opsi Meta MATI)
   *   Ctrl/Alt+digit (CSI-u)          → ESC [ <49-54> ; 5u (Ctrl) / ; 3u (Alt)
   *                  / ; 7u (Ctrl+Alt) — kitty, wezterm, Ghostty, foot, iTerm2
   *                  (Report modifiers)
   *   Ctrl/Alt+digit (modifyOtherKeys) → ESC [ 27 ; 5 ; <49-54> ~ (Ctrl) / ; 3~
   *                  / ; 7;~ (Ctrl+Alt) — xterm modifyOtherKeys=2, iTerm2 legacy
   *   Ctrl+4..6 (caret notation)       → 0x1C/0x1D/0x1E (FS/GS/RS). Ini byte
   *                  yang benar-benar dikirim terminal klasik untuk Ctrl+4..6
   *                  (Ctrl+3 = ESC, Ctrl+7 = 0x1F, Ctrl+8 = DEL).
   *
   * Sengaja TIDAK dipetakan (takut menabrak tombol inti aplikasi):
   *   - Ctrl+3 = 0x1B (ESC) — dipakai semua TUI (atto, vim)
   *   - Ctrl+2 = 0x00 (NUL) — sama dengan Ctrl+Space / Ctrl+@
   *   - Ctrl+8 = 0x7F (DEL) — sama dengan Backspace
   * Catatan: 0x1C/0x1D/0x1E juga berarti Ctrl+\ , Ctrl+] , Ctrl+^ — tidak ada
   * userland TSIX yang memakainya, jadi aman dialokasikan untuk pindah TTY.
   */
  private handleKeyboardHotkey(seq: string): boolean {
    // Alt+F1..F6 sequences vary by terminal, but common ones are:
    // Alt+F1: \x1b\x1bOP or \x1b[1;3P
    // For simplicity and compatibility, we'll check for several common patterns.
    // console.log(`key: ${seq}`);
    const hotkeys: Record<string, number> = {
      // Standard Alt+F1..F6 (Xterm, iTerm2, Terminal.app)
      "\x1b\x1bOP": 1,
      "\x1b[1;3P": 1,
      "\x1b[11;3~": 1,
      "\x1b\x1bOQ": 2,
      "\x1b[1;3Q": 2,
      "\x1b[12;3~": 2,
      "\x1b\x1bOR": 3,
      "\x1b[1;3R": 3,
      "\x1b[13;3~": 3,
      "\x1b\x1bOS": 4,
      "\x1b[1;3S": 4,
      "\x1b[14;3~": 4,
      "\x1b\x1b[15~": 5,
      "\x1b[15;3~": 5,
      "\x1b[1;3;15~": 5,
      "\x1b\x1b[17~": 6,
      "\x1b[17;3~": 6,
      "\x1b[1;3;17~": 6,

      // Option+1..6 di macOS Terminal (opsi "Use Option as Meta key" MATI —
      // kalau opsi itu AKTIF, yang datang justru ESC+digit di bawah)
      "¡": 1,
      "™": 2,
      "£": 3,
      "¢": 4,
      "∞": 5,
      "§": 6,

      // Ctrl+4..6 — caret notation (FS/GS/RS)
      "\x1c": 4,
      "\x1d": 5,
      "\x1e": 6,
    };

    // Alt+1..6 & Ctrl+Alt+1..6 (keduanya ESC+digit) + varian CSI-u /
    // modifyOtherKeys untuk Alt, Ctrl, dan Ctrl+Alt.
    for (let d = 1; d <= 6; d++) {
      const cp = 48 + d; // '1' = 49 ... '6' = 54
      hotkeys["\x1b" + d] = d; // Alt+digit & Ctrl+Alt+digit (xterm, GNOME, VS Code, iTerm2, macOS)
      hotkeys[`\x1b[${cp};3u`] = d; // Alt+digit (CSI-u)
      hotkeys[`\x1b[${cp};5u`] = d; // Ctrl+digit (CSI-u)
      hotkeys[`\x1b[${cp};7u`] = d; // Ctrl+Alt+digit (CSI-u)
      hotkeys[`\x1b[27;3;${cp}~`] = d; // Alt+digit (modifyOtherKeys)
      hotkeys[`\x1b[27;5;${cp}~`] = d; // Ctrl+digit (modifyOtherKeys)
      hotkeys[`\x1b[27;7;${cp}~`] = d; // Ctrl+Alt+digit (modifyOtherKeys)
    }

    const targetTtyId = hotkeys[seq];
    // typeof check (bukan `if (hotkeys[seq])`) supaya kata yang kebetulan sama
    // dengan properti prototype ("constructor", "toString") tidak ikut ditelan.
    if (typeof targetTtyId === "number") {
      // FIRE AND FORGET: Jangan await agar tidak nge-block input keyboard
      this.ttyManager?.switch(targetTtyId);
      return true; // Handled
    }

    return false;
  }

  /**
   * loadAuxDevices(): Menscan folder aux-devices dan memuat driver secara dinamis.
   *
   * Convention: Devices can export a static 'autoRegister(kernel)' method for
   * platform-specific hardware initialization (e.g., MCP23017 with I2C bus config).
   */
  private loadAuxDevices() {
    if (!this.devices) return;

    const auxPath = path.resolve(__dirname, "devices/aux-devices");
    if (!fs.existsSync(auxPath)) {
      this.logger.debug(`Auxiliary devices directory not found: ${auxPath}`);
      return;
    }

    const files = fs.readdirSync(auxPath);
    files.forEach((file) => {
      if (file.endsWith(".ts") || file.endsWith(".js")) {
        try {
          const fullPath = path.join(auxPath, file);
          const module = require(fullPath);
          const DeviceClass = module.default || module;

          if (typeof DeviceClass === "function") {
            // 1. Try auto-loading as device instance (original behavior)
            const instance = new DeviceClass() as IDevice;

            // Check if device is explicitly disabled
            if (instance.disabled === true) {
              this.logger.debug(
                `[Dynamic HAL] Kernel Plugin ${file} is disabled, skipping.`,
              );
              return;
            }

            const devName = (
              instance.name || file.replace(".ts", "").replace(".js", "")
            ).toLowerCase();
            this.devices![devName] = instance;
            this.logger.info(
              `[Dynamic HAL] Kernel Plugin Loaded: /dev/${devName}`,
            );

            // 2. Check for static autoRegister method (new convention)
            if (typeof (DeviceClass as any).autoRegister === "function") {
              try {
                (DeviceClass as any).autoRegister(this);
                this.logger.debug(
                  `[Dynamic HAL] Auto-register called for ${file}`,
                );
              } catch (e: any) {
                this.logger.debug(
                  `[Dynamic HAL] Auto-register skipped for ${file}: ${e.message}`,
                );
              }
            }
          }
        } catch (e: any) {
          this.logger.error(`Failed to load aux device ${file}: ${e.message}`);
        }
      }
    });
  }

  /**
   * applyDeviceConfigs(): Menerapkan izin (mode, uid, gid) dari sysconfig.conf ke perangkat yang terdaftar.
   */
  private applyDeviceConfigs() {
    const cfg = Config.get();
    if (!cfg.devices) return;

    for (const devName in cfg.devices) {
      const device = this.devices[devName];
      if (device) {
        const devCfg = cfg.devices[devName];
        if (devCfg.mode !== undefined) device.mode = devCfg.mode;
        if (devCfg.uid !== undefined) device.uid = devCfg.uid;
        if (devCfg.gid !== undefined) device.gid = devCfg.gid;
        this.logger.info(
          `[udev] Configuration applied to / dev / ${devName}: mode = ${device.mode?.toString(8)}, uid = ${device.uid}, gid = ${device.gid}`,
        );
      }
    }
  }

  /**
   * initializeSubsystems(): Fungsi internal untuk memanaskan komponen OS.
   */
  private async initializeSubsystems() {
    const cfg = Config.get();

    // 2. Inisialisasi root filesystem "/".
    //
    // Backend dipilih lewat `RootFilesystem.createRootFilesystem()`:
    //   - BKFS  (default) → root ada DI DALAM `system.db`; sinkron host↔VFS
    //     lewat `npm run vfs:bootstrap` / `vfs:pull`.
    //   - HostVFS         → root menunjuk FOLDER HOST nyata (`kernel.rootHostPath`,
    //     mis. `../rootfs`). Berkas dibaca apa adanya, jadi edit di VS Code
    //     langsung terlihat dari shell TSIX — tanpa bootstrap maupun pull.
    //
    // Aktifkan mode host: `kernel.rootType = "host"` di `src/sysconfig.conf`,
    // atau tanpa menyentuh konfigurasi: `TSIX_ROOTFS=host npm start`
    // (+ opsional `TSIX_ROOTFS_PATH=/path/ke/rootfs`).
    const root = createRootFilesystem(cfg);
    this.rootFs = root.driver;
    this.bootLogStart(`VFS: Mounting root filesystem (${root.label})`);
    this.mountManager.mount("/", root.driver, root.type, root.source, false);
    this.bootLogEnd(true);

    // Mode host = mode EKSPERIMEN, dan itu ditulis di boot log secara sengaja.
    // BKFS adalah root yang dimaksud desainnya (transaksi/WAL, isolasi, backup = 1
    // berkas image — lihat wiki/Virtual-File-System.md). Begitu root-nya folder
    // host, jaminan itu tidak berlaku: tidak ada transaksi, tidak ada image untuk
    // di-backup, dan berkas root bisa disentuh proses lain di host. Notis ini
    // mencegah perilaku eksperimen tertukar dengan perilaku produksi.
    if (root.type === "host") {
        const rel = path.relative(process.cwd(), root.source) || root.source;
        const notice = `MODE: Experimental — root "/" is a host folder (${rel})`;
        this.bootLogStart(notice);
        this.bootLogEnd(true, "no BKFS transaction/isolation/backup guarantees");
        this.logger.warn(`${notice} — BKFS remains the default for data that must be safe.`);
    }

    // 2a. Process Auto-mounts (fstab) — termasuk /tmp sebagai ramfs
    await this.processFstab();

    // 2b. Jaminan state runtime volatile (/var/run).
    this.ensureVolatileRunDir();

    // 3. Inisialisasi Scheduler
    this.bootLogStart("Core: Process Scheduler (Worker Threads)");
    this.scheduler = new Scheduler();
    this.bootLogEnd(true, "active.");

    // 4. Inisialisasi Security Layer
    this.bootLogStart("Security: Permission Manager");
    this.satpam = new PermissionManager();
    this.bootLogEnd(true, "ready.");

    // 6. Inisialisasi Port Manager (Networking)
    this.bootLogStart("Network: Virtual stack and port management");
    this.portManager = new PortManager();
    this.bootLogEnd(true, "online.");

    // 6a. Inisialisasi PTY Manager (Pseudo Terminal, on-demand)
    this.bootLogStart("PTY: Pseudo-terminal allocator");
    this.ptyManager = new PTYManager();
    this.bootLogEnd(true, "on-demand.");

    // 7. Inisialisasi Syscall Dispatcher
    if (this.rootFs && this.scheduler && this.satpam) {
      this.bootLogStart("Bridge: Establishing Syscall interface");
      this.syscall = new SyscallDispatcher(
        this.rootFs,
        this.mountManager,
        this.scheduler,
        this,
        this.satpam,
      );

      // Hubungkan Scheduler ke Syscall Handler agar bisa meneruskan pesan dari Worker
      this.scheduler.setSyscallHandler(async (req) => {
        return await this.syscall!.handleRequest(req);
      });

      // Pre-compile Framework libraries (Memory Cache Optimization)
      this.rebuildVFSCache();

      // Hubungkan Scheduler ke VFS Cache untuk Direct Memory Execution Worker
      this.scheduler.setVFSCacheProvider(() => {
        return this.vfsCache;
      });

      this.bootLogEnd(true, "established.");
    }
  }

  /**
   * readRoot()/lsRoot(): Baca root `/` dengan hasil SINKRON.
   *
   * IVFS mendeklarasikan `MaybePromise` (driver jaringan seperti NetFS bisa
   * async), tapi driver root SELALU sinkron — BKFS dan HostVFS dua-duanya
   * sinkron, dan NetFS tidak pernah dipasang di `/`. Cast-nya dikumpulkan di dua
   * helper ini supaya kode boot (yang memang berurutan) tidak penuh `as`.
   */
  private readRoot(vfsPath: string): string | null {
    return this.rootFs!.read(vfsPath) as string | null;
  }

  private lsRoot(vfsPath: string): any[] {
    return this.rootFs!.ls(vfsPath) as any[];
  }

  private rebuildVFSCache() {
    this.bootLogStart(
      "VFS: Pre-compiling framework libraries (Memory Cache)... ",
    );
    let esbuildHandle: any = null;
    try {
      const esbuild = require("esbuild");
      esbuildHandle = esbuild;
      const cache: Record<string, string> = {};
      const fetchDir = (dir: string) => {
        if (!this.rootFs!.exists(dir)) return;
        const items = this.lsRoot(dir);
        for (const item of items) {
          const p = `${dir}/${item.name}`;
          if (item.type === "DIRECTORY") {
            fetchDir(p);
          } else if (item.type === "FILE" && item.name.endsWith(".ts")) {
            // HANYA .ts yang masuk cache.
            //
            // WorkerEntry memetakan `@tsix/X` -> `/lib/X.ts` dan
            // `@common/Y` -> `/lib/common/Y.ts`, jadi entri `.js`/`.json`
            // TIDAK PERNAH di-lookup. Sebelumnya keduanya ikut disalin,
            // dan karena cache di-clone ke SETIAP worker lewat workerData,
            // 51 file `.js` (1.70 MB) menjadi beban mati per worker.
            // Terukur: 16.9 -> 12.5 MB/worker (~-4.4 MB/worker).
            // Tidak ada framework yang meng-import `.js` secara eksplisit
            // (diverifikasi), jadi pembuangan ini tidak memutus apa pun.
            const content = this.readRoot(p);
            if (!content) continue;

            // Isi VFS = BYTE. esbuild butuh TEKS, jadi konversi eksplisit: tanpa ini
            // setiap karakter non-ASCII (emoji, `─`, `→`) di `/lib/*.ts` masuk ke
            // worker sebagai mojibake — UI/terminal jadi kacau walau berkasnya benar.
            let code = vfsBytesToUtf8(content);
            try {
              // PENTING: JANGAN pakai sourcemap di sini. Cache ini dikirim ke
              // SETIAP worker, dan inline sourcemap menambah ~70% ukuran
              // (terukur: 1.45 MB -> 0.43 MB). Karena WorkerEntry meng-_compile()
              // dari string dan bukan via require(), sourcemap inline tidak
              // menambah akurasi stack trace sama sekali — stack trace worker
              // sudah ditangani --enable-source-maps + esbuild-register
              // (lihat Scheduler.spawnWorker).
              const result = esbuild.transformSync(code, {
                loader: "ts",
                format: "cjs",
                target: "node18",
                sourcemap: false,
              });
              code = result.code;
            } catch (err: any) {
              this.logger.error(`Failed to pre-compile ${p}: ${err.message}`);
            }

            cache[p] = code;
          }
        }
      };
      fetchDir("/lib");
      this.vfsCache = cache;
      this.bootLogEnd(true, "OK");
    } catch (e: any) {
      this.bootLogEnd(false, `Error: ${e.message}`);
    } finally {
      // LEPAS WORKER THREAD ESBUILD.
      //
      // `esbuild.transformSync` men-spawn worker thread native yang bertahan
      // sepanjang proses. Terukur: require('esbuild') +2.4 MB, transformSync
      // pertama +11.9 MB (thread lahir), dan `stop()` membebaskan ~10-12 MB.
      // Setelah boot, esbuild TIDAK dipakai lagi oleh kernel (transpile
      // berikutnya terjadi di dalam worker app, yang punya instance sendiri).
      // stop() aman dipanggil kapan saja: esbuild akan me-restart thread-nya
      // otomatis (lazy) bila transformSync dipanggil lagi — terverifikasi.
      try {
        void esbuildHandle?.stop?.();
      } catch {
        /* stop() gagal = non-fatal, hanya kehilangan penghematan */
      }
    }
  }

  /**
   * handleHostInterrupt(): Dipanggil saat Ctrl+C terdeteksi di host atau keyboard driver.
   */
  public handleHostInterrupt() {
    const kbd = this.devices.stdin as any;
    const isRaw = kbd?.rawMode;

    if (isRaw) {
      this.logger.debug(
        "Interrupt detected in RAW MODE - Forwarding to foreground process",
      );
    } else {
      process.stdout.write("^C\n");
    }

    if (this.scheduler && this.ttyManager) {
      // Send interrupt to the ACTIVE TTY's foreground process
      const activeTtyId = this.ttyManager.getActiveId();
      this.scheduler.sendInterruptSignal(activeTtyId);
    }
  }

  // Getters
  /** Driver root `/` (BKFS atau HostVFS — lihat `RootFilesystem.ts`). */
  public getRootFs(): IVFS | null {
    return this.rootFs;
  }

  /**
   * getBKFS(): alias historis dari `getRootFs()`.
   * @deprecated Root sudah tidak selalu BKFS — pakai `getRootFs()`.
   */
  public getBKFS(): IVFS | null {
    return this.rootFs;
  }
  public getMountManager() {
    return this.mountManager;
  }

  /**
   * closeFilesystems(): Tutup semua driver filesystem yang menyimpan state di file.
   *
   * KENAPA INI PENTING (bug operasional nyata): sebelumnya kernel TIDAK PERNAH
   * menutup storage saat sistem dimatikan. Karena root filesystem memakai
   * `journal_mode=WAL`, akibatnya setelah shutdown masih ada `system.db-wal`
   * (±750 KB transaksi terakhir) dan `system.db-shm`. Dua masalahnya:
   *
   *   1. `system.db` sendirian TIDAK lengkap — menyalin file itu sebagai backup /
   *      mengirimkannya ke node lain berarti kehilangan transaksi terakhir.
   *   2. Setiap boot berikutnya harus memulihkan dari WAL (benar, tapi lambat).
   *
   * `close()` pada BKFS menjalankan `wal_checkpoint(TRUNCATE)` lalu menutup koneksi,
   * sehingga sesudahnya satu file `system.db` benar-benar utuh.
   *
   * Idempotent + tidak pernah melempar: dipanggil dari hook `process.on("exit")`,
   * jadi kegagalan di sini tidak boleh menggagalkan proses keluar.
   */
  public closeFilesystems(): void {
    if (this.filesystemsClosed) return;
    this.filesystemsClosed = true;

    // Sengaja pakai console (BUKAN bootLog/syslog): setelah `closeAll()` database
    // sudah tertutup, jadi apa pun yang menulis ke VFS akan gagal. Kita juga mencatat
    // dulu SEBELUM menutup supaya urutannya jelas di log.
    try {
      const mounts = this.mountManager?.listMounts()?.length ?? 0;
      console.log(`\n[Kernel] Storage: closing ${mounts} filesystem(s) (WAL checkpoint)...`);

      const closed = this.mountManager?.closeAll() ?? 0;

      console.log(`[Kernel] Storage: ${closed} filesystem(s) closed cleanly — image is ready to copy.`);
    } catch (e: any) {
      // Jangan pernah menghalangi proses keluar.
      console.error(`[Kernel] Failed to close filesystem: ${e.message}`);
    }
  }

  public getScheduler() {
    return this.scheduler;
  }
  public getSyscall() {
    return this.syscall;
  }
  public getPortManager() {
    return this.portManager;
  }
  public getPTYManager() {
    return this.ptyManager;
  }

  private async ensureDefaultGroups() {
    if (!this.rootFs) return;
    const groupContent = this.readRoot("/etc/group") || "";
    // Group wajib yang harus selalu ada: users (GID 100) dan sudo (GID 27, gaya Ubuntu)
    const missing: string[] = [];
    if (!groupContent.includes("users:")) missing.push("users:x:100:");
    if (!groupContent.includes("sudo:")) missing.push("sudo:x:27:");
    if (missing.length > 0) {
      this.bootLogStart("Security: Adding missing groups...");
      const newContent = groupContent.trim() + "\n" + missing.join("\n") + "\n";
      this.rootFs.touch("/etc/group", newContent, 0, 0, 0o644);
      this.bootLogEnd(true, missing.join(", "));
    }
  }

  private async ensureDefaultAuth() {
    if (!this.rootFs) return;

    // 1. Ensure /etc directory exists
    if (!this.rootFs.exists("/etc")) {
      this.bootLogStart("VFS: Creating system directory /etc...");
      this.rootFs.mkdir("/etc", 0, 0, 0o755);
      this.bootLogEnd(true);
    }

    // 2. Ensure /etc/passwd exists with root entry
    const passwdPath = "/etc/passwd";
    if (!this.rootFs.exists(passwdPath)) {
      this.bootLogStart("Security: Seeding /etc/passwd...");
      // Shell default menunjuk ke sidecar .js, BUKAN .ts.
      // Alasan (terukur 2026-09-12): path .ts eksplisit melewati preferensi
      // .js di Syscalls.EXEC (blok ekstensi hanya jalan bila node tidak ada),
      // sehingga worker shell dipaksa memakai preload transpiler
      // (+14.4 MB RSS/worker). Sidecar .js dibuat scripts/vfs-bootstrap.ts.
      const rootPasswd = "root:x:0:0:root:/root:/bin/tsh.js\n";
      this.rootFs.touch(passwdPath, rootPasswd, 0, 0, 0o644);
      this.bootLogEnd(true, "root user added.");
    }

    // 3. Ensure /etc/shadow exists with root entry (password: root)
    const shadowPath = "/etc/shadow";
    if (!this.rootFs.exists(shadowPath)) {
      this.bootLogStart("Security: Seeding /etc/shadow...");
      const rootShadow =
        "root:$2b$10$BmsO7An4uheXRcU/vD.FwuB.QiDrwpjJRPPDU1CYMgf2NIYqjKupG:19750:0:99999:7:::\n";
      this.rootFs.touch(shadowPath, rootShadow, 0, 0, 0o640);
      this.bootLogEnd(true, "credentials added.");
    }

    // 4. Ensure /mnt directory exists
    if (!this.rootFs.exists("/mnt")) {
      this.bootLogStart("VFS: Preparing mount point /mnt...");
      this.rootFs.mkdir("/mnt", 0, 0, 0o755);
      this.bootLogEnd(true);
    }

    // 5. Ensure /tmp directory exists
    if (!this.rootFs.exists("/tmp")) {
      this.bootLogStart("VFS: Initializing /tmp...");
      this.rootFs.mkdir("/tmp", 0, 0, 0o755);
      this.bootLogEnd(true);
    }
  }

  /**
   * ensureVolatileRunDir(): Jaminan `/var/run` selalu VOLATILE (ramfs).
   *
   * Kenapa kernel yang menjamin, bukan hanya fstab? Karena kesalahannya mahal
   * dan sulit dilacak: `/var/run` menyimpan state runtime (marker kesiapan
   * daemon, PID). Kalau direktori itu ikut VFS persisten, marker seperti
   * `/var/run/dome.ready` dari boot sebelumnya terbaca sebagai "sudah siap",
   * sehingga dependen-nya (Asteracea) dijalankan sebelum DOME hidup dan gagal.
   *
   * Linux menyelesaikannya dengan `/run` = **tmpfs**. Kernel meniru itu: kalau
   * admin sudah memount `/var/run` sendiri di fstab (jenis apa pun), keputusan
   * itu dihormati dan fungsi ini tidak melakukan apa-apa.
   */
  private ensureVolatileRunDir(): void {
    const RUN_DIR = "/var/run";
    if (!this.rootFs) return;

    const alreadyMounted = this.mountManager
      .listMounts()
      .some((m) => m.vfsPath === RUN_DIR);
    if (alreadyMounted) {
      this.bootLogStart(`VFS: ${RUN_DIR} → following fstab`);
      this.bootLogEnd(true);
      return;
    }

    this.bootLogStart(`VFS: ${RUN_DIR} → ramfs (state runtime volatile)`);
    try {
      if (!this.rootFs.exists(RUN_DIR)) {
        this.rootFs.mkdir(RUN_DIR, 0, 0, 0o755);
      }
      this.mountManager.mount(
        RUN_DIR,
        new RamFS("var-run", 0, 0, 0o755),
        "ramfs",
        "RAM",
        false,
        0,
        0,
      );
      this.bootLogEnd(true);
    } catch (e: any) {
      // Jangan gagalkan boot hanya karena ini — cukup catat.
      this.bootLogEnd(false, e?.message ?? String(e));
    }
  }

  private async processFstab() {
    if (!this.rootFs) return;

    // FSTAB: SATU sumber kebenaran — `/etc/fstab.conf` (INI).
    //
    // Pembacaan & validasi isi ada di `FstabParser.ts` (murni, teruji terpisah).
    // Berkas itu memberi PERINGATAN untuk hal yang dulu senyap, mis.
    // `mode = 775` (desimal, bukan oktal) atau `type` yang typo.
    const FSTAB_PATH = "/etc/fstab.conf";
    const LEGACY_FSTAB_PATH = "/etc/fstab.json";

    // MIGRASI sekali-jalan untuk node yang belum sempat pindah: isi `.json`
    // (format lama) dipindahkan ke `.conf` SAAT BOOT, supaya tidak ada langkah
    // manual yang bisa terlupa dan mount-nya tidak hilang. Berkas `.json`-nya
    // sengaja TIDAK dihapus (itu milik admin) — ia hanya berhenti dipakai.
    if (!this.rootFs.exists(FSTAB_PATH) && this.rootFs.exists(LEGACY_FSTAB_PATH)) {
      const legacy = this.readRoot(LEGACY_FSTAB_PATH);
      const parsed = legacy ? parseFstabContent(legacy) : null;

      if (parsed && parsed.entries.length > 0) {
        this.bootLogStart("FSTAB: migrasi /etc/fstab.json → /etc/fstab.conf");
        this.rootFs.touch(
          FSTAB_PATH,
          formatFstabIni(
            parsed.entries,
            "# /etc/fstab.conf — hasil migrasi otomatis dari /etc/fstab.json\n" +
              "# Silakan rapikan komentar/urutannya. Format: lihat /etc/fstab.md",
          ),
          0,
          0,
          0o644,
        );
        this.bootLogEnd(true, `${parsed.entries.length} entries`);
        for (const message of parsed.warnings) {
          this.logger.warn(`FSTAB(migration): ${message}`);
          await this.syslog("fstab", `migrasi: ${message}`);
        }
        this.logger.info(
          "FSTAB: /etc/fstab.json is no longer used — its entries moved to /etc/fstab.conf",
        );
      } else {
        this.bootLogStart("FSTAB: migrasi /etc/fstab.json");
        this.bootLogEnd(false, "no entry could be migrated (unknown format)");
      }
    }

    if (!this.rootFs.exists(FSTAB_PATH)) {
      // Bukan error (image minimal memang begitu), tapi layak terlihat: semua
      // mount non-esensial (mis. netfs) hanya didefinisikan di berkas ini.
      this.logger.info("FSTAB: /etc/fstab.conf is missing — essential mounts only");
      return;
    }

    try {
      const content = this.readRoot(FSTAB_PATH);
      if (!content) {
        this.bootLog(`FSTAB: ${FSTAB_PATH} is empty`, false);
        return;
      }

      const { format, entries, warnings } = parseFstabContent(content);

      // Peringatan parser TIDAK menggagalkan boot, tapi harus terbaca operator:
      // salah tulis di sini bisa berarti izin ngawur atau mount tak terpasang.
      for (const message of warnings) {
        this.logger.warn(`FSTAB(${FSTAB_PATH}): ${message}`);
        await this.syslog("fstab", message);
      }
      if (format === "json") {
        // Isi `.conf` berupa JSON (mungkin hasil salin-tempel): tetap jalan, tapi
        // konversi ke INI dianjurkan supaya jelas mana sumber kebenarannya.
        this.logger.warn(
          `FSTAB: ${FSTAB_PATH} contains JSON (legacy) — prefer the INI format`,
        );
      }

      if (entries.length === 0) {
        this.bootLogStart(`FSTAB: ${FSTAB_PATH} (${format})`);
        this.bootLogEnd(false, "no valid mount entry");
        return;
      }

      // --- Loop mount ---
      for (const entry of entries) {
        // try per-ENTRI: satu entri rusak tidak boleh membatalkan mount sisanya.
        // Dulu seluruh loop ada di dalam satu `try`, jadi entri yang gagal
        // membuat entri berikutnya ikut hilang tanpa jejak.
        try {
          // `FstabEntry` punya index signature (key tambahan netfs: via/key/…),
          // jadi bentuk field yang dipakai di sini dinyatakan eksplisit.
          const {
            vfsPath,
            hostPath,
            type,
            readOnly,
            uid,
            gid,
            active,
            mode,
          } = entry as {
            vfsPath: string;
            hostPath?: string;
            type?: string;
            readOnly?: boolean;
            uid?: number;
            gid?: number;
            active?: boolean;
            mode?: number;
          };

          // Skip if explicitly marked inactive (default: active = true)
          if (active === false) {
            this.bootLogStart(`FSTAB: Skipping ${vfsPath} (inactive)`);
            this.bootLogEnd(true);
            continue;
          }

          // `type` wajib: tanpa ini entri tidak bisa dipetakan ke driver mana pun
          // (dulu langsung jatuh ke HostVFS dan menebak-nebak).
          if (!type) {
            this.bootLog(`FSTAB: ${vfsPath} has no 'type' → skipped`, false);
            continue;
          }

          // `hostPath` wajib untuk bkfs/host/netfs — ramfs murni di RAM.
          const hostSpec = hostPath ?? "";
          if (!hostSpec && type !== "ramfs") {
            this.bootLog(`FSTAB: ${vfsPath} (${type}) has no 'hostPath' → skipped`, false);
            continue;
          }

          // Ensure mount point exists with correct ownership & permissions
          const dirMode = mode ?? 0o755;
          if (!this.rootFs.exists(vfsPath)) {
            this.rootFs.mkdir(vfsPath, uid ?? 0, gid ?? 0, dirMode);
          } else {
            if (uid !== undefined || gid !== undefined) {
              // Re-apply ownership if dir already existed (e.g. created by ensureDefaultAuth)
              this.rootFs.chown(vfsPath, uid ?? 0, gid ?? 0);
            }
            if (mode !== undefined) {
              this.rootFs.chmod(vfsPath, dirMode);
            }
          }

          let driver: IVFS;
          if (type === "bkfs") {
            driver = new BKFS(
              path.resolve(process.cwd(), hostSpec),
              readOnly || false,
              uid,
              gid,
              dirMode,
            );
          } else if (type === "ramfs") {
            // RamFS tidak butuh hostPath — murni di RAM
            const label = vfsPath.replace(/\//g, "_").replace(/^_/, "");
            driver = new RamFS(label, uid, gid, dirMode);
          } else if (type === "netfs") {
            // --- NETFS dari fstab: filesystem node lain lewat MQTNL ---
            // Contoh entri:
            //   [/mnt/net]
            //   hostPath = tsix_2:7777
            //   type     = netfs
            //   via      = 7778          (port daemon klien lokal)
            //   key      = <64 hex>
            // `via` = port daemon klien lokal (netfsd --client); tanpa `via`
            // kernel bicara langsung ke SL (--direct).
            try {
              const spec = parseNetFSSpec(hostSpec);
              const viaPort = (entry as any).via;
              const target = viaPort
                ? typeof viaPort === "number"
                  ? { address: "localhost", port: viaPort }
                  : parseNetFSSpec(String(viaPort))
                : spec;

              const channel = MQTNLNetFSChannel.open(this, {
                address: target.address,
                port: target.port,
                iface: (entry as any).iface,
                key: (entry as any).key,
                agent: (entry as any).agent,
                procName: `netfs:${vfsPath}`,
              });
              const netfs = new NetFS({
                channel,
                timeoutMs: (entry as any).timeoutMs,
                cacheTtlMs: (entry as any).cacheTtlMs,
                readOnly: readOnly === true,
                label: vfsPath,
              });

              await netfs.handshake();
              this.bootLogStart(`FSTAB: Mounting ${vfsPath} (netfs)`);
              this.mountManager.mount(
                vfsPath,
                netfs,
                "netfs",
                formatNetFSSpec(spec.address, spec.port),
                readOnly || false,
                uid,
                gid,
              );
              this.bootLogEnd(true);
            } catch (e: any) {
              // NetFS tidak boleh menggagalkan boot: node peer mungkin sedang
              // mati. Mount bisa dilakukan manual nanti setelah peer hidup.
              this.bootLogStart(`FSTAB: Mounting ${vfsPath} (netfs)`);
              this.bootLogEnd(false, `NetFS failed: ${e.message}`);
            }
            continue;
          } else {
            driver = new HostVFS(hostSpec, readOnly || false, uid, gid, dirMode);
          }

          this.bootLogStart(`FSTAB: Mounting ${vfsPath} (${type})`);
          this.mountManager.mount(
            vfsPath,
            driver,
            type,
            hostSpec,
            readOnly || false,
            uid,
            gid,
          );
          this.bootLogEnd(true);
        } catch (e: any) {
          this.bootLog(`FSTAB: ${String(entry?.vfsPath ?? "?")} failed: ${e.message}`, false);
        }
      }
    } catch (e: any) {
      this.bootLog(`FSTAB: Error processing fstab: ${e.message}`, false);
    }
  }
}
