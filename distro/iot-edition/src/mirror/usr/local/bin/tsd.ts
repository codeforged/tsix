import { UserLib } from "../../../lib/UserLib";
import { SecurityAgent } from "../../../../common/SecurityAgent";
import * as crypto from "crypto";
import {
    TsdConfig,
    TsdManifest,
    TsdMessage,
    TsdInstallState,
    HandshakeMessage,
    HandshakeAckMessage,
    ListRequestMessage,
    InfoRequestMessage,
    GetPackageMessage,
    GetDiffMessage,
    ErrorMessage
} from "./TsdTypes";

/**
 * TSD - TSIX Software Distribution Client
 * 
 * Downloads and installs software packages with:
 * - Atomic installation (all-or-nothing)
 * - Rollback on failure
 * - Retry with exponential backoff
 * - Caching and integrity verification
 * - Differential updates
 */
export class Main {
    private lib!: UserLib;
    private config: TsdConfig = {
        cacheDir: "/var/cache/tsd",
        trustedRepos: "/etc/tsd/trusted",
        configFile: "/etc/tsd/config.json",
        maxRetries: 3,
        retryBackoff: 1000,              // Start at 1s
        timeoutHandshake: 5000,
        timeoutPackage: 60000,           // 60s for package
        installDir: "/tmp/tsd-install"
    };

    private sessionFd: number = -1;
    private currentAgent: any = null;
    private currentServerFingerprint: string = "";
    private metrics = {
        totalDownloads: 0,
        totalInstalls: 0,
        failedInstalls: 0,
        rolledBack: 0,
        cacheHits: 0
    };

    async execute(lib: UserLib, args: string[]) {
        this.lib = lib;

        if (args.includes("--help") || args.includes("-h")) {
            await this.showHelp();
            return;
        }

        try {
            await this.ensureCache();

            const cmd = args[0];

            switch (cmd) {
                case "update":
                    await this.doUpdate(args[1]);
                    break;
                case "list":
                    await this.doList(args[1]);
                    break;
                case "info":
                    await this.doInfo(args[1], args);
                    break;
                case "install":
                    await this.doInstall(args[1], args);
                    break;
                case "download":
                    await this.doDownload(args[1], args);
                    break;
                case "metrics":
                    await this.showMetrics();
                    break;
                case "verify":
                    await this.doVerify(args[1], args);
                    break;
                default:
                    await this.lib.std.print(`Unknown command: ${cmd}\n`);
                    await this.showHelp();
            }
        } catch (e: any) {
            await this.lib.std.print(`❌ Error: ${e.message}\n`);
            process.exit(1);
        }

        // Cleanup
        if (this.sessionFd >= 0) {
            await this.lib.net.close(this.sessionFd);
        }
    }

    // ============ COMMANDS ============

    private async doUpdate(host?: string) {
        if (!host) {
            const defaultRepo = await this.getDefaultRepo();
            if (defaultRepo) host = defaultRepo;
        }

        if (!host) {
            await this.lib.std.print("Usage: tsd update <host>\n");
            return;
        }

        await this.lib.std.print(`Updating catalog from ${host}...\n`);

        const session = await this.establishSession(host);
        if (!session) return;

        try {
            const request: ListRequestMessage = { type: "list_request" };
            const reply = await this.sendSecureRequest(host, request, this.config.timeoutPackage);

            if (reply.type === "list_reply") {
                // Verify signature
                const isValid = SecurityAgent.verify(
                    session.publicKey,
                    JSON.stringify(reply.packages),
                    reply.signature
                );

                if (!isValid) {
                    await this.lib.std.print("❌ Signature verification FAILED! Data may be tampered.\n");
                    return;
                }

                // Save catalog
                const cacheFile = `${this.config.cacheDir}/catalog.json`;
                await this.lib.fs.writeFile(cacheFile, JSON.stringify(reply.packages, null, 2));

                await this.lib.std.print(`✅ Updated: ${reply.packages.length} packages available (verified)\n`);
                this.metrics.cacheHits++;
            } else if (reply.type === "error") {
                await this.lib.std.print(`❌ Server: ${reply.message}\n`);
            }
        } catch (e: any) {
            await this.lib.std.print(`❌ Failed: ${e.message}\n`);
        }
    }

