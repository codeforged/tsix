import { SecurityAgent } from "@common/SecurityAgent";

async function testCrypto() {
    console.log("--- START CRYPTO VERIFICATION ---");

    // 1. Test RSA Key Generation
    console.log("[1] Generating RSA Key Pair...");
    const clientKeys = SecurityAgent.generateKeyPair();
    console.log("Client Public Key (PEM fragment):", clientKeys.publicKey.substring(0, 50) + "...");

    // 2. Test RSA Handshake Simulation
    console.log("[2] Simulating RSA Handshake...");
    const sessionKey = require("crypto").randomBytes(32);
    const encryptedKey = SecurityAgent.encryptWithPublicKey(clientKeys.publicKey, sessionKey);
    const decryptedKey = SecurityAgent.decryptWithPrivateKey(clientKeys.privateKey, encryptedKey);

    if (sessionKey.equals(decryptedKey)) {
        console.log("SUCCESS: RSA Handshake successful.");
    } else {
        console.error("FAILURE: RSA Handshake mismatch!");
        process.exit(1);
    }

    // 3. Test ChaCha20 Data Transfer
    console.log("[3] Testing ChaCha20 Encryption...");
    const serverAgent = new SecurityAgent();
    serverAgent.setSessionKey(sessionKey);

    const clientAgent = new SecurityAgent();
    clientAgent.setSessionKey(decryptedKey);

    const secretMessage = "Hello from the other side! TSIX-ANTIGONON-OK";
    console.log("Original Message:", secretMessage);

    const encrypted = serverAgent.securePacketOut(secretMessage);
    console.log("Encrypted (Base64):", encrypted);

    const decrypted = clientAgent.securePacketIn(encrypted);
    console.log("Decrypted Message:", decrypted);

    if (secretMessage === decrypted) {
        console.log("SUCCESS: ChaCha20 Encryption/Decryption verified.");
    } else {
        console.error("FAILURE: ChaCha20 Data mismatch!");
        process.exit(1);
    }

    console.log("--- CRYPTO VERIFICATION COMPLETE ---");
}

testCrypto().catch(console.error);
