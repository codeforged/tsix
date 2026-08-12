/**
 * KCONTEXT (Kernel Context)
 * 
 * Sekumpulan utility dari Kernel yang bisa disuntikkan ke Driver.
 */
export interface KContext {
    syslog: (message: string) => void;
}

/**
 * IDEVICE (Hardware Abstraction Layer)
 * 
 * Ini adalah 'Kontrak' atau Interface untuk semua hardware.
 * Kernel tidak perlu tahu isi di dalamnya, cukup panggil fungsi ini.
 */
export interface IDevice {
    name: string;
    read(offset?: number, length?: number): any;
    write(data: any, offset?: number): boolean;
    ioctl(cmd: number, arg: any): any;

    init?(ctx: KContext): void; // Opsional: Untuk nerima 'suntikan' dari Kernel
    open?(): boolean; // Opsional: Lazy open device hardware
    close?(): boolean; // Opsional: Close device hardware (with refcounting)

    /**
     * Opsional: Apakah hardware benar-benar tersedia SEKARANG?
     * Dipakai `ls /dev` untuk menyembunyikan device yang tidak present
     * (udev-like hotplug). Jika tidak diimplementasikan → selalu present.
     */
    present?(): boolean;

    uid?: number;
    gid?: number;
    mode?: number;
    disabled?: boolean;
}

/**
 * NULL DEVICE
 * 
 * Driver "Lubang Hitam". Apapun yang ditulis ke sini bakal hilang.
 * Mewakili /dev/null di Linux.
 */
export class NullDevice implements IDevice {
    name = "Null";
    read() { return ""; }
    write() { return true; }
    ioctl() { return -1; }
}