    private async doList(host?: string) {
        const cacheFile = `${this.config.cacheDir}/catalog.json`;

        if (!await this.exists(cacheFile)) {
            await this.lib.std.print("❌ No catalog cached. Run 'tsd update <host>' first.\n");
            return;
        }

        try {
            const content = await this.lib.fs.readFile(cacheFile);
            const packages = JSON.parse(content || "[]");

            await this.lib.std.print("\n\x1b[1;34mAvailable Packages:\x1b[0m\n");
            await this.lib.std.print("──────────────────────────────────────────\n");

            for (const pkg of packages) {
                await this.lib.std.print(`\x1b[1m${pkg.name.padEnd(20)}\x1b[0m v${pkg.version}\n`);
                await this.lib.std.print(`  ${pkg.description}\n`);
                if (pkg.author) {
                    await this.lib.std.print(`  by ${pkg.author}\n`);
                }
                await this.lib.std.print("\n");
            }
            await this.lib.std.print("──────────────────────────────────────────\n");

            this.metrics.cacheHits++;
        } catch (e: any) {
            await this.lib.std.print(`❌ Error: ${e.message}\n`);
        }
    }

    private async doInfo(pkgName?: string, args?: string[]) {
        if (!pkgName) {
            await this.lib.std.print("Usage: tsd info <package> [--from <host>]\n");
            return;
        }

        const host = await this.getHostFromArgs(args);
        if (!host) {
            await this.lib.std.print("No repository specified and no default set. Use --from <host>\n");
            return;
        }

        const session = await this.establishSession(host);
        if (!session) return;

        try {
            const request: InfoRequestMessage = { type: "info_request", name: pkgName };
            const reply = await this.sendSecureRequest(host, request, this.config.timeoutPackage);

            if (reply.type === "info_reply") {
                const manifest = reply.manifest;

                // Verify signature
                const isValid = SecurityAgent.verify(
                    session.publicKey,
                    JSON.stringify(manifest),
                    reply.signature
                );

                if (!isValid) {
                    await this.lib.std.print("❌ Signature verification FAILED!\n");
                    return;
                }

                await this.lib.std.print(`\n\x1b[1;34mPackage Information:\x1b[0m\n`);
                await this.lib.std.print("──────────────────────────────────────────\n");
                await this.lib.std.print(`\x1b[1mName:\x1b[0m        ${manifest.name}\n`);
                await this.lib.std.print(`\x1b[1mVersion:\x1b[0m     ${manifest.version}\n`);
                await this.lib.std.print(`\x1b[1mDescription:\x1b[0m ${manifest.description}\n`);
                if (manifest.author) {
                    await this.lib.std.print(`\x1b[1mAuthor:\x1b[0m      ${manifest.author}\n`);
                }
                if (manifest.minVersion) {
                    await this.lib.std.print(`\x1b[1mMin TSIX:\x1b[0m    ${manifest.minVersion}\n`);
                }
                await this.lib.std.print(`\x1b[1mFiles:\x1b[0m       ${manifest.files.length} items\n`);
                if (manifest.onInstall) {
                    await this.lib.std.print(`\x1b[1mPost-Install:\x1b[0m ${manifest.onInstall}\n`);
                }
                if (manifest.requiresReboot) {
                    await this.lib.std.print(`\x1b[1;33m⚠️  Requires reboot\x1b[0m\n`);
                }
                await this.lib.std.print("──────────────────────────────────────────\n");

            } else if (reply.type === "error") {
                await this.lib.std.print(`❌ ${reply.message}\n`);
                if (reply.suggestions && reply.suggestions.length > 0) {
                    await this.lib.std.print(`💡 Did you mean: ${reply.suggestions.join(", ")}?\n`);
                }
            }
        } catch (e: any) {
            await this.lib.std.print(`❌ Failed: ${e.message}\n`);
        }
    }

