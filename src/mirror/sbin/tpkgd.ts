import { UserLib } from "../lib/UserLib";
import { SecurityAgent } from "@common/SecurityAgent";
import { SMQTNL_IOCTL } from "../lib/NetworkLib";
import {
    TPKG_DEFAULT_MAX_BUNDLE,
    TPKG_DEFAULT_PORT,
    TPKG_PROTOCOL_VERSION,
    bundleDigest,
    formatBytes,
    isSafeHostDst,
    sha256Hex,
    type TpkgBundleFile,
    type TpkgManifest,
    type TpkgPackage,
} from "@tsix/TpkgProtocol";

/**
 * TPKGD — TSIX Package Repository Daemon
 *
 * Melayani repository paket (`/etc/tpkg/packages.json`) ke klien `tpkg`:
 * handshake RSA → session key ChaCha20 → LIST / INFO / GET_BUNDLE.
 *
 * Wajib root: memakai kunci identitas privat `/etc/keys/rsa` dan menyajikan isi
 * sistem (termasuk file kernel untuk paket "engine update").
 *
 * Perbaikan dari versi lama:
 *   - `--port` / `--repo` / `--max-bundle` bisa diatur (dulu port 80 di-hardcode);
 *   - protocol MQTNL di-PIN ke JSON per-port (dulu mengikuti `protocolRegistry`,
 *     sehingga payload bisa tiba sebagai Buffer dan `JSON.parse` gagal);
 *   - session punya TTL + dibersihkan berkala (dulu Map tumbuh selamanya);
 *   - rate limit per alamat pengirim;
 *   - bundle punya batas ukuran eksplisit, digest SHA-256 per file, dan yang
 *     ditandatangani adalah METADATA (path/hostDst/size/sha256) — bukan seluruh
 *     konten.
 */
export class Main {
    private lib!: UserLib;
    private port: number = TPKG_DEFAULT_PORT;
    private repoPath: string = "/etc/tpkg/packages.json";
    private keysPath: string = "/etc/keys/rsa";
    private maxBundle: number = TPKG_DEFAULT_MAX_BUNDLE;
    private sessionTtlMs: number = 10 * 60 * 1000;
    private rateLimitPerMin: number = 120;
    private privateKey: string = "";
    private publicKey: string = "";
    private sessions: Map<string, { agent: SecurityAgent; lastActivity: number }> = new Map();
    private rateLimiter: Map<string, { count: number; resetAt: number }> = new Map();
    private lastSweep: number = 0;
    private stats = { handshakes: 0, lists: 0, infos: 0, bundles: 0, denied: 0 };

