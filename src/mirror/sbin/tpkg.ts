import { UserLib } from "../lib/UserLib";
import { SecurityAgent } from "@common/SecurityAgent";

/**
 * TPKG Utility
 * 
 * TSIX Package Manager. Manage packages via MQTNL.
 */
export class Main {
    private lib!: UserLib;
    private cacheDir: string = "/var/cache/tpkg";
    private repoCache: string = "/var/cache/tpkg/repo.json";
    private trustedRepos: string = "/etc/tpkg/trusted_repos";
    private configFile: string = "/etc/tpkg/config.json";

    async execute(lib: UserLib, args: string[]) {
        this.lib = lib;

        if (args.includes("--help") || args.includes("-h")) {
            this.showHelp();
            return;
        }

        // Handle --set-repo
        const setRepoIdx = args.indexOf("--set-repo");
        if (setRepoIdx > -1) {
            const repo = args[setRepoIdx + 1];
            if (repo) {
                await this.saveConfig({ defaultRepo: repo });
                await this.lib.std.print(`✅ Default repository set to: ${repo}\n`);
                return;
            }
        }

        const cmd = args[0];

        if (!cmd || cmd === "help") {
            this.showHelp();
            return;
        }

        await this.ensureCache();

        // Security Check: Enforce root for mutations
        const who = await this.lib.shell.whoami();
        const rootRequired = ["install", "update"];
        if (rootRequired.includes(cmd) && who.uid !== 0) {
            await this.lib.std.print(`❌ Error: 'tpkg ${cmd}' requires root privileges. Use sudo.\n`);
            return;
        }

        switch (cmd) {
            case "update":
                await this.doUpdate(args[1]);
                break;
            case "list":
                await this.doList();
                break;
            case "install":
                await this.doInstall(args[1], args);
                break;
            case "info":
                await this.doInfo(args[1], args);
                break;
            default:
                await this.lib.std.print(`Unknown command: ${cmd}\n`);
                this.showHelp();
        }
    }

    private showHelp() {
        this.lib.std.print("\x1b[1mTPKG - TSIX Package Manager\x1b[0m\n");
        this.lib.std.print("Usage:\n");
        this.lib.std.print("  tpkg update [host]               - Update package catalog from host\n");
        this.lib.std.print("  tpkg list                       - List available packages\n");
        this.lib.std.print("  tpkg info <pkg> [--from <host>] - Show detailed package information\n");
        this.lib.std.print("  tpkg install <pkg> [--from <host>] - Install a package\n");
        this.lib.std.print("  tpkg --set-repo <host>          - Set default repository\n");
    }

    private async ensureCache() {
        if (!await this.exists("/var")) await this.lib.fs.mkdir("/var");
        if (!await this.exists("/var/cache")) await this.lib.fs.mkdir("/var/cache");
        if (!await this.exists(this.cacheDir)) await this.lib.fs.mkdir(this.cacheDir);
        if (!await this.exists("/etc/tpkg")) await this.lib.fs.mkdir("/etc/tpkg");
    }

    private async doUpdate(host: string) {
        if (!host) {
            const config = await this.loadConfig();
            host = config.defaultRepo;
        }

        if (!host) {
            await this.lib.std.print("Usage: tpkg update <host> (or set default with --set-repo)\n");
            return;
        }

        await this.lib.std.print(`Updating catalog from ${host}...\n`);
        const session = await this.establishSecureSession(host);
        if (!session) return;

        const { fd, publicKey: repoPubKey, agent } = session;

        try {
            await this.lib.net.sendto(fd, host, 80, agent.securePacketOut(JSON.stringify({ type: "LIST" })));
            const packet = await this.recvWithTimeout(fd, 5000); // Wait up to 5s

            if (packet) {
                let decrypted;
                try {
                    decrypted = agent.securePacketIn(packet.data);
                    const data = JSON.parse(decrypted);
                    if (data.type === "LIST_REPLY") {
                        // Verify Signature
                        const isValid = SecurityAgent.verify(repoPubKey, JSON.stringify(data.packages), data.signature);
                        if (!isValid) {
                            await this.lib.std.print("❌ ERROR: Repository signature verification failed! Data may be tampered.\n");
                            return;
                        }

                        await this.lib.fs.writeFile(this.repoCache, JSON.stringify(data.packages, null, 2));
                        await this.lib.std.print(`Successfully updated. ${data.packages.length} packages available. (Verified)\n`);
                    }
                } catch (e) {
                    await this.lib.std.print("❌ Received malformed response from server.\n");
                }
            } else {
                await this.lib.std.print("❌ Timeout or error waiting for server response.\n");
            }
        } finally {
            await this.lib.net.close(fd);
        }
    }