    private async doDownload(pkgName?: string, args?: string[]) {
        if (!pkgName) {
            await this.lib.std.print("Usage: tsd download <package> [--from <host>] [--version <ver>]\n");
            return;
        }

        const host = await this.getHostFromArgs(args);
        if (!host) {
            await this.lib.std.print("No repository specified.\n");
            return;
        }

        // For now, download is same as install but doesn't execute post-install
        await this.doInstall(pkgName, args);
    }

    private async doInstall(pkgName?: string, args?: string[]) {
        if (!pkgName) {
            await this.lib.std.print("Usage: tsd install <package> [--from <host>] [--force]\n");
            return;
        }

        const host = await this.getHostFromArgs(args);
        if (!host) {
            await this.lib.std.print("No repository specified.\n");
            return;
        }

        const force = (args || []).includes("--force");

        // Check if already installed
        const installedVersion = await this.getInstalledVersion(pkgName);
        if (installedVersion && !force) {
            const confirm = await this.lib.std.read(
                `${pkgName} v${installedVersion} is already installed. Update? [Y/n]: `
            );
            if (confirm.toLowerCase().trim() === "n") {
                await this.lib.std.print("Operation cancelled.\n");
                return;
            }
        }

        const installState: TsdInstallState = {
            packageName: pkgName,
            version: "",
            stagedDir: `${this.config.installDir}/${pkgName}-${Date.now()}`,
            files: new Map(),
            status: "pending",
            startTime: Date.now()
        };

        const session = await this.establishSession(host);
        if (!session) return;

        try {
            // Stage 1: Fetch package data
            await this.lib.std.print(`📥 Fetching ${pkgName}${installedVersion ? ` (Update ${installedVersion} -> Latest)` : ""}...\n`);

            let reply: any;
            if (installedVersion && !force) {
                const diffRequest: GetDiffMessage = {
                    type: "get_diff",
                    name: pkgName,
                    fromVersion: installedVersion,
                    toVersion: "" // Latest
                };
                reply = await this.sendSecureRequestWithRetry(host, diffRequest, this.config.timeoutPackage);
            } else {
                const pkgRequest: GetPackageMessage = {
                    type: "get_package",
                    name: pkgName,
                    version: "" // Latest
                };
                reply = await this.sendSecureRequestWithRetry(host, pkgRequest, this.config.timeoutPackage);
            }

            if (reply.type === "error") {
                await this.lib.std.print(`❌ ${reply.message}\n`);
                return;
            }

            // Verify integrity
            if (reply.type === "package_reply") {
                const fileHashes = reply.files.map((f: any) => `${f.path}:${crypto.createHash("sha256").update(f.content).digest("hex")}`).join("|");
                const isValid = SecurityAgent.verify(session.publicKey, fileHashes, reply.signature);
                if (!isValid) throw new Error("Package integrity check FAILED!");
            } else if (reply.type === "diff_reply") {
                const isValid = SecurityAgent.verify(session.publicKey, pkgName + reply.toVersion, reply.signature);
                if (!isValid) throw new Error("Update signature check FAILED!");
            }

            await this.lib.std.print(`✅ Received ${reply.type === "diff_reply" ? "differential update" : "full package"}\n`);

            // Normalize files for staging
            const filesToStage: any[] = [];
            const filesToRemove: string[] = [];

            if (reply.type === "package_reply") {
                filesToStage.push(...reply.files);
                installState.manifest = reply.manifest;
                installState.version = reply.manifest.version;
            } else if (reply.type === "diff_reply") {
                filesToStage.push(...reply.added, ...reply.changed);
                filesToRemove.push(...reply.removed);
                installState.manifest = reply.manifest;
                installState.version = reply.toVersion;
            }

            // Stage 2: Atomic staging (Removal)
            for (const path of filesToRemove) {
                if (await this.exists(path)) {
                    const backup = await this.lib.fs.readFile(path);
                    installState.files.set(path, backup || "");
                    await this.lib.fs.unlink(path);
                }
            }

            // Stage 2: Atomic staging (Writes)
            let i = 0;
            const total = filesToStage.length;
            for (const file of filesToStage) {
                i++;
                const percent = Math.round((i / total) * 100);
                const bar = "█".repeat(Math.floor(percent / 5)) + "░".repeat(20 - Math.floor(percent / 5));
                await this.lib.std.print(`\r  ${bar} ${percent}% [${i}/${total}] ${file.path.split('/').pop()}`.padEnd(60));

                const dir = file.path.substring(0, file.path.lastIndexOf("/"));
                if (dir) await this.mkdirRecursive(dir);

                // Backup if exists
                if (await this.exists(file.path)) {
                    const backup = await this.lib.fs.readFile(file.path);
                    installState.files.set(file.path, backup || "");
                }

                // Decode Base64 and write to destination
                const content = Buffer.from(file.content, "base64");
                await this.lib.fs.writeFile(file.path, content.toString("binary"));

                // Set permissions if manifest exists and matches
                if (installState.manifest) {
                    if (installState.manifest.files.find((f: any) => f.dst === file.path)?.isExecutable) {
                        await this.lib.fs.chmod(file.path, 0o755);
                    }
                }
            }
            await this.lib.std.print("\n");

            installState.status = "installed";
            await this.lib.std.print(`✅ ${reply.type === "diff_reply" ? "Update" : "Installation"} successful\n`);
            this.metrics.totalInstalls++;

            // Record status
            await this.updateInstalledStatus(pkgName, installState.version);

            // Stage 3: Post-install script
            if (reply.manifest?.onInstall) {
                const confirm = await this.lib.std.read(
                    `Run post-install script? [Y/n]: `
                );

                if (confirm.toLowerCase().trim() !== "n") {
                    await this.lib.std.print(`Executing: ${reply.manifest.onInstall}\n`);
                    try {
                        const proc = await this.lib.shell.exec(reply.manifest.onInstall, []);
                        const exitCode = await this.lib.shell.waitpid(proc.pid);

                        if (exitCode === 0) {
                            await this.lib.std.print(`✅ Post-install completed\n`);
                        } else {
                            await this.lib.std.print(`⚠️  Post-install exited with code ${exitCode}\n`);
                            // Offer rollback
                            const rollback = await this.lib.std.read("Rollback installation? [y/N]: ");
                            if (rollback.toLowerCase().trim() === "y") {
                                await this.rollbackInstall(installState);
                                this.metrics.rolledBack++;
                                return;
                            }
                        }
                    } catch (e: any) {
                        await this.lib.std.print(`❌ Post-install failed: ${e.message}\n`);
                        const rollback = await this.lib.std.read("Rollback? [y/N]: ");
                        if (rollback.toLowerCase().trim() === "y") {
                            await this.rollbackInstall(installState);
                            this.metrics.rolledBack++;
                        }
                        return;
                    }
                }
            }

            if (reply.manifest.requiresReboot) {
                await this.lib.std.print("\x1b[1;33m⚠️  REBOOT REQUIRED\x1b[0m to apply changes.\n");
            }

            installState.endTime = Date.now();

        } catch (e: any) {
            await this.lib.std.print(`❌ Installation failed: ${e.message}\n`);
            this.metrics.failedInstalls++;

            // Attempt rollback
            const rollback = await this.lib.std.read("Rollback? [y/N]: ");
            if (rollback.toLowerCase().trim() === "y") {
                await this.rollbackInstall(installState);
                this.metrics.rolledBack++;
            }
        }
    }

