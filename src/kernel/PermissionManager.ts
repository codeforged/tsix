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

        // Semantik Unix: kelas PERTAMA yang cocok yang menentukan, tidak
        // "jatuh" ke kelas berikutnya (SEC-18). Owner hanya memakai bit owner;
        // anggota grup hanya bit group; sisanya bit others. Dulu owner/grup
        // yang ditolak bit-nya tetap lolos lewat bit others (mis. 0o604
        // seharusnya menolak anggota grup).
        let bits: number;
        if (pcb.uid === node.uid) {
            // 2. OWNER
            bits = (mode >> 6) & 0x7;
        } else if (pcb.gid === node.gid || (pcb.groups && pcb.groups.includes(node.gid))) {
            // 3. GROUP
            bits = (mode >> 3) & 0x7;
        } else {
            // 4. OTHERS
            bits = mode & 0x7;
        }
        if ((bits & requested) === requested) return true;

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
