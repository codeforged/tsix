import { UserLib } from "../lib/UserLib";
import { SecurityAgent } from "@common/SecurityAgent";
import { SMQTNL_IOCTL } from "../lib/NetworkLib";
import { utf8ToVfsBytes, vfsBytesToUtf8 } from "@common/VfsText";
import {
    TPKG_DEFAULT_PORT,
    TPKG_PROTOCOL_VERSION,
    binaryPath,
    bundleDigest,
    bundleSignatureDigest,
    compareVersions,
    formatBytes,
    isBinaryCandidate,
    isSafeHostDst,
    parseDependency,
    parseHostPort,
    planInstall,
    resolveMode,
    sha256Hex,
    verifyBundleFiles,
    type TpkgBundleFile,
    type TpkgCatalogEntry,
    type TpkgDependency,
    type TpkgHostPort,
    type TpkgPlanStep,
} from "@tsix/TpkgProtocol";

/**
 * Versi klien tpkg (yang dicetak `tpkg -v`). Naikkan setiap kali perilaku klien
 * berubah. 1.1.0 = dependensi, upgrade, konfirmasi skrip, conffile `/etc`,
 * `rollback` dihapus.
 */
const TPKG_CLIENT_VERSION = "1.1.0";

/** Penanda image (ditulis `twrapper --no-mirror`), gaya /etc/os-release. */
const RELEASE_PATH = "/etc/tsix-release";

/** Bentuk satu entri backup di `/var/lib/tpkg/backup/<pkg>/<ts>/index.json`. */
interface BackupEntry {
    path: string;
    /** true = sudah ada sebelum install → `backup` berisi isinya. */
    existed: boolean;
    /** Nama file di folder backup (relatif), mis. "0001.bin". */
    backup?: string;
    /**
     * Kalau diisi, entri ini juga mewakili file di HOST (relatif root proyek).
     * Item ber-`hostDst` menulis ke DUA tempat (VFS `dst` + host), jadi keduanya
     * harus dibackup — kalau hanya host yang dibackup, kegagalan di tengah jalan
     * meninggalkan VFS sudah versi baru (bug yang ditemukan test P2.14).
     */
    hostPath?: string;
    /** true = file host sudah ada sebelum install → `hostBackup` berisi isinya. */
    hostExisted?: boolean;
    hostBackup?: string;
}

interface BackupIndex {
    package: string;
    version: string;
    createdAt: number;
    entries: BackupEntry[];
}

/**
 * Satu file yang DITULIS oleh sebuah paket saat instalasi.
 *
 * `sha256` adalah hash isi yang kita tulis (byte latin1). Dipakai `tpkg remove`
 * untuk mendeteksi apakah file — terutama berkas konfigurasi — sudah diubah
 * pengguna sejak dipasang. Kalau berubah, penghapusan dikonfirmasi lebih dulu.
 */
interface InstalledFile {
    path: string;
    sha256: string;
    /** Kalau ada, file ini juga dicerminkan ke HOST FS (relatif root proyek). */
    hostDst?: string;
    hostSha256?: string;
}

/** Manifest file terpasang: `/var/lib/tpkg/installed/<pkg>.json`. */
interface InstalledManifest {
    package: string;
    version: string;
    installedAt: number;
    /** Skrip `undoScript` paket — dijalankan (dengan konfirmasi) saat `tpkg remove`. */
    undoScript?: string;
    files: InstalledFile[];
}

/** Opsi baris perintah yang berlaku untuk semua subcommand. */
interface CliOptions {
    /** Nama paket (argumen posisi setelah subcommand). */
    names: string[];
    /** `--from <host[:port]>`. */
    from?: string;
    /** `--force`: pasang ulang walau versi lokal sama/lebih baru. */
    force: boolean;
    /** `-y` / `--yes`: jawab "ya" untuk konfirmasi biasa (BUKAN fingerprint & tulis-host). */
    yes: boolean;
    /** `--no-scripts`: jangan jalankan post-install / undo script. */
    noScripts: boolean;
    /** `--no-deps`: abaikan `depends`. */
    noDeps: boolean;
    /** `--source`: minta varian source (`.ts`) alih-alih binary (`.js`). */
    source: boolean;
    /** `--installed` (untuk `list`). */
    installed: boolean;
}

/**
 * Ekstensi yang dianggap berkas konfigurasi. Untuk berkas seperti ini,
 * `tpkg remove` SELALU meminta konfirmasi (dan menyoroti bila sudah diubah).
 */
const CONFIG_EXTENSIONS = [
    ".conf",
    ".cfg",
    ".cnf",
    ".ini",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".env",
    ".properties",
    ".xml",
];

/**
 * TPKG — TSIX Package Manager (klien)
 *
 * Ambil paket dari repository MQTNL (`tpkgd`) lalu pasang ke VFS dengan
 * verifikasi + backup + pemulihan otomatis bila penulisan gagal.
 *
 * Ikhtisar pengamanan berlapis:
 *   1. handshake RSA → session key ChaCha20 (transport terenkripsi);
 *   2. fingerprint kunci repo (dihitung klien, SHA-256) disimpan per host di
 *      `/etc/tpkg/trusted_repos` (TOFU, format `<host> <fp>`); kunci berubah → tolak;
 *   3. signature server atas **metadata** bundle (path/hostDst/size/sha256);
 *   4. SHA-256 tiap file diperiksa SEBELUM ditulis (tamper/korupsi ketahuan);
 *   5. backup ke disk sebelum menimpa, restore otomatis kalau penulisan gagal;
 *   6. paket yang menyentuh HOST FS (kernel & komponennya) WAJIB root dan
 *      dikonfirmasi eksplisit sebelum satu byte pun ditulis ke luar VFS;
 *   7. skrip post-install/undo TIDAK dijalankan tanpa persetujuan operator
 *      (skrip dari paket bisa saja jahat) — `--yes` / `--no-scripts` untuk otomasi.
 *
 * Semua perintah yang mengubah sistem (update/install/upgrade/remove/download)
 * menolak dijalankan sebagai non-root. Itu bukan sekadar sopan santun:
 * `SYNC_TO_HOST` di kernel juga menolak non-root, jadi paket ber-`hostDst` akan
 * gagal di tengah jalan kalau gerbang ini dilewati.
 *
 * `tpkg rollback` sengaja DIHAPUS: rollback hanya memulihkan `.ts`, sementara
 * sidecar `.js` hasil transpile versi baru tetap tinggal dan (karena `EXEC`
 * mendahulukan `.js`) tetap dijalankan — pemulihan yang menipu. Untuk melepas
 * paket pakai `tpkg remove`. Backup tetap dibuat untuk memulihkan instalasi
 * yang gagal di tengah penulisan (sebelum ada sidecar baru).
 */
export class Main {
    private lib!: UserLib;
    private cacheDir: string = "/var/cache/tpkg";
    private repoCache: string = "/var/cache/tpkg/repo.json";
    private trustedRepos: string = "/etc/tpkg/trusted_repos";
    private configFile: string = "/etc/tpkg/config.json";
    private statusFile: string = "/var/lib/tpkg/status.json";
    private backupDir: string = "/var/lib/tpkg/backup";
    /** Manifest file yang ditulis tiap paket — dasar `tpkg remove`. */
    private installedDir: string = "/var/lib/tpkg/installed";
    /**
     * Staging VFS untuk file host. `SYNC_TO_HOST` membaca isi dari VFS, jadi
     * file kernel harus mendarat di suatu path VFS dulu — pakai /tmp (ramfs)
     * supaya tidak meninggalkan jejak di root filesystem.
     */
    private hostStageDir: string = "/tmp/tpkg-stage";
    /**
     * Backup hanya dipakai untuk memulihkan instalasi yang gagal ditulis (dan
     * sebagai daftar file cadangan `remove` untuk paket lama) — cukup satu.
     */
    private maxBackupsPerPkg: number = 1;
    private metrics = { installs: 0, failed: 0, restored: 0, verified: 0, downloads: 0 };

    async execute(lib: UserLib, args: string[]) {
        this.lib = lib;

        if (args[0] === "-v" || args[0] === "--version" || args[0] === "version") {
            await this.showVersion();
            return;
        }

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

        // Kernel meng-compile `/lib/*.ts` ke cache HANYA saat boot. Setelah
        // `tpkg install tpkg`/`base-system` (dan transpile), `/sbin/tpkg.js` sudah
        // baru tapi `@tsix/TpkgProtocol` di cache masih versi boot. Beri pesan jelas
        // alih-alih crash `planInstall is not a function` di tengah instalasi.
        if (typeof planInstall !== "function" || typeof parseDependency !== "function") {
            await this.lib.std.print(
                "❌ tpkg was updated, but the running system still uses the old /lib/TpkgProtocol from boot.\n" +
                "   Reboot to load the new framework libraries, then run tpkg again.\n",
            );
            return;
        }

        const opts = this.parseOptions(args.slice(1));

        await this.ensureCache();

        // GERBANG ROOT.
        //
        // Perintah ini mengubah node: menulis ke rootfs (BKFS), ke `/var/lib/tpkg`,
        // dan untuk paket engine ke HOST FS (`syncToHost`). Kernel pun menolak
        // `SYNC_TO_HOST` dari non-root, jadi membiarkan perintah ini jalan sebagai
        // user biasa hanya menghasilkan kegagalan separuh jalan — lebih baik
        // ditolak di depan dengan pesan jelas.
        const who = await this.lib.shell.whoami();
        const rootRequired = ["install", "upgrade", "remove", "update", "download"];
        if (rootRequired.includes(cmd) && who.uid !== 0) {
            await this.lib.std.print(
                `❌ Error: 'tpkg ${cmd}' requires root privileges (modifies the system & may write to the host FS). Use sudo.\n`,
            );
            return;
        }

        switch (cmd) {
            case "update":
                await this.doUpdate(opts.names[0] ?? opts.from);
                break;
            case "list":
                if (opts.installed) await this.doListInstalled();
                else await this.doList();
                break;
            case "install":
                await this.doInstall(opts);
                break;
            case "upgrade":
                await this.doUpgrade(opts);
                break;
            case "remove":
                await this.doRemove(opts);
                break;
            case "download":
                await this.doDownload(opts.names[0], opts);
                break;
            case "info":
                await this.doInfo(opts.names[0], opts);
                break;
            case "verify":
                await this.doVerify(opts.names[0], opts);
                break;
            case "metrics":
                await this.showMetrics();
                break;
            default:
                await this.lib.std.print(`Unknown command: ${cmd}\n`);
                await this.showHelp();
        }
    }

