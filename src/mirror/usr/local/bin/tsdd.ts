import { UserLib } from "../../../lib/UserLib";
import { SecurityAgent } from "../../../../common/SecurityAgent";
import * as crypto from "crypto";
import {
    TsdManifest,
    TsdMessage,
    HandshakeAckMessage,
    HandshakeMessage,
    ListReplyMessage,
    InfoReplyMessage,
    PackageReplyMessage,
    TsddConfig,
    TsddSession,
    ErrorMessage
} from "./TsdTypes";

/**
 * TSDD - TSIX Software Distribution Daemon
 * 
 * Server that distributes software packages with atomic installation support.
 * Uses RSA + ChaCha20 for security, sign packages with digital signatures.
 * Features: rate limiting, session TTL, atomic bundles, differential updates.
 */
export class Main {
    private lib!: UserLib;
    private config: TsddConfig = {
        port: 8090,
        keysPath: "/etc/tsd/keys",
        manifestsPath: "/etc/tsd/manifests",
        packagesPath: "/var/tsd/packages",
        sessionTTL: 10 * 60 * 1000,     // 10 minutes
        maxBundleSize: 500 * 1024 * 1024, // 500 MB
        maxConnections: 100,
        enableLogging: true
    };

    private sessions: Map<string, TsddSession> = new Map();
    private rateLimiter: Map<string, { count: number; resetAt: number }> = new Map();
    private privateKey: string = "";
    private publicKey: string = "";
    private manifests: Map<string, TsdManifest> = new Map();

    async execute(lib: UserLib, args: string[]) {
        this.lib = lib;

        if (args.includes("--help") || args.includes("-h")) {
            await this.showHelp();
            return;
        }

        try {
            // Load configuration
            await this.loadConfig(args);

            // Ensure directories exist
            await this.ensureDirs();

            // Load or generate RSA keys
            await this.ensureKeys();

            // Load package manifests
            await this.loadManifests();

            // Create MQTNL listening socket
            const fd = await this.lib.net.socket();
            if (fd < 0) {
                await this.lib.std.print("❌ Failed to open MQTNL socket.\n");
                return;
            }

            const bindOk = await this.lib.net.bind(fd, this.config.port);
            if (!bindOk) {
                await this.lib.std.print(`❌ Failed to bind to port ${this.config.port}.\n`);
                return;
            }

            // Daemonize
            await this.lib.shell.daemonize("TPKG(d) Distribution Daemon");

            // Start background cleanup
            this.startSessionCleanup();

            // Main event loop
            await this.eventLoop(fd);

        } catch (e: any) {
            await this.lib.std.print(`❌ Daemon error: ${e.message}\n`);
            process.exit(1);
        }
    }

    private async eventLoop(fd: number) {
        while (true) {
            try {
                const packet = await this.lib.net.recv(fd);
                if (!packet) {
                    await new Promise(r => setTimeout(r, 100));
                    continue;
                }

                const { src, port: srcPort, data: payload } = packet;
                const clientId = `${src}:${srcPort}`;

                // Rate limiting check
                if (!this.checkRateLimit(src)) {
                    await this.log(`BLOCKED: Rate limit exceeded for ${src}`);
                    continue;
                }

                await this.log(`RECEIVED: ${payload.length} bytes from ${clientId}`);

                try {
                    // Try to parse as plaintext JSON (for handshake)
                    if (payload.includes('"type":"handshake"')) {
                        await this.handleHandshake(fd, packet);
                        continue;
                    }

                    // Otherwise, must have valid session
                    const session = this.sessions.get(clientId);
                    if (!session) {
                        await this.sendError(fd, src, srcPort, null, "Session not established. Handshake first.");
                        continue;
                    }

                    // Decrypt and handle request
                    await this.handleSecureRequest(fd, packet, session);

                } catch (e: any) {
                    await this.log(`Error handling request from ${clientId}: ${e.message}`);
                }

            } catch (e: any) {
                await this.log(`Event loop error: ${e.message}`);
                await new Promise(r => setTimeout(r, 100));
            }
        }
    }

