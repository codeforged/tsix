import { IDevice } from "./IDevice";

/**
 * SOCKET DEVICE
 * 
 * Abstraksi untuk sebuah koneksi network (Socket).
 * Menyimpan buffer data masuk.
 */
export class SocketDevice implements IDevice {
    name = "socket";
    private buffer: any[] = [];
    private waiters: Array<() => void> = [];
    private port: number | null = null;
    public bound: boolean = false;
    public driver: any = null; // Will bind to specific IDevice (SimpleMQTNLDriver)

    public setPort(port: number) {
        this.port = port;
        this.bound = true;
    }

    public getPort() { return this.port; }

    /**
     * push(): Dipanggil oleh MQTNLDriver saat ada data masuk.
     * Menyimpan data ke buffer dan membangunkan reader yang sedang menunggu.
     */
    public push(data: any) {
        this.buffer.push(data);
        // Bangunkan semua reader yang sedang nunggu data (event-driven)
        while (this.waiters.length > 0) {
            const w = this.waiters.shift()!;
            w();
        }
    }

    public read(): any {
        return this.buffer.shift() || null;
    }

    /**
     * waitForData(): Menunggu data masuk secara event-driven.
     * Resolve true begitu ada data yang di-push, atau false jika timeout.
     * Menggantikan pola polling buta (mis. sleep 100ms) supaya timing
     * seperti RTT yang diukur aplikasi (mis. ping) tetap akurat.
     */
    public async waitForData(timeoutMs: number): Promise<boolean> {
        if (this.buffer.length > 0) return true;
        return new Promise<boolean>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const onData = () => {
                if (timer) clearTimeout(timer);
                const idx = this.waiters.indexOf(onData);
                if (idx >= 0) this.waiters.splice(idx, 1);
                resolve(true);
            };
            timer = setTimeout(() => {
                const idx = this.waiters.indexOf(onData);
                if (idx >= 0) this.waiters.splice(idx, 1);
                resolve(false);
            }, timeoutMs);
            this.waiters.push(onData);
        });
    }

    public write(_data: any): boolean {
        // Harus lewat SENDTO syscall karena butuh target address/port
        return false;
    }

    public ioctl(cmd: number, arg: any): any {
        if (this.driver && this.driver.ioctl) {
            return this.driver.ioctl(cmd, arg);
        }
        return true;
    }
}
