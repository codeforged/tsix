import { Logger } from "../common/Logger";

/**
 * PORT MANAGER
 * 
 * Mengelola alokasi port virtual (0-65535) untuk networking MQTNL.
 */
export class PortManager {
    private usedPorts: Set<number> = new Set();
    private portOwner: Map<number, number> = new Map(); // port → PID yang punya
    private logger: Logger;

    constructor() {
        this.logger = new Logger("PortManager");
    }

    /**
     * allocatePort(): Mencoba memesan sebuah port.
     */
    public allocatePort(port: number, pid?: number): boolean {
        if (port < 0 || port > 65535) return false;
        if (this.usedPorts.has(port)) return false;

        this.usedPorts.add(port);
        if (pid !== undefined) this.portOwner.set(port, pid);
        this.logger.debug(`Port ${port} allocated${pid !== undefined ? ` for PID ${pid}` : ""}.`);
        return true;
    }

    /**
     * allocateRandomPort(): Mencari port bebas secara otomatis.
     */
    public allocateRandomPort(min: number = 10000, max: number = 20000): number | null {
        for (let i = 0; i < 100; i++) {
            const port = Math.floor(Math.random() * (max - min + 1)) + min;
            if (!this.usedPorts.has(port)) {
                this.usedPorts.add(port);
                this.logger.debug(`Random Port ${port} allocated.`);
                return port;
            }
        }
        return null;
    }

    /**
     * releasePort(): Membebaskan port agar bisa dipakai lagi.
     */
    public releasePort(port: number): void {
        this.usedPorts.delete(port);
        this.portOwner.delete(port);
        this.logger.debug(`Port ${port} released.`);
    }

    /**
     * releasePortsByPid(): Release all ports owned by a specific PID.
     * Dipanggil saat proses exit untuk cleanup port yang lupa di-close.
     */
    public releasePortsByPid(pid: number): void {
        const toRelease: number[] = [];
        this.portOwner.forEach((owner, port) => {
            if (owner === pid) toRelease.push(port);
        });
        for (const port of toRelease) {
            this.usedPorts.delete(port);
            this.portOwner.delete(port);
            this.logger.debug(`Port ${port} released (PID ${pid} cleanup).`);
        }
    }

    /**
     * isPortUsed(): Mengecek apakah port sedang dipakai.
     */
    public isPortUsed(port: number): boolean {
        return this.usedPorts.has(port);
    }
}
