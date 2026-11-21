import { UserLib } from "../../lib/UserLib";
import { SecurityAgent } from "@common/SecurityAgent";
import { IProgram, OSContext } from "../../lib/IProgram";

export class main implements IProgram {
    async execute(lib: UserLib, args: string[]): Promise<string | void> {
        const host = args[0] || "antigonon";
        const pkgName = args[1] || "hello-world";

        await lib.std.print(`[DEBUG] Handshake with ${host}...\n`);
        const pair = SecurityAgent.generateKeyPair();
        const fd = await lib.net.socket();
        await lib.net.bind(fd, 0);

        const handshake = JSON.stringify({ type: "handshake", publicKey: pair.publicKey });
        await lib.net.sendto(fd, host, 80, handshake);

        let packet = await this.recv(lib, fd);
        if (!packet) {
            await lib.std.print("❌ No handshake response.\n");
            return;
        }

        const ack = JSON.parse(packet.data);
        const sessionKey = SecurityAgent.decryptWithPrivateKey(pair.privateKey, ack.sessionKey);
        const agent = new SecurityAgent();
        agent.setSessionKey(sessionKey);
        await lib.std.print("[DEBUG] Handshake OK. Requesting INFO for " + pkgName + "...\n");

        // Upgrade port security in driver
        try {
            const actualPort = (packet as any).localPort || 0;
            await lib.net.ioctl(fd, 0x1001, { port: actualPort, sessionKey });
        } catch (e) { }

        const infoReq = JSON.stringify({ type: "INFO", name: pkgName });
        await lib.net.sendto(fd, host, 80, agent.securePacketOut(infoReq));

        packet = await this.recv(lib, fd);
        if (!packet) {
            await lib.std.print("❌ No response for INFO request.\n");
            return;
        }

        await lib.std.print(`[DEBUG] Received packet from ${packet.src}:${packet.port}. Payload Length: ${packet.data.length}\n`);

        // Try to parse as is (if driver already decrypted it)
        let decrypted = packet.data;
        let isJson = false;
        try {
            JSON.parse(decrypted);
            isJson = true;
            await lib.std.print("[DEBUG] Payload is ALREADY valid JSON (Decrypted by Driver).\n");
        } catch (e) {
            // Not JSON, try decrypting
            decrypted = agent.securePacketIn(packet.data);
            await lib.std.print("[DEBUG] Payload was NOT JSON, decrypted manually.\n");
        }

        await lib.std.print(`[DEBUG] Final Decrypted Response (Length: ${decrypted.length}):\n`);
        await lib.std.print(`--- START ---\n${decrypted}\n--- END ---\n`);

        try {
            JSON.parse(decrypted);
            await lib.std.print("✅ JSON parse OK.\n");
        } catch (e: any) {
            await lib.std.print(`❌ JSON parse FAILED: ${e.message}\n`);
        }
    }

    private async recv(lib: UserLib, fd: number): Promise<any> {
        const start = Date.now();
        while (Date.now() - start < 5000) {
            const p = await lib.net.recv(fd);
            if (p) return p;
            await new Promise(r => setTimeout(r, 100));
        }
        return null;
    }
}
