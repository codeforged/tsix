import { Logger } from "../common/Logger";
import { PTYDevice } from "./devices/PTYDevice";
import { PTYSlaveDevice } from "./devices/PTYSlaveDevice";

/**
 * PTY MANAGER
 *
 * Allocator pseudo-terminal on-demand (mirip PortManager).
 * PTY dibuat saat dibutuhkan (ada sesi sshd/airtermd/pixelterm) dan
 * dibebaskan saat selesai → hemat RAM dibanding pre-alokasi konsol virtual.
 *
 * Setiap PTY = pasangan (master, slave):
 *   - master: /dev/ptmx  → dipegang daemon
 *   - slave : /dev/pts/N → dipakai proses (login/shell)
 *
 * Nomor PTY independen dari nomor konsol virtual (tty1..N), ala Linux.
 */
export interface PTYPair {
    id: number;
    master: PTYDevice;
    slave: PTYSlaveDevice;
}

export class PTYManager {
    private pairs: Map<number, PTYPair> = new Map();
    private nextId: number = 0;
    private logger: Logger;

    constructor() {
        this.logger = new Logger("PTYManager");
    }

    /** alloc(): Buat PTY baru on-demand. */
    public alloc(): PTYPair {
        const id = this.nextId++;
        const slave = new PTYSlaveDevice(id);
        const master = new PTYDevice(id, slave);
        const pair: PTYPair = { id, master, slave };
        this.pairs.set(id, pair);
        this.logger.info(`PTY${id} allocated (master + slave pts/${id}).`);
        return pair;
    }

    /** free(): Bebaskan PTY (hapus dari registry). */
    public free(id: number): boolean {
        const pair = this.pairs.get(id);
        if (!pair) return false;
        this.pairs.delete(id);
        this.logger.info(`PTY${id} freed.`);
        return true;
    }

    public get(id: number): PTYPair | undefined {
        return this.pairs.get(id);
    }

    public getMaster(id: number): PTYDevice | undefined {
        return this.pairs.get(id)?.master;
    }

    public getSlave(id: number): PTYSlaveDevice | undefined {
        return this.pairs.get(id)?.slave;
    }

    public list(): PTYPair[] {
        return Array.from(this.pairs.values());
    }

    public count(): number {
        return this.pairs.size;
    }
}