    async execute(lib: UserLib, args: string[]) {
        this.lib = lib;

        if (args.includes("--help") || args.includes("-h")) {
            await this.printHelp();
            return;
        }

        // GERBANG ROOT.
        //
        // tpkgd memakai kunci identitas privat (`/etc/keys/rsa`) dan menyajikan isi
        // sistem — termasuk file kernel untuk paket "engine update". Membiarkannya
        // jalan sebagai user biasa berarti file sistem bisa dibaca dan
        // didistribusikan tanpa kontrol root. Sama seperti tsshd/netfsd.
        const who = await this.lib.shell.whoami();
        if (who.uid !== 0) {
            await this.lib.std.print(
                "❌ Error: tpkgd requires root privileges (membaca /etc/keys/rsa & menyajikan file sistem). Use sudo.\n",
            );
            return;
        }

        try {
            this.parseArgs(args);
        } catch (e: any) {
            await this.lib.std.print(`❌ ${e.message}\n`);
            await this.printHelp();
            return;
        }

        await this.ensureKeys();

        const fd = await this.lib.net.socket();
        if (fd < 0) {
            await this.lib.std.print("❌ Failed to open MQTNL socket.\n");
            return;
        }

        const bound = await this.lib.net.bind(fd, this.port);
        if (!bound) {
            await this.lib.std.print(`❌ Failed to bind MQTNL port ${this.port}.\n`);
            return;
        }
        this.port = bound;

        // Pin protocol per-port: TPKG selalu bicara JSON. Tanpa pin ini, framing
        // bisa terbelokkan protocol "terakhir dipakai peer" (`protocolRegistry`)
        // dan payload tiba sebagai Buffer → JSON.parse gagal tanpa pesan jelas.
        await this.lib.net.ioctl(fd, SMQTNL_IOCTL.SET_BINARY_MODE, {
            port: this.port,
            protocol: "JSON",
        });

        await this.lib.shell.daemonize("TPKG Repository Daemon");
        await this.lib.std.log(
            `listening on MQTNL port ${this.port} · repo ${this.repoPath} · max bundle ${formatBytes(this.maxBundle)}`,
            "tpkgd",
        );

        while (true) {
            const packet = await this.lib.net.recv(fd);
            if (!packet) {
                await new Promise((r) => setTimeout(r, 100));
                this.sweep();
                continue;
            }

            const { src } = packet;
            const text = this.payloadText(packet.data);

            try {
                if (!this.checkRateLimit(src)) {
                    this.stats.denied++;
                    await this.lib.std.log(`rate limit: ${src} ditolak`, "tpkgd");
                    continue;
                }

                // Handshake selalu plaintext JSON (belum ada session key).
                if (text.includes('"type":"handshake"')) {
                    await this.handleHandshake(fd, packet, text);
                    continue;
                }

                await this.handleRequest(fd, packet, text);
            } catch (e: any) {
                await this.lib.std.log(`Error: ${e.message}`, "tpkgd");
            }
        }
    }

    /** payloadText(): Normalkan payload jadi string (Buffer → utf8) tanpa melempar. */
    private payloadText(data: any): string {
        if (typeof data === "string") return data;
        if (Buffer.isBuffer(data)) return data.toString("utf8");
        if (data && typeof data.toString === "function") return data.toString("utf8");
        return "";
    }

    /** parseArgs(): dukung `--port`, `--repo`, `--max-bundle`. */
    private parseArgs(args: string[]) {
        for (let i = 0; i < args.length; i++) {
            const next = args[i + 1];
            if (args[i] === "--port" && next) {
                const p = Number(next);
                if (!Number.isInteger(p) || p <= 0 || p > 65535) {
                    throw new Error(`--port tidak valid: '${next}'`);
                }
                this.port = p;
            } else if (args[i] === "--repo" && next) {
                this.repoPath = next;
            } else if (args[i] === "--max-bundle" && next) {
                const n = Number(next);
                if (!Number.isFinite(n) || n <= 0) {
                    throw new Error(`--max-bundle tidak valid: '${next}'`);
                }
                this.maxBundle = n;
            }
        }
    }

    private async printHelp() {
        await this.lib.std.print("TPKGD — TSIX Package Repository Daemon\n\n");
        await this.lib.std.print("Usage: tpkgd [options]\n\n");
        await this.lib.std.print("Options:\n");
        await this.lib.std.print(`  --port <n>          MQTNL port (default: ${TPKG_DEFAULT_PORT})\n`);
        await this.lib.std.print("  --repo <path>       Manifest repository (default: /etc/tpkg/packages.json)\n");
        await this.lib.std.print(`  --max-bundle <byte> Batas ukuran bundle (default: ${TPKG_DEFAULT_MAX_BUNDLE})\n`);
        await this.lib.std.print("  --help              Show this help\n");
        await this.lib.std.print("\n⚠️  tpkgd wajib dijalankan sebagai root (sudo) — memakai /etc/keys/rsa\n");
        await this.lib.std.print("    dan menyajikan file sistem termasuk kernel.\n");
    }

