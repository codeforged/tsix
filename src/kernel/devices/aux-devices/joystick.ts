/**
 * JOYSTICK / GAMEPAD DEVICE (/dev/joystick)
 *
 * Driver membaca joystick/gamepad yang terhubung ke PC host — langsung
 * dari KERNEL (Node.js), TANPA perantara browser/DOME.
 *
 * Mengikuti kontrak `IDevice` (HAL TSIX) — "Everything is a File".
 *
 * ── SUMBER DATA ──
 * 1. HID (real, default): kernel membuka USB HID gamepad via `node-hid`.
 *    - `HID.devices()` dipindai untuk perangkat gamepad (usagePage=1 &
 *      usage 4/5, atau nama mengandung "controller"/"joystick"/"gamepad").
 *    - Report HID mentah (default 14 byte, lihat LAYOUT di bawah) di-parse
 *      menjadi axes (-1..1) & buttons (0/1).
 *    - Hotplug USB (attach/detach) via package `usb`.
 * 2. INJECTION (virtual, fallback): untuk virtualisasi hardware & tes tanpa
 *    joystick fisik, host/simulator (mis. CLI `joy-sim`) bisa menyuntikkan
 *    state lewat ioctl `INJECT_STATE` / `CONNECT` / `DISCONNECT`.
 *
 * ── LAYOUT REPORT HID (default, 14-byte gamepad generik) ──
 *   byte 0-1 : sumbu X (u16 LE, center 32768)
 *   byte 2-3 : sumbu Y
 *   byte 4-5 : sumbu Z
 *   byte 6-7 : sumbu Rz
 *   byte 8-13: tombol bitfield (48 tombol)
 * Layout bisa disesuaikan via `setLayout()` untuk device lain.
 *
 *   Contoh report mentah (14 byte):
 *     <Buffer 0e 87 e7 73 ea 74 f9 7c 00 80 00 00 00 00>
 *      0e 87 = X     e7 73 = Y
 *      ea 74 = Z     f9 7c = Rz
 *      00 80 00 00 00 00 = tombol
 *
 * ── AKSES USERLAND ──
 *   const fd = await lib.fs.open("/dev/joystick", "r");
 *   const state = await lib.std.ioctl(fd, 1, null); // GET_STATE
 *   const axis0 = await lib.std.ioctl(fd, 2, 0);    // GET_AXIS index 0
 *   await lib.fs.close(fd);
 *
 * Default permission 0666 (semua user bisa baca) — konsisten dgn perangkat
 * input umum. Owner root:0.
 */

import { IDevice, KContext } from "../IDevice";

// ================================================================
// TYPES
// ================================================================

/** Snapshot state joystick yang siap dikonsumsi userland. */
export interface JoystickState {
  /** Apakah ada joystick yang terhubung. */
  connected: boolean;
  /** Identitas perangkat (product HID / id hasil connect). */
  id: string;
  /** Nilai axis: -1.0 (kiri/atas) .. 1.0 (kanan/bawah), deadzone diterapkan. */
  axes: number[];
  /** Nilai tombol analog: 0.0 (lepas) .. 1.0 (tekan penuh). */
  buttons: number[];
  /** Waktu update terakhir (epoch ms). */
  timestamp: number;
}

/** Perintah ioctl untuk /dev/joystick (namespace 0x4A = 'J'). */
export enum JoystickIOCTL {
  /** arg: null → JoystickState lengkap */
  GET_STATE = 0x4a01,
  /** arg: number (index axis) → number (-1..1) */
  GET_AXIS = 0x4a02,
  /** arg: number (index tombol) → number (0..1) */
  GET_BUTTON = 0x4a03,
  /** arg: null → boolean connected */
  IS_CONNECTED = 0x4a04,
  /** arg: null → { id, axes, buttons, deadzone } */
  GET_INFO = 0x4a05,
  /** arg: number (0..1) → deadzone baru */
  SET_DEADZONE = 0x4a06,
  /** arg: null → deadzone saat ini */
  GET_DEADZONE = 0x4a07,
  /** arg: null → kalibrasi titik tengah axis (pakai posisi saat ini) */
  CALIBRATE = 0x4a08,
  /** arg: { strong, weak } (opsional) → true (efek getar) */
  RUMBLE = 0x4a09,
  /** arg: null → reset semua state & kalibrasi */
  RESET = 0x4a0a,
  // ── INJECTION (host/simulator) — menulis state joystick virtual ──
  /** arg: { connected, id?, axes?, buttons? } → inject snapshot utuh */
  INJECT_STATE = 0x4a0b,
  /** arg: { id, axes, buttons } → hubungkan joystick */
  CONNECT = 0x4a0c,
  /** arg: null → putuskan joystick */
  DISCONNECT = 0x4a0d,
}

