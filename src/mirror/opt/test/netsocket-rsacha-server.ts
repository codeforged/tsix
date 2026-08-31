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
 *   3. receive "1" REQUEST_KEY  -> send "2" + our public key (PEM)
 *   4. receive "3" + encKey     -> decrypt with our private key -> session key
 *   5. upgradeSecurity(sessionKey) -> now all data is ChaCha20-Poly1305
 *
 * Opcodes (first char of the payload string):
 *   "1" = REQUEST_KEY   (client -> server)
 *   "2" = PUBKEY        (server -> client, followed by PEM)
 *   "3" = SECRETKEY     (client -> server, followed by RSA-encrypted key hex)
 *   "4" = MSG           (either direction, encrypted after handshake)
 *
 * NOTE: We use the default JSON protocol (NOT binary) because binary mode
 * bypasses encryption on TX — we need ChaCha20 after the handshake.
 * The opcode is a string char (e.g. "1"), not a binary byte, so it survives
 * the JSON protocol untouched.
 *
 * NOTE: set onData BEFORE open() — otherwise the recv loop never starts.
 *
 * Run:  netsocket-rsacha-server [port]
 * (default: 2600 — pair with netsocket-rsacha-client)
 */

const PORT = 2600;

export const main = Program(async (args: string[]) => {
    const port = parseInt(args[0] || String(PORT), 10);

    const OP = { REQ_KEY: "1", PUBKEY: "2", SECRET_KEY: "3", MSG: "4" };

    // Our RSA key pair — generated once, private key never leaves this side.
    const keys = SecurityAgent.generateKeyPair();
    let secured = false;

    const sock = new NetSocket({ port });

    // Handle inbound packets (set BEFORE open()).
    sock.onData = async (pkt) => {
        const text = String(pkt.data);
        const op = text.charAt(0);
        const body = text.slice(1);

        // Handshake already done — ignore any repeated handshake packet.
        if (secured && (op === OP.REQ_KEY || op === OP.SECRET_KEY)) return;

        if (op === OP.REQ_KEY) {
            // Client wants our public key → send "2" + PEM.
            await sock.reply(pkt, OP.PUBKEY + keys.publicKey);
            std.println("[server] sent public key to client");
        } else if (op === OP.SECRET_KEY) {
            // Client sent the encrypted session key → decrypt it.
            const encHex = body;
            const sessionKey = SecurityAgent.decryptWithPrivateKey(keys.privateKey, encHex);

            // Activate ChaCha20 with the client's session key.
            await sock.upgradeSecurity(sessionKey.toString("hex"));
            secured = true;
            std.println("[server] 🔒 secure channel (ChaCha20) active");
        } else if (op === OP.MSG && secured) {
            // All data after the handshake is encrypted (ChaCha20).
            std.println(`[server] ← (encrypted) ${body}`);

            // Reply back through the same encrypted channel so the client can
            // see that both sides actually share the same session key.
            await sock.reply(pkt, OP.MSG + `echo: ${body}`);
            std.println(`[server] → (encrypted) echo: ${body}`);
        }
    };

    await sock.open();
    std.println(`[server] listening (plain) on port ${port}...`);

    // Keep the process alive until Ctrl+C.
    await sock.waitClosed();
});