    private async ensureKeys() {
        if (!(await this.exists(this.keysPath))) {
            await this.lib.fs.mkdir(this.keysPath);
        }

        const privPath = `${this.keysPath}/id_rsa`;
        const pubPath = `${this.keysPath}/id_rsa.pub`;

        if (!(await this.exists(privPath))) {
            await this.lib.std.print("Generating system RSA keys (id_rsa)...");
            const pair = SecurityAgent.generateKeyPair();
            await this.lib.fs.writeFile(privPath, pair.privateKey);
            await this.lib.fs.writeFile(pubPath, pair.publicKey);
            this.privateKey = pair.privateKey;
            this.publicKey = pair.publicKey;
            await this.lib.std.print(" Done.\n");
        } else {
            this.privateKey = (await this.lib.fs.readFile(privPath)) || "";
            this.publicKey = (await this.lib.fs.readFile(pubPath)) || "";
        }
    }

    private async handleHandshake(fd: number, packet: any, text: string) {
        let data: any;
        try {
            data = JSON.parse(text);
        } catch (e) {
            await this.lib.std.log(`handshake bukan JSON valid dari ${packet.src}`, "tpkgd");
            return;
        }

        if (data.type !== "handshake" || typeof data.publicKey !== "string" || !data.publicKey) {
            await this.lib.std.log(`handshake tidak lengkap dari ${packet.src}`, "tpkgd");
            return;
        }

        await this.lib.std.log(`Handshake request from ${packet.src}:${packet.port}`, "tpkgd");

        // Session key (ChaCha20) — dikirim terenkripsi dengan public key klien.
        const sessionKey = SecurityAgent.generateSessionKey();
        const encryptedKey = SecurityAgent.encryptWithPublicKey(data.publicKey, sessionKey);

        const response = {
            type: "handshake_ack",
            protocolVersion: TPKG_PROTOCOL_VERSION,
            sessionKey: encryptedKey,
            // Public key dikirim supaya klien bisa memverifikasi signature paket.
            publicKey: this.publicKey,
            fingerprint: SecurityAgent.getFingerprint(this.publicKey),
            serverVersion: TPKG_PROTOCOL_VERSION,
        };

        await this.lib.net.sendto(fd, packet.src, packet.port, JSON.stringify(response));

        const agent = new SecurityAgent();
        agent.setSessionKey(sessionKey);
        this.sessions.set(this.sessionId(packet), { agent, lastActivity: Date.now() });
        this.stats.handshakes++;
    }

    /** sessionId(): Kunci session = pasangan alamat:port pengirim. */
    private sessionId(packet: any): string {
        return `${packet.src}:${packet.port}`;
    }

    /**
     * checkRateLimit(): Jendela 1 menit per alamat pengirim.
     * Tanpa ini, satu klien yang salah bisa membanjiri daemon (dan setiap
     * request memicu RSA/Poly1305 kerja nyata).
     */
    private checkRateLimit(src: string): boolean {
        const now = Date.now();
        const limit = this.rateLimiter.get(src);
        if (!limit || now > limit.resetAt) {
            this.rateLimiter.set(src, { count: 1, resetAt: now + 60000 });
            return true;
        }
        limit.count++;
        return limit.count <= this.rateLimitPerMin;
    }

    /**
     * sweep(): Buang session kedaluwarsa + entri rate-limit basi.
     * Dipanggil saat loop menganggur (socket idle) — bukan via `setInterval`,
     * supaya daemon tidak bangun sia-sia saat sibuk.
     */
    private sweep(): void {
        const now = Date.now();
        if (now - this.lastSweep < 30000) return;
        this.lastSweep = now;

        for (const [sid, session] of this.sessions) {
            if (now - session.lastActivity > this.sessionTtlMs) this.sessions.delete(sid);
        }
        for (const [src, limit] of this.rateLimiter) {
            if (now > limit.resetAt) this.rateLimiter.delete(src);
        }
    }

    /** stats(): hitungan aktivitas (dipakai test & diagnosa). */
    get statistics() {
        return { ...this.stats, sessions: this.sessions.size };
    }

