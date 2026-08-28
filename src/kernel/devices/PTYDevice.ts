import { IDevice } from "./IDevice";
import { PTYSlaveDevice } from "./PTYSlaveDevice";

/**
 * PTY DEVICE (master) — /dev/ptmx
 *
 * Sisi "master" dari pasangan pseudo-terminal. Dipakai oleh daemon
 * (tsshd, airtermd, pixelterm) untuk:
 *   - write   → inject input ke slave (seolah-olah keyboard remote)
 *   - read    → ambil output dari slave (seolah-olah membaca layar remote)
 *
 * Setiap PTY punya SATU master. Master tidak pernah dipakai sebagai
 * stdin/stdout proses — hanya sebagai pegangan daemon.
 */
export class PTYDevice implements IDevice {
    public name: string = "ptmx";
    public uid: number = 0;
    public gid: number = 0;
    public mode: number = 0o600;

    private id: number;
    private slave: PTYSlaveDevice;

    constructor(id: number, slave: PTYSlaveDevice) {
        this.id = id;
        this.slave = slave;
        // Callback interrupt slave → (dipasang daemon via ioctl 0x3001)
    }

    public getPtyId(): number {
        return this.id;
    }

    public getSlave(): PTYSlaveDevice {
        return this.slave;
    }

    /**
     * read(): Master membaca output slave.
     * Berbagi outputBuffer yang sama dengan slave (satu sumber, tanpa duplikasi).
     */
    public read(): any {
        return this.slave.getOutput();
    }

    /** write(): Master menulis input → slave (line discipline). */
    public write(data: any): boolean {
        const str = data?.toString?.() ?? String(data ?? "");
        return this.slave.injectInput(str);
    }

    public ioctl(cmd: number, arg: any): any {
        switch (cmd) {
            case 10: // SET_RAW_MODE (slave) — kontrak TTY
                this.slave.setRawMode(!!arg);
                return 0;
            case 0x2001: // INJECT_INPUT → slave
                return this.slave.injectInput(arg as string);
            case 0x2002: // READ_OUTPUT → slave output
                return this.slave.getOutput();
            case 3: // TIOCSWINSZ → resize slave
                if (arg && typeof arg === "object") {
                    const { lines, columns } = arg as { lines: number; columns: number };
                    this.slave.width = (columns || 80);
                    this.slave.height = (lines || 24);
                }
                return 0;
            case 4: // TIOCGWINSZ
                return { lines: this.slave.height, columns: this.slave.width };
            case 0x3001: // SET_SLAVE_INTERRUPT (daemon pasang callback Ctrl+C)
                this.slave.onInterrupt = arg as () => void;
                return 0;
        }
        return -1;
    }
}
