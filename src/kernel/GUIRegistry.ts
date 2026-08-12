import { IWindowEntry, IGUIPayload, GUIAction } from "../common/GUITypes";
import { Logger } from "../common/Logger";

/**
 * GUI REGISTRY — RFC-TSIX-002 Layer 2
 * 
 * Dimiliki oleh Kernel. Otoritas tunggal untuk mapping wid ↔ pid.
 * 
 * Tugas:
 * 1. Mencatat kepemilikan setiap window (wid → pid)
 * 2. Mengelola Z-Index ordering
 * 3. Menyediakan lookup untuk otentikasi GUI_REQ
 * 4. Cleanup otomatis saat process mati
 */
export class GUIRegistry {
    private logger: Logger;

    /** Primary map: wid → IWindowEntry */
    private windows: Map<string, IWindowEntry> = new Map();

    /** Reverse map: pid → Set<wid> (untuk lookup cepat saat process exit) */
    private pidToWids: Map<number, Set<string>> = new Map();

    /** Counter untuk auto-increment Z-Index. Start dari 100. */
    private nextZIndex: number = 100;

    /** PID dari gued daemon. Hanya gued yang boleh menerima forward GUI_REQ. */
    private guedPid: number | null = null;

    constructor() {
        this.logger = new Logger("GUIRegistry");
    }

    // ============================================================
    // DAEMON MANAGEMENT
    // ============================================================

    /**
     * registerDaemon(): Catat PID gued.
     * Harus dipanggil saat gued pertama kali spawn.
     */
    public registerDaemon(pid: number): void {
        this.guedPid = pid;
        this.logger.info(`GUI Daemon (gued) registered at PID ${pid}`);
    }

    /**
     * getDaemonPid(): Dapatkan PID gued yang sedang aktif.
     */
    public getDaemonPid(): number | null {
        return this.guedPid;
    }

    /**
     * isDaemonAlive(): Cek apakah gued masih terdaftar.
     */
    public isDaemonAlive(): boolean {
        return this.guedPid !== null;
    }

    // ============================================================
    // WINDOW LIFECYCLE
    // ============================================================

    /**
     * createWindow(): Daftarkan window baru.
     * Dipanggil saat Kernel memproses GUI_REQ dengan action CREATE_WINDOW.
     */
    public createWindow(wid: string, pid: number, title: string = "Untitled"): IWindowEntry {
        // Cegah duplikat wid
        if (this.windows.has(wid)) {
            throw new Error(`GUIRegistry: Window '${wid}' already exists.`);
        }

        const entry: IWindowEntry = {
            wid,
            pid,
            title,
            zIndex: this.nextZIndex++,
            focused: true,   // Window baru otomatis focused
            createdAt: Date.now(),
        };

        this.windows.set(wid, entry);

        // Update reverse map
        if (!this.pidToWids.has(pid)) {
            this.pidToWids.set(pid, new Set());
        }
        this.pidToWids.get(pid)!.add(wid);

        // Defocus windows lain yang sebelumnya focused
        this.windows.forEach(w => {
            if (w.wid !== wid && w.focused) {
                w.focused = false;
            }
        });

        this.logger.debug(`Window '${wid}' created for PID ${pid} (z=${entry.zIndex})`);
        return entry;
    }

    /**
     * destroyWindow(): Hapus window dari registry.
     * Dipanggil saat GUI_REQ DESTROY_WINDOW atau process exit.
     */
    public destroyWindow(wid: string): boolean {
        const entry = this.windows.get(wid);
        if (!entry) return false;

        // Hapus dari reverse map
        const pidSet = this.pidToWids.get(entry.pid);
        if (pidSet) {
            pidSet.delete(wid);
            if (pidSet.size === 0) {
                this.pidToWids.delete(entry.pid);
            }
        }

        this.windows.delete(wid);
        this.logger.debug(`Window '${wid}' destroyed (PID ${entry.pid})`);
        return true;
    }

