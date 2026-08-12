import { OSContext } from "./IProgram";
import { SyscallCode } from "./common/SyscallCode";

/**
 * NETWORK LIB (SimpleMQTNL Extension)
 * 
 * Memudahkan aplikasi untuk ngobrol via virtual networking sederhana.
 * Mirip-mirip socket programming di Linux.
 */
export class NetworkLib {
    constructor(private os: OSContext) { }

    /**
     * socket(): Membuat socket baru.
     */
    public async socket(): Promise<number> {
        return await (this.os as any).shell.dispatch(SyscallCode.SOCKET, null);
    }

    /**
     * bind(): Mengikat socket ke port lokal.
     * @param address Optional address/interface to bind to (e.g. "tsix-node-2" or "smqtnl1")
     */
    public async bind(fd: number, port: number, address?: string): Promise<boolean> {
        return await (this.os as any).shell.dispatch(SyscallCode.BIND, { fd, port, address });
    }

    /**
     * sendTo(): Kirim data ke alamat dan port tujuan.
     */
    public async sendTo(fd: number, address: string, port: number, data: any, flag?: number): Promise<boolean> {
        return await (this.os as any).shell.dispatch(SyscallCode.SENDTO, { fd, address, port, data, flag });
    }

    /**
     * recvFrom(): Baca data dari socket.
     */
    /**
     * recvFrom(): Baca data dari socket.
     */
    public async recvFrom(fd: number, timeoutMs: number = 5000): Promise<any> {
        // RECVFROM di kernel sudah event-driven: begitu data masuk, langsung
        // di-return tanpa menunggu tick polling. Loop ini hanya menjaga batas
        // timeout keseluruhan.
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const res = await (this.os as any).shell.dispatch(SyscallCode.RECVFROM, fd);
            if (res) return res;
        }
        return null;
    }

    /**
     * netstat(): Cek info jaringan.
     */
    public async netstat(): Promise<any> {
        return await (this.os as any).shell.dispatch(SyscallCode.NETSTAT, null);
    }
}
