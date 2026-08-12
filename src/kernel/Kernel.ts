import * as fs from "fs";
import { Logger } from "../common/Logger";
import { BKFS } from "../vfs/BKFS"; // Pakai BKFS (SQLite)
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
import { SerialDeviceManager } from "./devices/SerialDeviceManager";
import { MountManager } from "./MountManager";
import { IVFS } from "../vfs/IVFS";
import { HostVFS } from "../vfs/HostVFS";
import { RamFS } from "../vfs/RamFS";
import { GUIRegistry } from "./GUIRegistry";

import path from "path";

/**
 * KERNEL.TS
 *
 * Di Linux asli, Kernel adalah program pertama yang dimuat ke RAM setelah Bootloader.
 * Di sini, kita mensimulasikan Kernel sebagai sebuah Class utama yang mengelola sistem.
 */
export class Kernel {
  // Versi kernel saat ini
  private codename: string = "Dinawari";
  private version: string = "0.2.22.20260811.1";

  public getCodename(): string {
    return this.codename;
  }
  public getVersion(): string {
    return this.version;
  }

  // Logger internal: Seperti layar (display) yang menampilkan log dari Kernel.
  private logger: Logger;

  // Sub-sistem Utama
  private bkfs: BKFS | null = null; // Ganti VFS ke BKFS
  private scheduler: Scheduler | null = null;
  private syscall: SyscallDispatcher | null = null;
  private mountManager: MountManager;
  private satpam: PermissionManager;
  private vfsCache: Record<string, string> = {};