    private async handleHandshake(fd: number, packet: any) {
        try {
            const handshake: HandshakeMessage = JSON.parse(packet.data);
            const clientId = `${packet.src}:${packet.port}`;

            if (handshake.type !== "handshake") {
                return;
            }

            await this.log(`HANDSHAKE from ${clientId} (version: ${handshake.clientVersion})`);

            // Generate session key
            const sessionKey = SecurityAgent.generateSessionKey();

            // Encrypt with client's public key
            const encryptedKey = SecurityAgent.encryptWithPublicKey(
                handshake.publicKey,
                sessionKey
            );

            const response: HandshakeAckMessage = {
                type: "handshake_ack",
                sessionKey: encryptedKey,
                publicKey: this.publicKey,
                fingerprint: SecurityAgent.getFingerprint(this.publicKey),
                serverVersion: "1.0.0"
            };

            // Send ACK
            await this.lib.net.sendto(
                fd,
                packet.src,
                packet.port,
                JSON.stringify(response)
            );

            await this.log(`HANDSHAKE ACK sent to ${clientId}`);

            // Register session
            const agent = new SecurityAgent();
            agent.setSessionKey(sessionKey);

            const session: TsddSession = {
                sessionKey,
                clientFingerprint: SecurityAgent.getFingerprint(handshake.publicKey),
                createdAt: Date.now(),
                lastActivity: Date.now(),
                clientPubKey: handshake.publicKey
            };

            // Store session (will be cleaned up by TTL check)
            this.sessions.set(clientId, session);

            // Store agent for this session too (for decryption) - simplified, use key directly
            (this as any).sessionAgents = (this as any).sessionAgents || {};
            (this as any).sessionAgents[clientId] = agent;

        } catch (e: any) {
            await this.log(`Handshake error: ${e.message}`);
        }
    }

    private async handleSecureRequest(fd: number, packet: any, session: TsddSession) {
        const clientId = `${packet.src}:${packet.port}`;

        // Update activity timestamp
        session.lastActivity = Date.now();

        // Decrypt request
        const agents = (this as any).sessionAgents || {};
        const agent = agents[clientId];

        if (!agent) {
            await this.sendError(fd, packet.src, packet.port, null, "Session invalid");
            return;
        }

        let request: TsdMessage;
        try {
            const decrypted = agent.securePacketIn(packet.data);
            request = JSON.parse(decrypted);
        } catch (e: any) {
            await this.log(`Decryption/parse error from ${clientId}: ${e.message}`);
            return;
        }

        // Dispatch to handler
        switch (request.type) {
            case "list_request":
                await this.handleListRequest(fd, packet, session, agent);
                break;
            case "info_request":
                await this.handleInfoRequest(fd, packet, session, agent, request.name);
                break;
            case "get_package":
                await this.handleGetPackage(fd, packet, session, agent, request.name, request.version);
                break;
            case "get_diff":
                await this.handleGetDiff(fd, packet, session, agent, request.name, request.fromVersion, request.toVersion);
                break;
            default:
                await this.sendError(fd, packet.src, packet.port, agent, `Unknown request type: ${request.type}`);
        }
    }

    private async handleListRequest(fd: number, packet: any, session: TsddSession, agent: any) {
        await this.loadManifests();
        const packages = Array.from(this.manifests.values()).map(m => ({
            name: m.name,
            version: m.version,
            description: m.description,
            author: m.author
        }));

        const reply: ListReplyMessage = {
            type: "list_reply",
            packages,
            signature: SecurityAgent.sign(this.privateKey, JSON.stringify(packages))
        };

        const encrypted = agent.securePacketOut(JSON.stringify(reply));
        await this.lib.net.sendto(fd, packet.src, packet.port, encrypted);

        await this.log(`LIST: sent ${packages.length} packages to ${packet.src}`);
    }

    private async handleInfoRequest(fd: number, packet: any, session: TsddSession, agent: any, pkgName: string) {
        await this.loadManifests();
        const manifest = this.manifests.get(pkgName);

        if (!manifest) {
            const suggestions = this.findSuggestions(pkgName, Array.from(this.manifests.keys()));
            await this.sendError(fd, packet.src, packet.port, agent, `Package not found: ${pkgName}`, suggestions);
            return;
        }

        const reply: InfoReplyMessage = {
            type: "info_reply",
            manifest,
            signature: SecurityAgent.sign(this.privateKey, JSON.stringify(manifest))
        };

        const encrypted = agent.securePacketOut(JSON.stringify(reply));
        await this.lib.net.sendto(fd, packet.src, packet.port, encrypted);

        await this.log(`INFO: ${pkgName} requested by ${packet.src}`);
    }

