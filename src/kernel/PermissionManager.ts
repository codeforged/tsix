import { Logger } from "../common/Logger";
import { PCB } from "./Scheduler";

/**
 * PERMISSION TYPES
 * r = 4, w = 2, x = 1
 */
export enum Permission {
    READ = 4,
    WRITE = 2,
    EXECUTE = 1
}

/**
 * PERMISSION MANAGER
 * 
 * Melakukan pengecekan rwxrwxrwx (Owner, Group, Others).
 */
export class PermissionManager {
    private logger: Logger;

    constructor() {
        this.logger = new Logger("PermissionManager");
    }

    /**
     * check(): Validasi apakah sebuah proses punya hak akses.
     * @param pcb Proses yang meminta akses
     * @param node Data file/folder dari database (Berisi uid, gid, mode)
     * @param requested Jenis akses (READ, WRITE, atau EXECUTE)
     */
    public check(pcb: PCB, node: any, requested: Permission): boolean {
        // 1. ROOT (UID 0) selalu punya akses ke semuanya (God Mode)
        if (pcb.uid === 0) return true;

        const mode = node.mode; // Mode disimpan sebagai decimal di SQLite

        // 2. Cek sebagai OWNER
        if (pcb.uid === node.uid) {
            const userMode = (mode >> 6) & 0x7;
            if ((userMode & requested) === requested) return true;
        }

        // 3. Cek sebagai GROUP
        if (pcb.gid === node.gid || (pcb.groups && pcb.groups.includes(node.gid))) {
            const groupMode = (mode >> 3) & 0x7;
            if ((groupMode & requested) === requested) return true;
        }

        // 4. Cek sebagai OTHERS
        const otherMode = mode & 0x7;
        if ((otherMode & requested) === requested) return true;

        this.logger.warn(`Permission Denied: PID [${pcb.pid}] User [${pcb.uid}] requested ${Permission[requested]} on ${node.name}`);
        return false;
    }

    /**
     * parseMode(): Helper untuk mengubah string octal (misal: "755") ke decimal.
     */
    public static parseMode(octal: string | number): number {
        return parseInt(octal.toString(), 8);
    }
}
