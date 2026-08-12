import { IDevice } from "./IDevice";
import { IVFS } from "../../vfs/IVFS";

/**
 * FILE SYSTEM DEVICE
 * 
 * Driver yang menjembatani Syscall ke Filesystem Backend (BKFS atau HostVFS).
 * Ini membuat file di dalam VFS terlihat sama seperti hardware lainnya.
 */
export class FileSystemDevice implements IDevice {
    name = "FileSystem";
    private vfs: IVFS;
    private currentPath: string = "";
    private flags: string = "r";

    constructor(vfs: IVFS) {
        this.vfs = vfs;
    }

    /**
     * Kita butuh cara memberi tahu driver ini file mana yang mau diakses.
     */
    public setPath(path: string, flags: string = "r") {
        this.currentPath = path;
        this.flags = flags;
    }

    read() {
        if (!this.currentPath) return null;
        return this.vfs.read(this.currentPath);
    }

    write(data: any) {
        if (!this.currentPath) return false;

        const isAppend = this.flags.includes("a");
        const isWrite = this.flags.includes("w");
        const isUpdate = this.flags.includes("+");

        if (isAppend || isWrite || isUpdate) {
            return this.vfs.append(this.currentPath, data);
        }

        // Fallback: Default Overwrite (Backward Compatibility)
        return this.vfs.touch(this.currentPath, data);
    }

    ioctl(cmd: number, arg: any) { return -1; }
}