    private async handleGetPackage(fd: number, packet: any, session: TsddSession, agent: any, pkgName: string, version: string) {
        await this.log(`GET_PACKAGE: ${pkgName}@${version} from ${packet.src}`);
        await this.loadManifests();
        const manifest = this.manifests.get(pkgName);

        if (!manifest) {
            const suggestions = this.findSuggestions(pkgName, Array.from(this.manifests.keys()));
            await this.sendError(fd, packet.src, packet.port, agent, `Package not found: ${pkgName}`, suggestions);
            return;
        }

        if (version !== "" && manifest.version !== version) {
            await this.sendError(fd, packet.src, packet.port, agent, `Version mismatch: have ${manifest.version}, requested ${version}`);
            return;
        }

        // Load files from disk
        const files = [];
        let totalSize = 0;

        for (const entry of manifest.files) {
            try {
                const fileData = await this.lib.fs.readFile(entry.src);
                if (!fileData) continue;

                // Always convert to Base64 for safe transport over MQTNL
                const buffer = Buffer.isBuffer(fileData) ? fileData : Buffer.from(fileData as any);
                const content = buffer.toString("base64");
                const size = buffer.length;

                totalSize += size;

                if (totalSize > this.config.maxBundleSize) {
                    await this.sendError(fd, packet.src, packet.port, agent, `Bundle exceeds max size (${this.config.maxBundleSize} bytes)`);
                    return;
                }

                files.push({
                    path: entry.dst,
                    content: content,
                    size
                });
            } catch (e: any) {
                await this.log(`Warning: Could not read file ${entry.src}: ${e.message}`);
            }
        }

        const fileHashes = files.map(f => `${f.path}:${crypto.createHash("sha256").update(f.content).digest("hex")}`).join("|");

        const reply: PackageReplyMessage = {
            type: "package_reply",
            manifest,
            files,
            signature: SecurityAgent.sign(this.privateKey, fileHashes)
        };

        const encrypted = agent.securePacketOut(JSON.stringify(reply));
        await this.lib.net.sendto(fd, packet.src, packet.port, encrypted);

        await this.log(`PACKAGE: ${pkgName}@${version} (${totalSize} bytes) sent to ${packet.src}`);
    }

    private async handleGetDiff(fd: number, packet: any, session: TsddSession, agent: any, pkgName: string, fromVersion: string, toVersion: string) {
        await this.log(`GET_DIFF: ${pkgName} ${fromVersion} -> ${toVersion} from ${packet.src}`);
        await this.loadManifests();
        const currentManifest = this.manifests.get(pkgName);

        if (!currentManifest) {
            await this.sendError(fd, packet.src, packet.port, agent, `Package not found: ${pkgName}`);
            return;
        }

        // For a real diff, we'd compare against an old manifest.
        // If we don't have the old manifest, we send the full package as a "diff" where everything is added.
        // In a more advanced version, we would load the manifest for 'fromVersion' from history.

        const added: any[] = [];
        const changed: any[] = [];
        const removed: string[] = [];

        // Simple implementation: if version matches toVersion, calculate diff
        if (currentManifest.version !== toVersion && toVersion !== "") {
            await this.sendError(fd, packet.src, packet.port, agent, `Version ${toVersion} not available (current is ${currentManifest.version})`);
            return;
        }

        // Compare current files with what the client 'should' have had in fromVersion.
        // Since we don't have the history here, we'll assume the client is asking for changes 
        // compared to our knowledge of that version.

        // MOCK: In this implementation, we treat it as a full package for now but marked as 'added'
        // to satisfy the protocol, until version history is implemented.
        for (const entry of currentManifest.files) {
            try {
                const fileData = await this.lib.fs.readFile(entry.src);
                if (!fileData) continue;
                const buffer = Buffer.isBuffer(fileData) ? fileData : Buffer.from(fileData as any);

                added.push({
                    path: entry.dst,
                    content: buffer.toString("base64"),
                    size: buffer.length
                });
            } catch (e) { }
        }

        const reply = {
            type: "diff_reply",
            name: pkgName,
            fromVersion,
            toVersion: currentManifest.version,
            added,
            changed,
            removed,
            manifest: currentManifest,
            signature: SecurityAgent.sign(this.privateKey, pkgName + currentManifest.version)
        };

        const encrypted = agent.securePacketOut(JSON.stringify(reply));
        await this.lib.net.sendto(fd, packet.src, packet.port, encrypted);
        await this.log(`DIFF: Sent ${added.length} added files to ${packet.src}`);
    }

    private async sendError(fd: number, destIp: string, destPort: number, agent: any, message: string, suggestions?: string[]) {
        const error: ErrorMessage = {
            type: "error",
            message,
            suggestions
        };

        const data = JSON.stringify(error);
        const encrypted = agent ? agent.securePacketOut(data) : data;

        try {
            await this.lib.net.sendto(fd, destIp, destPort, encrypted);
        } catch (e: any) {
            await this.log(`Failed to send error to ${destIp}: ${e.message}`);
        }
    }

    // ============ UTILITIES ============

