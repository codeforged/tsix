import { Program, std, NetSocket } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";

/**
 * NETSOCKET RSACHA CLIENT — Simple RSA + ChaCha20 handshake example (client side).
 *
 * Goal: establish an encrypted channel using a random ChaCha20 session key,
 * delivered securely via one RSA key exchange.
 *
 * Flow:
 *   1. open() the socket (PLAIN first)
 *   2. send [0x01] REQUEST_KEY  -> ask server for its RSA public key
 *   3. receive [0x02][serverPub] -> server's RSA public key (PEM)
 *   4. generate a random 32-byte session key
 *   5. encrypt it with server's public key (RSA-OAEP)
 *   6. send [0x03][encryptedKey] -> hand it to the server
 *   7. upgradeSecurity(sessionKey) -> now all data is ChaCha20-Poly1305
 *
 * Opcodes (1 byte at the start of each payload):
 *   0x01 = REQUEST_KEY   (client -> server)
 *   0x02 = PUBKEY        (server -> client, followed by PEM)
 *   0x03 = SECRETKEY     (client -> server, followed by RSA-encrypted key hex)
 *
 * NOTE: set onData BEFORE open() — otherwise the recv loop never starts.
 *
 * Run:  netsocket-rsacha-client [serverAddr] [serverPort]
 * (default: "localhost", 2600 — pair with netsocket-rsacha-server)
 */

const SERVER_PORT = 2600;

export const main = Program(async (args: string[]) => {
    const serverAddr = args[0] || "localhost";
    const serverPort = parseInt(args[1] || String(SERVER_PORT), 10);
    const myPort = 2601; // fixed local port (encryption is per srcPort)

    const OP = { REQ_KEY: 0x01, PUBKEY: 0x02, SECRET_KEY: 0x03 };

    const sock = new NetSocket({ port: myPort });

    // Handle inbound packets (set BEFORE open()).
    sock.onData = (pkt) => {
        const buf = Buffer.isBuffer(pkt.data)
            ? pkt.data
            : Buffer.from(String(pkt.data), "utf8");
        const op = buf[0];
        const body = buf.subarray(1);

        if (op === OP.PUBKEY) {
            // 1) Server's RSA public key arrived.
            const serverPub = body.toString("utf8");

            // 2) Generate a fresh ChaCha20 session key.
            const sessionKey = SecurityAgent.generateSessionKey();

            // 3) Encrypt the session key with the server's public key (RSA-OAEP).
            const encHex = SecurityAgent.encryptWithPublicKey(serverPub, sessionKey);

            // 4) Send it back: [0x03][encHex].
            const payload = Buffer.concat([
                Buffer.from([OP.SECRET_KEY]),
                Buffer.from(encHex, "utf8"),
            ]);
            void sock.sendTo(serverAddr, serverPort, payload);

            // 5) Switch this side to ChaCha20 with the same session key.
            void sock
                .upgradeSecurity(sessionKey.toString("hex"))
                .then(() => std.println("[client] 🔒 secure channel (ChaCha20) active"));
        } else {
            // Any other packet — the channel is encrypted now.
            std.println(`[client] ← ${pkt.src}:${pkt.port} : ${body.toString()}`);
        }
    };

    await sock.open();
    std.println("[client] socket open (plain), requesting server public key...");

    // Kick off the handshake: ask for the server's RSA public key.
    await sock.sendTo(serverAddr, serverPort, Buffer.from([OP.REQ_KEY]));

    // Keep the process alive until Ctrl+C.
    await sock.waitClosed();
    await sock.close();
});