    /** parseOptions(): pisahkan flag global dari nama paket. */
    private parseOptions(rest: string[]): CliOptions {
        const opts: CliOptions = {
            names: [],
            force: false,
            yes: false,
            noScripts: false,
            noDeps: false,
            source: false,
            installed: false,
        };
        for (let i = 0; i < rest.length; i++) {
            const a = rest[i];
            if (a === "--from") opts.from = rest[++i];
            else if (a === "--force") opts.force = true;
            else if (a === "-y" || a === "--yes") opts.yes = true;
            else if (a === "--no-scripts") opts.noScripts = true;
            else if (a === "--no-deps") opts.noDeps = true;
            else if (a === "--source") opts.source = true;
            else if (a === "--installed") opts.installed = true;
            else if (!a.startsWith("-")) opts.names.push(a);
        }
        return opts;
    }

    private async showHelp() {
        const p = (s: string) => this.lib.std.print(s);
        await p("\x1b[1mTPKG - TSIX Package Manager\x1b[0m\n");
        await p("Usage:\n");
        await p("  tpkg update [host]                  - Update package catalog from host\n");
        await p("  tpkg list [--installed]             - List available (or installed) packages\n");
        await p("  tpkg info <pkg> [--from <host>]     - Show detailed package information\n");
        await p("  tpkg install <pkg...> [--from <host>] - Install package(s) and their dependencies\n");
        await p("  tpkg upgrade [pkg...]               - Upgrade installed packages to the catalog version\n");
        await p("  tpkg remove <pkg...>                - Uninstall (asks before removing config files)\n");
        await p("  tpkg download <pkg> [--from <host>] - Fetch & verify without installing\n");
        await p("  tpkg verify <pkg> [--from <host>]   - Verify signature of a package\n");
        await p("  tpkg metrics                        - Show statistics\n");
        await p("  tpkg -v, --version                  - Show the tpkg version\n");
        await p("  tpkg --set-repo <host[:port]>       - Set default repository\n");
        await p("\nOptions:\n");
        await p("  -y, --yes        Answer yes to confirmations (not to repo fingerprint / host FS writes)\n");
        await p("  --no-scripts     Do not run post-install / undo scripts\n");
        await p("  --no-deps        Ignore package dependencies\n");
        await p("  --source         Get TypeScript sources (default: prebuilt .js for end users)\n");
        await p("  --force          Reinstall even if the same or a newer version is installed\n");
        await p(
            "\n⚠️  update/install/upgrade/remove/download require root (sudo): they modify the system,\n" +
            "    and engine packages (e.g. system-update) write to the HOST FS — kernel & lib.\n",
        );
    }

    /**
     * showVersion(): `tpkg -v`. Versi klien = konstanta di file ini (file tpkg
     * dikirim oleh `base-system` DAN `tpkg`, jadi versi paket saja tidak bisa
     * memastikan biner mana yang sedang jalan). Versi paket terpasang dan repo
     * default ditampilkan sebagai konteks.
     */
    private async showVersion() {
        await this.lib.std.print(`tpkg ${TPKG_CLIENT_VERSION} (protocol ${TPKG_PROTOCOL_VERSION})\n`);
        const status = await this.loadStatus().catch(() => ({}) as Record<string, string>);
        const pkgs = ["tpkg", "base-system"].filter((n) => status[n]).map((n) => `${n} ${status[n]}`);
        if (pkgs.length > 0) await this.lib.std.print(`Installed packages: ${pkgs.join(", ")}\n`);
        const config = await this.loadConfig().catch(() => ({}));
        if (config?.defaultRepo) await this.lib.std.print(`Default repository: ${config.defaultRepo}\n`);
        const release = this.parseRelease(await this.readMaybe(RELEASE_PATH));
        if (release.NAME || release.VARIANT) {
            await this.lib.std.print(
                `Image: ${release.NAME ?? "TSIX"}${release.VERSION ? ` ${release.VERSION}` : ""} (${release.VARIANT ?? "development"})\n`,
            );
        }
    }

    private async showMetrics() {
        await this.lib.std.print("\n\x1b[1;34mTPKG Metrics:\x1b[0m\n");
        await this.lib.std.print("------------------------------------------\n");
        await this.lib.std.print(`Installations:  ${this.metrics.installs}\n`);
        await this.lib.std.print(`Failed:         ${this.metrics.failed}\n`);
        await this.lib.std.print(`Restored:       ${this.metrics.restored}\n`);
        await this.lib.std.print(`Downloads:      ${this.metrics.downloads}\n`);
        await this.lib.std.print(`Verifications:  ${this.metrics.verified}\n`);
        await this.lib.std.print("------------------------------------------\n");
    }

    /**
     * confirm(): Pertanyaan ya/tidak. `--yes` menjawab "ya" otomatis (dan
     * mencetaknya, supaya log tetap menunjukkan apa yang disetujui).
     */
    private async confirm(prompt: string, opts: CliOptions, defaultYes: boolean): Promise<boolean> {
        if (opts.yes) {
            await this.lib.std.print(`${prompt}y (--yes)\n`);
            return true;
        }
        const ans = (await this.lib.std.read(prompt)).toLowerCase().trim();
        if (ans === "") return defaultYes;
        return ans === "y" || ans === "yes";
    }

    /**
     * resolveRepo(): Tentukan host tujuan dari `--from` atau config default.
     * Mengembalikan string spec (boleh `host:port`) atau null (sudah di-print).
     */
    private async resolveRepo(cmd: string, opts: CliOptions, pkgName?: string): Promise<string | null> {
        let host = opts.from ?? null;

        if (!host) {
            const config = await this.loadConfig();
            host = config.defaultRepo;
        }

        if (!host) {
            await this.lib.std.print(
                `Usage: tpkg ${cmd}${pkgName ? ` ${pkgName}` : ""} --from <host[:port]> (default port ${TPKG_DEFAULT_PORT}; or set with --set-repo)\n`,
            );
            return null;
        }
        return host;
    }

    private async ensureCache() {
        if (!(await this.exists("/var"))) await this.lib.fs.mkdir("/var");
        if (!(await this.exists("/var/cache"))) await this.lib.fs.mkdir("/var/cache");
        if (!(await this.exists(this.cacheDir))) await this.lib.fs.mkdir(this.cacheDir);
        if (!(await this.exists("/etc/tpkg"))) await this.lib.fs.mkdir("/etc/tpkg");
    }