    private async doList() {
        if (!await this.exists(this.repoCache)) {
            await this.lib.std.print("No catalog found. Run 'tpkg update <host>' first.\n");
            return;
        }

        const content = await this.lib.fs.readFile(this.repoCache);
        const pkgs = JSON.parse(content || "[]");

        await this.lib.std.print("\n\x1b[1;34mAvailable Packages:\x1b[0m\n");
        await this.lib.std.print("--------------------------------------------------\n");
        for (const p of pkgs) {
            await this.lib.std.print(`\x1b[1m${p.name.padEnd(15)}\x1b[0m v${p.version}\n`);
            await this.lib.std.print(`  ${p.description}\n\n`);
        }
    }

    private async doInstall(pkgName: string, args: string[]) {
        const fromIdx = args.indexOf("--from");
        let host = fromIdx > -1 ? args[fromIdx + 1] : null;

        if (!host) {
            const config = await this.loadConfig();
            host = config.defaultRepo;
        }

        if (!pkgName || !host) {
            await this.lib.std.print("Usage: tpkg install <pkg> --from <host> (or set default with --set-repo)\n");
            return;
        }

        // --- VERSION CHECK ---
        const catalog = await this.loadCatalog();
        const remotePkg = catalog.find((p: any) => p.name === pkgName);
        if (!remotePkg) {
            await this.lib.std.print(`❌ Error: Package '${pkgName}' not found in catalog. Run 'tpkg update' first.\n`);
            const suggestions = this.findSuggestions(pkgName, catalog.map((p: any) => p.name));
            if (suggestions.length > 0) {
                await this.lib.std.print(`💡 Did you mean: \x1b[1;36m${suggestions.join(", ")}\x1b[0m ?\n`);
            }
            return;
        }

        const localStatus = await this.loadStatus();
        const localVer = localStatus[pkgName];

        if (localVer) {
            const cmp = this.compareVersions(localVer, remotePkg.version);
            if (cmp >= 0) {
                const msg = cmp === 0 ? "already same version" : "already newer";
                await this.lib.std.print(`⚠️  Version local for \x1b[1m${pkgName}\x1b[0m is ${msg} (\x1b[1;36m${localVer}\x1b[0m).\n`);
                const confirm = await this.lib.std.read("Proceed with installation anyway? [y/N]: ");
                if (confirm.toLowerCase().trim() !== "y") {
                    await this.lib.std.print("Installation aborted.\n");
                    return;
                }
            }
        }

        await this.lib.std.print(`Preparing to install \x1b[1m${pkgName}\x1b[0m (v${remotePkg.version}) from \x1b[1m${host}\x1b[0m...\n`);
        const session = await this.establishSecureSession(host);
        if (!session) return;

        const { fd, publicKey: repoPubKey, agent } = session;

        try {
            await this.lib.std.print("Requesting bundle (Bulk Delivery)...\n");
            await this.lib.net.sendto(fd, host, 80, agent.securePacketOut(JSON.stringify({ type: "GET_BUNDLE", name: pkgName })));

            let packet = await this.recvWithTimeout(fd, 10000); // 10s for bundle

            if (packet) {
                let decrypted;
                try {
                    decrypted = agent.securePacketIn(packet.data);
                    const data = JSON.parse(decrypted);
                    if (data.type === "BUNDLE_REPLY") {
                        // Verify Signature of the files list
                        const isValid = SecurityAgent.verify(repoPubKey, JSON.stringify(data.files), data.signature);
                        if (!isValid) {
                            await this.lib.std.print("❌ ERROR: Bundle signature verification failed! Package may be tampered.\n");
                            return;
                        }

                        await this.lib.std.print(`Received bundle: ${data.name} v${data.version} (Verified)\n`);

                        for (const file of data.files) {
                            await this.lib.std.print(`  -> Unpacking ${file.path}...`);
                            const dir = file.path.substring(0, file.path.lastIndexOf("/"));
                            if (dir) {
                                await this.mkdirRecursive(dir);
                            }
                            await this.lib.fs.writeFile(file.path, file.content);

                            if (file.path.startsWith("/bin/")) {
                                await this.lib.fs.chmod(file.path, 493);
                            }
                            await this.lib.std.print(" OK\n");
                        }

                        // --- RECORD VERSION ---
                        localStatus[pkgName] = data.version;
                        await this.saveStatus(localStatus);

                        if (data.onAfter) {
                            await this.lib.std.print(`\n✅ Package installed. Post-install script: \x1b[1;36m${data.onAfter}\x1b[0m\n`);
                            const confirm = await this.lib.std.read("Run post-install script now? [Y/n]: ");
                            if (confirm.toLowerCase().trim() !== "n") {
                                await this.lib.std.print(`Running ${data.onAfter}...\n`);
                                const proc = await this.lib.shell.exec(data.onAfter, []);
                                const exitCode = await this.lib.shell.waitpid(proc.pid);
                                await this.lib.std.print(`Post-install finished with exit code: ${exitCode}\n`);
                            } else {
                                await this.lib.std.print(`Skipping post-install. You can run it manually: ${data.onAfter}\n`);
                            }
                        } else {
                            await this.lib.std.print("✅ Installation successful.\n");
                        }

                        if (data.needReboot) {
                            await this.lib.std.print("\x1b[1;33m⚠️  REBOOT REQUIRED: Run 'reboot' to apply system changes.\x1b[0m\n");
                        }
                    } else if (data.type === "ERROR") {
                        await this.lib.std.print(`❌ Server Error: ${data.message}\n`);
                        if (data.suggestions && data.suggestions.length > 0) {
                            await this.lib.std.print(`💡 Did you mean: \x1b[1;36m${data.suggestions.join(", ")}\x1b[0m ?\n`);
                        }
                    }
                } catch (e) {
                    await this.lib.std.print("❌ Received malformed response from server.\n");
                }
            } else {
                await this.lib.std.print("❌ Bundle reception timed out.\n");
            }
        } finally {
            await this.lib.net.close(fd);
        }
    }