    private async handleRequest(fd: number, packet: any, text: string) {
        const sid = this.sessionId(packet);
        const session = this.sessions.get(sid);
        if (!session) return; // belum handshake / session kedaluwarsa

        let request: any;
        try {
            request = JSON.parse(session.agent.securePacketIn(text));
        } catch (e) {
            // Ciphertext rusak / bukan untuk session ini — biarkan klien timeout.
            return;
        }
        if (!request || typeof request.type !== "string") return;

        session.lastActivity = Date.now();
        const { src, port: srcPort } = packet;

        if (request.type === "LIST") {
            this.stats.lists++;
            await this.lib.std.log(`[LIST] request from ${src}`, "tpkgd");
            const manifest = await this.getManifest();
            const packages = (manifest.packages ?? []).map((p) => ({
                name: p.name,
                version: p.version,
                description: p.description,
                author: p.author,
            }));

            const reply: any = {
                type: "LIST_REPLY",
                packages,
                signature: SecurityAgent.sign(this.privateKey, JSON.stringify(packages)),
            };

            await this.lib.net.sendto(fd, src, srcPort, session.agent.securePacketOut(JSON.stringify(reply)));
        } else if (request.type === "INFO" && request.name) {
            this.stats.infos++;
            await this.lib.std.log(`[INFO] request: ${request.name} from ${src}`, "tpkgd");
            const manifest = await this.getManifest();
            const pkg = manifest.packages.find((p) => p.name === request.name);

            if (!pkg) {
                await this.sendError(
                    fd,
                    src,
                    srcPort,
                    session.agent,
                    "Package not found",
                    manifest.packages.map((p) => p.name),
                    request.name,
                );
                return;
            }

            const reply: any = {
                type: "INFO_REPLY",
                package: pkg,
                signature: SecurityAgent.sign(this.privateKey, JSON.stringify(pkg)),
            };

            await this.lib.net.sendto(fd, src, srcPort, session.agent.securePacketOut(JSON.stringify(reply)));
        } else if (request.type === "GET_BUNDLE" && request.name) {
            this.stats.bundles++;
            await this.lib.std.log(`[BUNDLE] request: ${request.name} for ${src}`, "tpkgd");
            const manifest = await this.getManifest();
            const pkg = manifest.packages.find((p) => p.name === request.name);

            if (!pkg) {
                await this.sendError(
                    fd,
                    src,
                    srcPort,
                    session.agent,
                    "Package not found",
                    manifest.packages.map((p) => p.name),
                    request.name,
                );
                return;
            }

            let files: TpkgBundleFile[];
            try {
                files = await this.buildBundle(pkg);
            } catch (e: any) {
                // Paket setengah jadi TIDAK boleh dikirim — klien akan menolaknya
                // karena digest tidak cocok, dan pesannya jadi membingungkan.
                await this.sendError(fd, src, srcPort, session.agent, e.message);
                return;
            }

            const total = files.reduce((sum, f) => sum + f.size, 0);
            const reply: any = {
                type: "BUNDLE_REPLY",
                name: pkg.name,
                version: pkg.version,
                files,
                onAfter: pkg.onAfterDownload,
                undoScript: pkg.undoScript,
                needReboot: pkg.needReboot === true,
                // Yang ditandatangani = METADATA bundle (path/size/sha256), bukan
                // seluruh konten: payload tanda tangan kecil, integritas konten
                // tetap terjaga karena sha256 tiap file ada di dalamnya.
                signature: SecurityAgent.sign(this.privateKey, bundleDigest(files)),
            };

            await this.lib.net.sendto(fd, src, srcPort, session.agent.securePacketOut(JSON.stringify(reply)));
            await this.lib.std.log(
                `[BUNDLE] ${pkg.name} v${pkg.version}: ${files.length} file (${formatBytes(total)}) → ${src}`,
                "tpkgd",
            );
        }
    }