/** Konfigurasi layout report HID (default: 14-byte gamepad umum). */
export interface HidReportLayout {
  /** Indeks byte yang berisi bitfield tombol (tiap byte = 8 tombol). */
  buttonBytes: number[];
  /** Offset byte sumbu u16 LE (center = axisCenter). */
  axisOffsets: number[];
  /** Nilai tengah axis (default 32768 untuk u16). */
  axisCenter: number;
  /** Nilai max axis (default 32767 untuk u16). */
  axisMax: number;
}

// ================================================================
// DRIVER
// ================================================================

export class JoystickDevice implements IDevice {
  // ── Metadata hak akses ──
  public name = "Joystick"; // → /dev/joystick
  public uid = 0;
  public gid = 0;
  public mode = 0o666; // rw-rw-rw- (perangkat input, semua user bisa baca)

  private kctx: KContext | null = null;

  // ── State internal ──
  private connected = false;
  private deviceId = "";
  private axes: number[] = [];
  private buttons: number[] = [];
  private deadzone = 0.1; // 10% default — kecilkan noise analog stick
  private centerOffset: number[] = []; // offset kalibrasi titik tengah per axis
  private lastUpdate = 0;

  // ── node-hid & usb (dimuat lazy — jangan crash kalau belum terinstall) ──
  private hid: any = null; // module node-hid
  private usb: any = null; // module usb (hotplug)
  private device: any = null; // instance HID aktif
  private hotplugAttached: ((dev: any) => void) | null = null;
  private hotplugDetached: ((dev: any) => void) | null = null;

  // ── Layout report HID (default 14-byte gamepad generik) ──
  // Mapping hasil pengamatan perangkat: sumbu di byte 0-7, tombol di byte 8-13.
  private layout: HidReportLayout = {
    buttonBytes: [8, 9, 10, 11, 12, 13],
    axisOffsets: [0, 2, 4, 6],
    axisCenter: 32768,
    axisMax: 32767,
  };

  // ================================================================
  // LIFECYCLE (IDevice)
  // ================================================================

  /** Dipanggil Kernel saat device dimuat — suntikkan KContext. */
  public init(ctx: KContext): void {
    this.kctx = ctx;
    this.loadNativeModules();
    this.setupHotplug();
    this.log("Driver siap. Mencari gamepad USB HID...");
    this.tryConnect();
  }

  /** Buka device — pastikan koneksi HID aktif. */
  public open(): boolean {
    this.tryConnect();
    this.log("Device dibuka.");
    return true;
  }

  /** Tutup device — lepas koneksi HID. */
  public close(): boolean {
    this.disconnectHid();
    this.log("Device ditutup.");
    return true;
  }

  /**
   * present() → apakah ada joystick aktif sekarang.
   * - true saat HID terhubung ATAU sedang injection (virtualisasi h/w).
   * - false saat tidak ada hardware & tidak ada sim → `ls /dev` menyembunyikan node.
   */
  public present(): boolean {
    return this.connected;
  }

  // ================================================================
  // I/O (IDevice)
  // ================================================================

  /** read() → snapshot state sebagai JSON string. */
  public read(): any {
    return JSON.stringify(this.getState());
  }

  /**
   * write() → kirim perintah ke hardware.
   * Untuk joystick umumnya berupa efek (rumble/led). Data dikenali:
   *   { type: "rumble", option: { strong, weak } }
   */
  public write(data: any): boolean {
    try {
      if (data && typeof data === "object" && data.type === "rumble") {
        const o = data.option || {};
        this.log(`Rumble: strong=${o.strong ?? 0} weak=${o.weak ?? 0}`);
      }
      return true;
    } catch {
      return false;
    }
  }