    /**
     * getWindowsForPid(): Dapatkan semua wid milik sebuah PID.
     * Digunakan saat process exit untuk cleanup massal.
     */
    public getWindowsForPid(pid: number): string[] {
        const pidSet = this.pidToWids.get(pid);
        return pidSet ? Array.from(pidSet) : [];
    }

    /**
     * destroyAllForPid(): Hapus SEMUA window milik sebuah PID.
     * Dipanggil saat process exit/kill.
     * 
     * @returns Array of wid yang dihancurkan (untuk dikirim sebagai 
     *          DESTROY_WINDOW ke gued).
     */
    public destroyAllForPid(pid: number): string[] {
        const wids = this.getWindowsForPid(pid);
        for (const wid of wids) {
            this.windows.delete(wid);
        }
        this.pidToWids.delete(pid);

        if (wids.length > 0) {
            this.logger.info(`Cleaned up ${wids.length} windows for exited PID ${pid}`);
        }
        return wids;
    }

    // ============================================================
    // AUTHENTICATION (Piagam Antigonon — Aturan Keamanan)
    // ============================================================

    /**
     * isOwner(): Cek apakah pid adalah pemilik sah dari wid.
     * 
     * @returns true jika pid memiliki wid, false jika tidak.
     */
    public isOwner(pid: number, wid: string): boolean {
        const entry = this.windows.get(wid);
        if (!entry) return false;
        return entry.pid === pid;
    }

    /**
     * getOwner(): Dapatkan PID pemilik window.
     * @returns PID pemilik, atau null jika window tidak ditemukan.
     */
    public getOwner(wid: string): number | null {
        const entry = this.windows.get(wid);
        return entry ? entry.pid : null;
    }

    // ============================================================
    // Z-INDEX & FOCUS MANAGEMENT
    // ============================================================

    /**
     * setFocus(): Set window sebagai focused, defocus yang lain.
     */
    public setFocus(wid: string): boolean {
        const entry = this.windows.get(wid);
        if (!entry) return false;

        // Bawa ke depan (Z-Index tertinggi)
        entry.zIndex = this.nextZIndex++;
        entry.focused = true;

        // Defocus windows lain
        this.windows.forEach(w => {
            if (w.wid !== wid) w.focused = false;
        });

        return true;
    }

    /**
     * getTopWindow(): Dapatkan window dengan Z-Index tertinggi.
     */
    public getTopWindow(): IWindowEntry | null {
        let top: IWindowEntry | null = null;
        this.windows.forEach(w => {
            if (!top || w.zIndex > top.zIndex) {
                top = w;
            }
        });
        return top;
    }

    /**
     * getFocusedWindow(): Dapatkan window yang sedang focused.
     */
    public getFocusedWindow(): IWindowEntry | null {
        for (const w of this.windows.values()) {
            if (w.focused) return w;
        }
        return null;
    }

    /**
     * setWsClientId(): Catat WebSocket client ID untuk window tertentu.
     * Dipanggil oleh gued saat browser connect.
     */
    public setWsClientId(wid: string, wsClientId: string): boolean {
        const entry = this.windows.get(wid);
        if (!entry) return false;
        entry.wsClientId = wsClientId;
        return true;
    }

    // ============================================================
    // QUERY
    // ============================================================

    /**
     * getWindow(): Dapatkan entry window berdasarkan wid.
     */
    public getWindow(wid: string): IWindowEntry | undefined {
        return this.windows.get(wid);
    }

    /**
     * getAllWindows(): Dapatkan snapshot seluruh window registry.
     */
    public getAllWindows(): IWindowEntry[] {
        return Array.from(this.windows.values());
    }

    /**
     * getWindowCount(): Jumlah window yang terdaftar.
     */
    public getWindowCount(): number {
        return this.windows.size;
    }

    /**
     * getWindowCountForPid(): Jumlah window milik PID tertentu.
     */
    public getWindowCountForPid(pid: number): number {
        const pidSet = this.pidToWids.get(pid);
        return pidSet ? pidSet.size : 0;
    }
}