    private async doUpdate(host: string | undefined) {
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
            await this.lib.std.print(`Successfully updated. ${data.packages.length} packages available. (Verified)\n`);

            const upgradable = this.upgradable(data.packages, await this.loadStatus());
            if (upgradable.length > 0) {
                await this.lib.std.print(
                    `⬆  ${upgradable.length} installed package(s) can be upgraded. Run 'sudo tpkg upgrade'.\n`,
                );
            }
        } finally {
            await this.lib.net.close(fd).catch(() => { });
        }
    }

    private async doList() {
        if (!(await this.exists(this.repoCache))) {
            await this.lib.std.print("No catalog found. Run 'tpkg update <host>' first.\n");
            return;
        }

        const pkgs = await this.loadCatalog();
        const status = await this.loadStatus();

        await this.lib.std.print("\n\x1b[1;34mAvailable Packages:\x1b[0m\n");
        await this.lib.std.print("--------------------------------------------------\n");
        for (const p of pkgs) {
            const local = status[p.name];
            let tag = "";
            if (local) {
                tag =
                    compareVersions(p.version, local) > 0
                        ? `  \x1b[1;33m[installed ${local} → ${p.version} available]\x1b[0m`
                        : "  \x1b[1;32m[installed]\x1b[0m";
            }
            await this.lib.std.print(`\x1b[1m${p.name.padEnd(15)}\x1b[0m v${p.version}${tag}\n`);
            await this.lib.std.print(`  ${p.description ?? ""}\n`);
            if (p.depends?.length) await this.lib.std.print(`  \x1b[2mdepends: ${p.depends.join(", ")}\x1b[0m\n`);
            await this.lib.std.print("\n");
        }
    }

    /** doListInstalled(): paket yang tercatat terpasang + versi katalog. */
    private async doListInstalled() {
        const status = await this.loadStatus();
        const names = Object.keys(status).sort();
        if (names.length === 0) {
            await this.lib.std.print("No packages installed via tpkg.\n");
            return;
        }

        const catalog = new Map((await this.loadCatalog()).map((p) => [p.name, p]));
        let upgradable = 0;

        await this.lib.std.print("\n\x1b[1;34mInstalled Packages:\x1b[0m\n");
        await this.lib.std.print("--------------------------------------------------\n");
        for (const name of names) {
            const local = status[name];
            const remote = catalog.get(name)?.version;
            let note = "\x1b[2m(not in catalog)\x1b[0m";
            if (remote) {
                if (compareVersions(remote, local) > 0) {
                    note = `\x1b[1;33m⬆ ${remote} available\x1b[0m`;
                    upgradable++;
                } else {
                    note = "\x1b[2mup to date\x1b[0m";
                }
            }
            await this.lib.std.print(`\x1b[1m${name.padEnd(20)}\x1b[0m ${local.padEnd(10)} ${note}\n`);
        }
        await this.lib.std.print(
            `\n${names.length} installed${upgradable > 0 ? `, ${upgradable} upgradable — run 'sudo tpkg upgrade'` : ""}.\n`,
        );
    }

    /** upgradable(): paket terpasang yang versinya di katalog lebih baru. */
    private upgradable(catalog: TpkgCatalogEntry[], status: Record<string, string>): TpkgCatalogEntry[] {
        return catalog.filter((p) => status[p.name] && compareVersions(p.version, status[p.name]) > 0);
    }

    private async doInstall(opts: CliOptions) {
        const host = await this.resolveRepo("install", opts, opts.names[0]);
        if (!host) return;
        if (opts.names.length === 0) {
            await this.lib.std.print("Usage: tpkg install <pkg...> --from <host[:port]>\n");
            return;
        }

        // --- VERSION CHECK (katalog lokal dari `tpkg update`) ---
        const catalog = await this.loadCatalog();
        const status = await this.loadStatus();
        const names: string[] = [];

        for (const pkgName of opts.names) {
            const remotePkg = catalog.find((p) => p.name === pkgName);
            if (!remotePkg) {
                await this.lib.std.print(
                    `❌ Error: Package '${pkgName}' not found in catalog. Run 'tpkg update' first.\n`,
                );
                const suggestions = this.findSuggestions(
                    pkgName,
                    catalog.map((p) => p.name),
                );
                if (suggestions.length > 0) {
                    await this.lib.std.print(`💡 Did you mean: \x1b[1;36m${suggestions.join(", ")}\x1b[0m ?\n`);
                }
                return;
            }

            const localVer = status[pkgName];
            if (localVer && !opts.force) {
                const cmp = compareVersions(localVer, remotePkg.version);
                if (cmp >= 0) {
                    const msg = cmp === 0 ? "already the same version" : "already newer";
                    await this.lib.std.print(
                        `⚠️  Local version of \x1b[1m${pkgName}\x1b[0m is ${msg} (\x1b[1;36m${localVer}\x1b[0m).\n`,
                    );
                    if (!(await this.confirm("Proceed with installation anyway? [y/N]: ", opts, false))) {
                        await this.lib.std.print(`Skipping ${pkgName}.\n`);
                        continue;
                    }
                }
            }
            names.push(pkgName);
        }

        if (names.length === 0) {
            await this.lib.std.print("Installation aborted.\n");
            return;
        }

        const label = names.map((n) => `\x1b[1m${n}\x1b[0m (v${catalog.find((p) => p.name === n)!.version})`);
        await this.lib.std.print(`Preparing to install ${label.join(", ")} from \x1b[1m${host}\x1b[0m...\n`);

        const session = await this.establishSecureSession(host);
        if (!session) return;
        try {
            const steps = await this.resolvePlan(session, names, catalog, status, opts);
            if (!steps) return;
            await this.installSteps(session, steps, status, opts);
        } finally {
            await this.lib.net.close(session.fd).catch(() => { });
        }
    }

    /**
     * doUpgrade(): pasang versi katalog untuk paket terpasang yang lebih tua.
     * Tanpa argumen → semua paket terpasang; dengan argumen → hanya itu.
     */
    private async doUpgrade(opts: CliOptions) {
        const catalog = await this.loadCatalog();
        if (catalog.length === 0) {
            await this.lib.std.print("No catalog found. Run 'tpkg update <host>' first.\n");
            return;
        }
        const status = await this.loadStatus();

        for (const name of opts.names) {
            if (!status[name]) await this.lib.std.print(`⚠️  '${name}' is not installed — skipping.\n`);
        }

        let candidates = this.upgradable(catalog, status);
        if (opts.names.length > 0) candidates = candidates.filter((p) => opts.names.includes(p.name));

        if (candidates.length === 0) {
            await this.lib.std.print(
                "✅ All packages are up to date (according to the catalog from the last 'tpkg update').\n",
            );
            return;
        }

        await this.lib.std.print(`\n\x1b[1;34mPackages to upgrade:\x1b[0m\n`);
        for (const p of candidates) {
            await this.lib.std.print(`  • ${p.name.padEnd(20)} ${status[p.name]} → \x1b[1;36m${p.version}\x1b[0m\n`);
        }
        await this.lib.std.print("\x1b[2m  (based on the catalog from the last 'tpkg update')\x1b[0m\n");
        if (!(await this.confirm(`\nUpgrade ${candidates.length} package(s)? [Y/n]: `, opts, true))) {
            await this.lib.std.print("Upgrade aborted.\n");
            return;
        }

        const host = await this.resolveRepo("upgrade", opts);
        if (!host) return;

        const session = await this.establishSecureSession(host);
        if (!session) return;
        try {
            const steps = await this.resolvePlan(
                session,
                candidates.map((p) => p.name),
                catalog,
                status,
                opts,
            );
            if (!steps) return;
            await this.installSteps(session, steps, status, opts);
        } finally {
            await this.lib.net.close(session.fd).catch(() => { });
        }
    }

    /**
     * resolvePlan(): susun urutan instalasi + tanyakan dependensi yang kurang.
     *
     * Dependensi dianggap terpenuhi kalau (a) tercatat di status dengan versi
     * cukup, atau (b) semua file-nya sudah ada di disk (node yang dibangun dari
     * image tidak punya `status.json`, tapi emerald dkk. sudah ada) — dicek lewat
     * INFO di session yang sama. Return null kalau operator membatalkan.
     */
    private async resolvePlan(
        session: any,
        names: string[],
        catalog: TpkgCatalogEntry[],
        status: Record<string, string>,
        opts: CliOptions,
    ): Promise<TpkgPlanStep[] | null> {
        const requestedOnly = (): TpkgPlanStep[] =>
            names.map((n) => ({
                name: n,
                version: catalog.find((p) => p.name === n)?.version ?? "?",
                reason: "requested",
            }));
        if (opts.noDeps) return requestedOnly();

        const onDisk = new Set<string>();
        const probed = new Set<string>();
        const satisfied = (dep: TpkgDependency) => {
            const local = status[dep.name];
            if (local) return !dep.minVersion || compareVersions(local, dep.minVersion) >= 0;
            return onDisk.has(dep.name) && !dep.minVersion;
        };

        let plan = planInstall(names, catalog, satisfied);
        for (; ;) {
            const unprobed = plan.steps.filter((s) => s.reason === "dependency" && !probed.has(s.name));
            if (unprobed.length === 0) break;
            let found = false;
            for (const step of unprobed) {
                probed.add(step.name);
                if (!status[step.name] && (await this.isPresentOnDisk(session, step.name))) {
                    onDisk.add(step.name);
                    found = true;
                }
            }
            if (!found) break;
            plan = planInstall(names, catalog, satisfied);
        }

        const deps = plan.steps.filter((s) => s.reason === "dependency");
        if (deps.length === 0 && plan.problems.length === 0) return plan.steps;

        if (deps.length > 0) {
            await this.lib.std.print(`\n\x1b[1;34mAdditional packages required:\x1b[0m\n`);
            for (const d of deps) {
                const local = status[d.name];
                const state = local ? `installed ${local}, needs upgrade` : "not installed";
                await this.lib.std.print(
                    `  • ${d.name.padEnd(20)} v${d.version.padEnd(8)} \x1b[2m(${state}; required by ${d.requiredBy})\x1b[0m\n`,
                );
            }
        }
        for (const p of plan.problems) await this.lib.std.print(`  ⚠️  ${p}\n`);

        if (deps.length === 0) {
            // Hanya masalah yang tidak bisa dipasang otomatis.
            if (await this.confirm("Continue without them? [y/N]: ", opts, false)) return plan.steps;
            await this.lib.std.print("Installation aborted.\n");
            return null;
        }

        if (opts.yes) {
            await this.lib.std.print("Install dependencies? y (--yes)\n");
            return plan.steps;
        }
        const ans = (await this.lib.std.read("Install dependencies? [Y]es / [i]gnore / [a]bort: ")).toLowerCase().trim();
        if (ans === "" || ans === "y" || ans === "yes") return plan.steps;
        if (ans === "i" || ans === "ignore") {
            await this.lib.std.print("⚠️  Ignoring dependencies — the package may not work until they are installed.\n");
            return plan.steps.filter((s) => s.reason === "requested");
        }
        await this.lib.std.print("Installation aborted.\n");
        return null;
    }

    /**
     * isPresentOnDisk(): apakah semua file VFS paket sudah ada (paket dipasang
     * di luar tpkg, mis. dari image). File staging host (`/tmp/…`, `hostDst`)
     * tidak dihitung karena memang tidak menetap di VFS.
     */
    private async isPresentOnDisk(session: any, pkgName: string): Promise<boolean> {
        try {
            await this.lib.net.sendto(
                session.fd,
                session.address,
                session.port,
                session.agent.securePacketOut(JSON.stringify({ type: "INFO", name: pkgName })),
            );
            const data = await this.recvExpect(session.fd, ["INFO_REPLY", "ERROR"], 5000, {
                from: session.address,
                agent: session.agent,
            });
            if (!data || data.type !== "INFO_REPLY") return false;
            if (!SecurityAgent.verify(session.publicKey, JSON.stringify(data.package), data.signature)) return false;

            const paths = (data.package?.items ?? [])
                .filter((i: any) => !i.hostDst && typeof i.dst === "string" && !i.dst.startsWith("/tmp/"))
                .map((i: any) => i.dst as string);
            if (paths.length === 0) return false;
            // Paket bisa terpasang sebagai binary: `x.ts` di manifest = `x.js` di disk.
            for (const p of paths) {
                if (!(await this.exists(p)) && !(await this.exists(binaryPath(p)))) return false;
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    /** installSteps(): pasang rencana secara berurutan; berhenti di kegagalan pertama. */
    private async installSteps(
        session: any,
        steps: TpkgPlanStep[],
        status: Record<string, string>,
        opts: CliOptions,
    ) {
        let needReboot = false;
        /** Paket menulis `/lib/*.ts` → baru dipakai setelah reboot (cache kernel). */
        let libChanged = false;
        let installed = 0;

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (steps.length > 1) {
                await this.lib.std.print(
                    `\n\x1b[1m[${i + 1}/${steps.length}] ${step.name}\x1b[0m (v${step.version})` +
                    `${step.reason === "dependency" ? " \x1b[2m— dependency\x1b[0m" : ""}\n`,
                );
            }

            const reply = await this.fetchBundleWithRetry(session, step.name, opts.source);
            const ok =
                !!reply &&
                reply.type !== "ERROR" &&
                (await (async () => {
                    const verified = await this.verifyBundle(session.publicKey, reply);
                    if (!verified) return false;
                    const files = await this.preparePayload(verified, reply, opts);
                    const done = await this.installBundle(step.name, reply, files, status, opts);
                    if (done && files.some((f) => f.path.startsWith("/lib/") && f.path.endsWith(".ts"))) {
                        libChanged = true;
                    }
                    return done;
                })());

            if (!ok) {
                if (reply?.type === "ERROR") await this.printServerError(reply);
                const rest = steps.slice(i + 1).map((s) => s.name);
                if (rest.length > 0) {
                    await this.lib.std.print(`❌ Stopping: '${step.name}' failed — not installed: ${rest.join(", ")}\n`);
                }
                break;
            }
            installed++;
            if (reply.needReboot) needReboot = true;
        }

        if (steps.length > 1) {
            await this.lib.std.print(`\n${installed === steps.length ? "✅" : "⚠️ "} ${installed}/${steps.length} package(s) installed.\n`);
        }
        if (needReboot) {
            await this.lib.std.print("\x1b[1;33m⚠️  REBOOT REQUIRED: Run 'reboot' to apply system changes.\x1b[0m\n");
        } else if (libChanged) {
            await this.lib.std.print(
                "\x1b[1;33m⚠️  REBOOT REQUIRED: framework libraries in /lib were updated; the kernel loads them at boot.\n" +
                "   Until you reboot, programs keep using the old versions.\x1b[0m\n",
            );
        }
    }

    /**
     * doDownload(): Ambil + verifikasi bundle, simpan sebagai arsip di cache,
     * TANPA memasang apa pun dan TANPA menjalankan post-install.
     *
     * (Versi lama `tsd download` justru memanggil jalur install sehingga
     * post-install tetap jalan — di sini sengaja hanya mengunduh.)
     */
    private async doDownload(pkgName: string | undefined, opts: CliOptions) {
        const host = await this.resolveRepo("download", opts, pkgName);
        if (!host) return;
        if (!pkgName) {
            await this.lib.std.print("Usage: tpkg download <pkg> --from <host[:port]>\n");
            return;
        }

        await this.lib.std.print(`Downloading \x1b[1m${pkgName}\x1b[0m from \x1b[1m${host}\x1b[0m (no install)...\n`);
        const session = await this.establishSecureSession(host);
        if (!session) return;

        try {
            const reply = await this.fetchBundleWithRetry(session, pkgName, opts.source);
            if (!reply) return;
            if (reply.type === "ERROR") {
                await this.printServerError(reply);
                return;
            }

            const files = await this.verifyBundle(session.publicKey, reply);
            if (!files) return;

            const dir = `${this.cacheDir}/bundles/${reply.name}/${reply.version}`;
            for (const file of files) {
                // File engine (kernel) disimpan di bawah `host/` supaya jelas bahwa
                // isinya bukan path VFS — dan supaya tidak ketimpa file VFS lain.
                const dest = `${dir}/${file.hostDst ? `host/${file.hostDst}` : `files${file.path}`}`;
                const parent = dest.substring(0, dest.lastIndexOf("/"));
                if (parent) await this.mkdirRecursive(parent);
                await this.lib.fs.writeFile(dest, file.content);
            }
            await this.lib.fs.writeFile(
                `${dir}/index.json`,
                JSON.stringify({ name: reply.name, version: reply.version, files: bundleDigest(files) }, null, 2),
            );

            this.metrics.downloads++;
            await this.lib.std.print(`✅ Saved (verified) to ${dir}\n`);
        } finally {
            await this.lib.net.close(session.fd).catch(() => { });
        }
    }

    /**
     * doVerify(): Periksa signature + integritas paket tanpa memasangnya.
     * Berguna sebelum `install` di node penting.
     */
    private async doVerify(pkgName: string | undefined, opts: CliOptions) {
        const host = await this.resolveRepo("verify", opts, pkgName);
        if (!host) return;
        if (!pkgName) {
            await this.lib.std.print("Usage: tpkg verify <pkg> --from <host[:port]>\n");
            return;
        }

        await this.lib.std.print(`Verifying \x1b[1m${pkgName}\x1b[0m from \x1b[1m${host}\x1b[0m...\n`);
        const session = await this.establishSecureSession(host);
        if (!session) return;

        try {
            const reply = await this.fetchBundleWithRetry(session, pkgName, opts.source);
            if (!reply) return;
            if (reply.type === "ERROR") {
                await this.printServerError(reply);
                return;
            }

            const files = await this.verifyBundle(session.publicKey, reply);
            if (files) {
                await this.lib.std.print(`✅ Signature & integrity OK — ${files.length} file(s).\n`);
            } else {
                await this.lib.std.print("❌ Verification FAILED.\n");
            }
        } finally {
            await this.lib.net.close(session.fd).catch(() => { });
        }
    }

    private async printServerError(reply: any) {
        await this.lib.std.print(`❌ Server Error: ${reply.message}\n`);
        if (reply.suggestions && reply.suggestions.length > 0) {
            await this.lib.std.print(`💡 Did you mean: \x1b[1;36m${reply.suggestions.join(", ")}\x1b[0m ?\n`);
        }
    }

    /** fetchBundle(): GET_BUNDLE sekali jalan (tanpa retry). */
    private async fetchBundle(session: any, pkgName: string, source: boolean = false): Promise<any | null> {
        await this.lib.net.sendto(
            session.fd,
            session.address,
            session.port,
            session.agent.securePacketOut(JSON.stringify({ type: "GET_BUNDLE", name: pkgName, ...(source ? { source: true } : {}) })),
        );
        // Timeout longgar: bundle besar butuh waktu kirim (banyak fragmen MQTNL).
        return await this.recvExpect(session.fd, ["BUNDLE_REPLY", "ERROR"], 20000, {
            from: session.address,
            agent: session.agent,
        });
    }

    /** fetchBundleWithRetry(): ulangi pengambilan bundle dengan backoff. */
    private async fetchBundleWithRetry(session: any, pkgName: string, source: boolean = false): Promise<any | null> {
        try {
            return await this.withRetry(
                async () => {
                    const reply = await this.fetchBundle(session, pkgName, source);
                    if (!reply) throw new Error("timeout waiting for bundle");
                    return reply;
                },
                3,
                1000,
                "fetch bundle",
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

        // Signature menutup metadata file + onAfter/undoScript/versi/mode (SEC-16).
        if (!SecurityAgent.verify(repoPubKey, bundleSignatureDigest({ ...data, files }), data?.signature)) {
            await this.lib.std.print("❌ ERROR: Bundle signature verification failed! Package may be tampered.\n");
            return null;
        }

        const check = verifyBundleFiles(files);
        if (!check.ok) {
            await this.lib.std.print(`❌ ERROR: Integrity check failed — ${check.error}\n`);
            return null;
        }

        // Tujuan host diperiksa walau sudah ikut ditandatangani: server yang salah
        // konfigurasi tidak boleh membuat klien menulis di luar root proyek.
        for (const f of files) {
            if (f.hostDst !== undefined && !isSafeHostDst(f.hostDst)) {
                await this.lib.std.print(`❌ ERROR: unsafe hostDst in package: '${f.hostDst}'\n`);
                return null;
            }
        }

        this.metrics.verified++;
        const total = files.reduce((sum, f) => sum + f.size, 0);
        await this.lib.std.print(
            `Received bundle: ${data.name} v${data.version} — ${files.length} file(s), ${formatBytes(total)} (Verified${data.variant ? `, ${data.variant}` : ""})\n`,
        );
        return files;
    }

    /**
     * installBundle(): Tulis file + set mode + catat versi, dengan backup di
     * depan dan pemulihan otomatis kalau ada yang gagal ditulis.
     *
     * Semua file sudah diverifikasi sebelum fungsi ini dipanggil.
     */
    private async installBundle(
        pkgName: string,
        data: any,
        files: TpkgBundleFile[],
        localStatus: Record<string, string>,
        opts: CliOptions,
    ): Promise<boolean> {
        const hostFiles = files.filter((f) => !!f.hostDst);

        // Paket yang menyentuh HOST FS sangat berbahaya (bisa mengganti kernel),
        // jadi minta konfirmasi eksplisit walau sudah root. Default = TIDAK.
        // Sengaja TIDAK ikut `--yes`.
        if (hostFiles.length > 0) {
            if (!(await this.confirmHostWrite(pkgName, hostFiles))) {
                await this.lib.std.print("❌ Installation aborted — nothing was written.\n");
                return false;
            }
        }

        // Konfigurasi `/etc` yang sudah diubah operator TIDAK ditimpa — versi paket
        // ditulis ke `<file>.tpkg-new`. Diputuskan SEBELUM backup supaya backup
        // mencakup path yang benar-benar akan ditulis.
        const { writes, extra } = await this.planConfigWrites(pkgName, files);

        const backup = await this.backupFiles(pkgName, data.version, writes);
        if (!backup) return false; // gagal backup → jangan menyentuh apa pun

        try {
            for (const file of writes) {
                const dir = file.path.substring(0, file.path.lastIndexOf("/"));
                if (dir) await this.mkdirRecursive(dir);

                await this.lib.fs.writeFile(file.path, file.content);

                // Mode: `permissions` dari manifest menang, lalu aturan SetUID/EXEC
                // yang sama dengan `vfs-bootstrap` (lihat `resolveMode`). Ini yang
                // membuat skrip baru di luar /bin tetap bisa dieksekusi (dulu +x
                // hilang sehingga post-install gagal 126).
                const mode = resolveMode(file);
                if (mode !== undefined) await this.lib.fs.chmod(file.path, mode);

                const tag = mode !== undefined ? `, mode ${mode.toString(8)}` : "";
                await this.lib.std.print(`  -> ${file.path} (${formatBytes(file.size)}${tag})\n`);

                // File yang hidup di host (kernel dkk): VFS di atas hanya jalur
                // perantara — salin keluar sekarang, SEBELUM laporan sukses.
                if (file.hostDst) {
                    const ok = await this.lib.fs.syncToHost(file.path, file.hostDst);
                    if (!ok) throw new Error(`failed to sync to host: ${file.hostDst}`);
                    await this.lib.std.print(`     host: ${file.hostDst}\n`);
                }
            }
        } catch (e: any) {
            await this.lib.std.print(`❌ Write failed: ${e.message}\n`);
            await this.restoreBackup(backup);
            this.metrics.failed++;
            return false;
        }

        // Source → binary: `.ts` lama (dari instalasi --source sebelumnya) harus
        // pergi SEBELUM manifest lama tertimpa — lihat `retireStaleSources`.
        await this.retireStaleSources(pkgName, files, await this.loadInstalledManifest(pkgName));

        // Catat manifest file terpasang + hash isi yang kita tulis. Inilah dasar
        // `tpkg remove` untuk mendeteksi berkas konfigurasi yang sudah diubah.
        // File `.tpkg-new` ikut dicatat supaya `tpkg remove` membersihkannya.
        await this.saveInstalledManifest(pkgName, data.version, [...files, ...extra], data.undoScript);

        localStatus[pkgName] = data.version;
        await this.saveStatus(localStatus);
        this.metrics.installs++;

        await this.runPostInstall(pkgName, data, files, opts);
        await this.pruneBackups(pkgName);
        return true;
    }

    /**
     * preparePayload(): sesuaikan bundle yang SUDAH terverifikasi dengan node ini.
     *
     *   1. Image produksi → `hostDst` `src/mirror/…` dilipat ke VFS saja
     *      (`foldMirrorHostDst`); item itu lalu ikut di-compile ke `.js`.
     *   2. Compile lokal ke `.js` bila (a) repo lama yang tidak mengenal varian
     *      binary, atau (b) image produksi punya item hasil lipatan. Tidak dilakukan
     *      bila operator meminta `--source`.
     */
    private async preparePayload(verified: TpkgBundleFile[], data: any, opts: CliOptions): Promise<TpkgBundleFile[]> {
        let files = verified;
        let folded = 0;
        if (await this.isProductionImage()) {
            ({ files, folded } = this.foldMirrorHostDst(files));
            if (folded > 0) {
                await this.lib.std.print(
                    `ℹ️  Production image: ${folded} file(s) go to the system database only (no src/mirror/ on the host).\n`,
                );
            }
        }
        if (opts.source) return files;
        if (data.variant === undefined) return this.compileLocally(files, data);
        if (folded > 0) return this.compileLocally(files, data, "Production image");
        return files;
    }

    /**
     * isProductionImage(): node ini image produksi (`twrapper --no-mirror`)?
     *
     * VFS tidak bisa melihat apakah host punya `src/mirror/`, jadi builder menulis
     * penanda `/etc/tsix-release` (`VARIANT=production`). Dibaca sekali per proses.
     */
    private productionImage: boolean | undefined;
    private async isProductionImage(): Promise<boolean> {
        if (this.productionImage !== undefined) return this.productionImage;
        const release = this.parseRelease(await this.readMaybe(RELEASE_PATH));
        this.productionImage = release.VARIANT === "production";
        return this.productionImage;
    }

    /** parseRelease(): `KEY=VALUE` / `KEY="VALUE"` per baris (gaya /etc/os-release). */
    private parseRelease(text: string | null): Record<string, string> {
        const out: Record<string, string> = {};
        for (const raw of String(text ?? "").split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith("#")) continue;
            const eq = line.indexOf("=");
            if (eq <= 0) continue;
            let value = line.slice(eq + 1).trim();
            if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1).replace(/\\(["\\])/g, "$1");
            }
            out[line.slice(0, eq).trim()] = value;
        }
        return out;
    }

    /**
     * foldMirrorHostDst(): image produksi — item dengan `hostDst` `src/mirror/<p>`
     * dipasang ke VFS di `/<p>` SAJA, tanpa sinkron ke host.
     *
     * Di produksi rootfs hanya ada di BKFS. Menyalin ke `src/mirror/` di host akan
     * memunculkan lagi direktori itu (install.ts lalu salah mengira mode
     * development) dan tidak dibaca siapa pun. Item kernel / `src/common` /
     * userland tetap ke host — engine host membutuhkannya.
     *
     * Dilakukan SETELAH verifikasi signature (yang menutupi `hostDst` asli).
     * Item yang kini tanpa `hostDst` otomatis menjadi kandidat `.js` (compileLocally).
     */
    private foldMirrorHostDst(files: TpkgBundleFile[]): { files: TpkgBundleFile[]; folded: number } {
        const prefix = "src/mirror/";
        let folded = 0;
        const seen = new Set<string>();
        const out: TpkgBundleFile[] = [];
        for (const f of files) {
            let file = f;
            if (f.hostDst && f.hostDst.startsWith(prefix)) {
                file = { ...f, path: "/" + f.hostDst.slice(prefix.length) };
                delete file.hostDst;
                folded++;
            }
            if (seen.has(file.path)) continue;
            seen.add(file.path);
            out.push(file);
        }
        return { files: out, folded };
    }

    /**
     * compileLocally(): ubah bundle source dari repo LAMA (tpkgd tanpa varian
     * binary) menjadi binary di klien — aturan sama dengan server
     * (`isBinaryCandidate`: bukan /lib, bukan item host).
     *
     * Dipanggil SETELAH signature + SHA-256 diverifikasi atas isi asli, jadi
     * keaslian paket tetap terjamin; manifest terpasang mencatat hash `.js` yang
     * benar-benar ditulis. Skrip post-install/undo yang ikut di-compile dipanggil
     * lewat `.js`-nya. esbuild tidak tersedia → bundle dipasang sebagai source.
     */
    private async compileLocally(
        files: TpkgBundleFile[],
        data: any,
        reason: string = "The repository sent TypeScript sources (older tpkgd)",
    ): Promise<TpkgBundleFile[]> {
        const candidates = files.filter((f) => isBinaryCandidate({ dst: f.path, hostDst: f.hostDst })).length;
        if (candidates === 0) {
            data.variant = "binary";
            return files;
        }
        let esbuild: any;
        try {
            const req = (globalThis as any).require ?? (typeof require === "function" ? require : undefined);
            esbuild = req?.("esbuild");
        } catch (e) {
            esbuild = null;
        }
        if (!esbuild) {
            await this.lib.std.print(`⚠️  ${reason}, but esbuild is not available here — installing sources.\n`);
            return files;
        }

        await this.lib.std.print(
            `ℹ️  ${reason} — compiling ${candidates} file(s) to .js locally (use --source to keep sources).\n`,
        );
        const compiled = new Map<string, string>();
        const out: TpkgBundleFile[] = files.map((f) => {
            if (!isBinaryCandidate({ dst: f.path, hostDst: f.hostDst })) return f;
            try {
                const result = esbuild.transformSync(vfsBytesToUtf8(f.content), {
                    loader: "ts",
                    format: "cjs",
                    target: "node18",
                    sourcefile: f.path.split("/").pop(),
                });
                const content = utf8ToVfsBytes(result.code);
                const jsPath = binaryPath(f.path);
                compiled.set(f.path, jsPath);
                return { ...f, path: jsPath, content, size: content.length, sha256: sha256Hex(content) };
            } catch (e) {
                return f; // dibangun `transpile` seperti paket source
            }
        });
        // Sidecar `.js` yang juga dikirim server untuk `.ts` yang sama: hasil compile menang.
        const targets = new Set(compiled.values());
        const unique = out.filter((f, i) => !(targets.has(f.path) && !compiled.has(files[i].path)));

        if (data.onAfter && compiled.has(data.onAfter)) data.onAfter = compiled.get(data.onAfter);
        if (data.undoScript && compiled.has(data.undoScript)) data.undoScript = compiled.get(data.undoScript);
        data.variant = "binary";
        return unique;
    }

    /**
     * retireStaleSources(): hapus `.ts` lama milik paket ini yang kini dikirim
     * sebagai `.js` (bundle binary).
     *
     * KENAPA WAJIB: resolver import relatif mendahulukan `.ts` di atas `.js`
     * (`VfsModuleResolver`), jadi `.ts` versi lama yang tertinggal akan MENANG
     * atas `.js` baru — kode lama yang jalan, diam-diam.
     *
     * Hanya `.ts` yang tercatat di manifest instalasi SEBELUMNYA (milik paket ini,
     * bukan paket lain). Yang sudah diubah operator tidak dibuang: dipindah ke
     * `<file>.ts.tpkg-old`.
     */
    private async retireStaleSources(
        pkgName: string,
        files: TpkgBundleFile[],
        previous: InstalledManifest | null,
    ): Promise<void> {
        const owned = new Map((previous?.files ?? []).map((f) => [f.path, f.sha256]));
        if (owned.size === 0) return;
        const written = new Set(files.map((f) => f.path));
        const others = await this.filesOwnedByOthers(pkgName);

        for (const file of files) {
            if (!file.path.endsWith(".js")) continue;
            const ts = file.path.slice(0, -3) + ".ts";
            if (written.has(ts) || !owned.has(ts) || others.has(ts)) continue;
            const current = await this.readMaybe(ts);
            if (current === null) continue;
            try {
                if (sha256Hex(current) !== owned.get(ts)) {
                    await this.lib.fs.writeFile(`${ts}.tpkg-old`, current);
                    await this.lib.std.print(`  ~ ${ts} was modified locally — moved to ${ts}.tpkg-old\n`);
                }
                await this.lib.fs.unlink(ts);
                await this.lib.std.print(`  - ${ts} (old source, now prebuilt ${file.path})\n`);
            } catch (e: any) {
                await this.lib.std.print(`⚠️  Could not remove old source ${ts}: ${e.message}\n`);
            }
        }
    }

    /**
     * planConfigWrites(): perlakuan "conffile" ala dpkg untuk berkas di `/etc/`.
     *
     * Paket membawa konfigurasi default (mis. `/etc/tpkg/config.json`,
     * `/etc/dome/dome.conf`). Dulu setiap reinstall/upgrade menimpanya — node yang
     * sudah `tpkg --set-repo wintsix` kembali ke repo bawaan paket. Sekarang:
     *
     *   - belum ada                         → ditulis
     *   - isinya = versi paket              → ditulis (tidak ada beda)
     *   - isinya = yang dipasang dulu       → ditulis (tidak diubah operator → ikut upgrade)
     *   - selain itu (diubah / bukan milik
     *     tpkg, mis. dari image)            → DIBIARKAN; versi paket → `<file>.tpkg-new`
     *
     * Return `writes` (yang benar-benar ditulis, berurutan) dan `extra` (file
     * `.tpkg-new` yang perlu dicatat di manifest).
     */
    private async planConfigWrites(
        pkgName: string,
        files: TpkgBundleFile[],
    ): Promise<{ writes: TpkgBundleFile[]; extra: TpkgBundleFile[] }> {
        const previous = await this.loadInstalledManifest(pkgName);
        const installedSha = new Map((previous?.files ?? []).map((f) => [f.path, f.sha256]));
        const writes: TpkgBundleFile[] = [];
        const extra: TpkgBundleFile[] = [];

        for (const file of files) {
            if (!file.path.startsWith("/etc/") || !(await this.exists(file.path))) {
                writes.push(file);
                continue;
            }
            let current: string | null = null;
            try {
                current = await this.lib.fs.readFile(file.path);
            } catch (e) {
                current = null;
            }
            if (current === null || current === undefined) {
                writes.push(file);
                continue;
            }
            const sha = sha256Hex(current);
            if (sha === file.sha256 || sha === installedSha.get(file.path)) {
                writes.push(file);
                continue;
            }

            const newPath = `${file.path}.tpkg-new`;
            // Salinan `.tpkg-new` hanya untuk operator — tidak ikut dicerminkan ke host.
            const alt: TpkgBundleFile = { ...file, path: newPath };
            delete alt.hostDst;
            writes.push(alt);
            extra.push(alt);
            await this.lib.std.print(
                `  ~ ${file.path} kept \x1b[1;33m(locally modified)\x1b[0m — new version saved as ${newPath}\n`,
            );
        }
        return { writes, extra };
    }

    /**
     * confirmHostWrite(): Ringkas file host yang akan ditimpa, lalu minta izin.
     *
     * Menampilkan daftar (maks 10 + sisanya) penting: operator harus tahu bahwa
     * ini bukan sekadar memasang app, tapi menulis ke luar VFS.
     */
    private async confirmHostWrite(pkgName: string, hostFiles: TpkgBundleFile[]): Promise<boolean> {
        await this.lib.std.print(
            `\n\x1b[1;33m⚠️  Package '${pkgName}' writes to the HOST FS (${hostFiles.length} file(s)).\x1b[0m\n`,
        );
        await this.lib.std.print("   This modifies files outside the VFS — including the kernel & engine components.\n");
        for (const f of hostFiles.slice(0, 10)) {
            await this.lib.std.print(`   • ${f.hostDst}\n`);
        }
        if (hostFiles.length > 10) {
            await this.lib.std.print(`   … and ${hostFiles.length - 10} more file(s)\n`);
        }

        const answer = await this.lib.std.read("\nProceed with writing to host? [y/N]: ");
        return answer.toLowerCase().trim() === "y";
    }

    /**
     * runPostInstall(): jalankan `onAfter` SETELAH operator menyetujuinya.
     *
     * Skrip post-install berjalan sebagai root, jadi paket yang jahat (atau repo
     * yang dibobol) bisa melakukan apa saja lewat skrip ini. Karena itu skrip
     * ditampilkan lengkap dengan argumennya, ditandai bila skrip itu DIKIRIM oleh
     * paket ini sendiri, dan defaultnya TIDAK dijalankan.
     */
    private async runPostInstall(pkgName: string, data: any, files: TpkgBundleFile[], opts: CliOptions) {
        if (!data.onAfter) {
            await this.lib.std.print("✅ Installation successful.\n");
            return;
        }

        // Untuk hook transpile, kirim daftar berkas `.ts` yang baru ditulis supaya
        // hanya sidecar paket ini yang dibangun (bukan seluruh /bin,/sbin). Hook
        // lain (apply-update, app) tetap dipanggil tanpa argumen.
        const isTranspile = String(data.onAfter).includes("transpile");
        let hookArgs = isTranspile ? files.filter((f) => f.path.endsWith(".ts")).map((f) => f.path) : [];

        // Bundle BINARY: program sudah `.js` hasil compile server. `.ts` yang tersisa
        // di /lib dibaca kernel langsung (cache boot), jadi tidak perlu sidecar.
        // Yang masih perlu di-build hanya `.ts` yang gagal di-compile server.
        if (isTranspile && data.variant === "binary") {
            hookArgs = hookArgs.filter((p) => !p.startsWith("/lib/"));
            if (hookArgs.length === 0) {
                await this.lib.std.print("✅ Installation successful (prebuilt .js — no build step needed).\n");
                return;
            }
        }
        const cmdLine = [data.onAfter, ...hookArgs].join(" ");

        await this.lib.std.print(`\n✅ Package installed. Post-install script: \x1b[1;36m${data.onAfter}\x1b[0m\n`);
        if (hookArgs.length > 0) {
            await this.lib.std.print(`   \x1b[2margs: ${hookArgs.join(" ")}\x1b[0m\n`);
        }
        const shipped = files.some((f) => f.path === data.onAfter);
        await this.lib.std.print(
            shipped
                ? "   \x1b[1;33m⚠️  This script is shipped by the package itself — run it only if you trust the source.\x1b[0m\n"
                : "   \x1b[2m(system script, not part of this package)\x1b[0m\n",
        );

        const skip = async (why: string) => {
            await this.lib.std.print(`Skipping post-install (${why}). Run it manually: sudo ${cmdLine}\n`);
            if (!isTranspile) return;
            // Sidecar lama tetap menang atas `.ts` baru (EXEC mendahulukan `.js`).
            let stale = 0;
            for (const ts of hookArgs) if (await this.exists(ts.replace(/\.ts$/, ".js"))) stale++;
            if (stale > 0) {
                await this.lib.std.print(
                    `\x1b[1;33m⚠️  ${stale} existing .js sidecar(s) will keep running the OLD code until rebuilt.\x1b[0m\n`,
                );
            }
        };

        if (opts.noScripts) {
            await skip("--no-scripts");
            return;
        }
        if (!(await this.confirm("Run post-install script? [y/N]: ", opts, false))) {
            await skip("not confirmed");
            return;
        }

        await this.lib.std.print(`Running ${data.onAfter}...\n`);
        try {
            const proc = await this.lib.shell.exec(data.onAfter, hookArgs);
            const exitCode = await this.lib.shell.waitpid(proc.pid);
            if (exitCode === 0) {
                await this.lib.std.print("✅ Post-install finished.\n");
                return;
            }
            await this.lib.std.print(`⚠️  Post-install exit code ${exitCode}\n`);
        } catch (e: any) {
            await this.lib.std.print(`❌ Post-install failed: ${e.message}\n`);
        }
        await this.lib.std.print(
            `   The package files are installed. Fix the problem and re-run: sudo ${cmdLine}\n` +
            `   — or uninstall with 'tpkg remove ${pkgName}'.\n`,
        );
    }

    /**
     * backupFiles(): Simpan isi file yang AKAN DITIMPA ke disk.
     *
     * Hasilnya ditulis ke `/var/lib/tpkg/backup/<pkg>/<timestamp>/` + `index.json`
     * dan dipakai `restoreBackup()` kalau penulisan gagal di tengah jalan.
     *
     * Return null kalau backup gagal — pemanggil WAJIB membatalkan instalasi.
     *
     * File host (ber-`hostDst`) dibackup dengan cara dibaca dulu ke VFS lewat
     * `syncFromHost`, lalu disimpan seperti file biasa. Isinya jadi bisa dipulihkan
     * lewat `syncToHost` — tanpa ini, kegagalan paket engine hanya mengembalikan
     * sisi VFS dan meninggalkan kernel yang sudah tertimpa.
     */
    private async backupFiles(pkgName: string, version: string, files: TpkgBundleFile[]): Promise<BackupIndex | null> {
        const createdAt = Date.now();
        const dir = `${this.backupDir}/${pkgName}/${createdAt}`;
        const index: BackupIndex = { package: pkgName, version, createdAt, entries: [] };

        try {
            await this.mkdirRecursive(dir);
            let seq = 0;

            for (const file of files) {
                const entry: BackupEntry = { path: file.path, existed: false };

                // (a) Sisi VFS — file `dst` dicetak tiap install, host atau bukan.
                const existingStat = await this.lib.fs.stat(file.path);
                if (existingStat) {
                    const existing = await this.lib.fs.readFile(file.path);
                    if (existing === null || existing === undefined) {
                        throw new Error(`File exists but cannot be read for backup: ${file.path}`);
                    }
                    seq++;
                    const name = `${String(seq).padStart(4, "0")}.bin`;
                    await this.lib.fs.writeFile(`${dir}/${name}`, existing);
                    entry.existed = true;
                    entry.backup = name;
                }

                // (b) Sisi HOST — dibaca masuk ke folder backup lewat `syncFromHost`.
                // File yang belum ada di host mengelempar → catat "belum ada".
                if (file.hostDst) {
                    entry.hostPath = file.hostDst;
                    try {
                        seq++;
                        const name = `${String(seq).padStart(4, "0")}.bin`;
                        await this.lib.fs.syncFromHost(file.hostDst, `${dir}/${name}`);
                        entry.hostExisted = true;
                        entry.hostBackup = name;
                    } catch (e: any) {
                        entry.hostExisted = false;
                    }
                }

                index.entries.push(entry);
            }

            await this.lib.fs.writeFile(`${dir}/index.json`, JSON.stringify(index, null, 2));
            return index;
        } catch (e: any) {
            await this.lib.std.print(`❌ Backup failed (${e.message}) — installation aborted.\n`);
            return null;
        }
    }

    /** restoreBackup(): Kembalikan file ke kondisi sebelum instalasi yang gagal. */
    private async restoreBackup(backup: BackupIndex | null): Promise<boolean> {
        if (!backup) return false;
        const dir = `${this.backupDir}/${backup.package}/${backup.createdAt}`;
        let restored = 0;
        let removed = 0;
        let skippedHost = 0;

        for (const entry of backup.entries) {
            // --- sisi HOST (kalau ada) ---
            // try/catch TERPISAH dari sisi VFS: kalau pemulihan host gagal (mis. izin
            // atau target terkunci), VFS tetap harus dikembalikan. Satu kegagalan tidak
            // boleh membuat sisi lain ikut terlewat — itu yang bikin node berakhir
            // "separuh ter-update".
            if (entry.hostPath) {
                try {
                    if (entry.hostExisted && entry.hostBackup) {
                        const ok = await this.lib.fs.syncToHost(`${dir}/${entry.hostBackup}`, entry.hostPath);
                        if (!ok) throw new Error("syncToHost returned false");
                        restored++;
                    } else {
                        // File host yang BARU dibuat paket ini. VFS tidak punya syscall
                        // untuk menghapus file host, jadi dilaporkan ke operator — lebih
                        // jujur daripada gagal diam-diam.
                        skippedHost++;
                        await this.lib.std.print(`⚠️  New host file cannot be removed automatically: ${entry.hostPath}\n`);
                    }
                } catch (e: any) {
                    await this.lib.std.print(`⚠️  Failed to restore host file ${entry.hostPath}: ${e.message}\n`);
                }
            }

            // --- sisi VFS ---
            try {
                if (entry.existed && entry.backup) {
                    const content = await this.readMaybe(`${dir}/${entry.backup}`);
                    if (content === null || content === undefined) continue;
                    await this.lib.fs.writeFile(entry.path, content);
                    restored++;
                } else {
                    // File baru dari paket ini → hapus, jangan tinggalkan sampah.
                    await this.lib.fs.unlink(entry.path);
                    removed++;
                }
            } catch (e: any) {
                await this.lib.std.print(`⚠️  Failed to restore ${entry.path}: ${e.message}\n`);
            }
        }

        this.metrics.restored++;
        await this.lib.std.print(
            `↩️  Previous files restored (${restored} restored, ${removed} removed` +
            `${skippedHost > 0 ? `, ${skippedHost} host file(s) need manual removal` : ""}).\n`,
        );
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
        const content = await this.readMaybe(`${this.backupDir}/${pkgName}/${stamp}/index.json`);
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

    private async doInfo(pkgName: string | undefined, opts: CliOptions) {
        const host = await this.resolveRepo("info", opts, pkgName);
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
                await this.printServerError(data);
                return;
            }

            const pkg = data.package;
            const isValid = SecurityAgent.verify(repoPubKey, JSON.stringify(pkg), data.signature);
            if (!isValid) {
                await this.lib.std.print("❌ ERROR: Package info signature verification failed!\n");
                return;
            }

            const local = (await this.loadStatus())[pkg.name];
            await this.lib.std.print(`\n\x1b[1;34mPackage Information:\x1b[0m\n`);
            await this.lib.std.print(`--------------------------------------------------\n`);
            await this.lib.std.print(`\x1b[1mName:\x1b[0m        ${pkg.name}\n`);
            await this.lib.std.print(`\x1b[1mVersion:\x1b[0m     ${pkg.version}\n`);
            await this.lib.std.print(`\x1b[1mInstalled:\x1b[0m   ${local ?? "no"}\n`);
            await this.lib.std.print(`\x1b[1mDescription:\x1b[0m ${pkg.description}\n`);
            await this.lib.std.print(`\x1b[1mAuthor:\x1b[0m      ${pkg.author}\n`);
            await this.lib.std.print(`\x1b[1mReboot Req:\x1b[0m  ${pkg.needReboot ? "Yes" : "No"}\n`);
            await this.lib.std.print(
                `\x1b[1mDepends:\x1b[0m     ${Array.isArray(pkg.depends) && pkg.depends.length ? pkg.depends.join(", ") : "-"}\n`,
            );

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
            await this.lib.net.close(fd).catch(() => { });
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

        // Dua jalur gagal di bawah dulu `return null` tanpa pesan — tpkg berhenti
        // diam-diam setelah "Preparing to install ...".
        const fd = await this.lib.net.socket();
        if (fd < 0) {
            await this.lib.std.print("❌ Failed to open MQTNL socket (is the network up?).\n");
            return null;
        }

        const bound = await this.lib.net.bind(fd, 0); // port ephemeral
        if (!bound) {
            await this.lib.std.print("❌ Failed to bind a local MQTNL port.\n");
            await this.lib.net.close(fd).catch(() => { });
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
            await this.lib.std.print(`❌ Host ${target.address}:${target.port} did not respond to handshake.\n`);
            await this.lib.net.close(fd).catch(() => { });
            return null;
        }

        if (!ack.sessionKey || !ack.publicKey) {
            await this.lib.std.print("❌ Handshake failed (incomplete reply).\n");
            await this.lib.net.close(fd).catch(() => { });
            return null;
        }

        // ack.publicKey adalah kunci yang nanti memverifikasi signature katalog
        // & bundle. Kepercayaan diputuskan dari fingerprint yang DIHITUNG di
        // sini dari kunci itu, terikat ke host. `ack.fingerprint` kiriman server
        // hanya dicek konsistensinya: siapa pun bisa mengirim fingerprint repo
        // asli bersama kunci miliknya sendiri.
        const repoKey: string = ack.publicKey;
        if (ack.fingerprint && String(ack.fingerprint).toUpperCase() !== SecurityAgent.getFingerprint(repoKey)) {
            await this.lib.std.print("❌ Repository fingerprint does not match its public key. Aborting.\n");
            await this.lib.net.close(fd).catch(() => { });
            return null;
        }
        const fp = SecurityAgent.publicKeyFingerprint(repoKey);
        const trust = await this.checkTrusted(target.address, repoKey);
        if (trust === "mismatch") {
            await this.lib.std.print(
                `\x1b[1;31m⚠️  WARNING: REPOSITORY KEY FOR '${target.address}' HAS CHANGED!\x1b[0m\n` +
                `   New fingerprint: ${fp}\n` +
                `   Aborting. If the repository really changed its key, remove its line from ${this.trustedRepos}.\n`,
            );
            await this.lib.net.close(fd).catch(() => { });
            return null;
        }
        // Fingerprint repo baru SENGAJA tidak ikut `--yes`: menerima kunci repo
        // tanpa melihatnya membuka jalan bagi repo palsu.
        if (trust === "unknown") {
            await this.lib.std.print(`\x1b[1;33m⚠️  WARNING: Unknown Repository '${target.address}', SHA-256 fingerprint: ${fp}\x1b[0m\n`);
            const confirm = await this.lib.std.read("Accept and proceed? [y/N]: ");
            if (confirm.toLowerCase().trim() !== "y") {
                await this.lib.net.close(fd).catch(() => { });
                return null;
            }
            await this.addTrusted(target.address, fp);
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
        label: string = "operation",
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
                    `⏳ ${label} failed (${e.message}) — retrying in ${wait}ms (${attempt}/${attempts})\n`,
                );
                await new Promise((r) => setTimeout(r, wait));
            }
        }
        throw lastErr;
    }

    private async loadCatalog(): Promise<TpkgCatalogEntry[]> {
        if (!(await this.exists(this.repoCache))) return [];
        const content = await this.lib.fs.readFile(this.repoCache);
        try {
            const parsed = JSON.parse(content || "[]");
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    // ===================== REMOVE / UNINSTALL =====================

    private installedManifestPath(pkgName: string): string {
        return `${this.installedDir}/${pkgName}.json`;
    }

    /** saveInstalledManifest(): catat tiap file yang ditulis + sha256 isinya. */
    private async saveInstalledManifest(
        pkgName: string,
        version: string,
        files: TpkgBundleFile[],
        undoScript?: string,
    ) {
        const manifest: InstalledManifest = {
            package: pkgName,
            version,
            installedAt: Date.now(),
            ...(undoScript ? { undoScript } : {}),
            files: files.map((f) => ({
                path: f.path,
                sha256: sha256Hex(f.content),
                ...(f.hostDst ? { hostDst: f.hostDst, hostSha256: sha256Hex(f.content) } : {}),
            })),
        };
        await this.mkdirRecursive(this.installedDir);
        await this.lib.fs.writeFile(this.installedManifestPath(pkgName), JSON.stringify(manifest, null, 2));
    }

    private async loadInstalledManifest(pkgName: string): Promise<InstalledManifest | null> {
        const content = await this.readMaybe(this.installedManifestPath(pkgName));
        if (!content) return null;
        try {
            return JSON.parse(content) as InstalledManifest;
        } catch (e) {
            return null;
        }
    }

    /**
     * filesOwnedByOthers(): path → paket lain yang JUGA memasangnya.
     *
     * Beberapa paket sengaja berbagi file (mis. `tpkg` dan `base-system` sama-sama
     * mengirim `/sbin/tpkg.ts`). Menghapus satu paket tidak boleh merusak paket
     * lain yang masih terpasang.
     */
    private async filesOwnedByOthers(pkgName: string): Promise<Map<string, string>> {
        const owners = new Map<string, string>();
        let items: any[] = [];
        try {
            items = (await this.lib.fs.ls(this.installedDir)) ?? [];
        } catch (e) {
            return owners;
        }
        for (const item of items) {
            if (item.type !== "FILE" || !String(item.name).endsWith(".json")) continue;
            const other = String(item.name).replace(/\.json$/, "");
            if (other === pkgName) continue;
            const manifest = await this.loadInstalledManifest(other);
            for (const f of manifest?.files ?? []) if (!owners.has(f.path)) owners.set(f.path, other);
        }
        return owners;
    }

    /** isConfigPath(): heuristik berkas konfigurasi berdasarkan ekstensi. */
    private isConfigPath(path: string): boolean {
        const dot = path.lastIndexOf(".");
        if (dot < 0) return false;
        return CONFIG_EXTENSIONS.includes(path.slice(dot).toLowerCase());
    }

    /** pruneEmptyParents(): hapus direktori induk yang menjadi kosong setelah unlink. */
    private async pruneEmptyParents(path: string) {
        let dir = path.substring(0, path.lastIndexOf("/"));
        while (dir && dir !== "/") {
            try {
                const items = await this.lib.fs.ls(dir);
                if ((items ?? []).length > 0) break;
                await this.lib.fs.rmdir(dir);
            } catch (e) {
                break;
            }
            dir = dir.substring(0, dir.lastIndexOf("/"));
        }
    }

    /** doRemove(): lepas satu atau beberapa paket. */
    private async doRemove(opts: CliOptions) {
        if (opts.names.length === 0) {
            await this.lib.std.print("Usage: tpkg remove <pkg...>\n");
            return;
        }
        for (const name of opts.names) await this.removeOne(name, opts);
    }

    /**
     * removeOne(): uninstall paket — hapus file yang pernah ditulis (manifest
     * `/var/lib/tpkg/installed/<pkg>.json`) beserta sidecar `.js` hasil transpile.
     *
     * Berkas konfigurasi (`.conf`, `.json`, `.ini`, dst.) SELALU dikonfirmasi:
     *   - `remove`     → hapus berkas ini
     *   - `remove all` → hapus berkas ini & sisanya tanpa tanya lagi
     *   - `cancel`     → berhenti; sisa berkas dibiarkan, status paket tidak diubah
     *
     * Hash sha256 dari saat install dibandingkan dengan isi sekarang; bila beda,
     * berkas ditandai "(modified)" agar operator sadar sebelum menghapus.
     *
     * Sidecar `.js`: dibuat `transpile` SETELAH instalasi, jadi tidak tercatat di
     * manifest. Dulu tertinggal setelah remove — dan karena `EXEC` mendahulukan
     * `.js`, programnya masih bisa dijalankan walau paketnya sudah "dihapus".
     */
    private async removeOne(pkgName: string, opts: CliOptions) {
        const status = await this.loadStatus();
        const manifest = await this.loadInstalledManifest(pkgName);
        let files: InstalledFile[] = manifest?.files ?? [];

        // Fallback: paket lama (dipasang sebelum manifest ada) → pakai backup index.
        if (files.length === 0) {
            const stamps = await this.listBackups(pkgName);
            if (stamps.length > 0) {
                const idx = await this.loadBackupIndex(pkgName, stamps[0]);
                if (idx) {
                    files = idx.entries.map((e) => ({
                        path: e.path,
                        sha256: "",
                        ...(e.hostPath ? { hostDst: e.hostPath } : {}),
                    }));
                }
            }
        }

        if (files.length === 0 && !status[pkgName]) {
            await this.lib.std.print(`❌ Package '${pkgName}' is not installed.\n`);
            return;
        }
        if (files.length === 0) {
            await this.lib.std.print(
                `❌ No file list for '${pkgName}' (manifest/backup missing). Remove its files manually if needed.\n`,
            );
            return;
        }

        // Paket terpasang lain yang membutuhkan paket ini (dari katalog).
        const dependents = (await this.loadCatalog())
            .filter(
                (p) =>
                    p.name !== pkgName &&
                    status[p.name] &&
                    !opts.names.includes(p.name) &&
                    (p.depends ?? []).some((s) => parseDependency(s)?.name === pkgName),
            )
            .map((p) => p.name);
        if (dependents.length > 0) {
            await this.lib.std.print(
                `\x1b[1;33m⚠️  '${pkgName}' is required by installed package(s): ${dependents.join(", ")}\x1b[0m\n`,
            );
            if (!(await this.confirm("Remove it anyway? [y/N]: ", opts, false))) {
                await this.lib.std.print("Removal aborted.\n");
                return;
            }
        }

        await this.lib.std.print(`\n\x1b[1;33m⚠️  Removing package '${pkgName}' (${files.length} file(s)).\x1b[0m\n`);

        if (manifest?.undoScript) {
            await this.lib.std.print(`Undo script: \x1b[1;36m${manifest.undoScript}\x1b[0m\n`);
            if (opts.noScripts) {
                await this.lib.std.print("Skipping undo script (--no-scripts).\n");
            } else if (await this.confirm("Run undo script? [y/N]: ", opts, false)) {
                await this.runScript(manifest.undoScript, []);
            } else {
                await this.lib.std.print("Skipping undo script.\n");
            }
        }

        const owned = new Set(files.map((f) => f.path));
        const others = await this.filesOwnedByOthers(pkgName);

        let removeAll = false;
        let removed = 0;
        let sidecars = 0;
        let shared = 0;
        let kept = 0;
        let failed = 0;
        let hostManual = 0;
        let cancelled = false;

        for (const f of files) {
            const otherOwner = others.get(f.path);
            if (otherOwner) {
                shared++;
                await this.lib.std.print(`   kept ${f.path} \x1b[2m(also installed by ${otherOwner})\x1b[0m\n`);
                continue;
            }

            if (this.isConfigPath(f.path) && !removeAll) {
                const current = await this.readMaybe(f.path);
                const modified =
                    current !== null && current !== undefined && f.sha256 !== "" && sha256Hex(current) !== f.sha256;
                const tag = modified ? "\x1b[1;33m(modified)\x1b[0m" : "\x1b[2m(unchanged)\x1b[0m";
                const ans = (await this.lib.std.read(`Config file ${f.path} ${tag} — [r]emove / [a]ll / [c]ancel: `))
                    .toLowerCase()
                    .trim();
                if (ans === "c" || ans === "cancel") {
                    cancelled = true;
                    break;
                }
                if (ans === "a" || ans === "all" || ans === "remove all") {
                    removeAll = true;
                } else if (!(ans === "r" || ans === "remove" || ans === "y" || ans === "yes")) {
                    // Jawaban tak dikenal (termasuk kosong) → biarkan berkas ini.
                    kept++;
                    continue;
                }
            }

            try {
                if (await this.exists(f.path)) {
                    await this.lib.fs.unlink(f.path);
                    removed++;
                }
                // Sidecar `.js` hasil transpile — bukan bagian manifest, tapi milik paket ini.
                if (f.path.endsWith(".ts")) {
                    const js = f.path.replace(/\.ts$/, ".js");
                    if (!owned.has(js) && !others.has(js) && (await this.exists(js))) {
                        await this.lib.fs.unlink(js);
                        sidecars++;
                    }
                }
                await this.pruneEmptyParents(f.path);
            } catch (e: any) {
                failed++;
                await this.lib.std.print(`⚠️  Failed to remove ${f.path}: ${e.message}\n`);
            }

            if (f.hostDst) {
                // Kernel tidak punya syscall untuk menghapus file HOST; laporkan jujur.
                hostManual++;
                await this.lib.std.print(`⚠️  Host file must be removed manually: ${f.hostDst}\n`);
            }
        }

        if (cancelled) {
            await this.lib.std.print(
                `\n⏹️  Cancelled. ${removed} file(s) removed, ${kept} skipped — package status NOT changed.\n` +
                `   Run 'tpkg remove ${pkgName}' again to continue.\n`,
            );
            return;
        }

        delete status[pkgName];
        await this.saveStatus(status);
        // Manifest tidak relevan lagi setelah paket dilepas.
        try {
            await this.lib.fs.unlink(this.installedManifestPath(pkgName));
        } catch (e) {
            /* best-effort */
        }

        await this.lib.std.print(
            `\n✅ Package '${pkgName}' removed: ${removed} file(s)` +
            `${sidecars > 0 ? `, ${sidecars} .js sidecar(s)` : ""}` +
            `${shared > 0 ? `, ${shared} shared file(s) kept` : ""}` +
            `${kept > 0 ? `, ${kept} config file(s) kept` : ""}` +
            `${failed > 0 ? `, ${failed} failed` : ""}` +
            `${hostManual > 0 ? `, ${hostManual} host file(s) need manual removal` : ""}.\n`,
        );
    }

    /** runScript(): jalankan skrip paket (undo) dan laporkan hasilnya. */
    private async runScript(script: string, args: string[]) {
        await this.lib.std.print(`Running ${script}...\n`);
        try {
            const proc = await this.lib.shell.exec(script, args);
            const code = await this.lib.shell.waitpid(proc.pid);
            if (code !== 0) await this.lib.std.print(`⚠️  ${script} exited with code ${code}\n`);
        } catch (e: any) {
            await this.lib.std.print(`⚠️  ${script} failed: ${e.message}\n`);
        }
    }

    private async loadStatus(): Promise<Record<string, string>> {
        if (!(await this.exists(this.statusFile))) return {};
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

    /**
     * readMaybe(): baca file, `null` kalau tidak ada.
     *
     * `fs.readFile` di VFS asli MELEMPAR `File not found` untuk file yang tidak
     * ada (bukan return null). Memanggilnya langsung untuk file yang mungkin belum
     * ada — mis. manifest paket yang belum pernah dipasang — membuat tpkg crash.
     */
    private async readMaybe(path: string): Promise<string | null> {
        try {
            if (!(await this.exists(path))) return null;
            const content = await this.lib.fs.readFile(path);
            return content === undefined ? null : content;
        } catch (e) {
            return null;
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

    /**
     * checkTrusted(): status kunci repo untuk host ini menurut
     * `/etc/tpkg/trusted_repos` (format per baris: `<host> <sha256-hex-64>`,
     * seperti known_hosts).
     *   - "trusted":  ada entri untuk host ini dan cocok dengan kuncinya;
     *   - "mismatch": ada entri untuk host ini tapi tidak ada yang cocok;
     *   - "unknown":  belum ada entri untuk host ini (TOFU).
     * Baris format lama (fingerprint saja, tanpa host) diabaikan: tidak terikat
     * ke host, jadi tidak bisa dipakai memutuskan kepercayaan.
     */
    private async checkTrusted(host: string, publicKeyPem: string): Promise<"trusted" | "mismatch" | "unknown"> {
        if (!(await this.exists(this.trustedRepos))) return "unknown";
        const list = (await this.lib.fs.readFile(this.trustedRepos)) || "";
        let seen = false;
        for (const line of list.split("\n")) {
            const [h, fp, extra] = line.trim().split(/\s+/);
            if (!h || !fp || extra !== undefined || h !== host) continue;
            seen = true;
            if (SecurityAgent.verifyPinnedKey(publicKeyPem, fp)) return "trusted";
        }
        return seen ? "mismatch" : "unknown";
    }

    private async addTrusted(host: string, fp: string) {
        let list = "";
        if (await this.exists(this.trustedRepos)) {
            list = (await this.lib.fs.readFile(this.trustedRepos)) || "";
        }
        if (list && !list.endsWith("\n")) list += "\n";
        await this.lib.fs.writeFile(this.trustedRepos, list + `${host} ${fp}\n`);
    }

    private async loadConfig(): Promise<any> {
        if (!(await this.exists(this.configFile))) return {};
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
        if (path === "/" || path === "" || (await this.exists(path))) return;
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
            .filter((name) => name !== input)
            .slice(0, 3);
    }
}