    private async loadConfig(args: string[]) {
        // Parse command-line overrides (e.g., --port 8080)
        for (let i = 0; i < args.length; i++) {
            if (args[i] === "--port" && args[i + 1]) {
                this.config.port = parseInt(args[i + 1], 10);
            } else if (args[i] === "--packages" && args[i + 1]) {
                this.config.packagesPath = args[i + 1];
            }
        }
    }

    private async ensureDirs() {
        const dirs = [
            this.config.keysPath,
            this.config.manifestsPath,
            this.config.packagesPath
        ];

        for (const dir of dirs) {
            try {
                await this.lib.fs.mkdir(dir);
            } catch (e) {
                // May already exist
            }
        }
    }

    private async ensureKeys() {
        const privPath = `${this.config.keysPath}/id_rsa`;
        const pubPath = `${this.config.keysPath}/id_rsa.pub`;

        let hasPriv = false;
        let hasPub = false;

        try {
            const priv = await this.lib.fs.readFile(privPath);
            if (priv) {
                this.privateKey = priv;
                hasPriv = true;
            }
        } catch (e) { }

        try {
            const pub = await this.lib.fs.readFile(pubPath);
            if (pub) {
                this.publicKey = pub;
                hasPub = true;
            }
        } catch (e) { }

        if (!hasPriv || !hasPub) {
            await this.log("Generating RSA key pair...");
            const pair = SecurityAgent.generateKeyPair();
            this.privateKey = pair.privateKey;
            this.publicKey = pair.publicKey;

            try {
                await this.lib.fs.writeFile(privPath, this.privateKey);
                await this.lib.fs.writeFile(pubPath, this.publicKey);
            } catch (e: any) {
                await this.log(`Warning: Could not save keys: ${e.message}`);
            }
        }
    }

    private async loadManifests() {
        this.manifests.clear();

        try {
            const items = await this.lib.fs.ls(this.config.manifestsPath) || [];

            for (const item of items) {
                if (!item.name.endsWith(".json")) continue;

                try {
                    const content = await this.lib.fs.readFile(`${this.config.manifestsPath}/${item.name}`);
                    if (content) {
                        const manifest: TsdManifest = JSON.parse(content);
                        this.manifests.set(manifest.name, manifest);
                    }
                } catch (e: any) {
                    await this.log(`Warning: Failed to load manifest ${item.name}: ${e.message}`);
                }
            }

            await this.log(`Loaded ${this.manifests.size} packages`);
        } catch (e: any) {
            await this.log(`Warning: Could not list manifests: ${e.message}`);
        }
    }

    private checkRateLimit(ip: string): boolean {
        const now = Date.now();
        const limit = this.rateLimiter.get(ip);

        if (!limit || now > limit.resetAt) {
            // New window
            this.rateLimiter.set(ip, { count: 1, resetAt: now + 60000 }); // 1 min window
            return true;
        }

        // Within window
        limit.count++;
        if (limit.count > 100) { // 100 requests per min
            return false;
        }

        return true;
    }

    private startSessionCleanup() {
        setInterval(() => {
            const now = Date.now();
            const expired = [];

            for (const entry of Array.from(this.sessions.entries())) {
                const [key, session] = entry;
                if (now - session.lastActivity > this.config.sessionTTL) {
                    expired.push(key);
                }
            }

            for (const key of expired) {
                this.sessions.delete(key);
                const agents = (this as any).sessionAgents || {};
                delete agents[key];
            }

            if (expired.length > 0) {
                this.log(`Cleaned up ${expired.length} expired sessions`);
            }
        }, 60000); // Check every minute
    }

    private findSuggestions(input: string, choices: string[]): string[] {
        const results = choices.map(choice => ({
            name: choice,
            dist: this.levenshteinDistance(input, choice)
        }));

        return results
            .filter(r => r.dist < 4)
            .sort((a, b) => a.dist - b.dist)
            .map(r => r.name)
            .slice(0, 3);
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
                    matrix[i - 1][j] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j - 1] + cost
                );
            }
        }
        return matrix[len1][len2];
    }

    private async log(message: string) {
        if (this.config.enableLogging) {
            const timestamp = new Date().toISOString().split('T')[1];
            await this.lib.std.log(`[${timestamp}] ${message}`, "tsdd");
        }
    }

    private async showHelp() {
        await this.lib.std.print("TSDD - TSIX Software Distribution Daemon\n");
        await this.lib.std.print("Usage: tsdd [options]\n");
        await this.lib.std.print("Options:\n");
        await this.lib.std.print("  --port PORT              Listen on port (default: 80)\n");
        await this.lib.std.print("  --packages PATH          Package storage path\n");
        await this.lib.std.print("  --help                   Show this help\n");
    }
}
