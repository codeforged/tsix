/**
 * joystickLib.ts — Userland library untuk /dev/joystick
 *
 * Wrapper tingkat tinggi di atas device joystick (kernel aux-device).
 * Developer aplikasi TIDAK perlu pusing dengan FD & nomor ioctl — cukup
 * panggil method yang manusiawi.
 *
 * ── USAGE ──
 *   import { joystick } from "../lib/joystickLib";
 *
 *   if (await joystick.isConnected()) {
 *     const st = await joystick.getState();
 *     std.log(`Axis0: ${st.axes[0]}, Tombol A: ${st.buttons[0]}`);
 *   }
 *
 * Atau instance sendiri (untuk test/inject lib):
 *   import { JoystickLib } from "../lib/joystickLib";
 *   const joy = new JoystickLib(lib); // lib = UserLib
 *
 * ── CATATAN ──
 * Konstanta ioctl di bawah HARUS sinkron dengan enum `JoystickIOCTL` di
 * driver kernel: src/kernel/devices/aux-devices/joystick.ts
 */

// Perintah ioctl (namespace 0x4A = 'J') — wajib match dengan kernel driver.
const JOY_GET_STATE = 0x4a01; // null        → JoystickSnapshot
const JOY_GET_AXIS = 0x4a02; // index       → number (-1..1)
const JOY_GET_BUTTON = 0x4a03; // index       → number (0..1)
const JOY_IS_CONNECTED = 0x4a04; // null        → boolean
const JOY_GET_INFO = 0x4a05; // null        → { id, axes, buttons, deadzone }
const JOY_SET_DEADZONE = 0x4a06; // number      → deadzone baru
const JOY_GET_DEADZONE = 0x4a07; // null        → number
const JOY_CALIBRATE = 0x4a08; // null        → boolean
const JOY_RUMBLE = 0x4a09; // {strong,weak} → boolean
const JOY_RESET = 0x4a0a; // null        → boolean
const JOY_INJECT_STATE = 0x4a0b; // {connected,id?,axes?,buttons?} → state
const JOY_CONNECT = 0x4a0c; // {id,axes,buttons} → boolean
const JOY_DISCONNECT = 0x4a0d; // null         → boolean

/** Path device joystick di VFS. */
export const JOYSTICK_DEVICE_PATH = "/dev/joystick";

// ================================================================
// TYPES
// ================================================================

/** Snapshot state joystick (sama dgn JoystickState di kernel driver). */
export interface JoystickSnapshot {
    connected: boolean;
    id: string;
    axes: number[];
    buttons: number[];
    timestamp: number;
}

/** Info statis perangkat. */
export interface JoystickInfo {
    id: string;
    axes: number;
    buttons: number;
    deadzone: number;
}

// ================================================================
// LIBRARY
// ================================================================

export class JoystickLib {
    private _lib: any;
    private fd: number | null = null;

    /**
     * @param lib UserLib instance (opsional). Default: `(global as any)._tsixLib`
     *           — cocok untuk dipakai dari berbagai konteks (bin, lib, app).
     */
    constructor(lib?: any) {
        this._lib = lib || null;
    }

    /** Resolusi lazy — `global._tsixLib` baru tersedia saat runtime worker. */
    private get lib(): any {
        return this._lib || (global as any)._tsixLib || null;
    }

    private get fs(): any {
        return this.lib?.fs;
    }

    private get std(): any {
        return this.lib?.std;
    }

    /** Buka device sekali (lazy) — FD di-cache sampai close(). */
    private async ensureOpen(): Promise<number> {
        if (this.fd !== null) return this.fd;
        if (!this.lib?.fs || !this.lib?.std) {
            throw new Error(
                "[joystickLib] UserLib tidak tersedia (global._tsixLib kosong?). " +
                "Pastikan dipanggil di lingkungan TSIX Worker.",
            );
        }
        const fd = await this.fs.open(JOYSTICK_DEVICE_PATH, "r");
        if (fd < 0) {
            throw new Error(
                `[joystickLib] Gagal buka ${JOYSTICK_DEVICE_PATH} (fd=${fd}). ` +
                `Pastikan driver joystick sudah di-load kernel.`,
            );
        }
        this.fd = fd;
        return fd;
    }

    /** Tutup FD (jika terbuka). Panggil saat app selesai. */
    public async close(): Promise<void> {
        if (this.fd !== null) {
            try {
                await this.fs.close(this.fd);
            } catch {
                /* abaikan */
            }
            this.fd = null;
        }
    }

    /** Cek apakah device joystick ada & bisa dibuka. */
    public async isAvailable(): Promise<boolean> {
        try {
            const fd = await this.ensureOpen();
            return fd >= 0;
        } catch {
            return false;
        }
    }