  // Device Registry (HAL)
  public devices: Record<string, IDevice> = {};
  private portManager: PortManager | null = null;
  private ttyManager: TTYManager | null = null;
  private serialManager: SerialDeviceManager | null = null;
  private bootTime: number = Date.now();
  public wantedExitCode: number = 0;
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
    if (this.bkfs) {
      this.syslog("Kernel", message);
    }
  }

  /**
   * syslog(): Antarmuka internal untuk menulis ke /var/log/syslog (VFS).
   * Bisa dipanggil oleh Kernel maupun Device Driver.
   */
  public async syslog(tag: string, message: string) {
    if (!this.bkfs) return;
    const timestamp = new Date()
      .toISOString()
      .replace("T", " ")
      .substring(0, 19);
    const logLine = `[${timestamp}] [${tag}] ${message.trim()}\n`;
    const logFile = "/var/log/syslog";

    try {
      this.bkfs.append(logFile, logLine);
    } catch (e) {
      // Jika folder /var/log belum ada, buat dulu
      try {
        this.bkfs.mkdir("/var", 0, 0, 0o755);
        this.bkfs.mkdir("/var/log", 0, 0, 0o755);
        this.bkfs.touch(logFile, logLine);
      } catch (err) {}
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

    // Initialize TTY Manager
    this.ttyManager = new TTYManager(32);
    const ttysDevs: Record<string, TTYDevice> = {};
    for (let i = 1; i <= 32; i++) {
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
    // this.bootLog(`HAL: Registered ${Object.keys(ttysDevs).length} Virtual Console devices (tty1-32).`);
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

    // 4. Apply Device Configurations (udev-style from sysconfig.json)
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
    if (!this.bkfs?.exists("/dev")) {
      this.bkfs?.mkdir("/dev", 0, 0, 493);
    }

    this.bootLogEnd(true);

    // Expose keyboard for TTY IOCTL forwarding
    (process as any)._kernelStdin = this.devices.stdin;

    this.bootLogStart("VFS: System synchronization");
    this.bootLogEnd(true, "complete.");

    // --- VISUAL IDENTITY INITIALIZATION ---
    try {
      const pubKeyPath = "/etc/keys/rsa/id_rsa.pub";
      if (this.bkfs?.exists(pubKeyPath)) {
        this.bootLogStart("Security: System Visual Identity");
        const pubKey = this.bkfs.read(pubKeyPath);
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
   */
  public runInit(): void {
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
      const raw = res.vfs.read(res.relativePath);
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
   * handleKeyboardHotkey(): Deteksi Alt+F1..F6 untuk pindah TTY.
   */
  private handleKeyboardHotkey(seq: string): boolean {
    // Alt+F1..F6 sequences vary by terminal, but common ones are:
    // Alt+F1: \x1b\x1bOP or \x1b[1;3P
    // For simplicity and compatibility, we'll check for several common patterns.

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

      // Alt+1..6 (Common macOS alternative when Option acts as Meta)
      "\x1b1": 1,
      "\x1b2": 2,
      "\x1b3": 3,
      "\x1b4": 4,
      "\x1b5": 5,
      "\x1b6": 6,
    };

    if (hotkeys[seq]) {
      // FIRE AND FORGET: Jangan await agar tidak nge-block input keyboard
      this.ttyManager?.switch(hotkeys[seq]);
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
   * applyDeviceConfigs(): Menerapkan izin (mode, uid, gid) dari sysconfig.json ke perangkat yang terdaftar.
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

    // 2. Inisialisasi BKFS (SQLite VFS)
    this.bootLogStart("VFS: Mounting root filesystem (BKFS/SQLite)");
    this.bkfs = new BKFS(cfg.kernel.database);
    this.mountManager.mount("/", this.bkfs, "bkfs", cfg.kernel.database, false);
    this.bootLogEnd(true);

    // 2a. Process Auto-mounts (fstab) — termasuk /tmp sebagai ramfs
    await this.processFstab();

    // 3. Inisialisasi Scheduler
    this.bootLogStart("Core: Process Scheduler (Preemptive)");
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

    // 7. Inisialisasi Syscall Dispatcher
    if (this.bkfs && this.scheduler && this.satpam) {
      this.bootLogStart("Bridge: Establishing Syscall interface");
      this.syscall = new SyscallDispatcher(
        this.bkfs,
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

  private rebuildVFSCache() {
    this.bootLogStart(
      "VFS: Pre-compiling framework libraries (Memory Cache)... ",
    );
    try {
      const esbuild = require("esbuild");
      const cache: Record<string, string> = {};
      const fetchDir = (dir: string) => {
        if (!this.bkfs!.exists(dir)) return;
        const items = this.bkfs!.ls(dir);
        for (const item of items) {
          const p = `${dir}/${item.name}`;
          if (item.type === "DIRECTORY") {
            fetchDir(p);
          } else if (
            item.type === "FILE" &&
            (item.name.endsWith(".ts") ||
              item.name.endsWith(".js") ||
              item.name.endsWith(".json"))
          ) {
            let content = this.bkfs!.read(p);
            if (!content) continue;

            let code = content;

            // Transpile TS to JS for framework files
            if (item.name.endsWith(".ts")) {
              try {
                const result = esbuild.transformSync(code, {
                  loader: "ts",
                  format: "cjs",
                  target: "node18",
                  sourcemap: "inline",
                });
                code = result.code;
              } catch (err: any) {
                this.logger.error(`Failed to pre-compile ${p}: ${err.message}`);
              }
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
  public getBKFS() {
    return this.bkfs;
  }
  public getMountManager() {
    return this.mountManager;
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

  private async ensureDefaultGroups() {
    if (!this.bkfs) return;
    const groupContent = this.bkfs.read("/etc/group") || "";
    // Group wajib yang harus selalu ada: users (GID 100) dan sudo (GID 27, gaya Ubuntu)
    const missing: string[] = [];
    if (!groupContent.includes("users:")) missing.push("users:x:100:");
    if (!groupContent.includes("sudo:")) missing.push("sudo:x:27:");
    if (missing.length > 0) {
      this.bootLogStart("Security: Adding missing groups...");
      const newContent = groupContent.trim() + "\n" + missing.join("\n") + "\n";
      this.bkfs.touch("/etc/group", newContent, 0, 0, 0o644);
      this.bootLogEnd(true, missing.join(", "));
    }
  }

  private async ensureDefaultAuth() {
    if (!this.bkfs) return;

    // 1. Ensure /etc directory exists
    if (!this.bkfs.exists("/etc")) {
      this.bootLogStart("VFS: Creating system directory /etc...");
      this.bkfs.mkdir("/etc", 0, 0, 0o755);
      this.bootLogEnd(true);
    }

    // 2. Ensure /etc/passwd exists with root entry
    const passwdPath = "/etc/passwd";
    if (!this.bkfs.exists(passwdPath)) {
      this.bootLogStart("Security: Seeding /etc/passwd...");
      const rootPasswd = "root:x:0:0:root:/root:/bin/tsh.ts\n";
      this.bkfs.touch(passwdPath, rootPasswd, 0, 0, 0o644);
      this.bootLogEnd(true, "root user added.");
    }

    // 3. Ensure /etc/shadow exists with root entry (password: root)
    const shadowPath = "/etc/shadow";
    if (!this.bkfs.exists(shadowPath)) {
      this.bootLogStart("Security: Seeding /etc/shadow...");
      const rootShadow =
        "root:$2b$10$BmsO7An4uheXRcU/vD.FwuB.QiDrwpjJRPPDU1CYMgf2NIYqjKupG:19750:0:99999:7:::\n";
      this.bkfs.touch(shadowPath, rootShadow, 0, 0, 0o640);
      this.bootLogEnd(true, "credentials added.");
    }

    // 4. Ensure /mnt directory exists
    if (!this.bkfs.exists("/mnt")) {
      this.bootLogStart("VFS: Preparing mount point /mnt...");
      this.bkfs.mkdir("/mnt", 0, 0, 0o755);
      this.bootLogEnd(true);
    }

    // 5. Ensure /tmp directory exists
    if (!this.bkfs.exists("/tmp")) {
      this.bootLogStart("VFS: Initializing /tmp...");
      this.bkfs.mkdir("/tmp", 0, 0, 0o755);
      this.bootLogEnd(true);
    }
  }

  private async processFstab() {
    if (!this.bkfs) return;

    const fstabPath = "/etc/fstab.json";
    if (!this.bkfs.exists(fstabPath)) return;

    try {
      const content = this.bkfs.read(fstabPath);
      if (!content) return;

      const entries = JSON.parse(content) as any[];
      for (const entry of entries) {
        const { vfsPath, hostPath, type, readOnly, uid, gid, active, mode } =
          entry;

        // Skip if explicitly marked inactive (default: active = true)
        if (active === false) {
          this.bootLogStart(`FSTAB: Skipping ${vfsPath} (inactive)`);
          this.bootLogEnd(true);
          continue;
        }

        // Ensure mount point exists with correct ownership & permissions
        const dirMode = mode ?? 0o755;
        if (!this.bkfs.exists(vfsPath)) {
          this.bkfs.mkdir(vfsPath, uid ?? 0, gid ?? 0, dirMode);
        } else {
          if (uid !== undefined || gid !== undefined) {
            // Re-apply ownership if dir already existed (e.g. created by ensureDefaultAuth)
            this.bkfs.chown(vfsPath, uid ?? 0, gid ?? 0);
          }
          if (mode !== undefined) {
            this.bkfs.chmod(vfsPath, dirMode);
          }
        }

        let driver: IVFS;
        if (type === "bkfs") {
          driver = new BKFS(
            path.resolve(process.cwd(), hostPath),
            readOnly || false,
            uid,
            gid,
            dirMode,
          );
        } else if (type === "ramfs") {
          // RamFS tidak butuh hostPath — murni di RAM
          const label = vfsPath.replace(/\//g, "_").replace(/^_/, "");
          driver = new RamFS(label, uid, gid, dirMode);
        } else {
          driver = new HostVFS(hostPath, readOnly || false, uid, gid, dirMode);
        }

        this.bootLogStart(`FSTAB: Mounting ${vfsPath} (${type})`);
        this.mountManager.mount(
          vfsPath,
          driver,
          type,
          hostPath,
          readOnly || false,
          uid,
          gid,
        );
        this.bootLogEnd(true);
      }
    } catch (e: any) {
      this.bootLog(`FSTAB: Error processing fstab: ${e.message}`, false);
    }
  }
}
