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
 *   2. send "1" REQUEST_KEY   -> ask server for its RSA public key
 *   3. receive "2"+serverPub  -> server's RSA public key (PEM)
 *   4. generate a random 32-byte session key
 *   5. encrypt it with server's public key (RSA-OAEP)
 *   6. send "3"+encryptedKey -> hand it to the server
 *   7. upgradeSecurity(sessionKey) -> now all data is ChaCha20-Poly1305
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
 * Run:  netsocket-rsacha-client [serverAddr] [serverPort]
 * (default: "localhost", 2600 — pair with netsocket-rsacha-server)
 */

const SERVER_PORT = 2600;

export const main = Program(async (args: string[]) => {
    const serverAddr = args[0] || "localhost";
    const serverPort = parseInt(args[1] || String(SERVER_PORT), 10);
    const myPort = 2601; // fixed local port (encryption is per srcPort)

    const OP = { REQ_KEY: "1", PUBKEY: "2", SECRET_KEY: "3", MSG: "4" };

    let handshaked = false; // true after upgradeSecurity() — channel is encrypted

    const sock = new NetSocket({ port: myPort });

    // Handle inbound packets (set BEFORE open()).
    sock.onData = (pkt) => {
        const text = String(pkt.data);
        const op = text.charAt(0);
        const body = text.slice(1);

        if (op === OP.PUBKEY && !handshaked) {
            // 1) Server's RSA public key arrived.
            const serverPub = body;

            // 2) Generate a fresh ChaCha20 session key.
            const sessionKey = SecurityAgent.generateSessionKey();

            // 3) Encrypt the session key with the server's public key (RSA-OAEP).
            const encHex = SecurityAgent.encryptWithPublicKey(serverPub, sessionKey);

            // 4) Send it back: "3" + encHex.
            void sock.sendTo(serverAddr, serverPort, OP.SECRET_KEY + encHex);

            // 5) Switch this side to ChaCha20 with the same session key,
            //    then start the encrypted conversation.
            void sock.upgradeSecurity(sessionKey.toString("hex")).then(async () => {
                handshaked = true;
                std.println("[client] 🔒 secure channel (ChaCha20) active");
                std.println("[client] sending encrypted messages...");

                // Small delay so the server has time to finish its upgrade
                // (avoids the first message being sent before it is secured).
                await new Promise((r) => setTimeout(r, 300));
                for (let i = 1; i <= 3; i++) {
                    await sock.sendTo(serverAddr, serverPort, OP.MSG + `hello ${i} from client`);
                    await new Promise((r) => setTimeout(r, 500));
                }
            });
        } else if (op === OP.MSG && handshaked) {
            // Encrypted reply from the server — we can read it because both
            // sides share the same ChaCha20 session key.
            std.println(`[client] ← (encrypted) ${body}`);
        } else {
            // Unexpected packet before handshake finished.
            std.println(`[client] ? ${pkt.src}:${pkt.port} : ${text}`);
        }
    };

    await sock.open();
    std.println("[client] socket open (plain), requesting server public key...");

    // Kick off the handshake: ask for the server's RSA public key.
    await sock.sendTo(serverAddr, serverPort, OP.REQ_KEY);

    // Keep the process alive until Ctrl+C.
    await sock.waitClosed();
    await sock.close();
});
