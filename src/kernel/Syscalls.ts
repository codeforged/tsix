import { Logger } from "../common/Logger";
import { BKFS } from "../vfs/BKFS";
import { IVFS } from "../vfs/IVFS";
import { Scheduler } from "./Scheduler";
import { IDevice } from "./devices/IDevice";
import { FileSystemDevice } from "./devices/FileSystemDevice";
import { PathResolver } from "../common/PathResolver";
import { VNodeType } from "../vfs/VFS";
import { Permission, PermissionManager } from "./PermissionManager";
import { Config } from "../common/Config";
import { SyscallRequest } from "../common/IPCTypes";
import { SyscallCode } from "../common/SyscallCode";
import { PacketFlags } from "../common/PacketFlags";
import { SocketDevice } from "./devices/SocketDevice";
import { SimpleMQTNLDriver } from "./devices/SimpleMQTNLDriver";
import { PipeDevice } from "./devices/PipeDevice";
import * as fs from "fs";
import * as path from "path";
import { TTYDevice } from "./devices/TTYDevice";
import { PTYSlaveDevice } from "./devices/PTYSlaveDevice";
import { PTYDevice } from "./devices/PTYDevice";
import { MountManager } from "./MountManager";
import { HostVFS } from "../vfs/HostVFS";
import { RamFS } from "../vfs/RamFS";
import { GUIAction, IGUIPayload } from "../common/GUITypes";
import { v4 as uuidv4 } from "uuid";

/**
 * SYSCALL DISPATCHER
 */
export class SyscallDispatcher {
  private logger: Logger;
  private bkfs: BKFS;
  private mountManager: MountManager;
  private scheduler: Scheduler;
  private satpam: PermissionManager;
  private kernel: any;

  // --- DB Service daemon (transport alternatif untuk /dev/mysql) ---
  private dbServicePid: number | null = null;
  private pendingDbRequests: Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  > = new Map();

  // Network Sniffer (bitshark): interfaceName ("*" = semua) → (PID → izin).
  // Izin: { root: apakah pendaftar root, decrypt: apakah MINTA hasil dekripsi }.
  // Plaintext hanya dikirim jika root && decrypt (opt-in eksplisit via --decrypt).
  private netSniffers: Map<
    string,
    Map<number, { root: boolean; decrypt: boolean }>
  > = new Map();
  // Driver yang sudah di-wire onSniff (hindari duplikat callback)
  private wiredSniffers = new Set<SimpleMQTNLDriver>();

  constructor(
    bkfs: BKFS,
    mountManager: MountManager,
    scheduler: Scheduler,
    kernel: any,
    satpam: PermissionManager,
  ) {
    this.logger = new Logger("SyscallHandler");
    this.bkfs = bkfs;
    this.mountManager = mountManager;
    this.scheduler = scheduler;
    this.satpam = satpam;
    this.kernel = kernel;


    // Register Global Exit Hook: Cleanup resources on ANY process exit
    this.scheduler.setOnProcessExit(async (pid) => {
      const pcb = this.scheduler.getProcess(pid);
      if (pcb) {
        this.logger.debug(`Cleaning up resources for PID ${pid}...`);
        // Close all open FDs (release port via network cleanup)
        for (let fd = 0; fd < pcb.fdTable.length; fd++) {
          if (pcb.fdTable[fd]) {
            try {
              // We use the dispatch logic directly to trigger refcount decrements
              await this.dispatch(pid, SyscallCode.CLOSE, fd);
            } catch (e) {
              // Ignore errors during mass cleanup
            }
          }
        }

        // === Force release semua port milik PID ini ===
        // (antisipasi kalo ada socket yang kelewat cleanup-nya)
        try {
          this.kernel.getPortManager().releasePortsByPid(pid);
        } catch (_) { }

        // --- GUI Cleanup ---
        const guiRegistry = this.kernel.guiRegistry;
        if (guiRegistry) {
          const ownedWindows = guiRegistry.destroyAllForPid(pid);
          if (ownedWindows.length > 0) {
            const guedPid = guiRegistry.getDaemonPid();
            if (guedPid !== null) {
              for (const wid of ownedWindows) {
                this.scheduler.sendEvent(guedPid, "gui_request", {
                  syscall: "GUI_REQ",
                  pid,
                  wid,
                  action: GUIAction.DESTROY_WINDOW,
                } as IGUIPayload);
              }
            }
          }
        }
      }

      const keyboard = this.kernel.devices?.stdin as any;
      if (keyboard && keyboard.reset) {
        keyboard.reset();
      }

      // --- DB Service cleanup: daemon mati → reset + reject pending ---
      if (this.dbServicePid === pid) {
        this.dbServicePid = null;
        for (const [, pending] of this.pendingDbRequests) {
          pending.reject(new Error("DB_SERVICE: daemon exited"));
        }
        this.pendingDbRequests.clear();
      }

      // --- DB per-PID cleanup: app pemakai DB mati → lepas koneksinya ---
      // (daemon: kirim event "cleanup"; device fallback: release(pid))
      if (this.dbServicePid !== null && this.dbServicePid !== pid) {
        this.scheduler.sendEvent(this.dbServicePid, "db_request", {
          op: "cleanup",
          pid,
          args: null,
        });
      }
      const mysqlDev = this.kernel.devices?.mysql as any;
      if (mysqlDev && typeof mysqlDev.release === "function") {
        mysqlDev.release(pid).catch(() => { });
      }

      // --- Network Sniffer cleanup: proses mati → lepas dari semua interface ---
      for (const [iface, set] of this.netSniffers) {
        if (set.has(pid)) {
          set.delete(pid);
          if (set.size === 0) this.netSniffers.delete(iface);
        }
      }
    });
  }

  private isRoot(pcb: any): boolean {
    return pcb.uid === 0 || (pcb.groups && pcb.groups.includes(0));
  }

  /**
   * forwardDbRequest(): Kirim request DB ke service daemon (transport alternatif).
   * Daftarkan requestId → pending, kirim event "db_request", tunggu DB_SERVICE_REPLY.
   */
  private async forwardDbRequest(
    pid: number,
    op: string,
    args: any,
  ): Promise<any> {
    const requestId = uuidv4();
    return new Promise<any>((resolve, reject) => {
      this.pendingDbRequests.set(requestId, { resolve, reject });
      const sent = this.scheduler.sendEvent(this.dbServicePid!, "db_request", {
        requestId,
        pid,
        op,
        args,
      });
      if (!sent) {
        this.pendingDbRequests.delete(requestId);
        this.dbServicePid = null;
        reject(new Error("DB_SERVICE: daemon tidak dapat dijangkau"));
      }
    });
  }

  /**
   * forwardSniff(): Teruskan paket sniffer ke semua PID yang terdaftar untuk
   * interface tsb (atau "*" = semua interface).
   *
   * PEMFILTERAN PRIVILEGE (anti sadap plaintext):
   *   - Default SEMUA (termasuk root) menerima `data` = `raw` (payload di wire,
   *     masih encrypted) — mode "encrypted".
   *   - Hanya ROOT yang MENYADARI meminta (`--decrypt`) menerima `data` = hasil
   *     dekripsi (plaintext) — mode "decrypted". Dekripsi adalah keputusan sadar.
   * App menerima via lib.onEvent("ipc_message") → msg.data.type === "NET_SNIFF".
   */
  private forwardSniff(sniff: any): void {
    if (!sniff || !sniff.iface) return;

    // Gabungkan pendaftar dari "*" dan interface spesifik → (PID → izin).
    const privilege = new Map<number, { root: boolean; decrypt: boolean }>();
    const merge = (m?: Map<number, { root: boolean; decrypt: boolean }>) => {
      if (!m) return;
      for (const [pid, rec] of m) {
        const prev = privilege.get(pid);
        if (prev === undefined) {
          privilege.set(pid, { root: rec.root, decrypt: rec.decrypt });
        } else {
          // Konservatif: root = SEMUA pendaftaran harus root; decrypt = cukup
          // satu pendaftaran yang minta (PID yang sama, root-nya konsisten).
          prev.root = prev.root && rec.root;
          prev.decrypt = prev.decrypt || rec.decrypt;
        }
      }
    };
    merge(this.netSniffers.get("*"));
    merge(this.netSniffers.get(sniff.iface));

    for (const [pid, rec] of privilege) {
      const canDecrypt = rec.root && rec.decrypt;
      // Label "decrypted" HANYA jujur jika driver BENAR-BENAR mendekripsi data
      // (sniff.decrypted). Kalau driver tidak punya kunci utk port itu (mis.
      // trafik air-type server yang dekripsi manual di app), data tetap ciphertext
      // → ditampilkan mentah dengan label "encrypted", walau root meminta --decrypt.
      const actuallyDecrypted = canDecrypt && sniff.decrypted === true;
      let payload: any;
      if (actuallyDecrypted) {
        payload = { ...sniff, mode: "decrypted" };
      } else {
        const raw = sniff.raw;
        payload = {
          ...sniff,
          data: raw === undefined || raw === null ? "(encrypted)" : String(raw),
          size: raw === undefined || raw === null ? 0 : String(raw).length,
          mode: "encrypted",
        };
      }
      this.scheduler.sendEvent(pid, "ipc_message", { data: payload });
    }
  }

  /**
   * ensureSnifferWiring(): Wire onSniff tiap SimpleMQTNLDriver ke forwardSniff.
   * Dipanggil saat app mendaftar sniffer — saat itu device network sudah pasti
   * ter-registrasi (boot: initializeSubsystems → register devices).
   */
  private ensureSnifferWiring(): void {
    for (const key in this.kernel.devices) {
      const dev = this.kernel.devices[key];
      if (dev instanceof SimpleMQTNLDriver && !this.wiredSniffers.has(dev)) {
        this.wiredSniffers.add(dev);
        dev.onSniff((sniff: any) => this.forwardSniff(sniff));
      }
    }
  }