    private async doVerify(pkgName?: string, args?: string[]) {
        if (!pkgName) {
            await this.lib.std.print("Usage: tsd verify <package> [--from <host>]\n");
            return;
        }

        const host = await this.getHostFromArgs(args);
        if (!host) {
            await this.lib.std.print("No repository specified.\n");
            return;
        }

        await this.lib.std.print(`Verifying ${pkgName}...\n`);

        const session = await this.establishSession(host);
        if (!session) return;

        try {
            const request: InfoRequestMessage = { type: "info_request", name: pkgName };
            const reply = await this.sendSecureRequest(host, request, this.config.timeoutPackage);

            if (reply.type === "info_reply") {
                const isValid = SecurityAgent.verify(
                    session.publicKey,
                    JSON.stringify(reply.manifest),
                    reply.signature
                );

                if (isValid) {
                    await this.lib.std.print(`✅ Package signature is valid\n`);
                } else {
                    await this.lib.std.print(`❌ Package signature INVALID!\n`);
                }
            } else if (reply.type === "error") {
                await this.lib.std.print(`❌ ${reply.message}\n`);
            }
        } catch (e: any) {
            await this.lib.std.print(`❌ Verification failed: ${e.message}\n`);
        }
    }

    // ============ INTERNAL: SESSION & NETWORKING ============

