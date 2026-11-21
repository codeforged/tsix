import { IProgram, OSContext } from "../../lib/IProgram";
import { NetworkLib } from "../../lib/NetworkLib";

/**
 * LISTEN NET
 * 
 * Aplikasi untuk nunggu pesan masuk via SimpleMQTNL.
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, shell } = os;
        const net = new NetworkLib(os);
        const port = parseInt(args[0]) || 8080;
        const targetInterface = args[1] || undefined; // Optional: "smqtnl1" or "tsix-node-2"

        await std.print(`--- SIMPLE NETWORK LISTENER (Port ${port}) ---\n`);
        if (targetInterface) {
            await std.print(`Binding to specific interface: ${targetInterface}\n`);
        } else {
            await std.print(`Binding to DEFAULT interface.\n`);
        }

        const fd = await net.socket();
        await net.bind(fd, port, targetInterface);

        await std.print(`Menunggu pesan masuk di port ${port}...\n`);

        let interrupted = false;
        shell.onSignal("SIGINT", async () => {
            interrupted = true;
            await std.print("\n^C\n[STOP] Listener dihentikan.\n");
            await shell.exit(130);
        });

        while (!interrupted) {
            const packet = await net.recvFrom(fd);
            if (packet) {
                await std.print(`\n[PESAN DITERIMA] Dari: ${packet.src}\n`);
                await std.print(`Isi: ${JSON.stringify(packet.data, null, 2)}\n`);
                await std.print(`Waktu: ${new Date(packet.ts).toLocaleTimeString()}\n`);
                await std.print(`-------------------------\n`);
            }
            // Sedikit delay biar nggak makan CPU
            if (!interrupted) {
                await new Promise(r => setTimeout(r, 500));
            }
        }
    }
}