    /**
     * buildBundle(): Baca semua item paket → daftar file bundle siap kirim.
     *
     * Melempar Error dengan pesan manusiawi kalau ada file sumber yang tidak ada
     * atau total melewati `maxBundle` — supaya klien menerima ERROR yang jelas,
     * bukan bundle tidak lengkap yang gagal verifikasi.
     */
    private async buildBundle(pkg: TpkgPackage): Promise<TpkgBundleFile[]> {
        const files: TpkgBundleFile[] = [];
        const items = pkg.items ?? [];
        let total = 0;

        for (const item of items) {
            const content = await this.lib.fs.readFile(item.src);
            if (content === null || content === undefined) {
                throw new Error(`file sumber tidak ada: ${item.src}`);
            }

            // Tujuan host divalidasi di sisi server supaya manifest yang salah
            // ketahuan saat itu juga (bukan setelah klien menulis setengah paket).
            if (item.hostDst !== undefined && !isSafeHostDst(item.hostDst)) {
                throw new Error(
                    `hostDst tidak aman di paket '${pkg.name}': '${item.hostDst}' (harus relatif, tanpa '..')`,
                );
            }

            total += content.length;
            if (total > this.maxBundle) {
                throw new Error(
                    `bundle ${formatBytes(total)} melebihi batas ${formatBytes(this.maxBundle)} ` +
                        `— kecilkan paket atau jalankan tpkgd dengan --max-bundle`,
                );
            }
            files.push({
                path: item.dst,
                size: content.length,
                sha256: sha256Hex(content),
                content,
                ...(item.hostDst !== undefined ? { hostDst: item.hostDst } : {}),
                ...(typeof item.permissions === "number" ? { permissions: item.permissions } : {}),
                ...(item.isExecutable ? { isExecutable: true } : {}),
            });
        }

        if (files.length === 0) throw new Error("paket tidak punya file");
        return files;
    }

    /** sendError(): Balasan ERROR standar (opsional dengan saran nama terdekat). */
    private async sendError(
        fd: number,
        src: string,
        srcPort: number,
        agent: SecurityAgent,
        message: string,
        choices?: string[],
        input?: string,
    ) {
        const payload: any = { type: "ERROR", message };
        if (choices && input) {
            const suggestions = this.findSuggestions(input, choices);
            if (suggestions.length > 0) payload.suggestions = suggestions;
        }
        await this.lib.net.sendto(fd, src, srcPort, agent.securePacketOut(JSON.stringify(payload)));
    }

    /**
     * getManifest(): Baca `packages.json` dengan aman.
     * Return manifest kosong kalau file belum ada / rusak — daemon tidak boleh
     * mati (atau melayani data setengah) hanya karena repo salah tulis.
     */
    private async getManifest(): Promise<TpkgManifest> {
        if (!(await this.exists(this.repoPath))) {
            return { version: TPKG_PROTOCOL_VERSION, packages: [] };
        }
        const content = await this.lib.fs.readFile(this.repoPath);
        try {
            const parsed = JSON.parse(content || "{}");
            return {
                version: typeof parsed?.version === "string" ? parsed.version : TPKG_PROTOCOL_VERSION,
                packages: Array.isArray(parsed?.packages) ? (parsed.packages as TpkgPackage[]) : [],
            };
        } catch (e: any) {
            await this.lib.std.log(`manifest rusak (${this.repoPath}): ${e.message}`, "tpkgd");
            return { version: TPKG_PROTOCOL_VERSION, packages: [] };
        }
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
                    matrix[i - 1][j] + 1, // deletion
                    matrix[i][j - 1] + 1, // insertion
                    matrix[i - 1][j - 1] + cost, // substitution
                );
            }
        }
        return matrix[len1][len2];
    }

    private findSuggestions(input: string, choices: string[]): string[] {
        const results = choices.map((choice) => ({
            name: choice,
            dist: this.levenshteinDistance(input, choice),
        }));

        return results
            .filter((r) => r.dist < 4) // Max 3 edits
            .sort((a, b) => a.dist - b.dist)
            .map((r) => r.name)
            .filter((name) => name !== input) // Don't suggest the exact same thing (though logic usually handles this)
            .slice(0, 3);
    }
}