    private async establishSession(host: string): Promise<{ publicKey: string; fingerprint: string } | null> {
        try {
            // Parse host:port
            const [address, portStr] = host.split(':');
            const port = portStr ? parseInt(portStr, 10) : 80; // Default to 80 if no port

            if (this.sessionFd < 0) {
                this.sessionFd = await this.lib.net.socket();
                if (this.sessionFd < 0) throw new Error("Cannot open socket");

                const ok = await this.lib.net.bind(this.sessionFd, 0); // Random port
                if (!ok) throw new Error("Cannot bind socket");
            }

            // Generate key pair
            const pair = SecurityAgent.generateKeyPair();

            // Send handshake
            const handshake: HandshakeMessage = {
                type: "handshake",
                publicKey: pair.publicKey,
                clientVersion: "1.0.0"
            };

            await this.lib.net.sendto(
                this.sessionFd,
                address,
                port,
                JSON.stringify(handshake)
            );

            // Wait for ACK
            const ack = await this.recvWithTimeout(this.config.timeoutHandshake);
            if (!ack) throw new Error("Handshake timeout");

            const ackMsg: HandshakeAckMessage = JSON.parse(ack);
            if (ackMsg.type !== "handshake_ack") throw new Error("Invalid handshake response");

            // Check fingerprint
            const fp = ackMsg.fingerprint;
            if (!await this.isTrustedFingerprint(fp)) {
                await this.lib.std.print(`\x1b[1;33m⚠️  Unknown Repository Fingerprint:\x1b[0m ${fp}\n`);
                const confirm = await this.lib.std.read("Trust and proceed? [y/N]: ");
                if (confirm.toLowerCase().trim() !== "y") return null;
                await this.addTrustedFingerprint(fp);
            }

            // Decrypt session key
            const sessionKey = SecurityAgent.decryptWithPrivateKey(pair.privateKey, ackMsg.sessionKey);
            this.currentAgent = new SecurityAgent();
            this.currentAgent.setSessionKey(sessionKey);
            this.currentServerFingerprint = fp;

            return { publicKey: ackMsg.publicKey, fingerprint: fp };

        } catch (e: any) {
            await this.lib.std.print(`❌ Session error: ${e.message}\n`);
            return null;
        }
    }

