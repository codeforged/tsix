import { UserLib } from "../lib/UserLib";
import { SecurityAgent } from "@common/SecurityAgent";
import { SMQTNL_IOCTL } from "../lib/NetworkLib";
import {
    TPKG_DEFAULT_PORT,
    TPKG_PROTOCOL_VERSION,
    bundleDigest,
    compareVersions,
    formatBytes,
    parseHostPort,
    resolveMode,
    verifyBundleFiles,
    type TpkgBundleFile,
    type TpkgHostPort,
} from "./TpkgProtocol";

/** Bentuk satu entri backup di `/var/lib/tpkg/backup/<pkg>/<ts>/index.json`. */
interface BackupEntry {
    path: string;
    /** true = sudah ada sebelum install → `backup` berisi isinya. */
    existed: boolean;
    /** Nama file di folder backup (relatif), mis. "0001.bin". */
    backup?: string;
}

interface BackupIndex {
    package: string;
    version: string;
    createdAt: number;
    /** Skrip undo paket (kalau ada) — ikut dipulihkan saat rollback. */
    undoScript?: string;
    entries: BackupEntry[];
}

/**
 * TPKG — TSIX Package Manager (klien)
 *
 * Ambil paket dari repository MQTNL (`tpkgd`) lalu pasang ke VFS dengan
 * verifikasi + backup + rollback.
 *
 * Ikhtisar pengamanan berlapis:
 *   1. handshake RSA → session key ChaCha20 (transport terenkripsi);
 *   2. fingerprint repo disimpan di `/etc/tpkg/trusted_repos` (TOFU);
 *   3. signature server atas **metadata** bundle (path/size/sha256);
 *   4. SHA-256 tiap file diperiksa SEBELUM ditulis (tamper/korupsi ketahuan);
 *   5. backup ke disk sebelum menimpa, restore otomatis kalau gagal.
 *
 * Perbaikan dari versi lama: `host[:port]` di-parse (dulu port 80 hardcoded),
 * framing MQTNL di-pin ke JSON, paket yang tiba disaring berdasarkan tipe, dan
 * file baru bisa ditandai executable lewat manifest (dulu hanya path `/bin/*`).
 */
export class Main {
    private lib!: UserLib;
    private cacheDir: string = "/var/cache/tpkg";
    private repoCache: string = "/var/cache/tpkg/repo.json";
    private trustedRepos: string = "/etc/tpkg/trusted_repos";
    private configFile: string = "/etc/tpkg/config.json";
    private statusFile: string = "/var/lib/tpkg/status.json";
    private backupDir: string = "/var/lib/tpkg/backup";
    private maxBackupsPerPkg: number = 3;
    private metrics = { installs: 0, failed: 0, rolledBack: 0, verified: 0, downloads: 0 };