    private async doInfo(pkgName: string, args: string[]) {
        const fromIdx = args.indexOf("--from");
        let host = fromIdx > -1 ? args[fromIdx + 1] : null;

        if (!host) {
            const config = await this.loadConfig();
            host = config.defaultRepo;
        }

        if (!pkgName || !host) {
            await this.lib.std.print("Usage: tpkg info <pkg> [--from <host>] (or set default with --set-repo)\n");
            return;
        }

        await this.lib.std.print(`Fetching info for \x1b[1m${pkgName}\x1b[0m from \x1b[1m${host}\x1b[0m...\n`);
        const session = await this.establishSecureSession(host);
        if (!session) return;

        const { fd, publicKey: repoPubKey, agent } = session;

        try {
            await this.lib.net.sendto(fd, host, 80, agent.securePacketOut(JSON.stringify({ type: "INFO", name: pkgName })));
            const packet = await this.recvWithTimeout(fd, 5000);

            if (packet) {
                let decrypted;
                try {
                    decrypted = agent.securePacketIn(packet.data);
                    const data = JSON.parse(decrypted);
                    if (data.type === "INFO_REPLY") {
                        const pkg = data.package;
                        // Verify Signature
                        const isValid = SecurityAgent.verify(repoPubKey, JSON.stringify(pkg), data.signature);
                        if (!isValid) {
                            await this.lib.std.print("❌ ERROR: Package info signature verification failed!\n");
                            return;
                        }

                        await this.lib.std.print(`\n\x1b[1;34mPackage Information:\x1b[0m\n`);
                        await this.lib.std.print(`--------------------------------------------------\n`);
                        await this.lib.std.print(`\x1b[1mName:\x1b[0m        ${pkg.name}\n`);
                        await this.lib.std.print(`\x1b[1mVersion:\x1b[0m     ${pkg.version}\n`);
                        await this.lib.std.print(`\x1b[1mDescription:\x1b[0m ${pkg.description}\n`);
                        await this.lib.std.print(`\x1b[1mAuthor:\x1b[0m      ${pkg.author}\n`);
                        await this.lib.std.print(`\x1b[1mReboot Req:\x1b[0m  ${pkg.needReboot ? "Yes" : "No"}\n`);

                        if (pkg.onAfterDownload) {
                            await this.lib.std.print(`\x1b[1mPost-Install:\x1b[0m ${pkg.onAfterDownload}\n`);
                        }

                        await this.lib.std.print(`\n\x1b[1mFiles:\x1b[0m\n`);
                        for (const item of pkg.items) {
                            await this.lib.std.print(`  - [SRC] ${item.src.padEnd(30)} -> [DST] ${item.dst}\n`);
                        }
                        await this.lib.std.print(`--------------------------------------------------\n`);
                    } else if (data.type === "ERROR") {
                        await this.lib.std.print(`❌ Server Error: ${data.message}\n`);
                        if (data.suggestions && data.suggestions.length > 0) {
                            await this.lib.std.print(`💡 Did you mean: \x1b[1;36m${data.suggestions.join(", ")}\x1b[0m ?\n`);
                        }
                    }
                } catch (e) {
                    await this.lib.std.print("❌ Received malformed response from server.\n");
                }
            } else {
                await this.lib.std.print("❌ Timeout waiting for server response.\n");
            }
        } finally {
            await this.lib.net.close(fd);
        }
    }

