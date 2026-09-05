import { Program, std, RsaChaSocket } from "@tsix/Application";

/**
 * NETSOCKET RSACHA SERVER — RSA + ChaCha20 server example.
 *
 * RsaChaSocket mengurus RSA-OAEP handshake dan upgrade ChaCha20-Poly1305.
 * Aplikasi hanya menangani pesan setelah channel siap.
 *
 * Run: netsocket-rsacha-server [port]
 * (default: 2600 — pair with netsocket-rsacha-client)
 */

const PORT = 2600;

export const main = Program(async (args: string[]) => {
    const port = parseInt(args[0] || String(PORT), 10);
    const sock = new RsaChaSocket({ role: "server", port });

    sock.onMessage = async (message, packet) => {
        std.println(`[server] <- ${message}`);
        await sock.reply(packet, `echo: ${message}`);
        std.println(`[server] -> echo: ${message}`);
    };
    sock.onReady = () => {
        std.println(`[server] fingerprint: ${sock.fingerprint}`);
        std.println("[server] secure channel (ChaCha20) active");
    };
    sock.onError = (err) => std.error(err.message, "netsocket-rsacha-server");

    await sock.open();
    std.println(`[server] listening on port ${port}...`);
    await sock.waitClosed();
});