    async execute(lib: UserLib, args: string[]) {
        this.lib = lib;

        if (args.includes("--help") || args.includes("-h")) {
            await this.showHelp();
            return;
        }

        // Handle --set-repo
        const setRepoIdx = args.indexOf("--set-repo");
        if (setRepoIdx > -1) {
            const repo = args[setRepoIdx + 1];
            if (repo) {
                try {
                    parseHostPort(repo); // validasi awal, gagal cepat
                } catch (e: any) {
                    await this.lib.std.print(`❌ ${e.message}\n`);
                    return;
                }
                await this.saveConfig({ defaultRepo: repo });
                await this.lib.std.print(`✅ Default repository set to: ${repo}\n`);
                return;
            }
        }

        const cmd = args[0];

        if (!cmd || cmd === "help") {
            await this.showHelp();
            return;
        }

        await this.ensureCache();

        // Security Check: Enforce root for mutations
        const who = await this.lib.shell.whoami();
        const rootRequired = ["install", "update", "rollback"];
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
            case "download":
                await this.doDownload(args[1], args);
                break;
            case "info":
                await this.doInfo(args[1], args);
                break;
            case "verify":
                await this.doVerify(args[1], args);
                break;
            case "rollback":
                await this.doRollback(args[1]);
                break;
            case "metrics":
                await this.showMetrics();
                break;
            default:
                await this.lib.std.print(`Unknown command: ${cmd}\n`);
                await this.showHelp();
        }
    }

    private async showHelp() {
        await this.lib.std.print("\x1b[1mTPKG - TSIX Package Manager\x1b[0m\n");
        await this.lib.std.print("Usage:\n");
        await this.lib.std.print("  tpkg update [host]                 - Update package catalog from host\n");
        await this.lib.std.print("  tpkg list                          - List available packages\n");
        await this.lib.std.print("  tpkg info <pkg> [--from <host>]    - Show detailed package information\n");
        await this.lib.std.print("  tpkg install <pkg> [--from <host>] - Install a package (verify + backup + rollback)\n");
        await this.lib.std.print("  tpkg download <pkg> [--from <host>] - Fetch & verify without installing\n");
        await this.lib.std.print("  tpkg verify <pkg> [--from <host>]  - Verify signature of a package\n");
        await this.lib.std.print("  tpkg rollback <pkg>                - Restore the last backup of a package\n");
        await this.lib.std.print("  tpkg metrics                       - Show statistics\n");
        await this.lib.std.print("  tpkg --set-repo <host[:port]>      - Set default repository\n");
    }

    private async showMetrics() {
        await this.lib.std.print("\n\x1b[1;34mTPKG Metrics:\x1b[0m\n");
        await this.lib.std.print("------------------------------------------\n");
        await this.lib.std.print(`Installations:  ${this.metrics.installs}\n`);
        await this.lib.std.print(`Failed:         ${this.metrics.failed}\n`);
        await this.lib.std.print(`Rolled back:    ${this.metrics.rolledBack}\n`);
        await this.lib.std.print(`Downloads:      ${this.metrics.downloads}\n`);
        await this.lib.std.print(`Verifications:  ${this.metrics.verified}\n`);
        await this.lib.std.print("------------------------------------------\n");
    }

    /**
     * resolveRepo(): Tentukan host tujuan dari `--from` atau config default.
     * Mengembalikan string spec (boleh `host:port`) atau null (sudah di-print).
     */
    private async resolveRepo(args: string[] | undefined, pkgName?: string): Promise<string | null> {
        const list = args ?? [];
        const fromIdx = list.indexOf("--from");
        let host = fromIdx > -1 ? list[fromIdx + 1] : null;

        if (!host) {
            const config = await this.loadConfig();
            host = config.defaultRepo;
        }

        if (!host) {
            await this.lib.std.print(
                `Usage: tpkg ${list[0] ?? ""}${pkgName ? ` ${pkgName}` : ""} --from <host[:port]> (default port ${TPKG_DEFAULT_PORT}; or set with --set-repo)\n`,
            );
            return null;
        }
        return host;
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

        const { fd, agent, publicKey: repoPubKey } = session;

        try {
            await this.lib.net.sendto(
                fd,
                session.address,
                session.port,
                agent.securePacketOut(JSON.stringify({ type: "LIST" })),
            );
            const data = await this.recvExpect(fd, ["LIST_REPLY", "ERROR"], 5000, {
                from: session.address,
                agent,
            });

            if (!data) {
                await this.lib.std.print("❌ Timeout waiting for server response.\n");
                return;
            }
            if (data.type === "ERROR") {
                await this.lib.std.print(`❌ Server: ${data.message}\n`);
                return;
            }

            // Signature server atas daftar paket.
            const isValid = SecurityAgent.verify(repoPubKey, JSON.stringify(data.packages), data.signature);
            if (!isValid) {
                await this.lib.std.print("❌ ERROR: Repository signature verification failed! Data may be tampered.\n");
                return;
            }

            await this.lib.fs.writeFile(this.repoCache, JSON.stringify(data.packages, null, 2));
            await this.lib.std.print(
                `Successfully updated. ${data.packages.length} packages available. (Verified)\n`,
            );
        } finally {
            await this.lib.net.close(fd).catch(() => {});
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

    private async doInstall(pkgName: string | undefined, args: string[]) {
        const force = (args ?? []).includes("--force");
        const host = await this.resolveRepo(args, pkgName);
        if (!host) return;
        if (!pkgName) {
            await this.lib.std.print("Usage: tpkg install <pkg> --from <host[:port]>\n");
            return;
        }

        // --- VERSION CHECK (katalog lokal dari `tpkg update`) ---
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

        if (localVer && !force) {
            const cmp = compareVersions(localVer, remotePkg.version);
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

        try {
            const reply = await this.fetchBundleWithRetry(session, pkgName);
            if (!reply) return;
            if (reply.type === "ERROR") {
                await this.printServerError(reply);
                return;
            }

            const files = await this.verifyBundle(session.publicKey, reply);
            if (!files) return;

            const done = await this.installBundle(pkgName, reply, files, localStatus);
            if (!done) return;

            if (reply.needReboot) {
                await this.lib.std.print("\x1b[1;33m⚠️  REBOOT REQUIRED: Run 'reboot' to apply system changes.\x1b[0m\n");
            }
        } finally {
            await this.lib.net.close(session.fd).catch(() => {});
        }
    }

    /**
     * doDownload(): Ambil + verifikasi bundle, simpan sebagai arsip di cache,
     * TANPA memasang apa pun dan TANPA menjalankan post-install.
     *
     * (Versi lama `tsd download` justru memanggil jalur install sehingga
     * post-install tetap jalan — di sini sengaja hanya mengunduh.)
     */
    private async doDownload(pkgName: string | undefined, args: string[]) {
        const host = await this.resolveRepo(args, pkgName);
        if (!host) return;
        if (!pkgName) {
            await this.lib.std.print("Usage: tpkg download <pkg> --from <host[:port]>\n");
            return;
        }

        await this.lib.std.print(`Downloading \x1b[1m${pkgName}\x1b[0m from \x1b[1m${host}\x1b[0m (no install)...\n`);
        const session = await this.establishSecureSession(host);
        if (!session) return;

        try {
            const reply = await this.fetchBundleWithRetry(session, pkgName);
            if (!reply) return;
            if (reply.type === "ERROR") {
                await this.printServerError(reply);
                return;
            }

            const files = await this.verifyBundle(session.publicKey, reply);
            if (!files) return;

            const dir = `${this.cacheDir}/bundles/${reply.name}/${reply.version}`;
            for (const file of files) {
                const dest = `${dir}/files${file.path}`;
                const parent = dest.substring(0, dest.lastIndexOf("/"));
                if (parent) await this.mkdirRecursive(parent);
                await this.lib.fs.writeFile(dest, file.content);
            }
            await this.lib.fs.writeFile(
                `${dir}/index.json`,
                JSON.stringify({ name: reply.name, version: reply.version, files: bundleDigest(files) }, null, 2),
            );

            this.metrics.downloads++;
            await this.lib.std.print(`✅ Disimpan (terverifikasi) di ${dir}\n`);
        } finally {
            await this.lib.net.close(session.fd).catch(() => {});
        }
    }

    /**
     * doVerify(): Periksa signature + integritas paket tanpa memasangnya.
     * Berguna sebelum `install` di node penting.
     */
    private async doVerify(pkgName: string | undefined, args: string[]) {
        const host = await this.resolveRepo(args, pkgName);
        if (!host) return;
        if (!pkgName) {
            await this.lib.std.print("Usage: tpkg verify <pkg> --from <host[:port]>\n");
            return;
        }

        await this.lib.std.print(`Verifying \x1b[1m${pkgName}\x1b[0m from \x1b[1m${host}\x1b[0m...\n`);
        const session = await this.establishSecureSession(host);
        if (!session) return;

        try {
            const reply = await this.fetchBundleWithRetry(session, pkgName);
            if (!reply) return;
            if (reply.type === "ERROR") {
                await this.printServerError(reply);
                return;
            }

            const files = await this.verifyBundle(session.publicKey, reply);
            if (files) {
                await this.lib.std.print(`✅ Signature & integrity OK — ${files.length} file.\n`);
            } else {
                await this.lib.std.print("❌ Verifikasi GAGAL.\n");
            }
        } finally {
            await this.lib.net.close(session.fd).catch(() => {});
        }
    }

    /**
     * doRollback(): Pulihkan file paket dari backup terakhir di disk.
     * Backup ditulis `backupFiles()` SEBELUM instalasi — jadi rollback tetap
     * bisa dilakukan setelah reboot/proses mati (dulu backup hanya di memori).
     */
    private async doRollback(pkgName: string | undefined) {
        if (!pkgName) {
            await this.lib.std.print("Usage: tpkg rollback <pkg>\n");
            return;
        }

        const stamps = await this.listBackups(pkgName);
        if (stamps.length === 0) {
            await this.lib.std.print(`❌ Tidak ada backup untuk '${pkgName}'.\n`);
            return;
        }

        const index = await this.loadBackupIndex(pkgName, stamps[0]);
        if (!index) {
            await this.lib.std.print(`❌ Backup ${pkgName}/${stamps[0]} rusak (index.json tidak terbaca).\n`);
            return;
        }

        await this.lib.std.print(
            `Rolling back \x1b[1m${pkgName}\x1b[0m ke backup ${new Date(index.createdAt).toISOString()}...\n`,
        );
        await this.restoreBackup(index);
        await this.runUndoScript(index.undoScript);
        this.metrics.rolledBack++;

        const status = await this.loadStatus();
        delete status[pkgName];
        await this.saveStatus(status);
    }

    private async printServerError(reply: any) {
        await this.lib.std.print(`❌ Server Error: ${reply.message}\n`);
        if (reply.suggestions && reply.suggestions.length > 0) {
            await this.lib.std.print(`💡 Did you mean: \x1b[1;36m${reply.suggestions.join(", ")}\x1b[0m ?\n`);
        }
    }

    /** fetchBundle(): GET_BUNDLE sekali jalan (tanpa retry). */
    private async fetchBundle(session: any, pkgName: string): Promise<any | null> {
        await this.lib.net.sendto(
            session.fd,
            session.address,
            session.port,
            session.agent.securePacketOut(JSON.stringify({ type: "GET_BUNDLE", name: pkgName })),
        );
        // Timeout longgar: bundle besar butuh waktu kirim (banyak fragmen MQTNL).
        return await this.recvExpect(session.fd, ["BUNDLE_REPLY", "ERROR"], 20000, {
            from: session.address,
            agent: session.agent,
        });
    }

    /** fetchBundleWithRetry(): ulangi pengambilan bundle dengan backoff. */
    private async fetchBundleWithRetry(session: any, pkgName: string): Promise<any | null> {
        try {
            return await this.withRetry(
                async () => {
                    const reply = await this.fetchBundle(session, pkgName);
                    if (!reply) throw new Error("timeout menunggu bundle");
                    return reply;
                },
                3,
                1000,
                "ambil bundle",
            );
        } catch (e: any) {
            await this.lib.std.print(`❌ ${e.message}\n`);
            return null;
        }
    }

    /**
     * verifyBundle(): dua lapis pemeriksaan sebelum satu byte pun ditulis.
     *
     * 1. SIGNATURE server atas metadata bundle (path/size/sha256) — mendeteksi
     *    paket yang diubah orang lain;
     * 2. SHA-256 tiap file — mendeteksi korupsi transport/konten terpotong.
     */
    private async verifyBundle(repoPubKey: string, data: any): Promise<TpkgBundleFile[] | null> {
        const files: TpkgBundleFile[] = Array.isArray(data?.files) ? data.files : [];

        if (!SecurityAgent.verify(repoPubKey, bundleDigest(files), data?.signature)) {
            await this.lib.std.print("❌ ERROR: Bundle signature verification failed! Package may be tampered.\n");
            return null;
        }

        const check = verifyBundleFiles(files);
        if (!check.ok) {
            await this.lib.std.print(`❌ ERROR: Integrity check failed — ${check.error}\n`);
            return null;
        }

        this.metrics.verified++;
        const total = files.reduce((sum, f) => sum + f.size, 0);
        await this.lib.std.print(
            `Received bundle: ${data.name} v${data.version} — ${files.length} file, ${formatBytes(total)} (Verified)\n`,
        );
        return files;
    }

    /**
     * installBundle(): Tulis file + set mode + catat versi, dengan backup di
     * depan dan rollback otomatis kalau ada yang gagal.
     *
     * Semua file sudah diverifikasi sebelum fungsi ini dipanggil.
     */
    private async installBundle(
        pkgName: string,
        data: any,
        files: TpkgBundleFile[],
        localStatus: Record<string, string>,
    ): Promise<boolean> {
        const backup = await this.backupFiles(pkgName, data.version, files, data.undoScript);
        if (!backup) return false; // gagal backup → jangan menyentuh apa pun

        try {
            for (const file of files) {
                const dir = file.path.substring(0, file.path.lastIndexOf("/"));
                if (dir) await this.mkdirRecursive(dir);

                await this.lib.fs.writeFile(file.path, file.content);

                // Mode: `permissions`/`isExecutable` dari manifest menang; path
                // `/bin/*` tetap dianggap executable demi repo lama. Inilah yang
                // memperbaiki paket dengan skrip baru di luar /bin (dulu +x hilang
                // sehingga post-install gagal 126).
                const mode = resolveMode(file);
                if (mode !== undefined) await this.lib.fs.chmod(file.path, mode);

                const tag = mode !== undefined ? `, mode ${mode.toString(8)}` : "";
                await this.lib.std.print(`  -> ${file.path} (${formatBytes(file.size)}${tag})\n`);
            }
        } catch (e: any) {
            await this.lib.std.print(`❌ Gagal menulis: ${e.message}\n`);
            await this.restoreBackup(backup);
            this.metrics.failed++;
            return false;
        }

        localStatus[pkgName] = data.version;
        await this.saveStatus(localStatus);
        this.metrics.installs++;

        await this.runPostInstall(pkgName, data, backup);
        await this.pruneBackups(pkgName);
        return true;
    }

    /** runPostInstall(): jalankan `onAfter`, tawarkan rollback bila gagal. */
    private async runPostInstall(pkgName: string, data: any, backup: BackupIndex) {
        if (!data.onAfter) {
            await this.lib.std.print("✅ Installation successful.\n");
            return;
        }

        await this.lib.std.print(`\n✅ Package installed. Post-install script: \x1b[1;36m${data.onAfter}\x1b[0m\n`);
        const confirm = await this.lib.std.read("Run post-install script now? [Y/n]: ");
        if (confirm.toLowerCase().trim() === "n") {
            await this.lib.std.print(`Skipping post-install. You can run it manually: ${data.onAfter}\n`);
            return;
        }

        await this.lib.std.print(`Running ${data.onAfter}...\n`);
        try {
            const proc = await this.lib.shell.exec(data.onAfter, []);
            const exitCode = await this.lib.shell.waitpid(proc.pid);
            if (exitCode === 0) {
                await this.lib.std.print("✅ Post-install finished.\n");
                return;
            }
            await this.lib.std.print(`⚠️  Post-install exit code ${exitCode}\n`);
        } catch (e: any) {
            await this.lib.std.print(`❌ Post-install failed: ${e.message}\n`);
        }

        const rollback = await this.lib.std.read("Rollback installation? [y/N]: ");
        if (rollback.toLowerCase().trim() === "y") {
            await this.runUndoScript(data.undoScript);
            await this.restoreBackup(backup);
            this.metrics.rolledBack++;
        }
    }

    /** runUndoScript(): jalankan `undoScript` manifest kalau ada. */
    private async runUndoScript(script?: string) {
        if (!script) return;
        await this.lib.std.print(`Running undo script: ${script}\n`);
        try {
            const proc = await this.lib.shell.exec(script, []);
            await this.lib.shell.waitpid(proc.pid);
        } catch (e: any) {
            await this.lib.std.print(`⚠️  Undo script failed: ${e.message}\n`);
        }
    }

    /**
     * backupFiles(): Simpan isi file yang AKAN DITIMPA ke disk.
     *
     * Berbeda dari implementasi lama (backup hanya di memori → hilang kalau
     * proses/daemon mati), hasilnya ditulis ke
     * `/var/lib/tpkg/backup/<pkg>/<timestamp>/` + `index.json`, sehingga
     * `tpkg rollback` bisa memulihkan kapan pun.
     *
     * Return null kalau backup gagal — pemanggil WAJIB membatalkan instalasi.
     */
    private async backupFiles(
        pkgName: string,
        version: string,
        files: TpkgBundleFile[],
        undoScript?: string,
    ): Promise<BackupIndex | null> {
        const createdAt = Date.now();
        const dir = `${this.backupDir}/${pkgName}/${createdAt}`;
        const index: BackupIndex = {
            package: pkgName,
            version,
            createdAt,
            ...(undoScript ? { undoScript } : {}),
            entries: [],
        };

        try {
            await this.mkdirRecursive(dir);
            let seq = 0;

            for (const file of files) {
                const existing = await this.lib.fs.readFile(file.path);
                if (existing === null || existing === undefined) {
                    index.entries.push({ path: file.path, existed: false });
                    continue;
                }
                seq++;
                const name = `${String(seq).padStart(4, "0")}.bin`;
                await this.lib.fs.writeFile(`${dir}/${name}`, existing);
                index.entries.push({ path: file.path, existed: true, backup: name });
            }

            await this.lib.fs.writeFile(`${dir}/index.json`, JSON.stringify(index, null, 2));
            return index;
        } catch (e: any) {
            await this.lib.std.print(`❌ Backup gagal (${e.message}) — instalasi dibatalkan.\n`);
            return null;
        }
    }

    /** restoreBackup(): Kembalikan file ke kondisi sebelum instalasi. */
    private async restoreBackup(backup: BackupIndex | null): Promise<boolean> {
        if (!backup) return false;
        const dir = `${this.backupDir}/${backup.package}/${backup.createdAt}`;
        let restored = 0;
        let removed = 0;

        for (const entry of backup.entries) {
            try {
                if (entry.existed && entry.backup) {
                    const content = await this.lib.fs.readFile(`${dir}/${entry.backup}`);
                    if (content === null || content === undefined) continue;
                    await this.lib.fs.writeFile(entry.path, content);
                    restored++;
                } else {
                    // File baru dari paket ini → hapus, jangan tinggalkan sampah.
                    await this.lib.fs.unlink(entry.path);
                    removed++;
                }
            } catch (e: any) {
                await this.lib.std.print(`⚠️  Gagal memulihkan ${entry.path}: ${e.message}\n`);
            }
        }

        await this.lib.std.print(`✅ Rollback selesai (${restored} dipulihkan, ${removed} dihapus).\n`);
        return true;
    }

    /** listBackups(): Nama folder backup paket, terbaru lebih dulu. */
    private async listBackups(pkgName: string): Promise<string[]> {
        try {
            const items = await this.lib.fs.ls(`${this.backupDir}/${pkgName}`);
            return (items ?? [])
                .filter((i: any) => i.type === "DIRECTORY")
                .map((i: any) => String(i.name))
                .sort()
                .reverse();
        } catch (e) {
            return [];
        }
    }

    private async loadBackupIndex(pkgName: string, stamp: string): Promise<BackupIndex | null> {
        const content = await this.lib.fs.readFile(`${this.backupDir}/${pkgName}/${stamp}/index.json`);
        if (!content) return null;
        try {
            return JSON.parse(content) as BackupIndex;
        } catch (e) {
            return null;
        }
    }

    /** pruneBackups(): sisakan `maxBackupsPerPkg` backup terbaru per paket. */
    private async pruneBackups(pkgName: string) {
        const stamps = await this.listBackups(pkgName);
        for (const old of stamps.slice(this.maxBackupsPerPkg)) {
            await this.removeTree(`${this.backupDir}/${pkgName}/${old}`);
        }
    }

    private async removeTree(dir: string) {
        try {
            const items = await this.lib.fs.ls(dir);
            for (const item of items ?? []) {
                const child = `${dir}/${item.name}`;
                if (item.type === "DIRECTORY") await this.removeTree(child);
                else await this.lib.fs.unlink(child);
            }
            await this.lib.fs.rmdir(dir);
        } catch (e) {
            /* biarkan — pruning bersifat best-effort */
        }
    }

    private async doInfo(pkgName: string, args: string[]) {
        const host = await this.resolveRepo(args, pkgName);
        if (!host) return;
        if (!pkgName) {
            await this.lib.std.print("Usage: tpkg info <pkg> [--from <host[:port]>]\n");
            return;
        }

        await this.lib.std.print(`Fetching info for \x1b[1m${pkgName}\x1b[0m from \x1b[1m${host}\x1b[0m...\n`);
        const session = await this.establishSecureSession(host);
        if (!session) return;

        const { fd, agent, publicKey: repoPubKey } = session;

        try {
            await this.lib.net.sendto(
                fd,
                session.address,
                session.port,
                agent.securePacketOut(JSON.stringify({ type: "INFO", name: pkgName })),
            );
            const data = await this.recvExpect(fd, ["INFO_REPLY", "ERROR"], 5000, {
                from: session.address,
                agent,
            });

            if (!data) {
                await this.lib.std.print("❌ Timeout waiting for server response.\n");
                return;
            }
            if (data.type === "ERROR") {
                await this.lib.std.print(`❌ Server Error: ${data.message}\n`);
                if (data.suggestions && data.suggestions.length > 0) {
                    await this.lib.std.print(`💡 Did you mean: \x1b[1;36m${data.suggestions.join(", ")}\x1b[0m ?\n`);
                }
                return;
            }

            const pkg = data.package;
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
            if (pkg.undoScript) {
                await this.lib.std.print(`\x1b[1mUndo Script:\x1b[0m  ${pkg.undoScript}\n`);
            }

            await this.lib.std.print(`\n\x1b[1mFiles:\x1b[0m\n`);
            for (const item of pkg.items ?? []) {
                const mode = item.isExecutable ? " [exec]" : "";
                await this.lib.std.print(`  - [SRC] ${String(item.src).padEnd(30)} -> [DST] ${item.dst}${mode}\n`);
            }
            await this.lib.std.print(`--------------------------------------------------\n`);
        } finally {
            await this.lib.net.close(fd).catch(() => {});
        }
    }

    /**
     * establishSecureSession(): Handshake penuh ke repository.
     *
     * `host` boleh `node` atau `node:port` (default `TPKG_DEFAULT_PORT`).
     * Return `{ fd, address, port, publicKey, agent }` atau null (sudah di-print).
     *
     * Perbaikan penting: alamat + port di-parse (dulu port 80 di-hardcode dan
     * spec mentah dipakai sebagai alamat), dan protocol port lokal di-pin ke
     * JSON supaya framing tidak ikut berubah karena trafik aplikasi lain.
     */
    private async establishSecureSession(host: string): Promise<any> {
        let target: TpkgHostPort;
        try {
            target = parseHostPort(host);
        } catch (e: any) {
            await this.lib.std.print(`❌ ${e.message}\n`);
            return null;
        }

        const fd = await this.lib.net.socket();
        if (fd < 0) return null;

        const bound = await this.lib.net.bind(fd, 0); // port ephemeral
        if (!bound) {
            await this.lib.net.close(fd).catch(() => {});
            return null;
        }

        await this.lib.net.ioctl(fd, SMQTNL_IOCTL.SET_BINARY_MODE, {
            port: bound,
            protocol: "JSON",
        });

        const pair = SecurityAgent.generateKeyPair();

        await this.lib.net.sendto(
            fd,
            target.address,
            target.port,
            JSON.stringify({
                type: "handshake",
                publicKey: pair.publicKey,
                clientVersion: TPKG_PROTOCOL_VERSION,
            }),
        );

        const ack = await this.recvExpect(fd, ["handshake_ack"], 5000, { from: target.address });
        if (!ack) {
            await this.lib.std.print(`❌ Host ${target.address}:${target.port} tidak merespons handshake.\n`);
            await this.lib.net.close(fd).catch(() => {});
            return null;
        }

        if (!ack.sessionKey || !ack.publicKey) {
            await this.lib.std.print("❌ Handshake gagal (balasan tidak lengkap).\n");
            await this.lib.net.close(fd).catch(() => {});
            return null;
        }

        const fp = ack.fingerprint;
        if (!(await this.isTrusted(fp))) {
            await this.lib.std.print(`\x1b[1;33m⚠️  WARNING: Unknown Repository Fingerprint: ${fp}\x1b[0m\n`);
            const confirm = await this.lib.std.read("Accept and proceed? [y/N]: ");
            if (confirm.toLowerCase().trim() !== "y") {
                await this.lib.net.close(fd).catch(() => {});
                return null;
            }
            await this.addTrusted(fp);
        }

        const sessionKey = SecurityAgent.decryptWithPrivateKey(pair.privateKey, ack.sessionKey);
        const agent = new SecurityAgent();
        agent.setSessionKey(sessionKey);

        return { fd, address: target.address, port: target.port, publicKey: ack.publicKey, agent };
    }

    /**
     * recvExpect(): Tunggu paket dengan `type` yang DIHARAPKAN.
     *
     * Versi lama mengambil paket PERTAMA yang tiba apa pun isinya — satu paket
     * nyasar (ping, gema, balasan basi) membuat `JSON.parse` gagal dan dilaporkan
     * sebagai "malformed response" padahal server sehat. Paket yang tidak relevan
     * dibuang; `opts.agent` dipakai untuk mendekripsi balasan yang tersandi.
     */
    private async recvExpect(
        fd: number,
        expected: string[],
        timeoutMs: number,
        opts: { from?: string; agent?: SecurityAgent } = {},
    ): Promise<any | null> {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const packet = await this.lib.net.recv(fd);
            if (!packet) {
                await new Promise((r) => setTimeout(r, 50));
                continue;
            }
            if (opts.from && packet.src && packet.src !== opts.from) continue;

            const raw = typeof packet.data === "string" ? packet.data : "";
            if (!raw) continue;

            let text = raw;
            if (opts.agent) {
                try {
                    text = opts.agent.securePacketIn(raw);
                } catch (e) {
                    continue;
                }
                if (!text) continue;
            }

            try {
                const body = JSON.parse(text);
                if (body && typeof body.type === "string" && expected.includes(body.type)) {
                    return body;
                }
            } catch (e) {
                /* bukan JSON yang kita tunggu — coba paket berikutnya */
            }
        }
        return null;
    }

    /**
     * withRetry(): Ulangi operasi dengan backoff eksponensial.
     * Diambil dari `tsd` (satu-satunya fitur di sana yang memang bekerja) —
     * jaringan MQTNL bisa kehilangan paket QoS 0, dan satu kegagalan sementara
     * tidak seharusnya memaksa operator mengulang seluruh instalasi.
     */
    private async withRetry<T>(
        fn: () => Promise<T>,
        attempts: number = 3,
        baseMs: number = 1000,
        label: string = "operasi",
    ): Promise<T> {
        let lastErr: any;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                return await fn();
            } catch (e: any) {
                lastErr = e;
                if (attempt === attempts) break;
                const wait = baseMs * Math.pow(2, attempt - 1);
                await this.lib.std.print(
                    `⏳ ${label} gagal (${e.message}) — ulang dalam ${wait}ms (${attempt}/${attempts})\n`,
                );
                await new Promise((r) => setTimeout(r, wait));
            }
        }
        throw lastErr;
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
        if (!await this.exists(this.statusFile)) return {};
        const content = await this.lib.fs.readFile(this.statusFile);
        try {
            return JSON.parse(content || "{}");
        } catch (e) {
            return {};
        }
    }

    private async saveStatus(status: Record<string, string>) {
        const dir = this.statusFile.substring(0, this.statusFile.lastIndexOf("/"));
        if (dir) await this.mkdirRecursive(dir);
        await this.lib.fs.writeFile(this.statusFile, JSON.stringify(status, null, 2));
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
