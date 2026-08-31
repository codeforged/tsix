import { Program, std, NetSocket } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";

/**
 * NETSOCKET RSACHA SERVER — Simple RSA + ChaCha20 handshake example (server side).
 *
 * Goal: accept a client, share our RSA public key, receive an encrypted
 * ChaCha20 session key, then secure the whole channel with it.
 *
 * Flow:
 *   1. generate our RSA key pair once at startup
 *   2. open() the socket (PLAIN first)
 *   3. receive [0x01] REQUEST_KEY -> send [0x02][ourPubKey]
 *   4. receive [0x03][encKey] -> decrypt with our private key -> session key
 *   5. upgradeSecurity(sessionKey) -> now all data is ChaCha20-Poly1305
 *
 * Opcodes (1 byte at the start of each payload):
 *   0x01 = REQUEST_KEY   (client -> server)
 *   0x02 = PUBKEY        (server -> client, followed by PEM)
 *   0x03 = SECRETKEY     (client -> server, followed by RSA-encrypted key hex)
 *
 * NOTE: set onData BEFORE open() — otherwise the recv loop never starts.
 *
 * Run:  netsocket-rsacha-server [port]
 * (default: 2600 — pair with netsocket-rsacha-client)
 */

const PORT = 2600;

export const main = Program(async (args: string[]) => {
    const port = parseInt(args[0] || String(PORT), 10);

    const OP = { REQ_KEY: 0x01, PUBKEY: 0x02, SECRET_KEY: 0x03 };

    // Our RSA key pair — generated once, private key never leaves this side.
    const keys = SecurityAgent.generateKeyPair();
    let secured = false;

    const sock = new NetSocket({ port });

    // Handle inbound packets (set BEFORE open()).
    sock.onData = async (pkt) => {
        const buf = Buffer.isBuffer(pkt.data)
            ? pkt.data
            : Buffer.from(String(pkt.data), "utf8");
        const op = buf[0];
        const body = buf.subarray(1);

        if (op === OP.REQ_KEY) {
            // Client wants our public key → send [0x02][PEM].
            const payload = Buffer.concat([
                Buffer.from([OP.PUBKEY]),
                Buffer.from(keys.publicKey, "utf8"),
            ]);
            await sock.reply(pkt, payload);
            std.println("[server] sent public key to client");
        } else if (op === OP.SECRET_KEY) {
            // Client sent the encrypted session key → decrypt it.
            const encHex = body.toString("utf8");
            const sessionKey = SecurityAgent.decryptWithPrivateKey(keys.privateKey, encHex);

            // Activate ChaCha20 with the client's session key.
            await sock.upgradeSecurity(sessionKey.toString("hex"));
            secured = true;
            std.println("[server] 🔒 secure channel (ChaCha20) active");
        } else if (secured) {
            // All data after the handshake is encrypted.
            std.println(`[server] ← ${pkt.src}:${pkt.port} : ${body.toString()}`);
        }
    };

    await sock.open();
    std.println(`[server] listening (plain) on port ${port}...`);

    // Keep the process alive until Ctrl+C.
    await sock.waitClosed();
});