    private async establishSecureSession(host: string): Promise<any> {
        const fd = await this.lib.net.socket();
        if (fd < 0) return null;

        await this.lib.net.bind(fd, 0); // Random port

        const pair = SecurityAgent.generateKeyPair();

        await this.lib.net.sendto(fd, host, 80, JSON.stringify({
            type: "handshake",
            publicKey: pair.publicKey
        }));

        const packet = await this.recvWithTimeout(fd, 5000); // 5s for handshake
        if (!packet) {
            await this.lib.std.print(`❌ Host ${host} not responding.\n`);
            return null;
        }

        const ack = JSON.parse(packet.data);
        if (ack.type !== "handshake_ack") {
            await this.lib.std.print("❌ Handshake failed.\n");
            return null;
        }

        const fp = ack.fingerprint;
        if (!await this.isTrusted(fp)) {
            await this.lib.std.print(`\x1b[1;33m⚠️  WARNING: Unknown Repository Fingerprint: ${fp}\x1b[0m\n`);
            const confirm = await this.lib.std.read("Accept and proceed? [y/N]: ");
            if (confirm.toLowerCase().trim() !== "y") return null;
            await this.addTrusted(fp);
        }

        const sessionKey = SecurityAgent.decryptWithPrivateKey(pair.privateKey, ack.sessionKey);
        const agent = new SecurityAgent();
        agent.setSessionKey(sessionKey);

        return { fd, publicKey: ack.publicKey, agent };
    }

    private async loadCatalog(): Promise<any[]> {
        if (!await this.exists(this.repoCache)) return [];
        const content = await this.lib.fs.readFile(this.repoCache);
        try {
            return JSON.parse(content || "[]");
        } catch (e) {
            return [];
        }
    }

    private async loadStatus(): Promise<Record<string, string>> {
        const path = "/var/lib/tpkg/status.json";
        if (!await this.exists(path)) return {};
        const content = await this.lib.fs.readFile(path);
        try {
            return JSON.parse(content || "{}");
        } catch (e) {
            return {};
        }
    }

    private async saveStatus(status: Record<string, string>) {
        const dir = "/var/lib/tpkg";
        if (!await this.exists(dir)) {
            if (!await this.exists("/var/lib")) await this.lib.fs.mkdir("/var/lib");
            await this.lib.fs.mkdir(dir);
        }
        await this.lib.fs.writeFile(`${dir}/status.json`, JSON.stringify(status, null, 2));
    }

    /**
     * compareVersions(v1, v2):
     * Return 1 if v1 > v2, -1 if v1 < v2, 0 if v1 == v2
     */
    private compareVersions(v1: string, v2: string): number {
        const p1 = v1.replace(/[^0-9.]/g, "").split(".").map(Number);
        const p2 = v2.replace(/[^0-9.]/g, "").split(".").map(Number);
        const len = Math.max(p1.length, p2.length);

        for (let i = 0; i < len; i++) {
            const a = p1[i] || 0;
            const b = p2[i] || 0;
            if (a > b) return 1;
            if (a < b) return -1;
        }
        return 0;
    }

    private async exists(path: string): Promise<boolean> {
        try {
            const s = await this.lib.fs.stat(path);
            return !!s;
        } catch (e) {
            return false;
        }
    }

    private async isTrusted(fp: string): Promise<boolean> {
        if (!await this.exists(this.trustedRepos)) return false;
        const list = await this.lib.fs.readFile(this.trustedRepos);
        return (list || "").includes(fp);
    }

    private async addTrusted(fp: string) {
        let list = "";
        if (await this.exists(this.trustedRepos)) {
            list = await this.lib.fs.readFile(this.trustedRepos) || "";
        }
        await this.lib.fs.writeFile(this.trustedRepos, list + fp + "\n");
    }

    private async recvWithTimeout(fd: number, timeoutMs: number): Promise<any> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const packet = await this.lib.net.recv(fd);
            if (packet) return packet;
            await new Promise(r => setTimeout(r, 100)); // Sleep 100ms
        }
        return null;
    }

    private async loadConfig(): Promise<any> {
        if (!await this.exists(this.configFile)) return {};
        const content = await this.lib.fs.readFile(this.configFile);
        try {
            return JSON.parse(content || "{}");
        } catch (e) {
            return {};
        }
    }

    private async saveConfig(config: any) {
        await this.lib.fs.writeFile(this.configFile, JSON.stringify(config, null, 2));
    }

    private async mkdirRecursive(path: string) {
        if (path === "/" || path === "" || await this.exists(path)) return;
        const parent = path.substring(0, path.lastIndexOf("/"));
        if (parent) {
            await this.mkdirRecursive(parent);
        }
        try {
            await this.lib.fs.mkdir(path);
        } catch (e) {
            // Ignore if exists (race condition)
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
            .filter(name => name !== input)
            .slice(0, 3);
    }
}
