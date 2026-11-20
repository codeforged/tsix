import { IProgram, OSContext } from "../../lib/IProgram";
import { NetworkLib } from "../../lib/NetworkLib";
import { PacketFlags } from "@common/PacketFlags";

/**
 * PING NET (Standard v1.0)
 * 
 * Kirim pesan atau ping ke alamat lain via SimpleMQTNL.
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std } = os;
        const net = new NetworkLib(os);

        if (args.length < 2) {
            await std.print("Usage: ping_net <target> <port> [message] [--ping]\n");
            return;
        }

        const target = args[0];
        const port = parseInt(args[1]);
        const isPing = args.includes("--ping");
        const message = args[2] || "Halo om! Standar MQTNL v1.0 mantap! 🔥";

        if (isPing) {
            await std.print(`Mengirim MQTNL PING ke ${target}...\n`);
            const fd = await net.socket();
            await net.bind(fd, 12345); // Bind ke port bebas buat nerima reply
            const start = Date.now();
            await net.sendTo(fd, target, 65535, "", PacketFlags.FLAG_PING_REQUEST);

            // Tunggu reply (SimpleMQTNLDriver handle ini otomatis)
            // Di versi "Simple" ini kita nunggu manual di recvFrom
            const reply = await net.recvFrom(fd);
            if (reply) {
                const rtt = Date.now() - start;
                await std.print(`Reply dari ${target}: time=${rtt}ms ✅\n`);
            } else {
                await std.print("Request timeout. (Atau target tidak merespon)\n");
            }
            return;
        }

        await std.print(`Mengirim pesan ke ${target}:${port}...\n`);

        const fd = await net.socket();
        const success = await net.sendTo(fd, target, port, message, PacketFlags.FLAG_DATA);

        if (success) {
            await std.print("Pesan terkirim om! ✅ (Encrypted & Standardized)\n");
        } else {
            await std.print("Pesan gagal dikirim. ❌\n");
        }
    }
}
