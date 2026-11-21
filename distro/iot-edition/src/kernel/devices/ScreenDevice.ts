import { IDevice } from "./IDevice";

/**
 * SCREEN DEVICE (Framebuffer Emulator)
 * 
 * Driver untuk mengelola output ke layar.
 * Memberikan informasi tentang dimensi terminal ($LINES & $COLUMNS).
 */
export class ScreenDevice implements IDevice {
    name = "Screen";

    /**
     * read(): Mengembalikan informasi dimensi layar.
     */
    read() {
        return {
            lines: process.stdout.rows || 24,
            columns: process.stdout.columns || 80
        };
    }

    /**
     * write(): Menulis data ke layar (sama seperti ConsoleDevice tapi lebih 'low-level').
     */
    write(data: any): boolean {
        process.stdout.write(data);
        return true;
    }

    public ioctl(_cmd: number, _arg: any): any {
        return true;
    }

    /**
     * clear(): Membersihkan layar terminal.
     */
    public clear() {
        process.stdout.write("\x1bc");
    }
}
