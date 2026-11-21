import { IDevice } from "./IDevice";

/**
 * PIPE DEVICE (FIFO)
 * 
 * Driver untuk komunikasi antar proses (Inter-Process Communication).
 * Menggunakan Reference Counting untuk mendeteksi EOF.
 */
export class PipeDevice implements IDevice {
    name = "Pipe";
    private buffer: string[] = [];

    // Reference Counting
    private readRefs = 0;
    private writeRefs = 0;

    public read(): string | null {
        if (this.buffer.length === 0) {
            // Jika tidak ada data DAN tidak ada lagi penulis (writeRefs === 0), kembalikan EOF ("")
            if (this.writeRefs === 0) return "";

            // Masih ada penulis tapi buffer kosong, kembalikan null (wait)
            return null;
        }
        return this.buffer.shift() || "";
    }

    public write(data: any): boolean {
        // Jika tidak ada pembaca, tulis dianggap gagal/pipa pecah
        if (this.readRefs === 0) return false;
        if (data === null || data === undefined) return false;

        this.buffer.push(data.toString());
        return true;
    }

    public ioctl(cmd: number, arg: any): any {
        switch (cmd) {
            case 10: // INC_READ_REF
                this.readRefs++;
                return 0;
            case 11: // DEC_READ_REF
                this.readRefs = Math.max(0, this.readRefs - 1);
                return 0;
            case 20: // INC_WRITE_REF
                this.writeRefs++;
                return 0;
            case 21: // DEC_WRITE_REF
                this.writeRefs = Math.max(0, this.writeRefs - 1);
                return 0;
            case 2: // Legacy CLOSE
                this.writeRefs = 0;
                return 0;
        }
        return -1;
    }
}