  // ================================================================
  // IOCTL (IDevice)
  // ================================================================

  public ioctl(cmd: number, arg: any): any {
    switch (cmd) {
      case JoystickIOCTL.GET_STATE:
        return this.getState();

      case JoystickIOCTL.GET_AXIS:
        return this.getAxis(Number(arg));

      case JoystickIOCTL.GET_BUTTON:
        return this.getButton(Number(arg));

      case JoystickIOCTL.IS_CONNECTED:
        return this.connected;

      case JoystickIOCTL.GET_INFO:
        return {
          id: this.deviceId,
          axes: this.axes.length,
          buttons: this.buttons.length,
          deadzone: this.deadzone,
        };

      case JoystickIOCTL.SET_DEADZONE: {
        this.deadzone = this.clamp(Number(arg ?? this.deadzone), 0, 1);
        return this.deadzone;
      }

      case JoystickIOCTL.GET_DEADZONE:
        return this.deadzone;

      case JoystickIOCTL.CALIBRATE:
        return this.calibrateCenters();

      case JoystickIOCTL.RUMBLE: {
        const o = (arg && typeof arg === "object" ? arg : {}) as any;
        this.log(`Rumble via ioctl: strong=${o.strong ?? 0} weak=${o.weak ?? 0}`);
        return true;
      }

      case JoystickIOCTL.RESET:
        this.reset();
        return true;

      // ── INJECTION — menulis state joystick virtual (virtualisasi h/w) ──
      case JoystickIOCTL.INJECT_STATE: {
        const s = (arg && typeof arg === "object" ? arg : {}) as Partial<JoystickState>;
        if (s.connected) {
          const axisCount = Array.isArray(s.axes)
            ? s.axes.length
            : this.axes.length;
          const btnCount = Array.isArray(s.buttons)
            ? s.buttons.length
            : this.buttons.length;
          // Auto-connect jika belum terhubung atau jumlah axis/tombol berubah
          if (
            !this.connected ||
            this.axes.length !== axisCount ||
            this.buttons.length !== btnCount
          ) {
            this.connect(s.id || this.deviceId || "gamepad", axisCount, btnCount);
          } else if (s.id !== undefined && s.id !== this.deviceId) {
            this.deviceId = s.id;
          }
          if (Array.isArray(s.axes)) this.axes = s.axes.slice();
          if (Array.isArray(s.buttons)) this.buttons = s.buttons.slice();
          this.lastUpdate = Date.now();
        } else {
          this.disconnect();
        }
        return this.getState();
      }

      case JoystickIOCTL.CONNECT: {
        const c = (arg && typeof arg === "object" ? arg : {}) as {
          id?: string;
          axes?: number;
          buttons?: number;
        };
        this.connect(
          c.id || "gamepad",
          Number(c.axes) || 0,
          Number(c.buttons) || 0,
        );
        return this.connected;
      }

      case JoystickIOCTL.DISCONNECT:
        this.disconnect();
        return true;

      default:
        return null; // perintah tak dikenal
    }
  }

  // ================================================================
  // HID — node-hid (sumber REAL dari kernel)
  // ================================================================

  /** Muat module node-hid & usb secara lazy (aman kalau belum terinstall). */
  private loadNativeModules(): void {
    try {
      this.hid = require("node-hid");
    } catch (e: any) {
      this.log(`node-hid tidak tersedia: ${e?.message}`);
      this.hid = null;
    }
    try {
      this.usb = require("usb");
    } catch (e: any) {
      this.usb = null;
    }
  }

