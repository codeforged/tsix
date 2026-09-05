import { Program, std, RsaChaSocket } from "@tsix/Application";

/**
 * NETSOCKET RSACHA CLIENT — RSA + ChaCha20 client example.
 *
 * open() otomatis meminta public key server, membuat session key, mengirimnya
 * via RSA-OAEP, lalu mengaktifkan ChaCha20-Poly1305.
 * Argumen ketiga dapat diisi fingerprint server untuk verifikasi anti-MITM.
 *
 * Run: netsocket-rsacha-client [serverAddr] [serverPort]
 * (default: localhost:2600 — pair with netsocket-rsacha-server)
 */

const SERVER_PORT = 2600;

export const main = Program(async (args: string[]) => {
    const lib = (global as any)._tsixLib;
    const serverAddr = args[0] || "localhost";
    const serverPort = parseInt(args[1] || String(SERVER_PORT), 10);
    const trustedFingerprint = args[2];
    const sock = new RsaChaSocket({
        role: "client",
        port: 2601,
        peer: { address: serverAddr, port: serverPort },
        trustedFingerprint,
        verifyFingerprint: async (fingerprint) => {
            std.println(`\nThe authenticity of '${serverAddr}' can't be established.`);
            std.println(`RSA key fingerprint is SHA256:${fingerprint}`);
            std.println("Are you sure you want to continue connecting (yes/no)? ");
            const answer = await lib.std.readLine();
            return answer?.trim().toLowerCase() === "yes";
        },
    });

    sock.onMessage = (message) => {
        std.println(`[client] <- ${message}`);
    };
    sock.onReady = () => std.println("[client] secure channel (ChaCha20) active");
    sock.onError = (err) => std.error(err.message, "netsocket-rsacha-client");

    await sock.open();
    std.println("[client] sending encrypted messages...");
    for (let i = 1; i <= 3; i++) {
        await sock.send(`hello ${i} from client`);
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    await sock.waitClosed();
});
