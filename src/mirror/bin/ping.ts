import { IProgram, OSContext } from "../lib/IProgram";
import { NetworkLib } from "../lib/NetworkLib";
import { PacketFlags } from "@common/PacketFlags";

/**
 * PING Utility
 * 
 * Send ICMP-like (MQTNL PING) ECHO_REQUEST to network hosts.
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, shell } = os;

        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: ping <host> [count]\n\n" +
                "Check connectivity to a remote MQTNL host.\n" +
                "Arguments:\n" +
                "  host     Target host name or address\n" +
                "  count    Number of packets to send (default: infinite)\n");
            return;
        }

        const net = new NetworkLib(os);

        if (args.length < 1) {
            await std.print("Usage: ping <host> [count]\n");
            return;
        }

        const target = args[0];
        const count = args[1] ? parseInt(args[1]) : Infinity;
        let seq = 0;
        let received = 0;
        let interrupted = false;

        // Handle Ctrl+C gracefully
        shell.onSignal("SIGINT", async () => {
            interrupted = true;
            await std.print("\n^C\n");
            await std.print(`\n--- ${target} ping statistics ---\n`);
            await std.print(`${seq} packets transmitted, ${received} received, ${Math.round((seq - received) / seq * 100)}% packet loss\n`);
            await shell.exit(130);
        });

        await std.print(`PING ${target} with MQTNL v1.0 data.\n`);

        const fd = await net.socket();
        // Bind to random ephemeral port (managed by Kernel/PortManager if we pass 0, 
        // but for now let's pick a random one per session to avoid conflict logic in userland)
        const localPort = 10000 + Math.floor(Math.random() * 50000);
        await net.bind(fd, localPort);

        try {
            while (seq < count && !interrupted) {
                const start = Date.now();
                const sent = await net.sendTo(fd, target, 65535, "PING_REQ_V1", PacketFlags.FLAG_PING_REQUEST);

                if (!sent) {
                    await std.print(`Destination host unreachable (send failed)\n`);
                    seq++;
                    continue;
                }

                // Wait for reply with polling using NetworkLib's recvFrom
                const reply = await net.recvFrom(fd, 2000);

                if (reply) {
                    const rtt = Date.now() - start;
                    const bytes = JSON.stringify(reply).length;
                    await std.print(`Reply from ${reply.src}: bytes=${bytes} seq=${seq} time=${rtt}ms\n`);
                    received++;
                } else {
                    await std.print(`Request timeout for seq ${seq}\n`);
                }

                seq++;
                if (seq < count && !interrupted) {
                    await this.sleep(1000);
                }
            }
        } catch (e) {
            // Interrupted usually
        }

        if (!interrupted) {
            await std.print(`\n--- ${target} ping statistics ---\n`);
            await std.print(`${seq} packets transmitted, ${received} received, ${Math.round((seq - received) / seq * 100)}% packet loss\n`);
        }
    }

    private async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
