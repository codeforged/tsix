import { UserLib } from "../lib/UserLib";
import { SecurityAgent } from "@common/SecurityAgent";

/**
 * TPKGD Utility
 * 
 * TSIX Package Repository Daemon. Serve package manifests and bundles.
 */
export class Main {
    private lib!: UserLib;
    private port: number = 80;
    private repoPath: string = "/etc/tpkg/packages.json";
    private keysPath: string = "/etc/keys/rsa";
    private privateKey: string = "";
    private publicKey: string = "";
    private sessions: Map<string, SecurityAgent> = new Map();

    async execute(lib: UserLib, args: string[]) {
        this.lib = lib;

        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: tpkgd\nTSIX Package Repository Daemon.\n");
            return;
        }

        // 1. Persiapkan Kunci RSA (Jika belum ada)
        await this.ensureKeys();

        // 2. Buka koneksi MQTNL di Port 80
        const fd = await this.lib.net.socket();
        if (fd < 0) {
            await this.lib.std.print("❌ Failed to open MQTNL socket.\n");
            return;
        }

        await this.lib.net.bind(fd, this.port);
        // await this.lib.std.print(`📡 Listening on MQTNL Port ${this.port}...\n`);

        // 3. Daemonize (Detach from TTY)
        await this.lib.shell.daemonize("TPKG Repository Daemon");