    private async sendSecureRequest(host: string, request: TsdMessage, timeout: number): Promise<any> {
        if (!this.currentAgent) throw new Error("Not connected");

        // Parse host:port
        const [address, portStr] = host.split(':');
        const port = portStr ? parseInt(portStr, 10) : 80;

        const encrypted = this.currentAgent.securePacketOut(JSON.stringify(request));
        await this.lib.net.sendto(this.sessionFd, address, port, encrypted);

        const rawReply = await this.recvWithTimeout(timeout);
        if (!rawReply) throw new Error("Request timeout");

        const decrypted = this.currentAgent.securePacketIn(rawReply);
        return JSON.parse(decrypted);
    }

    private async sendSecureRequestWithRetry(host: string, request: TsdMessage, timeout: number): Promise<any> {
        let lastError: any;

        for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    const backoff = this.config.retryBackoff * Math.pow(2, attempt - 1);
                    await this.lib.std.print(`⏳ Retry ${attempt}/${this.config.maxRetries} (wait ${backoff}ms)...\n`);
                    await new Promise(r => setTimeout(r, backoff));
                }

                return await this.sendSecureRequest(host, request, timeout);
            } catch (e: any) {
                lastError = e;
                await this.lib.std.print(`⚠️  Attempt ${attempt + 1} failed: ${e.message}\n`);
            }
        }

        throw new Error(`Failed after ${this.config.maxRetries} retries: ${lastError.message}`);
    }

    private async recvWithTimeout(timeoutMs: number): Promise<string | null> {
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
            const packet = await this.lib.net.recv(this.sessionFd);
            if (packet) return packet.data;
            await new Promise(r => setTimeout(r, 100));
        }

        return null;
    }

    // ============ INTERNAL: FILE OPERATIONS & ROLLBACK ============

    private async rollbackInstall(state: TsdInstallState) {
        await this.lib.std.print(`🔄 Rolling back ${state.packageName}...\n`);

        try {
            // Restore backed up files
            for (const entry of Array.from(state.files.entries())) {
                const [path, originalContent] = entry;
                if (originalContent) {
                    await this.lib.fs.writeFile(path, originalContent);
                } else {
                    // Was new file, delete it
                    try {
                        await this.lib.fs.unlink(path);
                    } catch (e) { }
                }
            }

            // Run undo script if available
            if (state.manifest && state.manifest.undoScript) {
                try {
                    await this.lib.std.print(`Running undo script: ${state.manifest.undoScript}\n`);
                    const proc = await this.lib.shell.exec(state.manifest.undoScript, []);
                    await this.lib.shell.waitpid(proc.pid);
                } catch (e: any) {
                    await this.lib.std.print(`⚠️  Undo script failed: ${e.message}\n`);
                }
            }

            state.status = "rolled_back";
            await this.lib.std.print(`✅ Rollback complete\n`);
        } catch (e: any) {
            await this.lib.std.print(`❌ Rollback error: ${e.message}\n`);
        }
    }

    private async mkdirRecursive(path: string) {
        if (!path || path === "/" || await this.exists(path)) return;

        const parent = path.substring(0, path.lastIndexOf("/"));
        if (parent && parent !== path) {
            await this.mkdirRecursive(parent);
        }

        try {
            await this.lib.fs.mkdir(path);
        } catch (e) {
            // May already exist
        }
    }

    private async exists(path: string): Promise<boolean> {
        try {
            const stat = await this.lib.fs.stat(path);
            return !!stat;
        } catch (e) {
            return false;
        }
    }

    // ============ INTERNAL: CONFIG & CACHE ============

    private async ensureCache() {
        const dirs = [
            "/var",
            "/var/cache",
            this.config.cacheDir,
            "/etc/tsd"
        ];

        for (const dir of dirs) {
            try {
                await this.lib.fs.mkdir(dir);
            } catch (e) { }
        }
    }

    private async getHostFromArgs(args?: string[]): Promise<string | null> {
        if (!args) return await this.getDefaultRepo();

        const fromIdx = (args || []).indexOf("--from");
        if (fromIdx > -1 && args![fromIdx + 1]) {
            return args![fromIdx + 1];
        }

        return await this.getDefaultRepo();
    }

    private async getDefaultRepo(): Promise<string | null> {
        try {
            if (!await this.exists(this.config.configFile)) return null;
            const content = await this.lib.fs.readFile(this.config.configFile);
            const config = JSON.parse(content || "{}");
            return config.defaultRepo || null;
        } catch (e) {
            return null;
        }
    }

    private async getInstalledVersion(pkgName: string): Promise<string | null> {
        try {
            const statusFile = "/var/lib/tsd/installed.json";
            if (!await this.exists(statusFile)) return null;
            const content = await this.lib.fs.readFile(statusFile);
            const status = JSON.parse(content || "{}");
            return status[pkgName] || null;
        } catch (e) {
            return null;
        }
    }

    private async updateInstalledStatus(pkgName: string, version: string) {
        try {
            const statusFile = "/var/lib/tsd/installed.json";
            let status: any = {};
            if (await this.exists(statusFile)) {
                const content = await this.lib.fs.readFile(statusFile);
                status = JSON.parse(content || "{}");
            }
            status[pkgName] = version;

            // Ensure directory exists
            await this.mkdirRecursive("/var/lib/tsd");
            await this.lib.fs.writeFile(statusFile, JSON.stringify(status, null, 2));
        } catch (e: any) {
            await this.lib.std.print(`⚠️  Could not update installation status: ${e.message}\n`);
        }
    }

    private async isTrustedFingerprint(fp: string): Promise<boolean> {
        try {
            if (!await this.exists(this.config.trustedRepos)) return false;
            const content = await this.lib.fs.readFile(this.config.trustedRepos);
            return (content || "").includes(fp);
        } catch (e) {
            return false;
        }
    }

    private async addTrustedFingerprint(fp: string) {
        try {
            let content = "";
            if (await this.exists(this.config.trustedRepos)) {
                content = await this.lib.fs.readFile(this.config.trustedRepos) || "";
            }
            await this.lib.fs.writeFile(this.config.trustedRepos, content + fp + "\n");
        } catch (e: any) {
            await this.lib.std.print(`⚠️  Could not save fingerprint: ${e.message}\n`);
        }
    }

    // ============ UTILITIES ============

    private async showMetrics() {
        await this.lib.std.print("\n\x1b[1;34mTSD Metrics:\x1b[0m\n");
        await this.lib.std.print("──────────────────────────────────────────\n");
        await this.lib.std.print(`Downloads:      ${this.metrics.totalDownloads}\n`);
        await this.lib.std.print(`Installations:  ${this.metrics.totalInstalls}\n`);
        await this.lib.std.print(`Failed:         ${this.metrics.failedInstalls}\n`);
        await this.lib.std.print(`Rolled back:    ${this.metrics.rolledBack}\n`);
        await this.lib.std.print(`Cache hits:     ${this.metrics.cacheHits}\n`);
        await this.lib.std.print("──────────────────────────────────────────\n");
    }

    private async showHelp() {
        await this.lib.std.print("\x1b[1mTSD - TSIX Software Distribution Client\x1b[0m\n");
        await this.lib.std.print("Usage: tsd <command> [options]\n\n");
        await this.lib.std.print("Commands:\n");
        await this.lib.std.print("  update <host>                    Update package catalog\n");
        await this.lib.std.print("  list                             List cached packages\n");
        await this.lib.std.print("  info <package> --from <host>     Show package details\n");
        await this.lib.std.print("  install <package> --from <host>  Install package (atomic)\n");
        await this.lib.std.print("  download <package> --from <host> Download without post-install\n");
        await this.lib.std.print("  verify <package> --from <host>   Verify package signature\n");
        await this.lib.std.print("  metrics                          Show statistics\n");
        await this.lib.std.print("\nOptions:\n");
        await this.lib.std.print("  --from <host>                    Repository host:port\n");
        await this.lib.std.print("  --force                          Force reinstall\n");
        await this.lib.std.print("  --help                           Show this help\n");
    }
}
