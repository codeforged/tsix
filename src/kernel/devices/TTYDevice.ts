import { IDevice } from "./IDevice";
import { TTY } from "../tty/TTY";

/**
 * TTY DEVICE
 * 
 * Driver yang membungkus objek TTY untuk diekspos ke VFS sebagai /dev/ttyX.
 */
export class TTYDevice implements IDevice {
    public name: string;
    private tty: TTY;
    private isActive: () => boolean;

    /**
     * @param id Nomor TTY (1-6)
     * @param tty Objek TTY yang dikelola
     * @param isActive Fungsi callback untuk mengecek apakah TTY ini sedang aktif di layar
     */
    constructor(id: number, tty: TTY, isActive: () => boolean) {
        this.name = `tty${id}`;
        this.tty = tty;
        this.isActive = isActive;
    }

    public read(): any {
        // Ambil data dari buffer input TTY
        return this.tty.read();
    }

    /**
     * write(): Menulis ke buffer TTY. Jika aktif, langsung lempar ke stdout host.
     */
    write(data: string): boolean {
        this.tty.write(data);
        return true;
    }

    public ioctl(cmd: number, arg: any): any {
        if (cmd === 1) { // 1 = CLEAR_SCREEN
            this.tty.clear();
            if (this.isActive()) {
                process.stdout.write("\x1bc");
            }
            return 0;
        }
        if (cmd === 2) { // 2 = SWITCH_TTY
            return -1; // Handled in Syscalls.ts via Kernel.ttyManager
        }
        if (cmd === 10) { // 10 = SET_RAW_MODE
            this.tty.setRawMode(!!arg);
            return 0;
        }
        if (cmd === 0x2001) { // INJECT_INPUT (Master typing into slave stdin)
            this.tty.pushInput(arg as string);
            return true;
        }
        if (cmd === 0x2002) { // READ_OUTPUT (Master reading slave stdout)
            return this.tty.getOutput();
        }
        if (cmd === 4) { // 4 = TIOCGWINSZ (Get Window Size)
            return { lines: this.tty.height, columns: this.tty.width };
        }
        return -1;
    }
}