        while (true) {
            const packet = await this.lib.net.recv(fd);
            if (!packet) {
                await new Promise(r => setTimeout(r, 100));
                continue;
            }

            const { data: payload, src, port: srcPort } = packet;

            try {
                // Skenario: Handshake RSA (Plaintext JSON)
                if (payload.includes('"type":"handshake"')) {
                    await this.handleHandshake(fd, packet);
                    continue;
                }

                await this.handleRequest(fd, packet);

            } catch (e: any) {
                await this.lib.std.log(`Error: ${e.message}`, "tpkgd");
            }
        }
    }

    private async ensureKeys() {
        if (!await this.exists(this.keysPath)) {
            await this.lib.fs.mkdir(this.keysPath);
        }

        const privPath = `${this.keysPath}/id_rsa`;
        const pubPath = `${this.keysPath}/id_rsa.pub`;

        if (!await this.exists(privPath)) {
            await this.lib.std.print("Generating system RSA keys (id_rsa)...");
            const pair = SecurityAgent.generateKeyPair();
            await this.lib.fs.writeFile(privPath, pair.privateKey);
            await this.lib.fs.writeFile(pubPath, pair.publicKey);
            this.privateKey = pair.privateKey;
            this.publicKey = pair.publicKey;
            await this.lib.std.print(" Done.\n");
        } else {
            this.privateKey = await this.lib.fs.readFile(privPath) || "";
            this.publicKey = await this.lib.fs.readFile(pubPath) || "";
        }
    }

    private async handleHandshake(fd: number, packet: any) {
        const data = JSON.parse(packet.data);
        if (data.type === "handshake") {
            const clientPubKey = data.publicKey;
            await this.lib.std.log(`Handshake request from ${packet.src}:${packet.port}`, "tpkgd");

            // Generate Session Key (ChaCha20)
            const sessionKey = SecurityAgent.generateSessionKey();

            // Encrypt session key with Client's Public Key
            const encryptedKey = SecurityAgent.encryptWithPublicKey(clientPubKey, sessionKey);

            // Send ACK back
            const response = {
                type: "handshake_ack",
                sessionKey: encryptedKey,
                publicKey: this.publicKey, // Masukkan public key biar client bisa verifikasi signature
                fingerprint: SecurityAgent.getFingerprint(this.publicKey)
            };

            await this.lib.net.sendto(fd, packet.src, packet.port, JSON.stringify(response));

            // Register session
            const agent = new SecurityAgent();
            agent.setSessionKey(sessionKey);
            this.sessions.set(`${packet.src}:${packet.port}`, agent);
        }
    }

    private async handleRequest(fd: number, packet: any) {
        const sid = `${packet.src}:${packet.port}`;
        const agent = this.sessions.get(sid);
        if (!agent) return;

        let request;
        try {
            request = JSON.parse(agent.securePacketIn(packet.data));
        } catch (e) {
            return;
        }

        const { src, port: srcPort } = packet;

        if (request.type === "LIST") {
            await this.lib.std.log(`[LIST] request from ${src}`, "tpkgd");
            const manifest = await this.getManifest();
            const reply: any = {
                type: "LIST_REPLY",
                packages: manifest.packages.map((p: any) => ({
                    name: p.name,
                    version: p.version,
                    description: p.description,
                    author: p.author
                }))
            };

            // Sign the packages list
            reply.signature = SecurityAgent.sign(this.privateKey, JSON.stringify(reply.packages));

            await this.lib.net.sendto(fd, src, srcPort, agent.securePacketOut(JSON.stringify(reply)));
        }
        else if (request.type === "INFO" && request.name) {
            await this.lib.std.log(`[INFO] request: ${request.name} from ${src}`, "tpkgd");
            const manifest = await this.getManifest();
            const pkg = manifest.packages.find((p: any) => p.name === request.name);

            if (!pkg) {
                const suggestions = this.findSuggestions(request.name, manifest.packages.map((p: any) => p.name));
                const errorMsg = JSON.stringify({
                    type: "ERROR",
                    message: "Package not found",
                    suggestions: suggestions
                });
                await this.lib.net.sendto(fd, src, srcPort, agent.securePacketOut(errorMsg));
                return;
            }

            const reply: any = {
                type: "INFO_REPLY",
                package: pkg
            };

            // Sign the package info
            reply.signature = SecurityAgent.sign(this.privateKey, JSON.stringify(pkg));

            await this.lib.net.sendto(fd, src, srcPort, agent.securePacketOut(JSON.stringify(reply)));
        }
        else if (request.type === "GET_BUNDLE" && request.name) {
            await this.lib.std.log(`[BUNDLE] request: ${request.name} for ${src}`, "tpkgd");
            const manifest = await this.getManifest();
            const pkg = manifest.packages.find((p: any) => p.name === request.name);

            if (!pkg) {
                const suggestions = this.findSuggestions(request.name, manifest.packages.map((p: any) => p.name));
                const errorMsg = JSON.stringify({
                    type: "ERROR",
                    message: "Package not found",
                    suggestions: suggestions
                });
                await this.lib.net.sendto(fd, src, srcPort, agent.securePacketOut(errorMsg));
                return;
            }

            const bundle: any[] = [];
            for (const item of pkg.items) {
                if (await this.exists(item.src)) {
                    const content = await this.lib.fs.readFile(item.src);
                    bundle.push({
                        path: item.dst,
                        content: content
                    });
                }
            }

            const reply: any = {
                type: "BUNDLE_REPLY",
                name: pkg.name,
                version: pkg.version,
                files: bundle,
                onAfter: pkg.onAfterDownload,
                needReboot: pkg.needReboot
            };

            // Sign the entire bundle contents
            reply.signature = SecurityAgent.sign(this.privateKey, JSON.stringify(reply.files));

            await this.lib.net.sendto(fd, src, srcPort, agent.securePacketOut(JSON.stringify(reply)));
        }
    }

    private async getManifest() {
        if (!await this.exists(this.repoPath)) {
            return { version: "1.0", packages: [] };
        }
        const content = await this.lib.fs.readFile(this.repoPath);
        return JSON.parse(content || "{}");
    }

    private async exists(path: string): Promise<boolean> {
        try {
            const s = await this.lib.fs.stat(path);
            return !!s;
        } catch (e) {
            return false;
        }
    }

    private levenshteinDistance(s1: string, s2: string): number {
        const len1 = s1.length;
        const len2 = s2.length;
        const matrix: number[][] = [];

        for (let i = 0; i <= len1; i++) matrix[i] = [i];
        for (let j = 0; j <= len2; j++) matrix[0][j] = j;

        for (let i = 1; i <= len1; i++) {
            for (let j = 1; j <= len2; j++) {
                const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,      // deletion
                    matrix[i][j - 1] + 1,      // insertion
                    matrix[i - 1][j - 1] + cost // substitution
                );
            }
        }
        return matrix[len1][len2];
    }

    private findSuggestions(input: string, choices: string[]): string[] {
        const results = choices.map(choice => ({
            name: choice,
            dist: this.levenshteinDistance(input, choice)
        }));

        return results
            .filter(r => r.dist < 4) // Max 3 edits
            .sort((a, b) => a.dist - b.dist)
            .map(r => r.name)
            .filter(name => name !== input) // Don't suggest the exact same thing (though logic usually handles this)
            .slice(0, 3);
    }
}