  /** Pasang listener hotplug USB (attach/detach) jika `usb` tersedia. */
  private setupHotplug(): void {
    if (!this.usb || typeof this.usb.on !== "function") return;
    try {
      this.hotplugAttached = () => {
        // Beri jeda agar OS selesai daftarkan HID subsystem sebelum dibuka
        setTimeout(() => this.tryConnect(), 1500);
      };
      this.hotplugDetached = () => {
        this.disconnectHid();
        // Cek ulang barangkali masih ada stik lain terpasang
        setTimeout(() => this.tryConnect(), 500);
      };
      this.usb.on("attach", this.hotplugAttached);
      this.usb.on("detach", this.hotplugDetached);
      this.log("Hotplug USB aktif.");
    } catch (e: any) {
      this.log(`Gagal pasang hotplug: ${e?.message}`);
    }
  }

  /** Cari & buka gamepad HID pertama yang cocok. */
  public tryConnect(): void {
    if (this.device) return; // sudah terhubung
    if (!this.hid) {
      this.log("node-hid tidak tersedia — mode injection (virtual).");
      return;
    }
    try {
      const devices = this.hid.devices();
      const found = devices.find(
        (d: any) =>
          (d.usagePage === 1 && (d.usage === 4 || d.usage === 5)) ||
          (d.product && /controller|joystick|gamepad/i.test(d.product)) ||
          (d.manufacturer && /controller|joystick|gamepad/i.test(d.manufacturer)),
      );
      if (!found) {
        this.log("Belum ada gamepad HID terdeteksi — mode injection (virtual).");
        return;
      }
      const dev = new this.hid.HID(found.path || found);
      this.device = dev;
      this.deviceId = found.product || found.path || "hid-gamepad";
      // Siapkan array sesuai layout default
      this.prepareArraysFromLayout();

      dev.on("data", (buf: Buffer) => this.onHidData(buf));
      dev.on("error", (err: Error) => {
        this.log(`HID error: ${err?.message}`);
        this.disconnectHid();
      });

      this.connected = true;
      this.lastUpdate = Date.now();
      this.log(
        `Connected HID: ${this.deviceId} (${this.axes.length} axes, ${this.buttons.length} buttons)`,
      );
    } catch (e: any) {
      this.log(`Gagal buka HID: ${e?.message}`);
      this.device = null;
    }
  }

  /** Terima report HID mentah → parse tombol & axis. */
  private onHidData(buf: Buffer): void {
    try {
      // Tombol: bitfield per byte
      for (let bi = 0; bi < this.layout.buttonBytes.length; bi++) {
        const off = this.layout.buttonBytes[bi];
        const byte = buf[off] ?? 0;
        for (let bit = 0; bit < 8; bit++) {
          const idx = bi * 8 + bit;
          if (idx >= this.buttons.length) break;
          this.buttons[idx] = (byte >> bit) & 1;
        }
      }
      // Axis: u16 LE dengan center
      for (let ai = 0; ai < this.layout.axisOffsets.length; ai++) {
        const off = this.layout.axisOffsets[ai];
        if (off + 1 >= buf.length) continue;
        if (ai >= this.axes.length) break;
        const raw = buf.readUInt16LE(off);
        this.axes[ai] = this.clamp(
          (raw - this.layout.axisCenter) / this.layout.axisMax,
          -1,
          1,
        );
      }
      this.lastUpdate = Date.now();
    } catch (_) {
      /* parse error — abaikan report */
    }
  }

  /** Siapkan array axes/buttons mengikuti ukuran layout. */
  private prepareArraysFromLayout(): void {
    const axisCount = this.layout.axisOffsets.length;
    const btnCount = this.layout.buttonBytes.length * 8;
    this.axes = new Array(axisCount).fill(0);
    this.buttons = new Array(btnCount).fill(0);
    this.centerOffset = new Array(axisCount).fill(0);
  }

  /** Set layout report HID (untuk device yang formatnya beda). */
  public setLayout(layout: Partial<HidReportLayout>): void {
    this.layout = { ...this.layout, ...layout };
    this.log(
      `Layout HID: buttonBytes=[${this.layout.buttonBytes}] axisOffsets=[${this.layout.axisOffsets}]`,
    );
  }

  /** Lepas koneksi HID. */
  private disconnectHid(): void {
    if (this.device) {
      try {
        this.device.close();
      } catch (_) { }
    }
    this.device = null;
    this.connected = false;
    this.deviceId = "";
    this.log("HID dicabut.");
  }