  public async handleRequest(req: SyscallRequest): Promise<any> {
    const silentCodes = [
      SyscallCode.READ,
      SyscallCode.PS,
      SyscallCode.GETCWD,
      SyscallCode.WHOAMI,
    ];
    if (!silentCodes.includes(req.code)) {
      this.logger.debug(
        `[IPC] PID ${req.pid} Request: ${SyscallCode[req.code]} (${req.requestId})`,
      );
    }

    try {
      this.validateArgs(req.code, req.args);
      return await this.dispatch(req.pid, req.code, req.args);
    } catch (e: any) {
      this.logger.error(
        `Syscall Error [${SyscallCode[req.code]}]: ${e.message}`,
      );
      throw e;
    }
  }

  /**
   * validateArgs(): Memastikan data dari userland tidak "ajaib" atau bikin kernel bingung.
   */
  private validateArgs(code: SyscallCode, args: any) {
    // 1. Check if args exists if expected (basic check)
    const needsArgs = [
      SyscallCode.WRITE,
      SyscallCode.OPEN,
      SyscallCode.MKDIR,
      SyscallCode.CHDIR,
      SyscallCode.EXEC,
      SyscallCode.KILL,
      SyscallCode.WAITPID,
      SyscallCode.SIGNAL,
      SyscallCode.IOCTL,
      SyscallCode.CHMOD,
      SyscallCode.CHOWN,
      SyscallCode.SETUID,
      SyscallCode.SETGID,
      SyscallCode.UNLINK,
      SyscallCode.RMDIR,
      SyscallCode.SEND_MSG,
      SyscallCode.BIND,
      SyscallCode.SENDTO,
      SyscallCode.SETENV,
      SyscallCode.SYNC_TO_HOST,
      SyscallCode.REEXEC,
      SyscallCode.SYNC_FROM_HOST,
      SyscallCode.MOUNT,
      SyscallCode.GUI_REQ,
      SyscallCode.SET_IDENTITY,
      SyscallCode.READ_CHUNK,
      SyscallCode.WRITE_CHUNK,
      SyscallCode.GET_SIZE,
      SyscallCode.PTY_ALLOC,
      SyscallCode.PTY_FREE,
    ];

    if (needsArgs.includes(code) && (args === undefined || args === null)) {
      throw new Error(`Syscall ${SyscallCode[code]} requires arguments.`);
    }

    // 2. Specific type checks
    switch (code) {
      case SyscallCode.WRITE:
        if (typeof args === "object" && args.pid !== undefined) {
          if (args.content === undefined)
            throw new Error(
              "Invalid WRITE arguments: content missing for PID-based route",
            );
        } else if (typeof args.fd !== "number" || args.content === undefined) {
          throw new Error("Invalid WRITE arguments: fd must be numeric");
        }
        break;
      case SyscallCode.READ:
        if (
          typeof args !== "number" &&
          (typeof args !== "object" || args.pid === undefined)
        ) {
          throw new Error(
            `Syscall ${SyscallCode[code]} expects a numeric argument or bridge object`,
          );
        }
        break;
      case SyscallCode.CLOSE:
      case SyscallCode.WAITPID:
      case SyscallCode.KILL:
      case SyscallCode.PTY_FREE:
        if (typeof args !== "number")
          throw new Error(
            `Syscall ${SyscallCode[code]} expects a numeric argument`,
          );
        break;
      case SyscallCode.OPEN:
        if (
          typeof args !== "string" &&
          (typeof args !== "object" || !args.path)
        )
          throw new Error("Invalid OPEN arguments");
        break;
      case SyscallCode.BIND:
        if (typeof args.fd !== "number" || typeof args.port !== "number")
          throw new Error("Invalid BIND arguments");
        break;
      case SyscallCode.SENDTO:
        if (
          typeof args.fd !== "number" ||
          !args.address ||
          typeof args.port !== "number"
        )
          throw new Error("Invalid SENDTO arguments");
        break;
      case SyscallCode.EXEC:
      case SyscallCode.REEXEC:
        if (!args.path || !Array.isArray(args.args))
          throw new Error(`Invalid ${SyscallCode[code]} arguments`);
        break;
      case SyscallCode.READ_CHUNK:
        if (
          !args.path ||
          typeof args.offset !== "number" ||
          typeof args.length !== "number"
        ) {
          throw new Error("READ_CHUNK requires { path, offset, length }");
        }
        break;
      case SyscallCode.WRITE_CHUNK:
        if (
          !args.path ||
          args.chunk === undefined ||
          typeof args.offset !== "number"
        ) {
          throw new Error("WRITE_CHUNK requires { path, chunk, offset }");
        }
        break;
      case SyscallCode.SYNC_TO_HOST:
      case SyscallCode.SYNC_FROM_HOST:
        if (!args.vfsPath || !args.hostPath)
          throw new Error(`${SyscallCode[code]} requires vfsPath and hostPath`);
        break;
    }
  }