    /** Apakah ada joystick yang terhubung. */
    public async isConnected(): Promise<boolean> {
        const fd = await this.ensureOpen();
        return !!(await this.std.ioctl(fd, JOY_IS_CONNECTED, null));
    }

    /** Snapshot lengkap: axes (deadzone applied) + buttons + timestamp. */
    public async getState(): Promise<JoystickSnapshot> {
        const fd = await this.ensureOpen();
        return (await this.std.ioctl(fd, JOY_GET_STATE, null)) as JoystickSnapshot;
    }

    /** Baca satu axis (-1..1). Index di luar rentang → 0. */
    public async getAxis(index: number): Promise<number> {
        const fd = await this.ensureOpen();
        return Number(await this.std.ioctl(fd, JOY_GET_AXIS, index)) || 0;
    }

    /** Baca satu tombol (0..1 analog). */
    public async getButton(index: number): Promise<number> {
        const fd = await this.ensureOpen();
        return Number(await this.std.ioctl(fd, JOY_GET_BUTTON, index)) || 0;
    }

    /** Cek tombol ditekan (analog > 0.5). */
    public async isPressed(index: number): Promise<boolean> {
        return (await this.getButton(index)) > 0.5;
    }

    /** Info statis perangkat (jumlah axis/tombol, deadzone). */
    public async getInfo(): Promise<JoystickInfo> {
        const fd = await this.ensureOpen();
        return (await this.std.ioctl(fd, JOY_GET_INFO, null)) as JoystickInfo;
    }

    /** Jumlah axis joystick. */
    public async getAxisCount(): Promise<number> {
        const info = await this.getInfo();
        return info?.axes ?? 0;
    }

    /** Jumlah tombol joystick. */
    public async getButtonCount(): Promise<number> {
        const info = await this.getInfo();
        return info?.buttons ?? 0;
    }

    /** Set deadzone (0..1) — nilai axis di bawahnya dianggap 0. */
    public async setDeadzone(value: number): Promise<number> {
        const fd = await this.ensureOpen();
        return Number(await this.std.ioctl(fd, JOY_SET_DEADZONE, value));
    }

    /** Baca deadzone saat ini. */
    public async getDeadzone(): Promise<number> {
        const fd = await this.ensureOpen();
        return Number(await this.std.ioctl(fd, JOY_GET_DEADZONE, null));
    }

    /** Kalibrasi titik tengah — posisi axis saat ini jadi netral. */
    public async calibrate(): Promise<boolean> {
        const fd = await this.ensureOpen();
        return !!(await this.std.ioctl(fd, JOY_CALIBRATE, null));
    }

    /** Efek getar (rumble): strong 0..1, weak 0..1. */
    public async rumble(strong = 0, weak = 0): Promise<boolean> {
        const fd = await this.ensureOpen();
        return !!(await this.std.ioctl(fd, JOY_RUMBLE, { strong, weak }));
    }

    /** Reset device ke kondisi awal. */
    public async reset(): Promise<boolean> {
        const fd = await this.ensureOpen();
        return !!(await this.std.ioctl(fd, JOY_RESET, null));
    }

    /** Baca state mentah (read() device → JSON string), atau null jika gagal. */
    public async readRaw(): Promise<string | null> {
        try {
            const fd = await this.ensureOpen();
            const raw = await this.fs.read(fd);
            return typeof raw === "string" ? raw : null;
        } catch {
            return null;
        }
    }

    // ================================================================
    // INJECTION — menulis state joystick virtual (tes CLI / emulasi)
    // ================================================================

    /** Inject snapshot utuh — otomatis connect jika belum/berubah. */
    public async injectState(
        state: Partial<JoystickSnapshot>,
    ): Promise<boolean> {
        try {
            const fd = await this.ensureOpen();
            await this.std.ioctl(fd, JOY_INJECT_STATE, state);
            return true;
        } catch {
            return false;
        }
    }

    /** Hubungkan joystick virtual dengan jumlah axis/tombol tertentu. */
    public async injectConnect(
        id: string,
        axes: number,
        buttons: number,
    ): Promise<boolean> {
        try {
            const fd = await this.ensureOpen();
            return !!(await this.std.ioctl(fd, JOY_CONNECT, { id, axes, buttons }));
        } catch {
            return false;
        }
    }

    /** Putuskan joystick virtual. */
    public async injectDisconnect(): Promise<boolean> {
        try {
            const fd = await this.ensureOpen();
            return !!(await this.std.ioctl(fd, JOY_DISCONNECT, null));
        } catch {
            return false;
        }
    }
}

// ================================================================
// SINGLETON KONVENIEN (gaya theme.ts / cashew.ts)
// ================================================================

/** Instance global — pakai lib aktif dari `(global as any)._tsixLib`. */
export const joystick = new JoystickLib();

export default JoystickLib;