  // ================================================================
  // INJECTION API — untuk host/simulator menyuntikkan state virtual
  // ================================================================

  /** Hubungkan joystick virtual/real dari host. */
  public connect(id: string, axisCount: number, buttonCount: number): void {
    this.deviceId = id || "unknown";
    this.axes = new Array(Math.max(0, axisCount)).fill(0);
    this.buttons = new Array(Math.max(0, buttonCount)).fill(0);
    this.centerOffset = new Array(this.axes.length).fill(0);
    this.connected = true;
    this.lastUpdate = Date.now();
    this.log(`Connected: ${this.deviceId} (${this.axes.length} axes, ${this.buttons.length} buttons)`);
  }

  /** Putuskan joystick. */
  public disconnect(): void {
    this.connected = false;
    this.deviceId = "";
    this.lastUpdate = Date.now();
    this.log("Disconnected.");
  }

  /** Ganti seluruh state sekaligus (dipakai host tiap frame). */
  public updateState(state: Partial<JoystickState>): void {
    if (typeof state.connected === "boolean") this.connected = state.connected;
    if (state.id !== undefined) this.deviceId = state.id;
    if (Array.isArray(state.axes)) this.axes = state.axes.slice();
    if (Array.isArray(state.buttons)) this.buttons = state.buttons.slice();
    this.lastUpdate = Date.now();
  }

  /** Set nilai satu axis (index, -1..1). */
  public setAxis(index: number, value: number): void {
    if (index < 0 || index >= this.axes.length) return;
    this.axes[index] = this.clamp(Number(value) || 0, -1, 1);
    this.lastUpdate = Date.now();
  }

  /** Set nilai satu tombol (index, 0..1). */
  public setButton(index: number, value: number): void {
    if (index < 0 || index >= this.buttons.length) return;
    this.buttons[index] = this.clamp(Number(value) || 0, 0, 1);
    this.lastUpdate = Date.now();
  }

  // ================================================================
  // INTERNAL
  // ================================================================

  private log(msg: string): void {
    if (this.kctx) {
      this.kctx.syslog(`[joystick] ${msg}`);
    }
  }

  /** Bangun snapshot state (deadzone diterapkan pada axis). */
  private getState(): JoystickState {
    const axesOut: number[] = [];
    for (let i = 0; i < this.axes.length; i++) {
      axesOut.push(this.getAxis(i));
    }
    return {
      connected: this.connected,
      id: this.deviceId,
      axes: axesOut,
      buttons: this.buttons.slice(),
      timestamp: this.lastUpdate,
    };
  }

  /** Baca satu axis dengan deadzone + offset kalibrasi. */
  private getAxis(index: number): number {
    if (!this.connected || index < 0 || index >= this.axes.length) return 0;
    const raw = this.axes[index] - (this.centerOffset[index] || 0);
    return this.applyDeadzone(this.clamp(raw, -1, 1));
  }

  /** Baca satu tombol (0..1). */
  private getButton(index: number): number {
    if (!this.connected || index < 0 || index >= this.buttons.length) return 0;
    return this.buttons[index];
  }

  /** Nol-kan axis yang nilainya di bawah deadzone. */
  private applyDeadzone(value: number): number {
    return Math.abs(value) < this.deadzone ? 0 : value;
  }

  /** Ambil posisi axis saat ini sebagai titik tengah (kalibrasi). */
  private calibrateCenters(): boolean {
    if (!this.connected) return false;
    this.centerOffset = this.axes.slice();
    this.log("Kalibrasi titik tengah selesai.");
    return true;
  }

  /** Reset seluruh state + kalibrasi. */
  private reset(): void {
    this.axes = [];
    this.buttons = [];
    this.centerOffset = [];
    this.connected = false;
    this.deviceId = "";
    this.deadzone = 0.1;
    this.lastUpdate = 0;
    this.log("Device di-reset.");
  }

  /** Batasi nilai ke rentang [min, max]. */
  private clamp(v: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, v));
  }
}

// Plugin Export: kernel memakai `module.default || module` lalu `new DeviceClass()`.
export default JoystickDevice;