  public async dispatch(
    pid: number,
    code: SyscallCode,
    args: any,
  ): Promise<any> {
    const pcb = this.scheduler.getProcess(pid);
    if (!pcb) {
      this.logger.error(`PID [${pid}] not found!`);
      return null;
    }

    switch (code) {
      case SyscallCode.MKDIR: {
        const absoluteMkdirPath = PathResolver.resolve(pcb.cwd, args as string);
        const { vfs, relativePath } =
          this.mountManager.resolve(absoluteMkdirPath);

        // Permission Check
        const parentPath =
          absoluteMkdirPath.substring(0, absoluteMkdirPath.lastIndexOf("/")) ||
          "/";
        const { vfs: parentVfs, relativePath: parentRelativePath } =
          this.mountManager.resolve(parentPath);
        const parentNode = parentVfs.stat(parentRelativePath);

        if (
          parentNode &&
          !this.satpam.check(pcb, parentNode, Permission.WRITE)
        ) {
          throw new Error(
            "Permission Denied: Cannot write to parent directory.",
          );
        }
        return vfs.mkdir(relativePath, pcb.uid, pcb.gid, 493);
      }

      case SyscallCode.LS: {
        const target = (args as string) || ".";
        const absoluteLsPath = PathResolver.resolve(pcb.cwd, target);

        if (absoluteLsPath === "/dev") {
          const devNames = Object.keys((this.kernel as any).devices || {});
          const base = devNames
            .filter((d) => {
              const device = (this.kernel as any).devices[d];
              // Device yang tidak mengimplementasikan present() dianggap selalu ada.
              // Device dengan hardware hotplug (mis. joystick) bisa menyembunyikan
              // node-nya dari ls /dev saat hardware dicabut (udev-like).
              if (device && typeof device.present === "function") {
                return device.present();
              }
              return true;
            })
            .map((d) => {
              const device = (this.kernel as any).devices[d];
              return {
                name: d,
                type: "DEVICE",
                size: 0,
                uid: device.uid ?? 0,
                gid: device.gid ?? 0,
                mode: device.mode ?? 0o600,
              };
            });

          // Tambahkan node PTY slave aktif (/dev/pts/N) on-demand
          const ptyManager = this.kernel.getPTYManager?.();
          if (ptyManager) {
            for (const pair of ptyManager.list()) {
              base.push({
                name: `pts/${pair.id}`,
                type: "DEVICE",
                size: 0,
                uid: pair.slave.uid ?? 0,
                gid: pair.slave.gid ?? 0,
                mode: pair.slave.mode ?? 0o600,
              });
            }
          }
          return base;
        }

        const { vfs, relativePath } = this.mountManager.resolve(absoluteLsPath);
        // Cek permission: user harus punya READ access ke direktori
        const lsNode = vfs.stat(relativePath);
        if (!lsNode) {
          throw new Error(
            `ls: cannot access '${absoluteLsPath}': No such file or directory`,
          );
        }
        if (!this.satpam.check(pcb, lsNode, Permission.READ)) {
          throw new Error(
            `ls: cannot open directory '${absoluteLsPath}': Permission denied`,
          );
        }
        return vfs.ls(relativePath);
      }

      case SyscallCode.OPEN: {
        let absoluteOpenPath = "";
        let flags = "r";

        // Backward compatibility: Support string arg (defaults to 'r') or object
        if (typeof args === "string") {
          absoluteOpenPath = PathResolver.resolve(pcb.cwd, args);
        } else {
          const params = args as { path: string; flags: string };
          absoluteOpenPath = PathResolver.resolve(pcb.cwd, params.path);
          flags = params.flags || "r";
        }

        // 0. Resolve VFS
        const { vfs, relativePath } =
          this.mountManager.resolve(absoluteOpenPath);

        // 1. Permission Check
        const requiredPerm =
          flags.includes("w") || flags.includes("+")
            ? Permission.WRITE
            : Permission.READ;

        // Existence Check
        const node = vfs.stat(relativePath);

        if (node) {
          // Check File Permission
          if (!this.satpam.check(pcb, node, requiredPerm)) {
            throw new Error(
              `Permission Denied: Cannot open ${absoluteOpenPath} for ${Permission[requiredPerm]}`,
            );
          }
        } else {
          // Fail if file doesn't exist AND flags is 'r' (Reading)
          if (flags === "r" && !absoluteOpenPath.startsWith("/dev/")) {
            throw new Error(`File not found: ${absoluteOpenPath}`);
          }

          // Check Parent Directory Write Permission (Creation)
          // Skip this check for /dev/ because we don't want to create device nodes in VFS database
          if (
            requiredPerm === Permission.WRITE &&
            !absoluteOpenPath.startsWith("/dev/")
          ) {
            const parentDir =
              absoluteOpenPath.substring(
                0,
                absoluteOpenPath.lastIndexOf("/"),
              ) || "/";
            const { vfs: parentVfs, relativePath: parentRelativePath } =
              this.mountManager.resolve(parentDir);
            const parentNode = parentVfs.stat(parentRelativePath);
            if (parentNode) {
              if (!this.satpam.check(pcb, parentNode, Permission.WRITE)) {
                throw new Error(
                  `Permission Denied: Cannot create file in ${parentDir}`,
                );
              }
            }
          }
          if (
            requiredPerm === Permission.WRITE &&
            !node &&
            !absoluteOpenPath.startsWith("/dev/")
          ) {
            vfs.touch(relativePath, "", pcb.uid, pcb.gid, 420); // 644 equivalent
          }

          // Truncate if Opening with 'w' (Write) and NOT 'a' (Append)
          if (
            node &&
            flags.includes("w") &&
            !flags.includes("a") &&
            !absoluteOpenPath.startsWith("/dev/")
          ) {
            // Keep existing mode/owner, just empty the content
            vfs.touch(relativePath, "", node.uid, node.gid, node.mode);
          }
        }

        if (absoluteOpenPath.startsWith("/dev/")) {
          const devName = absoluteOpenPath.replace("/dev/", "");
          let device: IDevice | null = null;
          if (this.kernel.devices && this.kernel.devices[devName]) {
            device = this.kernel.devices[devName];
          }
          const stdoutAliases = ["screen", "console", "stdout", "fb0"];
          const stdinAliases = ["keyboard", "stdin"];

          if (!device) {
            if (devName === "tty") {
              // Resolve to current process tty
              const ttyName = `tty${pcb.ttyId || 1}`;
              device = this.kernel.devices[ttyName] || null;
            } else if (devName.startsWith("pts/")) {
              // Pseudo-terminal slave: /dev/pts/N → PTY slave
              const ptyId = parseInt(devName.substring(4), 10);
              if (!isNaN(ptyId)) {
                device =
                  (this.kernel.getPTYManager?.()?.getSlave(ptyId) as unknown as IDevice) ||
                  null;
              }
            } else if (stdoutAliases.includes(devName)) {
              device =
                (pcb.ttyId ? this.kernel.devices[`tty${pcb.ttyId}`] : null) ||
                this.kernel.devices?.fb0 ||
                null;
            } else if (stdinAliases.includes(devName)) {
              device = this.kernel.devices?.stdin || null;
            }
          }

          if (device) {
            // Bypass strict permission check for standard I/O devices
            const isStdDev =
              stdoutAliases.includes(devName) || stdinAliases.includes(devName);
            if (!isStdDev) {
              // Check device permissions using metadata if available
              const devPerm = {
                name: devName,
                uid: device.uid ?? 0,
                gid: device.gid ?? 0,
                mode: device.mode ?? 0o600, // Default: root only (rw-------)
              };

              if (!this.satpam.check(pcb, devPerm, requiredPerm)) {
                throw new Error(
                  `Permission Denied: You cannot access device /dev/${devName}`,
                );
              }
            }

            // Update Ref Counts (for Pipes specifically)
            const f = flags || "r";
            if (f.includes("r") && device.ioctl) await device.ioctl(10, null); // INC_READ_REF
            if ((f.includes("w") || f.includes("a")) && device.ioctl)
              await device.ioctl(20, null); // INC_WRITE_REF

            // Lazy-Open: Call device.open() if available (e.g., SerialDevice)
            if (device.open) {
              const opened = device.open();
              if (!opened) {
                throw new Error(`Failed to open device /dev/${devName}`);
              }
            }

            const fd = pcb.fdTable.length;
            pcb.fdTable.push({ device, context: absoluteOpenPath, flags });
            return fd;
          }
        }

        // If it's a /dev/ path but NOT handled by a driver, we MUST enforce VFS permissions now
        if (absoluteOpenPath.startsWith("/dev/") && node) {
          if (!this.satpam.check(pcb, node, requiredPerm)) {
            throw new Error(
              `Permission Denied: Cannot open ${absoluteOpenPath} for ${Permission[requiredPerm]}`,
            );
          }
        }

        const fsDriver = new FileSystemDevice(vfs);
        fsDriver.setPath(relativePath, flags);

        // TRUNCATE: If opened with 'w' (and not 'a'), we must clear content first
        if (
          flags &&
          flags.includes("w") &&
          !flags.includes("a") &&
          !flags.includes("+")
        ) {
          vfs.touch(relativePath, "", pcb.uid, pcb.gid, 420);
        }

        const fd = pcb.fdTable.length;
        pcb.fdTable.push({ device: fsDriver, context: relativePath, flags });
        return fd;
      }

      case SyscallCode.STAT: {
        const absoluteStatPath = PathResolver.resolve(pcb.cwd, args as string);

        if (absoluteStatPath.startsWith("/dev/")) {
          const devName = absoluteStatPath.replace("/dev/", "");
          const device = (this.kernel as any).devices[devName];
          if (device) {
            return {
              name: devName,
              type: "DEVICE",
              size: 0,
              uid: device.uid ?? 0,
              gid: device.gid ?? 0,
              mode: device.mode ?? 0o600,
              modified_at: Date.now(),
            };
          }
        }

        const { vfs, relativePath } =
          this.mountManager.resolve(absoluteStatPath);
        return vfs.stat(relativePath);
      }

      case SyscallCode.CHMOD: {
        const { path: argPath, mode } = args as { path: string; mode: number };
        const absolutePath = PathResolver.resolve(pcb.cwd, argPath);

        if (absolutePath.startsWith("/dev/")) {
          if (!this.isRoot(pcb)) return false;
          const devName = absolutePath.replace("/dev/", "");
          const device = this.kernel.devices[devName];
          if (!device) return false;
          device.mode = mode;
          return true;
        }

        const { vfs, relativePath } = this.mountManager.resolve(absolutePath);
        const node = vfs.stat(relativePath);
        if (!node) return false;
        if (pcb.uid !== 0 && pcb.uid !== node.uid) return false;
        return vfs.chmod(relativePath, mode);
      }

      case SyscallCode.CHOWN: {
        const {
          path: argPath,
          uid: targetUid,
          gid: targetGid,
        } = args as { path: string; uid: number; gid: number };
        const absolutePath = PathResolver.resolve(pcb.cwd, argPath);

        if (absolutePath.startsWith("/dev/")) {
          if (!this.isRoot(pcb)) return false;
          const devName = absolutePath.replace("/dev/", "");
          const device = (this.kernel as any).devices[devName];
          if (!device) return false;
          if (targetUid !== -1) device.uid = Number(targetUid);
          if (targetGid !== -1) device.gid = Number(targetGid);
          return true;
        }

        if (!this.isRoot(pcb)) return false;
        const { vfs, relativePath } = this.mountManager.resolve(absolutePath);
        return vfs.chown(relativePath, targetUid, targetGid);
      }

      case SyscallCode.UNLINK: {
        const absolutePath = PathResolver.resolve(pcb.cwd, args as string);
        const { vfs, relativePath } = this.mountManager.resolve(absolutePath);
        const node = vfs.stat(relativePath);
        if (!node) throw new Error("File not found");
        if (!this.satpam.check(pcb, node, Permission.WRITE))
          throw new Error("Permission Denied");
        return vfs.unlink(relativePath);
      }

      case SyscallCode.RMDIR: {
        const absolutePath = PathResolver.resolve(pcb.cwd, args as string);
        const { vfs, relativePath } = this.mountManager.resolve(absolutePath);
        const node = vfs.stat(relativePath);
        if (!node || node.type !== "DIRECTORY")
          throw new Error("Not a directory");
        if (!this.satpam.check(pcb, node, Permission.WRITE))
          throw new Error("Permission Denied");
        return vfs.rmdir(relativePath);
      }

      case SyscallCode.WRITE: {
        if (typeof args === "object" && (args as any).pid !== undefined) {
          const {
            pid: targetPid,
            content,
            stream,
          } = args as { pid: number; content: string; stream?: string };
          const targetPcb = this.scheduler.getProcess(targetPid);
          if (!targetPcb) throw new Error(`Target PID ${targetPid} not found`);

          // Route to target's stdin (FD 0)
          const entry = targetPcb.fdTable[0];
          if (!entry) return false;

          // Robust TTY detection (VT console + PTY slave)
          const isTty =
            entry.device instanceof TTYDevice ||
            entry.device instanceof PTYSlaveDevice ||
            entry.device.name?.startsWith("tty") ||
            entry.device.name?.startsWith("pts/");

          if (isTty) {
            // If it's a TTY, we want to INJECT into the keyboard buffer (Master -> Slave Input)
            this.logger.debug(
              `[SYSCALL] Injecting ${content.length} chars into PID ${targetPid} stdin (TTY)`,
            );
            return entry.device.ioctl(0x2001, content);
          }
          return entry.device.write(content);
        }

        const { fd, content } = args;
        const entry = pcb.fdTable[fd];
        if (!entry) return false;

        // Check if FD was opened with Write permission
        const flags = entry.flags || "r";
        if (
          !flags.includes("w") &&
          !flags.includes("a") &&
          !flags.includes("+")
        ) {
          throw new Error("Bad File Descriptor: Not open for writing");
        }

        return entry.device.write(content);
      }

      case SyscallCode.READ: {
        if (typeof args === "object" && (args as any).pid !== undefined) {
          const { pid: targetPid, stream } = args as {
            pid: number;
            stream?: string;
          };
          const targetPcb = this.scheduler.getProcess(targetPid);
          if (!targetPcb) throw new Error(`Target PID ${targetPid} not found`);

          // In TSIX, stdout/stderr usually go to same TTY.
          // We'll read from the target's stdout (FD 1).
          const entry = targetPcb.fdTable[1];
          if (!entry) return null;

          const isTty =
            entry.device instanceof TTYDevice ||
            entry.device instanceof PTYSlaveDevice ||
            (entry.device as any).name?.startsWith("tty") ||
            (entry.device as any).name?.startsWith("pts/");

          if (isTty) {
            // If it's a TTY, we want to READ what was printed to the screen (Slave Output -> Master)
            const output = entry.device.ioctl(0x2002, null);
            if (output)
              this.logger.debug(
                `[SYSCALL] Captured ${output.length} chars from PID ${targetPid} stdout (TTY)`,
              );
            return output;
          }
          return entry.device.read();
        }

        const fd = args as number;
        const entry = pcb.fdTable[fd];
        if (!entry) throw new Error(`FD NOT FOUND: ${fd}`);
        return entry.device.read();
      }

      case SyscallCode.CLOSE: {
        const fd = args as number;
        const entry = pcb.fdTable[fd];
        if (entry) {
          const { device, flags } = entry;

          // --- NETWORK CLEANUP ---
          if (device instanceof SocketDevice) {
            const socket = device as SocketDevice;
            if (socket.bound && socket.driver) {
              const port = socket.getPort();
              if (port !== null) {
                this.logger.debug(
                  `Closing socket on port ${port}, releasing resources.`,
                );
                socket.driver.unregisterHandler(port);
                this.kernel.getPortManager().releasePort(port);
              }
            }
          }

          // Decrement Ref Counts
          const f = flags || "r";
          if (f.includes("r") && device.ioctl) await device.ioctl(11, null); // DEC_READ_REF
          if ((f.includes("w") || f.includes("a")) && device.ioctl)
            await device.ioctl(21, null); // DEC_WRITE_REF

          // Lazy-Close: Call device.close() if available (e.g., SerialDevice)
          if ((device as any).close) {
            (device as any).close();
          }

          pcb.fdTable[fd] = null;
          return true;
        }
        return false;
      }

      case SyscallCode.SCREEN_INFO: {
        const ttyName = `tty${pcb.ttyId || 1}`;
        const ttyDev = this.kernel.devices?.[ttyName];
        if (ttyDev && ttyDev.ioctl) {
          const info = ttyDev.ioctl(4, null); // 4 = TIOCGWINSZ
          return info;
        }

        const fb0 = this.kernel.devices?.fb0;
        if (fb0 && fb0.read) return fb0.read();
        return { lines: 24, columns: 80 };
      }

      case SyscallCode.PS: {
        const processes = this.scheduler.listProcesses();
        return processes.map((p) => ({
          pid: p.pid,
          ppid: p.ppid,
          name: p.name,
          state: p.state,
          user: p.owner,
          uid: p.uid,
          gid: p.gid,
          groups: p.groups,
          cwd: p.cwd,
          ttyId: p.ttyId,
          uuid: (p as any).uuid,
        }));
      }

      case SyscallCode.KILL: {
        const targetPid = args as number;
        const targetPcb = this.scheduler.getProcess(targetPid);
        if (!targetPcb)
          throw new Error(`kill: No such process (PID ${targetPid})`);

        // PID 1 (init) cannot be killed — not even by root
        // Use the SHUTDOWN syscall for proper system termination
        if (targetPid === 1) {
          throw new Error(
            `kill: PID 1 (init) is protected — cannot be killed directly. Use 'shutdown' or 'reboot' instead.`,
          );
        }

        // Permission check: root can kill anyone, non-root can only kill own processes
        if (!this.isRoot(pcb) && targetPcb.uid !== pcb.uid) {
          throw new Error(
            `kill: Permission denied — you do not own process ${targetPid} (owned by UID ${targetPcb.uid})`,
          );
        }

        return await this.scheduler.kill(targetPid, 9); // SIGKILL
      }

      case SyscallCode.WAITPID: {
        const targetPid = args as number;
        return await this.scheduler.waitpid(targetPid);
      }

      case SyscallCode.SIGNAL: {
        const { pid: targetPid, sig } = args as { pid: number; sig: number };
        const targetPcb = this.scheduler.getProcess(targetPid);
        if (!targetPcb)
          throw new Error(`kill: No such process (PID ${targetPid})`);

        // PID 1 (init) is protected from all signals
        if (targetPid === 1) {
          throw new Error(
            `kill: PID 1 (init) is protected — cannot send signals directly. Use 'shutdown' or 'reboot' instead.`,
          );
        }

        // Permission check: root can signal anyone, non-root can only signal own processes
        if (!this.isRoot(pcb) && targetPcb.uid !== pcb.uid) {
          throw new Error(
            `kill: Permission denied — you do not own process ${targetPid} (owned by UID ${targetPcb.uid})`,
          );
        }

        return await this.scheduler.kill(targetPid, sig);
      }

      case SyscallCode.IOCTL: {
        const { fd, cmd, arg } = args as { fd: number; cmd: number; arg: any };
        const entry = pcb.fdTable[fd];
        if (!entry) throw new Error(`FD NOT FOUND: ${fd}`);

        // Special handling for SWITCH_TTY (2)
        if (cmd === 2 && entry.device instanceof TTYDevice) {
          // Cek apakah ada argumen target TTY (e.g. ioctl(fd, 2, 3) untuk pindah ke TTY3)
          let targetTtyId =
            arg !== null && arg !== undefined ? parseInt(arg) : NaN;

          // Jika tidak ada argumen, pindah ke TTY yang memiliki device ini
          if (isNaN(targetTtyId)) {
            targetTtyId = parseInt(entry.device.name.replace("tty", ""));
          }

          const ttyCount = Config.get().shell.ttyCount ?? 6;
          if (!isNaN(targetTtyId) && targetTtyId >= 1 && targetTtyId <= ttyCount) {
            await this.kernel.ttyManager?.switch(targetTtyId);
            return 0;
          }
        }

        // Special handling for SET_VISUAL_IDENTITY (33)
        if (cmd === 33 && pcb.uid === 0) {
          this.kernel.ttyManager?.setVisualIdentity(arg as string);
          return 0;
        }

        // Special handling for TIOCSWINSZ (3) - Terminal Resize
        if (cmd === 3 && entry.device instanceof TTYDevice) {
          const { lines, columns } = arg as { lines: number; columns: number };
          const ttyId = parseInt(entry.device.name.replace("tty", ""));

          if (!isNaN(ttyId)) {
            this.kernel.ttyManager?.handleTTYResize(ttyId, columns, lines);

            // Update environment for all processes on this TTY
            this.scheduler.listProcesses().forEach((p) => {
              if (p.ttyId === ttyId && p.state !== "EXITED") {
                p.env["LINES"] = lines.toString();
                p.env["COLUMNS"] = columns.toString();
                // Send SIGWINCH signal to application
                this.scheduler.sendEvent(p.pid, "signal", "SIGWINCH");
              }
            });
            return 0;
          }
        }

        // Special handling for TIOCSWINSZ (3) on PTY slave — resize + SIGWINCH
        // (proses di PTY memakai ttyId negatif = -(ptyId+1))
        if (cmd === 3 && entry.device instanceof PTYSlaveDevice) {
          const { lines, columns } = arg as { lines: number; columns: number };
          const ptyId = entry.device.getPtyId();
          const ptyTtyId = -(ptyId + 1);

          entry.device.ioctl(3, { lines, columns });

          // Update environment for all processes on this PTY
          this.scheduler.listProcesses().forEach((p) => {
            if (p.ttyId === ptyTtyId && p.state !== "EXITED") {
              p.env["LINES"] = (lines ?? 24).toString();
              p.env["COLUMNS"] = (columns ?? 80).toString();
              this.scheduler.sendEvent(p.pid, "signal", "SIGWINCH");
            }
          });
          return 0;
        }

        return entry.device.ioctl(cmd, arg);
      }

      case SyscallCode.EXEC: {
        const {
          path: execPath,
          args: commandArgs,
          stdoutFd,
          stdinFd,
          ttyId,
          ptyId,
        } = args as {
          path: string;
          args: string[];
          stdoutFd?: number;
          stdinFd?: number;
          ttyId?: number;
          ptyId?: number;
        };
        let absoluteExecPath = PathResolver.resolve(pcb.cwd, execPath);

        let { vfs, relativePath } = this.mountManager.resolve(absoluteExecPath);
        let node = vfs.stat(relativePath);

        // Prioritize .js over .ts for performance
        if (!node) {
          const extensions = [".js", ".ts"];
          for (const ext of extensions) {
            if (absoluteExecPath.endsWith(ext)) continue;

            const altPath = absoluteExecPath + ext;
            const { vfs: altVfs, relativePath: altRelativePath } =
              this.mountManager.resolve(altPath);
            const altNode = altVfs.stat(altRelativePath);
            if (altNode) {
              absoluteExecPath = altPath;
              node = altNode;
              vfs = altVfs;
              relativePath = altRelativePath;
              break;
            }
          }
        }

        if (!node) {
          this.logger.error(
            `EXEC Failed: File not found [${absoluteExecPath}]`,
          );
          throw new Error(`File not found: ${absoluteExecPath}`);
        }
        if (!this.satpam.check(pcb, node, Permission.EXECUTE)) {
          throw new Error(
            `Permission Denied: Cannot execute ${absoluteExecPath}`,
          );
        }

        const binaryName = execPath.split("/").pop() || execPath;
        // --- EXECUTION PRIORITIZATION ---

        let appContent: string | undefined = undefined;

        if (node && node.type === "FILE") {
          // Gunakan vfs.read() sesuai kontrak IVFS (stat = metadata, read = konten)
          // Jangan mengandalkan node.content karena tidak semua IVFS menyertakan
          // konten di stat() (BKFS kebetulan return full DB row, RamFS/HostVFS tidak)
          appContent = vfs.read(relativePath) ?? undefined;
        }

        this.logger.debug(
          `[EXEC] Using VFS content for ${absoluteExecPath} (Direct Memory)`,
        );

        let stdoutDevice =
          pcb.fdTable[1]?.device || this.kernel.devices!.stdout;
        let stdinDevice = pcb.fdTable[0]?.device || this.kernel.devices!.stdin;
        let stderrDevice =
          pcb.fdTable[2]?.device || this.kernel.devices!.stderr;

        // --- TTY / PTY REDIRECTION SUPPORT ---
        // If a specific TTY is requested, we override the default I/O to that TTY.
        // If a specific PTY (pseudo-terminal) is requested, route I/O to its slave
        // (pts/N) — daemon (tsshd/airtermd/pixelterm) menjalankan shell di sini.
        let targetTtyDevice: IDevice | null = null;
        if (ptyId !== undefined && ptyId >= 0) {
          const ptySlave = this.kernel.getPTYManager?.()?.getSlave(ptyId) || null;
          if (ptySlave) targetTtyDevice = ptySlave as unknown as IDevice;
        } else {
          const ttyCount = Config.get().shell.ttyCount ?? 6;
          if (ttyId !== undefined && ttyId >= 1 && ttyId <= ttyCount) {
            targetTtyDevice = this.kernel.devices[`tty${ttyId}`] || null;
          }
        }

        if (targetTtyDevice) {
          stdinDevice = targetTtyDevice;
          stdoutDevice = targetTtyDevice;
          stderrDevice = targetTtyDevice;
        } else {
          // Normal inheritance logic if no specific TTY requested
          if (stdoutFd !== undefined && pcb.fdTable[stdoutFd]) {
            stdoutDevice = pcb.fdTable[stdoutFd]!.device;
          }

          if (stdinFd !== undefined && pcb.fdTable[stdinFd]) {
            stdinDevice = pcb.fdTable[stdinFd]!.device;
          }
        }

        let targetUid = pcb.uid;
        let targetGid = pcb.gid;
        let targetOwner = pcb.owner;

        // --- SETUID BIT SUPPORT (0o4000 = 2048) ---
        if (node && node.mode & 2048) {
          targetUid = node.uid;
          targetGid = node.gid;
          // For now, if UID is 0, we treat it as root.
          // Ideally we'd look up the username from UID in /etc/passwd.
          if (targetUid === 0) targetOwner = "root";
          this.logger.info(
            `SetUID Execution detected for ${absoluteExecPath}: Running as UID ${targetUid}`,
          );
        }

        const newPcb = this.scheduler.createProcess(binaryName, {
          fds: [stdinDevice, stdoutDevice, stderrDevice],
          appName: binaryName,
          args: commandArgs,
          appPath: undefined,
          stackBkfsPath: absoluteExecPath,
          appContent: appContent,
          cwd: pcb.cwd,
          env: { ...pcb.env },
          uid: targetUid,
          gid: targetGid,
          ruid: pcb.ruid, // Preserve Real UID
          owner: targetOwner,
          groups: [...pcb.groups], // Inherit supplementary groups
          // Proses di PTY memakai ttyId negatif (-(ptyId+1)) supaya tidak bentrok
          // dengan konsol virtual (tty1..N). Routing interrupt via ttyId ini.
          ttyId:
            ptyId !== undefined && ptyId >= 0
              ? -(ptyId + 1)
              : ttyId !== undefined
                ? ttyId
                : pcb.ttyId,
          ppid: pid, // Track parent → child relationship
        });

        if (!newPcb) throw new Error("Failed to create process.");

        // EXEC increments refs for inherited devices
        if (stdinDevice.ioctl) await stdinDevice.ioctl(10, null); // INC_READ_REF
        if (stdoutDevice.ioctl) await stdoutDevice.ioctl(20, null); // INC_WRITE_REF

        return {
          pid: newPcb.pid,
          name: binaryName,
          message: `Started PID ${newPcb.pid}`,
          stdout: 1,
          stdin: 0,
        };
      }

      case SyscallCode.CHDIR: {
        const targetPath = PathResolver.resolve(pcb.cwd, args as string);
        const { vfs, relativePath } = this.mountManager.resolve(targetPath);

        const node = vfs.stat(relativePath);
        if (!node) return false; // not found
        if (!this.satpam.check(pcb, node, Permission.EXECUTE))
          throw new Error(`cd: permission denied: ${targetPath}`);
        if (node.type !== "DIRECTORY") return false;

        pcb.cwd = targetPath;
        return true;
      }

      case SyscallCode.PRINT: {
        const entry = pcb.fdTable[1];
        if (!entry) return -1;
        entry.device.write(args as string);
        return 0;
      }

      case SyscallCode.GETCWD:
        return pcb.cwd;

      case SyscallCode.WHOAMI:
        return {
          uid: pcb.uid,
          gid: pcb.gid,
          ruid: pcb.ruid,
          groups: pcb.groups,
          username: pcb.owner,
          ttyId: pcb.ttyId,
        };
      case SyscallCode.UNAME: {
        const cfg = Config.get();
        return {
          sysname: "TSIX",
          distroname: cfg.kernel.distroName,
          version: this.kernel.getVersion(),
          codename: this.kernel.getCodename(),
          machine: process.arch === "x64" ? "x86_64" : process.arch,
          runtime: `Node.js ${process.version}`,
          engine: `${cfg.kernel.engineName} (TypeScript)`,
        };
      }
      case SyscallCode.GETENV:
        return pcb.env[args as string] || null;
      case SyscallCode.SETENV: {
        const { name, value } = args;
        pcb.env[name] = value;
        return true;
      }

      case SyscallCode.SETUID: {
        const newUid = args as number;
        // Model Saved UID (mirip setuid/seteuid di Unix):
        //  - Proses ROOT bebas ganti UID. Saved UID diisi UID lama (0 utk root)
        //    supaya bisa kembali ke root saat re-login — dibutuhkan WM/login
        //    manager utk switch user (logout user A → login user B).
        //  - Proses NON-ROOT hanya boleh "restore" ke Saved UID-nya (mis. balik
        //    ke root). Selain itu ditolak.
        if (this.isRoot(pcb)) {
          pcb.suid = pcb.uid;
          pcb.uid = newUid;
          pcb.ruid = newUid;
        } else if (newUid === pcb.suid) {
          pcb.uid = newUid;
          pcb.ruid = newUid;
        } else {
          throw new Error(
            "Permission Denied: Only root or root group members can change UID",
          );
        }

        // --- UPDATE OWNER NAME logic ---
        if (newUid === 0) {
          pcb.owner = "root";
        } else {
          try {
            const content = this.bkfs.read("/etc/passwd");
            if (content) {
              const lines = content
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
              const entry = lines.find(
                (l) => parseInt(l.split(":")[2]) === newUid,
              );
              if (entry) {
                pcb.owner = entry.split(":")[0];
              }
            }
          } catch (e: any) {
            this.logger.warn(
              `Failed to resolve username for UID ${newUid}: ${e.message}`,
            );
          }
        }

        return true;
      }

      case SyscallCode.SETGID: {
        const newGid = args as number;
        if (!this.isRoot(pcb))
          throw new Error(
            "Permission Denied: Only root or root group members can change GID",
          );
        pcb.gid = newGid;
        return true;
      }

      case SyscallCode.SETGROUPS: {
        const newGroups = args as number[];
        if (!this.isRoot(pcb))
          throw new Error(
            "Permission Denied: Only root or root group members can change groups",
          );
        pcb.groups = [...newGroups];
        return true;
      }

      case SyscallCode.EXIT: {
        const exitCode = (args as number) || 0;
        if (pcb.exitCode === undefined) {
          pcb.exitCode = exitCode;
        }
        // Non-blocking cleanup: allows worker to receive the result of this syscall
        // before it gets terminated by the kernel.
        this.cleanupProcess(pid).catch(() => { });
        return true;
      }

      case SyscallCode.SEND_MSG: {
        const { targetPid, data } = args as {
          targetPid: number | string;
          data: any;
        };
        let actualPid: number;

        if (typeof targetPid === "string") {
          const resolvedId = this.scheduler.getPidByIdentity(targetPid);
          if (resolvedId === undefined)
            throw new Error(`Destination Identity "${targetPid}" not found.`);
          actualPid = resolvedId;
        } else {
          actualPid = targetPid;
        }

        return this.scheduler.sendEvent(actualPid, "ipc_message", {
          fromPid: pid,
          fromUser: pcb.owner,
          data,
        });
      }

      case SyscallCode.GET_PPID: {
        return pcb.ppid ?? 0;
      }

      case SyscallCode.GUI_REQ: {
        const payload = args as IGUIPayload;

        // --- 1. TYPE VALIDATION (Piagam Antigonon Aturan 4) ---
        if (!payload || payload.syscall !== "GUI_REQ") {
          this.logger.error(
            `PID ${pid} sent malformed GUI_REQ payload. SIGKILL.`,
          );
          await this.scheduler.kill(pid, 9);
          throw new Error(
            "GUI_REQ: Invalid payload format — syscall must be 'GUI_REQ'",
          );
        }
        if (
          !payload.action ||
          !Object.values(GUIAction).includes(payload.action)
        ) {
          throw new Error(`GUI_REQ: Unknown action '${payload.action}'`);
        }
        if (!payload.wid || typeof payload.wid !== "string") {
          throw new Error("GUI_REQ: 'wid' is required and must be a string");
        }

        // Override pid in payload with the ACTUAL sender (jangan percaya userland)
        payload.pid = pid;

        const guiRegistry = this.kernel.guiRegistry;
        if (!guiRegistry) {
          throw new Error("GUI_REQ: GUIRegistry not initialized");
        }

        // --- REGISTER_DAEMON: gued mendaftarkan diri ---
        if (payload.action === GUIAction.REGISTER_DAEMON) {
          guiRegistry.registerDaemon(pid);
          this.logger.info(
            `PixelSpace: Process ${pid} (${pcb.name}) registered as DOME engine`,
          );
          return { success: true, action: "REGISTER_DAEMON", pid };
        }

        // --- 2. AUTHENTICATION (Piagam Antigonon — cek kepemilikan wid) ---
        if (payload.action === GUIAction.CREATE_WINDOW) {
          // CREATE: daftarkan kepemilikan baru
          const title = payload.node?.props?.title || "Untitled";
          guiRegistry.createWindow(payload.wid, pid, title);
          this.logger.info(
            `PixelSpace: PID ${pid} created window '${payload.wid}' ("${title}")`,
          );
        } else {
          const ownerPid = guiRegistry.getOwner(payload.wid);
          const isOwner = ownerPid !== null && ownerPid === pid;
          const isParentManagedAction =
            (payload.action === GUIAction.MINIMIZE_WINDOW ||
              payload.action === GUIAction.RESTORE_WINDOW) &&
            ownerPid !== null &&
            this.scheduler.isAncestor(pid, ownerPid);
          const isAuthorized = isOwner || isParentManagedAction;

          if (!isAuthorized) {
            this.logger.warn(
              `GUI: PID ${pid} attempted to modify window '${payload.wid}' ` +
              `owned by PID ${ownerPid}. Sending SIGSEGV.`,
            );
            this.scheduler.sendEvent(pid, "signal", "SIGSEGV");
            throw new Error(
              `GUI_REQ: Access Denied — PID ${pid} does not own window '${payload.wid}'`,
            );
          }

          // UPDATE: jika DESTROY_WINDOW, hapus dari registry setelah forward
          if (payload.action === GUIAction.DESTROY_WINDOW) {
            guiRegistry.destroyWindow(payload.wid);
            this.logger.info(
              `PixelSpace: Window '${payload.wid}' destroyed by PID ${pid}`,
            );
          }

          // UPDATE: jika MOUNT_NODE, pastikan node punya data
          if (payload.action === GUIAction.MOUNT_NODE && !payload.node) {
            throw new Error("GUI_REQ: MOUNT_NODE requires 'node' data");
          }
        }

        // --- 3. FORWARD ke gued daemon ---
        const guedPid = guiRegistry.getDaemonPid();
        if (guedPid === null) {
          throw new Error("GUI_REQ: DOME engine is not running");
        }

        const forwarded = this.scheduler.sendEvent(
          guedPid,
          "gui_request",
          payload,
        );
        if (!forwarded) {
          // gued mungkin mati — rollback CREATE jika perlu
          if (payload.action === GUIAction.CREATE_WINDOW) {
            guiRegistry.destroyWindow(payload.wid);
          }
          throw new Error(
            "GUI_REQ: Failed to forward to DOME engine (process may be dead)",
          );
        }

        return { success: true, wid: payload.wid, action: payload.action };
      }

      // --- NETWORKING (MQTNL) syscalls ---

      case SyscallCode.PIPE: {
        const pipe = new PipeDevice();
        // Initialize with 1 Read Ref and 1 Write Ref
        await pipe.ioctl(10, null); // INC_READ_REF
        await pipe.ioctl(20, null); // INC_WRITE_REF

        const readFd = pcb.fdTable.length;
        pcb.fdTable.push({ device: pipe, context: "pipe:read", flags: "r" });
        const writeFd = pcb.fdTable.length;
        pcb.fdTable.push({ device: pipe, context: "pipe:write", flags: "w" });
        return [readFd, writeFd];
      }

      case SyscallCode.SOCKET: {
        const device = new SocketDevice();
        const fd = pcb.fdTable.length;
        pcb.fdTable.push({ device, context: "socket" });
        return fd;
      }

      case SyscallCode.BIND: {
        const { fd, port, address } = args as {
          fd: number;
          port: number;
          address?: string;
        };
        const entry = pcb.fdTable[fd];
        if (!entry || !(entry.device instanceof SocketDevice))
          throw new Error("Invalid Socket FD");

        const socket = entry.device as SocketDevice;
        if (socket.bound) throw new Error("Socket already bound");

        // Determine Interface (Driver)
        let targetDriver: SimpleMQTNLDriver | null = null;
        const cfg = Config.get();

        if (address) {
          // Search by address OR device name
          for (const key in this.kernel.devices) {
            const dev = this.kernel.devices[key];
            if (dev instanceof SimpleMQTNLDriver) {
              if (
                (dev as any).localAddress === address ||
                dev.name === address
              ) {
                targetDriver = dev;
                break;
              }
            }
          }
        } else {
          // Use Default
          targetDriver = this.kernel.devices[
            cfg.network.defaultDevice
          ] as SimpleMQTNLDriver;
        }

        if (!targetDriver)
          throw new Error(
            `Network Interface not found for address: ${address || "DEFAULT"}`,
          );

        const portMgr = this.kernel.getPortManager();
        let actualPort = port;

        if (port === 0) {
          const randomPort = portMgr.allocateRandomPort();
          if (randomPort === null) throw new Error("No random ports available");
          actualPort = randomPort;
        } else {
          if (!portMgr.allocatePort(port, pcb.pid))
            throw new Error(`Port ${port} already in use`);
        }

        socket.setPort(actualPort);
        socket.driver = targetDriver;

        // Register handler
        targetDriver.registerHandler(actualPort, (data) => {
          socket.push(data);
        });

        return true;
      }

      case SyscallCode.SENDTO: {
        const {
          fd,
          address,
          port,
          data,
          flag,
          srcPort: argLocalPort,
        } = args as {
          fd: number;
          address: string;
          port: number;
          data: any;
          flag?: number;
          srcPort?: number;
        };
        const entry = pcb.fdTable[fd];
        if (!entry || !(entry.device instanceof SocketDevice))
          throw new Error("Invalid Socket FD");

        const socket = entry.device as SocketDevice;
        let mqtnl = socket.driver as SimpleMQTNLDriver;

        // If socket not bound to a specific driver (e.g. sending before bind, or valid usage pattern)
        // Use default device
        if (!mqtnl) {
          const cfg = Config.get();
          mqtnl = this.kernel.devices[
            cfg.network.defaultDevice
          ] as SimpleMQTNLDriver;
        }

        if (!mqtnl) throw new Error("No network interface available");

        const finalSrcPort = argLocalPort || socket.getPort() || 0;
        return await mqtnl.send(
          address,
          port,
          data,
          flag ?? PacketFlags.FLAG_DATA,
          finalSrcPort,
        );
      }

      case SyscallCode.RECVFROM: {
        const fd = args as number;
        const entry = pcb.fdTable[fd];
        if (!entry || !(entry.device instanceof SocketDevice))
          throw new Error("Invalid Socket FD");

        const socket = entry.device as SocketDevice;
        // Cek non-blocking dulu (buffer sudah ada isinya)
        const immediate = socket.read();
        if (immediate) return immediate;
        // Kalau kosong, tunggu secara event-driven hingga data di-push.
        // Paket yang baru sampai akan terdeteksi langsung (bukan polling 100ms),
        // sehingga RTT yang diukur aplikasi (mis. ping) akurat.
        await socket.waitForData(50);
        return socket.read();
      }

      case SyscallCode.NETSTAT: {
        // Info tentang semua interface dengan Statistik
        const stats: any[] = [];
        const cfg = Config.get();

        for (const key in this.kernel.devices) {
          const dev = this.kernel.devices[key];
          if (dev instanceof SimpleMQTNLDriver) {
            stats.push(dev.getStats());
          }
        }

        return {
          interfaces: stats,
          defaultDevice: cfg.network.defaultDevice,
        };
      }

      case SyscallCode.DETACH: {
        // Redirect standard FDs to null device to avoid leaking logs to the starting TTY
        const nullDev = this.kernel.devices?.null;
        if (nullDev) {
          await this.dispatch(pid, SyscallCode.CLOSE, 0);
          await this.dispatch(pid, SyscallCode.CLOSE, 1);
          await this.dispatch(pid, SyscallCode.CLOSE, 2);

          pcb.fdTable[0] = {
            device: nullDev,
            context: "/dev/null",
            flags: "r",
          };
          pcb.fdTable[1] = {
            device: nullDev,
            context: "/dev/null",
            flags: "w",
          };
          pcb.fdTable[2] = {
            device: nullDev,
            context: "/dev/null",
            flags: "w",
          };
        }
        return await this.scheduler.detach(pcb.pid);
      }

      case SyscallCode.SHUTDOWN: {
        if (!this.isRoot(pcb))
          throw new Error(
            "Permission Denied: Only root or root group members can shutdown original system",
          );

        const exitCode = args ?? 0; // Default to 0 (shutdown), 1 for reboot
        this.kernel.wantedExitCode = exitCode; // Crucial for main.ts

        this.kernel.bootLog(
          `${exitCode === 1 ? "REBOOT" : "SHUTDOWN"} initiated by PID ${pid} (User ${pcb.uid})`,
        );

        // 1. Broadcast SIGTERM (15) to everyone except self and PID 1
        this.kernel.bootLog(`Broadcast: Sending SIGTERM to all processes...`);
        await this.scheduler.broadcastEvent("signal", "SIGTERM");

        // 2. Dynamic wait for graceful exit (up to 5000ms)
        this.kernel.bootLog(
          `Graceful Wait: Monitoring process termination (max 5s)...`,
        );
        const startTime = Date.now();
        while (Date.now() - startTime < 5000) {
          const survivors = this.scheduler
            .listProcesses()
            .filter(
              (p) => p.pid !== 1 && p.pid !== pid && p.state !== "EXITED",
            );
          if (survivors.length === 0) {
            this.kernel.bootLog(`SUCCESS: All processes exited gracefully.`);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // 3. SIGKILL (9) survivors
        const survivors = this.scheduler
          .listProcesses()
          .filter((p) => p.pid !== 1 && p.pid !== pid && p.state !== "EXITED");
        if (survivors.length > 0) {
          this.kernel.bootLog(
            `TIMEOUT: Sending SIGKILL to ${survivors.length} non-responsive processes...`,
            false,
          );
          for (const p of survivors) {
            await this.scheduler.kill(p.pid, 9);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));

        // 4. Post-Cleanup Flush (Crucial for slow devices/network links)
        // Give the underlying Node.js/OS network stack time to flush the last packets (like !exit!)
        this.kernel.bootLog(`Flushing: Final network buffer sync (1s)...`);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // 5. Final Termination of PID 1
        this.kernel.bootLog(
          `Halting: Terminating PID 1 with exit code ${exitCode}.`,
        );
        this.kernel.bootLog(
          exitCode === 1 ? "System is rebooting." : "System is halting.",
        );
        await this.scheduler.kill(1, 9, exitCode);
        return true;
      }

      case SyscallCode.UPTIME: {
        return this.kernel.getUptime();
      }

      case SyscallCode.SYNC_TO_HOST: {
        if (!this.isRoot(pcb))
          throw new Error(
            "Permission Denied: Only root or root group members can perform physical sync.",
          );
        const { vfsPath, hostPath } = args;

        // Security: Ensure hostPath is relative and doesn't escape project root
        const projectRoot = process.cwd();
        const absoluteHostPath = path.resolve(projectRoot, hostPath);

        if (!absoluteHostPath.startsWith(projectRoot)) {
          throw new Error(
            "Security Violation: Target path is outside project root.",
          );
        }

        const { vfs, relativePath } = this.mountManager.resolve(vfsPath);
        const content = vfs.read(relativePath);
        if (content === null)
          throw new Error(`Source file not found in VFS: ${vfsPath}`);

        // Ensure parent directory exists on host
        const parentDir = path.dirname(absoluteHostPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        fs.writeFileSync(absoluteHostPath, content);
        this.logger.info(`[SYNC] Applied VFS:${vfsPath} -> HOST:${hostPath}`);
        return true;
      }

      case SyscallCode.REEXEC: {
        // Re-exec replaces the current process image but keeps the PID (conceptually)
        // In our worker model, we stop the current worker and start a new one with same PID slot info
        const { path: appPath, args: appArgs } = args;
        this.logger.info(
          `[REEXEC] Process ${pid} is replacing itself with ${appPath}`,
        );

        // We reuse the scheduler's ability to "restart" or we could implement a formal re-exec
        // For now, let's trigger a deferred re-exec via the scheduler
        return await this.scheduler.reexec(pid, appPath, appArgs || []);
      }

      case SyscallCode.REPARENT: {
        if (!pcb) throw new Error("No calling process for reparent");
        const { pid: targetPid, newPpid } = args;
        const childPcb = this.scheduler.getProcess(targetPid);
        if (!childPcb)
          throw new Error(`REPARENT: No such process ${targetPid}`);
        // Verifikasi parent baru exists (atau PID 1 selalu ada)
        if (newPpid !== 1 && !this.scheduler.getProcess(newPpid)) {
          throw new Error(`REPARENT: New parent ${newPpid} not found`);
        }
        childPcb.ppid = newPpid;
        this.logger.info(`[REPARENT] PID ${targetPid} → parent ${newPpid}`);
        return true;
      }

      case SyscallCode.SYNC_FROM_HOST: {
        if (!this.isRoot(pcb))
          throw new Error(
            "Permission Denied: Only root or root group members can perform sync from host.",
          );
        const { vfsPath, hostPath } = args;

        // Security: Ensure hostPath is relative and doesn't escape project root
        const projectRoot = process.cwd();
        const absoluteHostPath = path.resolve(projectRoot, hostPath);

        if (!absoluteHostPath.startsWith(projectRoot)) {
          throw new Error(
            "Security Violation: Target path is outside project root.",
          );
        }

        if (!fs.existsSync(absoluteHostPath)) {
          throw new Error(`Host file not found: ${hostPath}`);
        }

        // Robust normalization of VFS target path
        const cleanVfsPath = PathResolver.resolve("/", vfsPath);
        const content = fs.readFileSync(absoluteHostPath, "utf8");

        const { vfs, relativePath } = this.mountManager.resolve(cleanVfsPath);

        // Ensure parent directory exists in the resolved VFS
        const vfsDirParts = relativePath.split("/").filter((p) => p.length > 0);
        vfsDirParts.pop();
        const vfsDir = "/" + vfsDirParts.join("/");

        if (vfsDir !== "/") {
          vfs.mkdir(vfsDir, pcb.uid, pcb.gid);
        }

        // --- SMART PERMISSIONS ---
        // Binary locations (like /bin) or root home should get 0755 (493)
        let mode = 420; // Default 0644
        if (
          cleanVfsPath.startsWith("/bin/") ||
          cleanVfsPath.startsWith("/root/")
        ) {
          mode = 493; // 0755
        }

        // Driver uses touch for writing/updating file content
        vfs.touch(relativePath, content, pcb.uid, pcb.gid, mode);
        this.logger.info(
          `[SYNC] Pulled HOST:${hostPath} -> VFS:${cleanVfsPath} (Mode: ${mode.toString(8)})`,
        );
        return true;
      }

      case SyscallCode.MOUNT: {
        if (!this.isRoot(pcb))
          throw new Error(
            "Permission Denied: Only root or root group members can mount.",
          );
        const { vfsPath, hostPath, readOnly, type, uid, gid } = args as {
          vfsPath: string;
          hostPath: string;
          readOnly?: boolean;
          type?: string;
          uid?: number;
          gid?: number;
        };

        const fullVfsPath = PathResolver.resolve(pcb.cwd, vfsPath);

        // Unix fidelity: mount point harus SUDAH ADA & berupa direktori.
        // Sebelumnya auto-create diam-diam — sekarang ditolak seperti Linux
        // ("mount point does not exist"). Fstab (boot) tetap bisa auto-create
        // karena lewat processFstab, bukan syscall ini.
        const { vfs: mntVfs, relativePath: mntRel } =
          this.mountManager.resolve(fullVfsPath);
        const mntNode = mntVfs.stat(mntRel);
        if (!mntNode) {
          throw new Error(`mount: mount point ${fullVfsPath} does not exist`);
        }
        if (mntNode.type !== "DIRECTORY") {
          throw new Error(`mount: ${fullVfsPath} is not a directory`);
        }

        let driver: IVFS;
        const fsType = type || "host";

        if (fsType === "bkfs") {
          this.logger.info(
            `Mounting secondary BKFS: ${hostPath} -> ${fullVfsPath}${readOnly ? " (Read-Only)" : ""}`,
          );
          driver = new BKFS(
            path.resolve(process.cwd(), hostPath),
            readOnly || false,
          );
        } else if (fsType === "ramfs") {
          this.logger.info(`Mounting RamFS: ${fullVfsPath}`);
          const label = fullVfsPath.replace(/\//g, "_").replace(/^_/, "");
          driver = new RamFS(label, uid, gid);
        } else {
          this.logger.info(`Mounting Host Path: ${hostPath} -> ${fullVfsPath}`);
          driver = new HostVFS(hostPath, readOnly || false, uid, gid);
        }

        this.mountManager.mount(
          fullVfsPath,
          driver,
          fsType,
          hostPath,
          readOnly || false,
          uid,
          gid,
        );
        return true;
      }

      case SyscallCode.UMOUNT: {
        if (!this.isRoot(pcb))
          throw new Error(
            "Permission Denied: Only root or root group members can unmount.",
          );
        const vfsPath = args as string;
        const fullVfsPath = PathResolver.resolve(pcb.cwd, vfsPath);

        if (fullVfsPath === "/") {
          throw new Error("Cannot unmount root filesystem.");
        }

        return this.mountManager.unmount(fullVfsPath);
      }

      case SyscallCode.GET_SYSPATH: {
        const cfg = Config.get();
        const relativeRoot = cfg.kernel.rootHostPath || "../.root";
        const absoluteRoot = path.resolve(__dirname, relativeRoot);
        return {
          rootHostPath: absoluteRoot,
          projectRoot: process.cwd(),
        };
      }

      case SyscallCode.GET_MOUNTS: {
        return this.mountManager.listMounts();
      }

      case SyscallCode.GET_USAGE: {
        const targetPath = PathResolver.resolve(
          pcb.cwd,
          (args as string) || "/",
        );
        const { vfs, mountPoint } = this.mountManager.resolve(targetPath);
        const usage = await vfs.getUsage();

        // Add physical disk size if it's a file-backed BKFS
        const m = this.mountManager
          .listMounts()
          .find((mt) => mt.vfsPath === mountPoint);
        if (m && m.type === "bkfs") {
          // source is usually relative to project root
          const absoluteHostPath = path.resolve(process.cwd(), m.source);
          if (fs.existsSync(absoluteHostPath)) {
            usage.diskSize = fs.statSync(absoluteHostPath).size;
          }
        }
        return usage;
      }

      // --- CHUNKED I/O (Progress-aware, untuk file besar >500MB) ---

      case SyscallCode.READ_CHUNK: {
        const {
          path: chunkPath,
          offset,
          length,
        } = args as { path: string; offset: number; length: number };
        const absolutePath = PathResolver.resolve(pcb.cwd, chunkPath);

        // Permission Check: harus punya READ access
        const { vfs, relativePath } = this.mountManager.resolve(absolutePath);
        const node = vfs.stat(relativePath);
        if (!node) throw new Error(`File not found: ${absolutePath}`);
        if (!this.satpam.check(pcb, node, Permission.READ)) {
          throw new Error(`Permission Denied: Cannot read ${absolutePath}`);
        }
        return vfs.readChunk(relativePath, offset, length);
      }

      case SyscallCode.WRITE_CHUNK: {
        const {
          path: chunkPath,
          chunk,
          offset,
        } = args as { path: string; chunk: string; offset: number };
        const absolutePath = PathResolver.resolve(pcb.cwd, chunkPath);

        const { vfs, relativePath } = this.mountManager.resolve(absolutePath);
        const node = vfs.stat(relativePath);

        if (node) {
          // File exists — check write permission
          if (!this.satpam.check(pcb, node, Permission.WRITE)) {
            throw new Error(
              `Permission Denied: Cannot write to ${absolutePath}`,
            );
          }
        } else {
          // File doesn't exist — check parent dir write permission
          const parentDir =
            absolutePath.substring(0, absolutePath.lastIndexOf("/")) || "/";
          const { vfs: parentVfs, relativePath: parentRel } =
            this.mountManager.resolve(parentDir);
          const parentNode = parentVfs.stat(parentRel);
          if (
            parentNode &&
            !this.satpam.check(pcb, parentNode, Permission.WRITE)
          ) {
            throw new Error(
              `Permission Denied: Cannot create file in ${parentDir}`,
            );
          }
        }
        return vfs.writeChunk(relativePath, chunk, offset);
      }

      case SyscallCode.GET_SIZE: {
        const sizePath = args as string;
        const absolutePath = PathResolver.resolve(pcb.cwd, sizePath);

        const { vfs, relativePath } = this.mountManager.resolve(absolutePath);
        const node = vfs.stat(relativePath);
        if (!node) throw new Error(`File not found: ${absolutePath}`);
        // Tidak perlu permission khusus — ukuran file bukan data sensitif
        return vfs.getSize(relativePath);
      }

      case SyscallCode.SET_IDENTITY: {
        const uuid = args as string;
        if (!uuid || typeof uuid !== "string") {
          throw new Error("SET_IDENTITY: UUID must be a non-empty string");
        }
        const success = this.scheduler.setProcessIdentity(pid, uuid);
        if (!success) {
          this.logger.warn(
            `SET_IDENTITY: UUID ${uuid} already held by another active process`,
          );
        }
        return success;
      }

      // ============================================================
      // DATABASE (DbLib) — transport: /dev/mysql (eksperimental)
      // TODO(security): tambah cek permission/whitelist PID sebelum produksi
      // ============================================================
      case SyscallCode.DB_CONNECT: {
        // Transport alternatif: service daemon (jika terdaftar)
        if (this.dbServicePid !== null) {
          return await this.forwardDbRequest(pid, "connect", args);
        }
        // Transport default: /dev/mysql device
        const device = this.kernel.devices?.mysql as any;
        if (!device) throw new Error("DB_CONNECT: /dev/mysql tidak tersedia");
        if (!args || typeof args !== "object") {
          throw new Error("DB_CONNECT: cfg {host,user,password,database} wajib");
        }
        const ok = await device.connect(args, pid);
        this.logger.info(
          `[DB] PID ${pid} connect → ${args.host}/${args.database}: ${ok}`,
        );
        return ok;
      }

      case SyscallCode.DB_QUERY: {
        // Transport alternatif: service daemon (jika terdaftar)
        if (this.dbServicePid !== null) {
          return await this.forwardDbRequest(pid, "query", args);
        }
        // Transport default: /dev/mysql device
        const device = this.kernel.devices?.mysql as any;
        if (!device) throw new Error("DB_QUERY: /dev/mysql tidak tersedia");
        if (!args || typeof args !== "string") {
          throw new Error("DB_QUERY: sql harus string");
        }
        const result = await device.query(args, pid);
        return result;
      }

      case SyscallCode.DB_DISCONNECT: {
        // Transport alternatif: service daemon (jika terdaftar)
        if (this.dbServicePid !== null) {
          return await this.forwardDbRequest(pid, "disconnect", null);
        }
        // Transport default: /dev/mysql device
        const device = this.kernel.devices?.mysql as any;
        if (!device) throw new Error("DB_DISCONNECT: /dev/mysql tidak tersedia");
        const ok = await device.disconnect(pid);
        this.logger.info(`[DB] PID ${pid} disconnect: ${ok}`);
        return ok;
      }

      // --- DB Service daemon (transport alternatif) ---
      case SyscallCode.DB_SERVICE_REGISTER: {
        this.dbServicePid = pid;
        this.logger.info(`[DB] PID ${pid} registered as DB service daemon`);
        return true;
      }

      case SyscallCode.DB_SERVICE_REPLY: {
        const { requestId, result } = args || {};
        const pending = this.pendingDbRequests.get(requestId);
        if (pending) {
          this.pendingDbRequests.delete(requestId);
          pending.resolve(result);
        }
        return true;
      }

      // --- Network Sniffer (bitshark) ---
      case SyscallCode.NET_SNIFFER_REGISTER: {
        // Dua bentuk argumen:
        //   lama: string iface ("*" / "smqtnl0" / dll)
        //   baru: { iface, decrypt } — decrypt=true = MINTA hasil dekripsi
        let iface = "*";
        let wantDecrypt = false;
        if (args != null && typeof args === "object") {
          iface = String((args as any).iface ?? "*");
          wantDecrypt = !!(args as any).decrypt;
        } else {
          iface = args == null ? "*" : String(args);
        }
        this.ensureSnifferWiring();
        if (!this.netSniffers.has(iface)) this.netSniffers.set(iface, new Map());
        const isRootSniffer = this.isRoot(pcb);
        // Izin: plaintext (decrypted) HANYA dikabulkan jika ROOT && decrypt
        // (opt-in eksplisit via flag --decrypt di bitshark). Non-root tidak pernah.
        this.netSniffers
          .get(iface)!
          .set(pid, { root: isRootSniffer, decrypt: wantDecrypt });
        this.logger.info(
          `[SNIFF] PID ${pid} (${isRootSniffer ? "ROOT" : "user"}${wantDecrypt ? ", decrypt:ON" : ""}) sniffing "${iface}"`,
        );
        return true;
      }

      case SyscallCode.NET_SNIFFER_UNREGISTER: {
        const iface = args == null ? "*" : String(args);
        const set = this.netSniffers.get(iface);
        if (set) {
          set.delete(pid);
          if (set.size === 0) this.netSniffers.delete(iface);
        }
        this.logger.info(`[SNIFF] PID ${pid} stopped sniffing "${iface}"`);
        return true;
      }

      // --- Pseudo Terminal (PTY, on-demand) ---
      case SyscallCode.PTY_ALLOC: {
        const ptyManager = this.kernel.getPTYManager?.() || null;
        if (!ptyManager) throw new Error("PTY subsystem not available");
        const opts = (args ?? {}) as { rows?: number; cols?: number };
        const pair = ptyManager.alloc();
        // Set ukuran awal jika diberikan
        if (opts.rows && opts.cols) {
          pair.slave.width = opts.cols;
          pair.slave.height = opts.rows;
        }

        // --- WIRE CTRL+C PADA SLAVE → SIGINT KE FOREGROUND PROCESS PTY ---
        // Sebelumnya onInterrupt slave TIDAK PERNAH di-set → injectInput("\x03")
        // membuang Ctrl+C diam-diam (continue) tanpa mengirim sinyal → di
        // pixelterm/tsshd/airtermd Ctrl+C tidak berefek.
        // Konsisten dengan konsol virtual: TTYManager mengikat tty.onInterrupt →
        // onInterruptCallback → Kernel kirim SIGINT ke foreground process TTY.
        // Proses di PTY memakai ttyId NEGATIF = -(ptyId+1) (lihat handler EXEC),
        // jadi foreground process dicari di ttyId tersebut.
        const ptyTtyId = -(pair.id + 1);
        pair.slave.onInterrupt = () => {
          const fgPid = this.scheduler?.getForegroundProcess(ptyTtyId);
          if (fgPid) {
            this.logger.info(
              `[PTY] Sending SIGINT to PID ${fgPid} (PTY${pair.id} Ctrl+C)`,
            );
            this.scheduler?.sendEvent(fgPid, "signal", "SIGINT");
          }
        };

        this.logger.info(
          `[PTY] PID ${pid} allocated PTY${pair.id} (/dev/pts/${pair.id})`,
        );
        return {
          id: pair.id,
          slavePath: `/dev/pts/${pair.id}`,
          masterPath: "/dev/ptmx",
        };
      }

      case SyscallCode.PTY_FREE: {
        const ptyManager = this.kernel.getPTYManager?.() || null;
        if (!ptyManager) throw new Error("PTY subsystem not available");
        const id = args as number;
        const ok = ptyManager.free(id);
        if (ok) this.logger.info(`[PTY] PID ${pid} freed PTY${id}`);
        return ok;
      }

      default:
        throw new Error(`Unknown Syscall: ${code}`);
    }
  }

  private async cleanupProcess(pid: number): Promise<boolean> {
    const pcb = this.scheduler.getProcess(pid);
    if (!pcb) return false;

    // Ensure all FDs are closed via the proper CLOSE syscall logic
    // (which handles socket cleanup, port release, and refcounts).
    for (let fd = 0; fd < pcb.fdTable.length; fd++) {
      if (pcb.fdTable[fd]) {
        try {
          await this.dispatch(pid, SyscallCode.CLOSE, fd);
        } catch (e) {
          // Ignore errors during mass cleanup
        }
      }
    }

    // Manual kill will trigger the onProcessExit hook (which resets the keyboard)
    await this.scheduler.kill(pid);

    return true;
  }
}
