import { OSContext } from "./IProgram";
import { SyscallCode } from "./common/SyscallCode";

/**
 * RANDOM LIB (User Extension)
 * 
 * Terisolasi dari kernel core. Om bisa ngoprek di sini sepuasnya!
 * Menghubungkan aplikasi ke /dev/randomdevice.
 */
export class RandomLib {
    constructor(private os: OSContext) { }

    /**
     * getNumber(): Ngambil angka acak dengan cara pro.
     */
    public async getNumber(): Promise<number> {
        // Buka device
        const fd = await this.os.fs.open("/dev/randomdevice");
        if (fd < 0) throw new Error("Gagal buka /dev/randomdevice om!");

        // Baca data
        const raw = await this.os.fs.read(fd);

        // Tutup device
        await this.os.fs.close(fd);

        return parseInt(raw.trim());
    }

    /**
     * getFortune(): Contoh logika tambahan yang bisa om oprek
     */
    public async getFortune(): Promise<string> {
        const num = await this.getNumber();
        if (num > 700) return "HOKI GEDE!";
        if (num > 300) return "LUMAYAN LAH...";
        return "COBA LAGI BESOK OM!";
    }
}
