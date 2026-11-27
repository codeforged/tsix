import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

// Di VFS, program memuat esbuild host lewat `global.require` (disediakan
// WorkerEntry). tpkgd memakainya untuk meng-compile bundle binary.
(globalThis as any).require ??= createRequire(import.meta.url);
import { Main as TpkgClient, HOST_STAGE_DIR } from "./tpkg";
import { Main as TpkgDaemon } from "./tpkgd";
import { execModeForPath, parseDependency, planInstall, type TpkgPackage } from "@tsix/TpkgProtocol";
import { SecurityAgent } from "@common/SecurityAgent";

/**
 * TPKG end-to-end (P2) — klien `tpkg` ↔ daemon `tpkgd` lewat MQTNL TIRUAN.
 *
 * Dunia palsu ini meniru yang penting saja:
 *   - `net`: socket/bind/sendto/recv antar DUA node (fs terpisah per node),
 *     sehingga alur handshake → LIST → GET_BUNDLE benar-benar dijalankan;
 *   - `fs`: VFS in-memory per node + pencatatan mode (chmod);
 *   - `shell`/`std`: whoami, exec (dicatat), read (jawaban antre), print/log.
 *
 * Catatan: RSA keygen asli tetap dipakai (SecurityAgent) supaya jalur
 * signature benar-benar diuji — bukan mock.
 */

type Packet = { src: string; port: number; localPort: number; data: any };

interface NodeFs {
    files: Map<string, string>;
    dirs: Set<string>;
    modes: Map<string, number>;
}

/** World: dua node (client & server) + jaringan loopback di antara keduanya. */
class World {
    public nodes = new Map<string, NodeFs>();
    /**
     * "HOST FS" palsu — file di luar VFS (kernel & komponen engine).
     * Dipakai `syncToHost`/`syncFromHost`; per node supaya uji rollback bisa
     * memeriksa bahwa isi lama benar-benar kembali.
     */
    public hostFiles = new Map<string, string>();
    public hostSyncs: Array<{ op: "to" | "from"; hostPath: string }> = [];
    /** Kalau diisi, `syncToHost` untuk hostPath ini mengembalikan false (uji gagal). */
    public failHostSync: string | null = null;
    public prints: string[] = [];
    public logs: string[] = [];
    public execs: Array<{ node: string; cmd: string }> = [];
    public answers: string[] = [];
    public ioctls: Array<{ cmd: number; arg: any }> = [];
    public execExit = 0;
    public stopped = false;
    /** Hook dipanggil setiap kali paket dikirim (dipakai uji misroute). */
    public onDeliver: ((to: string, port: number, pkt: Packet) => void) | null = null;

    private inbox = new Map<string, Packet[]>();
    private fdPort = new Map<number, number>();
    private fdNode = new Map<number, string>();
    private nextFd = 3;
    private nextPort = 10000;

    constructor(
        public readonly clientNode = "client",
        public readonly serverNode = "server",
    ) {
        for (const n of [clientNode, serverNode]) {
            this.nodes.set(n, {
                files: new Map(),
                dirs: new Set(["/", "/etc", "/var", "/bin", "/opt"]),
                modes: new Map(),
            });
        }
    }

    public fs(node: string): NodeFs {
        return this.nodes.get(node)!;
    }

    private key(node: string, port: number): string {
        return `${node}:${port}`;
    }

    private queue(node: string, port: number): Packet[] {
        const k = this.key(node, port);
        if (!this.inbox.has(k)) this.inbox.set(k, []);
        return this.inbox.get(k)!;
    }

    /** deliver(): Kirim paket ke node tujuan pada port tujuan. */
    public deliver(node: string, port: number, pkt: Packet) {
        this.queue(node, port).push(pkt);
        this.onDeliver?.(node, port, pkt);
    }

    /** queueSize(): Jumlah paket yang masih menunggu di inbox node:port. */
    public queueSize(node: string, port: number): number {
        return this.queue(node, port).length;
    }

    public makeLib(node: string, opts: { uid?: number } = {}) {
        const world = this;
        const fs = this.fs(node);

        return {
            std: {
                print: async (s: string) => void world.prints.push(s),
                log: async (s: string) => void world.logs.push(s),
                println: async (s: string) => void world.prints.push(s + "\n"),
                read: async (prompt?: string) => {
                    if (prompt) world.prints.push(prompt);
                    return world.answers.shift() ?? "y";
                },
            },
            shell: {
                whoami: async () => ({
                    uid: opts.uid ?? 0,
                    gid: 0,
                    username: (opts.uid ?? 0) === 0 ? "root" : "user",
                }),
                daemonize: async () => {},
                exec: async (cmd: string) => {
                    world.execs.push({ node, cmd });
                    return { pid: 4242 };
                },
                waitpid: async () => world.execExit,
            },
            net: {
                socket: async () => {
                    const fd = world.nextFd++;
                    world.fdNode.set(fd, node);
                    return fd;
                },
                bind: async (fd: number, port: number) => {
                    const actual = port === 0 ? world.nextPort++ : port;
                    world.fdPort.set(fd, actual);
                    return actual;
                },
                ioctl: async (_fd: number, cmd: number, arg: any) => {
                    world.ioctls.push({ cmd, arg });
                    return true;
                },
                sendto: async (fd: number, address: string, port: number, data: any) => {
                    const from = world.fdPort.get(fd) ?? 0;
                    world.deliver(address, port, { src: node, port: from, localPort: port, data });
                    return true;
                },
                recv: async (fd: number) => {
                    const port = world.fdPort.get(fd);
                    if (port === undefined) return null;
                    // Beri kesempatan paket datang (meniru socket), lalu null-kan.
                    for (let i = 0; i < 4; i++) {
                        const q = world.queue(node, port);
                        if (q.length > 0) return q.shift()!;
                        await new Promise((r) => setTimeout(r, 1));
                    }
                    if (world.stopped) throw new Error("STOP"); // hentikan loop daemon
                    return null;
                },
                close: async (fd: number) => {
                    world.fdPort.delete(fd);
                    return true;
                },
            },
            fs: {
                // Sama seperti VFS asli: file yang tidak ada MELEMPAR, bukan null.
                // (Dulu tiruan ini return null, sehingga crash nyata
                // `File not found: /var/lib/tpkg/installed/<pkg>.json` lolos dari test.)
                readFile: async (path: string) => {
                    if (!fs.files.has(path)) throw new Error(`File not found: ${path}`);
                    return fs.files.get(path)!;
                },
                writeFile: async (path: string, content: string) => {
                    fs.files.set(path, content);
                    return true;
                },
                mkdir: async (path: string) => {
                    fs.dirs.add(path);
                    return true;
                },
                stat: async (path: string) => {
                    if (fs.files.has(path)) {
                        return {
                            name: path.split("/").pop(),
                            type: "FILE",
                            size: fs.files.get(path)!.length,
                            mode: fs.modes.get(path) ?? 0o644,
                        };
                    }
                    if (fs.dirs.has(path)) {
                        return { name: path.split("/").pop() || "/", type: "DIRECTORY", size: 0, mode: 0o755 };
                    }
                    return null;
                },
                ls: async (dir: string) => {
                    const prefix = dir.endsWith("/") ? dir : dir + "/";
                    const out: any[] = [];
                    for (const p of fs.files.keys()) {
                        if (!p.startsWith(prefix)) continue;
                        const rest = p.slice(prefix.length);
                        if (rest.includes("/") || rest === "") continue;
                        out.push({ name: rest, type: "FILE", size: fs.files.get(p)!.length });
                    }
                    for (const d of fs.dirs) {
                        if (d === dir || !d.startsWith(prefix)) continue;
                        const rest = d.slice(prefix.length);
                        if (rest.includes("/") || rest === "") continue;
                        out.push({ name: rest, type: "DIRECTORY", size: 0 });
                    }
                    return out;
                },
                unlink: async (path: string) => fs.files.delete(path),
                rmdir: async (path: string) => fs.dirs.delete(path),
                chmod: async (path: string, mode: number) => {
                    fs.modes.set(path, mode);
                    return true;
                },
                getMounts: async () => [],
                // --- HOST FS (di luar VFS): dipakai paket engine ---
                syncToHost: async (vfsPath: string, hostPath: string) => {
                    if (world.failHostSync === hostPath) return false;
                    if (!fs.files.has(vfsPath)) return false;
                    world.hostFiles.set(hostPath, fs.files.get(vfsPath)!);
                    world.hostSyncs.push({ op: "to", hostPath });
                    return true;
                },
                syncFromHost: async (hostPath: string, vfsPath: string) => {
                    if (!world.hostFiles.has(hostPath)) {
                        throw new Error(`Host file not found: ${hostPath}`);
                    }
                    fs.files.set(vfsPath, world.hostFiles.get(hostPath)!);
                    world.hostSyncs.push({ op: "from", hostPath });
                    return true;
                },
            },
        };
    }
}

/** setupServer(): tulis manifest + file sumber paket di node server. */
function setupServer(world: World, pkg?: Partial<TpkgPackage>) {
    const fs = world.fs(world.serverNode);
    const entry: TpkgPackage = {
        name: "hello-world",
        version: "1.0.0",
        description: "Sample package",
        author: "test",
        onAfterDownload: "/opt/test/hello-pkg.ts",
        items: [
            { src: "/opt/test/hello-pkg.ts", dst: "/opt/test/hello-pkg.ts", isExecutable: true },
            { src: "/etc/pkg-demo.conf", dst: "/etc/pkg-demo.conf" },
        ],
        ...pkg,
    };

    fs.files.set("/opt/test/hello-pkg.ts", "#!/bin/tsh\nprint HALO\n");
    fs.files.set("/etc/pkg-demo.conf", "version=1.0\nmode=demo");
    const manifest = JSON.stringify({ version: "1.0", packages: [entry] }, null, 2);
    fs.files.set("/etc/tpkg/packages.json", manifest);

    // Pra-isi katalog di sisi KLIEN (hasil `tpkg update`) supaya test instalasi
    // tidak perlu satu session RSA ekstra. Jalur `update` sendiri diuji di P2.03.
    world
        .fs(world.clientNode)
        .files.set(
            "/var/cache/tpkg/repo.json",
            JSON.stringify([
                { name: entry.name, version: entry.version, description: entry.description, author: entry.author },
            ]),
        );
    return entry;
}

/** mkPkg(): paket ringkas untuk repo multi-paket. */
function mkPkg(name: string, version: string, dsts: string[], extra: Partial<TpkgPackage> = {}): TpkgPackage {
    return {
        name,
        version,
        description: `${name} package`,
        author: "test",
        items: dsts.map((d) => ({ src: d, dst: d })),
        ...extra,
    };
}

/**
 * setupRepo(): manifest berisi beberapa paket + isi file sumbernya di server,
 * dan katalog yang sama (termasuk `depends`) di klien.
 */
function setupRepo(world: World, pkgs: TpkgPackage[], files: Record<string, string>) {
    const fs = world.fs(world.serverNode);
    for (const [p, c] of Object.entries(files)) fs.files.set(p, c);
    fs.files.set("/etc/tpkg/packages.json", JSON.stringify({ version: "1.0", packages: pkgs }, null, 2));
    world.fs(world.clientNode).files.set(
        "/var/cache/tpkg/repo.json",
        JSON.stringify(
            pkgs.map((p) => ({
                name: p.name,
                version: p.version,
                description: p.description,
                ...(p.depends ? { depends: p.depends } : {}),
            })),
        ),
    );
}

/** startDaemon(): jalankan tpkgd di background (loop tak pernah selesai). */
async function startDaemon(world: World, args: string[] = []) {
    const lib = world.makeLib(world.serverNode);
    const daemon = new TpkgDaemon();
    const running = daemon.execute(lib as any, args).catch(() => {});
    await settle();
    return { daemon, running };
}

/** settle(): beri kesempatan microtask/timer singkat selesai. */
async function settle(ms = 5) {
    await new Promise((r) => setTimeout(r, ms));
}

async function stopDaemon(world: World, running: Promise<void>) {
    world.stopped = true;
    await running;
}

const out = (world: World) => world.prints.join("");

// Handshake nyata = generate RSA 2048-bit, dan itu bisa >5 detik kalau seluruh
// suite berjalan paralel (CPU rebutan) → timeout default 5s bikin test "flaky".
describe("TPKG end-to-end (P2)", { timeout: 30_000 }, () => {
    let world: World;
    let daemonRun: Promise<void> | null = null;

    beforeEach(() => {
        world = new World();
    });

    afterEach(async () => {
        if (daemonRun) await stopDaemon(world, daemonRun);
        daemonRun = null;
    });

    async function boot(args: string[] = []) {
        const started = await startDaemon(world, args);
        daemonRun = started.running;
        return started;
    }

    it("P2.01 tpkgd --help menyebut port/repo/max-bundle", async () => {
        const lib = world.makeLib(world.serverNode);
        await new TpkgDaemon().execute(lib as any, ["--help"]);

        const text = out(world);
        expect(text).toContain("--port");
        expect(text).toContain("--repo");
        expect(text).toContain("--max-bundle");
    });

    it("P2.02 tpkgd --port tidak valid → pesan jelas, tidak bind", async () => {
        const lib = world.makeLib(world.serverNode);
        await new TpkgDaemon().execute(lib as any, ["--port", "abc"]);

        expect(out(world)).toMatch(/invalid --port/);
        expect(world.ioctls).toHaveLength(0);
    });

    it("P2.03 tpkg update → katalog tersimpan & signature terverifikasi", async () => {
        setupServer(world);
        await boot();

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["update", "server"]);

        const text = out(world);
        expect(text).toContain("Successfully updated");
        expect(text).toContain("(Verified)");

        const catalog = world.fs(world.clientNode).files.get("/var/cache/tpkg/repo.json")!;
        expect(JSON.parse(catalog)[0].name).toBe("hello-world");
    });

    it("P2.04 first install backs up safely when readFile rejects missing destinations", async () => {
        setupServer(world);
        await boot();
        const lib = world.makeLib(world.clientNode) as any;
        const readFile = lib.fs.readFile;
        lib.fs.readFile = async (path: string) => {
            if (["/opt/test/hello-pkg.ts", "/etc/pkg-demo.conf"].includes(path)) {
                throw new Error(`File not found: ${path}`);
            }
            return readFile(path);
        };

        await new TpkgClient().execute(lib, ["install", "hello-world", "--from", "server"]);

        const fs = world.fs(world.clientNode);
        const text = out(world);

        expect(text).toContain("(Verified");
        // Ada post-install → pesan suksesnya lewat jalur post-install.
        expect(text).toContain("Package installed");
        expect(text).toContain("Post-install finished");

        // 1) isi file terpasang
        expect(fs.files.get("/opt/test/hello-pkg.ts")).toBe("#!/bin/tsh\nprint HALO\n");
        expect(fs.files.get("/etc/pkg-demo.conf")).toBe("version=1.0\nmode=demo");

        // 2) mode dari manifest `isExecutable` benar-benar diterapkan
        expect(fs.modes.get("/opt/test/hello-pkg.ts")).toBe(0o755);
        expect(fs.modes.get("/etc/pkg-demo.conf")).toBeUndefined();

        // 3) versi tercatat
        expect(JSON.parse(fs.files.get("/var/lib/tpkg/status.json")!)["hello-world"]).toBe("1.0.0");

        // 4) post-install dijalankan (bukan dilewati)
        expect(world.execs.map((e) => e.cmd)).toContain("/opt/test/hello-pkg.ts");

        // 5) backup dibuat di disk sebelum menimpa
        const backups = await lib.fs.ls("/var/lib/tpkg/backup/hello-world");
        expect(backups).toHaveLength(1);
    });

    it("P2.05 file sumber hilang → ERROR jelas & TIDAK ada file setengah terpasang", async () => {
        setupServer(world, {
            items: [
                { src: "/opt/test/hello-pkg.ts", dst: "/opt/test/hello-pkg.ts", isExecutable: true },
                { src: "/etc/hilang.conf", dst: "/etc/hilang.conf" },
            ],
        });
        await boot();

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "install",
            "hello-world",
            "--from",
            "server",
        ]);

        const text = out(world);
        expect(text).toMatch(/source file not found/);

        const fs = world.fs(world.clientNode);
        expect(fs.files.has("/opt/test/hello-pkg.ts")).toBe(false);
        expect(fs.files.has("/etc/hilang.conf")).toBe(false);
    });

    it("P2.06 bundle melebihi --max-bundle → ditolak server dengan pesan batas", async () => {
        setupServer(world);
        await boot(["--max-bundle", "10"]);

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "install",
            "hello-world",
            "--from",
            "server",
        ]);

        expect(out(world)).toMatch(/exceeds limit/);
        expect(world.fs(world.clientNode).files.has("/opt/test/hello-pkg.ts")).toBe(false);
    });

    it("P2.07 'tpkg rollback' sudah dihapus (pakai 'tpkg remove')", async () => {
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["rollback", "hello-world"]);
        expect(out(world)).toMatch(/Unknown command: rollback/);
        expect(out(world)).not.toMatch(/tpkg rollback/);
    });

    it("P2.08 tpkg download menyimpan bundle terverifikasi TANPA post-install", async () => {
        setupServer(world);
        await boot();

        const before = world.execs.length;
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "download",
            "hello-world",
            "--from",
            "server",
        ]);

        const text = out(world);
        expect(text).toMatch(/Saved \(verified\)/);

        const fs = world.fs(world.clientNode);
        expect(fs.files.has("/var/cache/tpkg/bundles/hello-world/1.0.0/files/opt/test/hello-pkg.ts")).toBe(true);
        // Tidak memasang ke tujuan…
        expect(fs.files.has("/opt/test/hello-pkg.ts")).toBe(false);
        // …dan post-install tidak dijalankan (bug lama `tsd download`).
        expect(world.execs.length).toBe(before);
    });

    it("P2.09 paket nyasar dari sumber lain diabaikan (dulu bikin 'malformed response')", async () => {
        setupServer(world);
        await boot();

        // Setiap request klien, sisipkan decoy JSON valid dari node asing.
        world.onDeliver = (_to, port, pkt) => {
            if (pkt.src !== world.clientNode || port !== 80) return;
            world.deliver(world.clientNode, pkt.port, {
                src: "intruder",
                port: 9999,
                localPort: pkt.port,
                data: JSON.stringify({ type: "PING" }),
            });
        };

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["update", "server"]);

        expect(out(world)).toContain("Successfully updated");
    });

    it("P2.10 request tanpa handshake diabaikan (server tidak membalas)", async () => {
        setupServer(world);
        await boot();

        world.deliver(world.serverNode, 80, {
            src: "penyusup",
            port: 5555,
            localPort: 80,
            data: "bukan-session-apa-pun",
        });
        await settle(150);

        expect(world.queueSize(world.serverNode, 5555)).toBe(0);
        expect(out(world)).not.toContain("Handshake");
    });

    it("P2.11 host:port dipakai apa adanya (bukan selalu port 80)", async () => {
        setupServer(world);
        const { daemon } = await boot(["--port", "8090"]);

        // Bukti kuat & cepat: daemon HANYA mendengarkan di 8090 (tidak ada listener
        // di 80), jadi `--from server:8090` yang berhasil membuktikan port dari
        // spec benar-benar dipakai — bukan hardcode 80 seperti versi lama.
        expect(world.ioctls.map((i) => i.arg.port)).toContain(8090);

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["update", "server:8090"]);
        expect(out(world)).toContain("Successfully updated");
        expect((daemon as any).sessions.size).toBe(1);
    });

    // ========================================================================
    // PAKET ENGINE — menulis ke HOST FS (kernel & komponennya)
    //
    // Ini jalur paling berbahaya: file di luar VFS. Yang diuji bukan cuma
    // "berhasil menulis", tapi juga bahwa yang GAGAL tidak meninggalkan sistem
    // separuh ter-update, dan bahwa non-root tidak bisa melakukannya.
    // ========================================================================

    it("P2.12 paket engine menulis ke host + backup + tetap ke VFS", async () => {
        setupServer(world, {
            name: "engine",
            version: "9.9.9",
            onAfterDownload: undefined,
            items: [
                { src: "/bin/init.ts", dst: "/bin/init.ts", isExecutable: true, hostDst: "src/mirror/bin/init.ts" },
                {
                    src: "/tmp/tpkg-stage/kernel/Kernel.ts",
                    dst: "/tmp/tpkg-stage/kernel/Kernel.ts",
                    hostDst: "src/kernel/Kernel.ts",
                },
            ],
        });
        const serverFs = world.fs(world.serverNode);
        serverFs.files.set("/bin/init.ts", "// init v2");
        serverFs.files.set("/tmp/tpkg-stage/kernel/Kernel.ts", "// kernel v3");

        // Isi host SEBELUM update (harus dibackup supaya rollback mungkin).
        world.hostFiles.set("src/kernel/Kernel.ts", "// kernel LAMA");
        world.hostFiles.set("src/mirror/bin/init.ts", "// init LAMA");

        await boot();
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "install",
            "engine",
            "--from",
            "server",
        ]);

        const text = out(world);
        // Konfirmasi tulis-host ditampilkan (bukan diam-diam menulis).
        expect(text).toMatch(/writes to the HOST FS/);
        expect(text).toMatch(/src\/kernel\/Kernel\.ts/);

        // VFS ter-update…
        const fs = world.fs(world.clientNode);
        expect(fs.files.get("/bin/init.ts")).toBe("// init v2");
        // …dan HOST ikut ter-update.
        expect(world.hostFiles.get("src/kernel/Kernel.ts")).toBe("// kernel v3");
        expect(world.hostFiles.get("src/mirror/bin/init.ts")).toBe("// init v2");

        // Backup host memakai syncFromHost (isi lama terbaca dari host).
        expect(world.hostSyncs.filter((s) => s.op === "from").map((s) => s.hostPath)).toContain("src/kernel/Kernel.ts");
        const backups = await world.makeLib(world.clientNode).fs.ls("/var/lib/tpkg/backup/engine");
        expect(backups).toHaveLength(1);
    });

    // SEC-28: staging file host tidak boleh di /tmp (1777, bisa ditulis user mana pun).
    it("P2.12b staging file host dipindah dari /tmp ke direktori khusus root", async () => {
        setupServer(world, {
            name: "engine",
            version: "9.9.9",
            onAfterDownload: undefined,
            items: [
                {
                    src: "/tmp/tpkg-stage/kernel/Kernel.ts",
                    dst: "/tmp/tpkg-stage/kernel/Kernel.ts",
                    hostDst: "src/kernel/Kernel.ts",
                },
            ],
        });
        world.fs(world.serverNode).files.set("/tmp/tpkg-stage/kernel/Kernel.ts", "// kernel v3");
        world.hostFiles.set("src/kernel/Kernel.ts", "// kernel LAMA");

        await boot();
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["install", "engine", "--from", "server"]);

        const fs = world.fs(world.clientNode);
        expect(world.hostFiles.get("src/kernel/Kernel.ts")).toBe("// kernel v3");
        expect(fs.files.has("/tmp/tpkg-stage/kernel/Kernel.ts")).toBe(false);
        expect(fs.files.get(`${HOST_STAGE_DIR}/kernel/Kernel.ts`)).toBe("// kernel v3");
        expect(fs.modes.get(HOST_STAGE_DIR)).toBe(0o700);
    });

    it("P2.12c file host dengan path VFS lain di /tmp ditolak", async () => {
        setupServer(world, {
            name: "engine",
            version: "9.9.9",
            onAfterDownload: undefined,
            items: [{ src: "/tmp/other/K.ts", dst: "/tmp/other/K.ts", hostDst: "src/kernel/Kernel.ts" }],
        });
        world.fs(world.serverNode).files.set("/tmp/other/K.ts", "// kernel v3");
        world.hostFiles.set("src/kernel/Kernel.ts", "// kernel LAMA");

        await boot();
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["install", "engine", "--from", "server"]);

        expect(world.hostFiles.get("src/kernel/Kernel.ts")).toBe("// kernel LAMA");
        expect(world.hostSyncs.filter((s) => s.op === "to")).toHaveLength(0);
        expect(out(world)).toMatch(/world-writable/);
    });

    it("tpkgd preserves UTF-8 host package bytes without a /hostsrc VFS mount", async () => {
        setupServer(world, {
            name: "base-system",
            version: "0.3.3",
            onAfterDownload: undefined,
            items: [
                {
                    src: "/hostsrc/kernel/Kernel.ts",
                    dst: "/tmp/tpkg-stage/kernel/Kernel.ts",
                    hostDst: "src/kernel/Kernel.ts",
                },
            ],
        });
        const hostText = "\uFEFF// kernel café — 東京\n";
        const hostBytes = Buffer.from(hostText, "utf8");
        const hostVfsBytes = hostBytes.toString("latin1");
        world.hostFiles.set("src/kernel/Kernel.ts", hostVfsBytes);

        await boot();
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "install",
            "base-system",
            "--from",
            "server",
        ]);

        expect(out(world)).toContain("Installation successful");
        const clientBytes = world.fs(world.clientNode).files.get(`${HOST_STAGE_DIR}/kernel/Kernel.ts`);
        expect(Buffer.from(clientBytes!, "latin1")).toEqual(hostBytes);
        expect(Buffer.from(clientBytes!, "latin1").toString("utf8")).toBe(hostText);
        expect(world.hostFiles.get("src/kernel/Kernel.ts")).toBe(hostVfsBytes);
        expect(
            world.hostSyncs.filter((sync) => sync.op === "from" && sync.hostPath === "src/kernel/Kernel.ts"),
        ).toHaveLength(2);
    });

    it("P2.13 konfirmasi tulis-host ditolak → tidak ada yang berubah", async () => {
        setupServer(world, {
            name: "engine",
            version: "9.9.9",
            onAfterDownload: undefined,
            items: [{ src: "/bin/init.ts", dst: "/bin/init.ts", hostDst: "src/mirror/bin/init.ts" }],
        });
        world.fs(world.serverNode).files.set("/bin/init.ts", "// init v2");
        world.hostFiles.set("src/mirror/bin/init.ts", "// init LAMA");

        await boot();
        // Jawaban: [0] = prompt TOFU fingerprint ("y"), [1] = konfirmasi tulis-host (kosong = TIDAK).
        world.answers = ["y", ""];

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "install",
            "engine",
            "--from",
            "server",
        ]);

        expect(out(world)).toMatch(/Installation aborted/);
        expect(world.hostFiles.get("src/mirror/bin/init.ts")).toBe("// init LAMA");
        expect(world.fs(world.clientNode).files.has("/bin/init.ts")).toBe(false);
    });

    it("P2.14 gagal sync ke host → VFS dipulihkan (tidak separuh ter-update)", async () => {
        setupServer(world, {
            name: "engine",
            version: "9.9.9",
            onAfterDownload: undefined,
            items: [{ src: "/bin/init.ts", dst: "/bin/init.ts", hostDst: "src/kernel/Kernel.ts" }],
        });
        world.fs(world.serverNode).files.set("/bin/init.ts", "// init v2");
        world.fs(world.clientNode).files.set("/bin/init.ts", "// init LAMA");
        world.hostFiles.set("src/kernel/Kernel.ts", "// kernel LAMA");
        world.failHostSync = "src/kernel/Kernel.ts";

        await boot();
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "install",
            "engine",
            "--from",
            "server",
        ]);

        expect(out(world)).toMatch(/Write failed/);
        // VFS kembali ke isi lama — bukan tertinggal versi baru tanpa host-nya.
        expect(world.fs(world.clientNode).files.get("/bin/init.ts")).toBe("// init LAMA");
        expect(world.hostFiles.get("src/kernel/Kernel.ts")).toBe("// kernel LAMA");
    });

    it("P2.16 server menolak manifest dengan hostDst tidak aman", async () => {
        setupServer(world, {
            name: "jahat",
            version: "1.0.0",
            onAfterDownload: undefined,
            items: [{ src: "/bin/init.ts", dst: "/bin/init.ts", hostDst: "../../etc/shadow" }],
        });
        world.fs(world.serverNode).files.set("/bin/init.ts", "// x");

        await boot();
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "install",
            "jahat",
            "--from",
            "server",
        ]);

        // Gagal, dan tidak ada file host yang tersentuh di luar root proyek.
        expect([...world.hostFiles.keys()]).not.toContain("../../etc/shadow");
        expect(world.fs(world.clientNode).files.has("/bin/init.ts")).toBe(false);
    });

    it("P2.17 tpkg menolak perintah pengubah sistem saat non-root", async () => {
        setupServer(world);
        await boot();

        for (const cmd of ["install", "upgrade", "remove", "update", "download"]) {
            world.prints.length = 0;
            await new TpkgClient().execute(world.makeLib(world.clientNode, { uid: 1000 }) as any, [
                cmd,
                "hello-world",
                "--from",
                "server",
            ]);
            expect(out(world)).toMatch(/requires root privileges/);
        }

        // Bukti tambahan: tidak ada file yang ditulis ke VFS klien.
        expect(world.fs(world.clientNode).files.has("/opt/test/hello-pkg.ts")).toBe(false);
    });

    it("P2.18 tpkgd menolak dijalankan non-root", async () => {
        const lib = world.makeLib(world.serverNode, { uid: 1000 });
        await new TpkgDaemon().execute(lib as any, ["--port", "8091"]);

        expect(out(world)).toMatch(/tpkgd requires root privileges/);
        expect(world.ioctls).toHaveLength(0); // tidak bind, tidak pin protokol
    });

    it("P2.19 tpkg remove menghapus file & menandai konfigurasi yang dimodifikasi", async () => {
        setupServer(world);
        await boot();
        const lib = world.makeLib(world.clientNode) as any;
        const fs = world.fs(world.clientNode);

        await new TpkgClient().execute(lib, ["install", "hello-world", "--from", "server"]);
        expect(fs.files.has("/opt/test/hello-pkg.ts")).toBe(true);
        // Manifest file terpasang dicatat (dasar `tpkg remove`).
        expect(fs.files.has("/var/lib/tpkg/installed/hello-world.json")).toBe(true);

        world.prints.length = 0;
        // Ubah konfigurasi setelah install → hash beda → harus ditandai "(dimodifikasi)".
        fs.files.set("/etc/pkg-demo.conf", "version=9.9\nmode=local");
        world.answers.push("r"); // hapus konfigurasi ini

        await new TpkgClient().execute(lib, ["remove", "hello-world"]);

        const text = out(world);
        expect(text).toContain("(modified)");
        // File biasa langsung dihapus tanpa tanya.
        expect(fs.files.has("/opt/test/hello-pkg.ts")).toBe(false);
        // Konfigurasi dihapus setelah konfirmasi `remove`.
        expect(fs.files.has("/etc/pkg-demo.conf")).toBe(false);
        // Status & manifest dibersihkan.
        expect(JSON.parse(fs.files.get("/var/lib/tpkg/status.json")!)).toEqual({});
        expect(fs.files.has("/var/lib/tpkg/installed/hello-world.json")).toBe(false);
    });

    it("P2.20 tpkg remove cancel → konfigurasi dibiarkan, status paket tidak diubah", async () => {
        setupServer(world);
        await boot();
        const lib = world.makeLib(world.clientNode) as any;
        const fs = world.fs(world.clientNode);

        await new TpkgClient().execute(lib, ["install", "hello-world", "--from", "server"]);

        world.prints.length = 0;
        world.answers.push("c"); // cancel saat tiba di konfigurasi
        await new TpkgClient().execute(lib, ["remove", "hello-world"]);

        expect(out(world)).toMatch(/Cancelled/);
        // Berkas konfigurasi tetap ada…
        expect(fs.files.has("/etc/pkg-demo.conf")).toBe(true);
        // …status paket tetap (belum benar-benar dilepas)…
        expect(JSON.parse(fs.files.get("/var/lib/tpkg/status.json")!)["hello-world"]).toBe("1.0.0");
        // …dan manifest masih ada untuk melanjutkan remove berikutnya.
        expect(fs.files.has("/var/lib/tpkg/installed/hello-world.json")).toBe(true);
    });

    // ========================================================================
    // REMOVE — sidecar .js & file bersama
    // ========================================================================

    it("P2.21 tpkg remove ikut menghapus sidecar .js hasil transpile", async () => {
        setupServer(world);
        await boot();
        const lib = world.makeLib(world.clientNode) as any;
        const fs = world.fs(world.clientNode);

        await new TpkgClient().execute(lib, ["install", "hello-world", "--from", "server"]);
        // Disimulasikan: post-install `transpile` membangun sidecar di samping .ts.
        fs.files.set("/opt/test/hello-pkg.js", "// built");
        // File .js lain yang BUKAN pasangan .ts paket ini tidak boleh tersentuh.
        fs.files.set("/opt/test/lain.js", "// milik orang lain");

        world.prints.length = 0;
        world.answers.push("r");
        await new TpkgClient().execute(lib, ["remove", "hello-world"]);

        expect(fs.files.has("/opt/test/hello-pkg.ts")).toBe(false);
        expect(fs.files.has("/opt/test/hello-pkg.js")).toBe(false);
        expect(fs.files.get("/opt/test/lain.js")).toBe("// milik orang lain");
        expect(out(world)).toMatch(/1 \.js sidecar/);
    });

    it("P2.22 tpkg remove tidak menghapus file yang juga dipasang paket lain", async () => {
        setupRepo(
            world,
            [
                mkPkg("app", "1.0.0", ["/opt/app/app.ts", "/lib/shared.ts"]),
                mkPkg("tool", "1.0.0", ["/opt/tool/tool.ts", "/lib/shared.ts"]),
            ],
            { "/opt/app/app.ts": "// app", "/opt/tool/tool.ts": "// tool", "/lib/shared.ts": "// shared" },
        );
        await boot();
        const lib = world.makeLib(world.clientNode) as any;
        const fs = world.fs(world.clientNode);

        await new TpkgClient().execute(lib, ["install", "app", "tool", "--from", "server"]);
        fs.files.set("/lib/shared.js", "// built");

        world.prints.length = 0;
        await new TpkgClient().execute(lib, ["remove", "tool"]);

        expect(fs.files.has("/opt/tool/tool.ts")).toBe(false);
        expect(fs.files.get("/lib/shared.ts")).toBe("// shared");
        expect(fs.files.has("/lib/shared.js")).toBe(true);
        expect(out(world)).toMatch(/also installed by app/);
    });

    // ========================================================================
    // POST-INSTALL — wajib dikonfirmasi
    // ========================================================================

    it("P2.23 post-install ditolak → skrip TIDAK dijalankan, sidecar basi diperingatkan", async () => {
        setupServer(world, { onAfterDownload: "/sbin/transpile.ts" });
        await boot();
        const fs = world.fs(world.clientNode);
        fs.files.set("/opt/test/hello-pkg.js", "// sidecar versi lama");
        world.answers = ["y", "n"]; // [0] fingerprint, [1] post-install

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "install",
            "hello-world",
            "--from",
            "server",
        ]);

        const text = out(world);
        expect(world.execs).toHaveLength(0);
        expect(text).toMatch(/system script, not part of this package/);
        expect(text).toMatch(/Skipping post-install/);
        expect(text).toMatch(/sudo \/sbin\/transpile\.ts \/opt\/test\/hello-pkg\.ts/);
        expect(text).toMatch(/keep running the OLD code/);
        // File tetap terpasang.
        expect(fs.files.has("/opt/test/hello-pkg.ts")).toBe(true);
    });

    it("P2.24 skrip yang dikirim paket sendiri ditandai; --no-scripts & --yes", async () => {
        setupServer(world);
        await boot();
        const lib = world.makeLib(world.clientNode) as any;

        world.answers = ["y", "n"];
        await new TpkgClient().execute(lib, ["install", "hello-world", "--from", "server"]);
        expect(out(world)).toMatch(/shipped by the package itself/);
        expect(world.execs).toHaveLength(0);

        world.prints.length = 0;
        await new TpkgClient().execute(lib, ["install", "hello-world", "--force", "--no-scripts", "--from", "server"]);
        expect(out(world)).toMatch(/Skipping post-install \(--no-scripts\)/);
        expect(world.execs).toHaveLength(0);

        // --yes tidak membaca jawaban: "n" di antrean tidak terpakai, skrip jalan.
        world.prints.length = 0;
        world.answers = ["n"];
        await new TpkgClient().execute(lib, ["install", "hello-world", "--force", "-y", "--from", "server"]);
        expect(out(world)).toMatch(/Run post-install script\? \[y\/N\]: y \(--yes\)/);
        expect(world.execs.map((e) => e.cmd)).toContain("/opt/test/hello-pkg.ts");
        expect(world.answers).toEqual(["n"]);
    });

    // ========================================================================
    // DEPENDENSI
    // ========================================================================

    function setupDepsRepo() {
        setupRepo(
            world,
            [
                mkPkg("libx", "1.0.0", ["/lib/libx.ts"]),
                mkPkg("appx", "2.0.0", ["/opt/appx/appx.ts"], { depends: ["libx"] }),
            ],
            { "/lib/libx.ts": "// libx", "/opt/appx/appx.ts": "// appx" },
        );
    }

    it("P2.25 dependensi dikonfirmasi lalu dipasang LEBIH DULU", async () => {
        setupDepsRepo();
        await boot();
        world.answers = ["y", "y"]; // fingerprint, install dependencies

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["install", "appx", "--from", "server"]);

        const text = out(world);
        const status = JSON.parse(world.fs(world.clientNode).files.get("/var/lib/tpkg/status.json")!);
        expect(text).toMatch(/Additional packages required/);
        expect(text).toMatch(/libx.*required by appx/);
        expect(status).toEqual({ libx: "1.0.0", appx: "2.0.0" });
        expect(text.indexOf("[1/2] libx")).toBeGreaterThan(-1);
        expect(text.indexOf("[1/2] libx")).toBeLessThan(text.indexOf("[2/2] appx"));
    });

    it("P2.26 dependensi diabaikan ([i]gnore) → hanya paket yang diminta", async () => {
        setupDepsRepo();
        await boot();
        world.answers = ["y", "i"];

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["install", "appx", "--from", "server"]);

        const fs = world.fs(world.clientNode);
        expect(fs.files.has("/opt/appx/appx.js")).toBe(true);
        expect(fs.files.has("/lib/libx.ts")).toBe(false);
        expect(out(world)).toMatch(/Ignoring dependencies/);
    });

    it("P2.27 dependensi dibatalkan ([a]bort) → tidak ada yang dipasang", async () => {
        setupDepsRepo();
        await boot();
        world.answers = ["y", "a"];

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["install", "appx", "--from", "server"]);

        const fs = world.fs(world.clientNode);
        expect(fs.files.has("/opt/appx/appx.ts")).toBe(false);
        expect(fs.files.has("/lib/libx.ts")).toBe(false);
        expect(out(world)).toMatch(/Installation aborted/);
    });

    it("P2.28 dependensi yang sudah ada di disk (bukan dari tpkg) tidak ditawarkan lagi", async () => {
        setupDepsRepo();
        await boot();
        // Node dari image: file libx ada, tapi status.json tidak mencatatnya.
        world.fs(world.clientNode).files.set("/lib/libx.ts", "// libx dari image");

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["install", "appx", "--from", "server"]);

        const fs = world.fs(world.clientNode);
        expect(out(world)).not.toMatch(/Additional packages required/);
        expect(fs.files.get("/lib/libx.ts")).toBe("// libx dari image");
        expect(JSON.parse(fs.files.get("/var/lib/tpkg/status.json")!)).toEqual({ appx: "2.0.0" });
    });

    it("P2.34 paket yang menulis /lib/*.ts → peringatan reboot (cache /lib dibangun saat boot)", async () => {
        setupRepo(world, [mkPkg("libonly", "1.0.0", ["/lib/Baru.ts"])], { "/lib/Baru.ts": "export const x = 1;" });
        await boot();

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["install", "libonly", "--from", "server"]);
        expect(out(world)).toMatch(/framework libraries in \/lib were updated/);

        // Paket tanpa /lib → tidak ada peringatan.
        world.prints.length = 0;
        setupRepo(world, [mkPkg("app", "1.0.0", ["/opt/app/app.ts"])], { "/opt/app/app.ts": "//" });
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["install", "app", "--from", "server"]);
        expect(out(world)).not.toMatch(/REBOOT REQUIRED/);
    });

    it("P2.35 konfigurasi /etc yang diubah operator TIDAK ditimpa saat reinstall", async () => {
        setupRepo(world, [mkPkg("cfg", "1.0.0", ["/etc/cfg/config.json", "/opt/cfg/cfg.ts"])], {
            "/etc/cfg/config.json": '{"defaultRepo":"antigonon"}',
            "/opt/cfg/cfg.ts": "//",
        });
        await boot();
        const lib = world.makeLib(world.clientNode) as any;
        const fs = world.fs(world.clientNode);

        await new TpkgClient().execute(lib, ["install", "cfg", "--from", "server"]);
        fs.files.set("/etc/cfg/config.json", '{"defaultRepo":"wintsix"}'); // seperti `tpkg --set-repo`

        world.prints.length = 0;
        await new TpkgClient().execute(lib, ["install", "cfg", "--force", "--from", "server"]);

        expect(fs.files.get("/etc/cfg/config.json")).toBe('{"defaultRepo":"wintsix"}');
        expect(fs.files.get("/etc/cfg/config.json.tpkg-new")).toBe('{"defaultRepo":"antigonon"}');
        expect(out(world)).toMatch(/\/etc\/cfg\/config\.json kept .*locally modified/);

        // remove ikut membersihkan .tpkg-new (manifest mencatatnya).
        world.answers = ["a"];
        await new TpkgClient().execute(lib, ["remove", "cfg"]);
        expect(fs.files.has("/etc/cfg/config.json.tpkg-new")).toBe(false);
        expect(fs.files.has("/etc/cfg/config.json")).toBe(false);
    });

    it("P2.36 konfigurasi yang TIDAK diubah ikut ter-upgrade; file /etc dari image dibiarkan", async () => {
        setupRepo(world, [mkPkg("cfg", "1.0.0", ["/etc/cfg/a.conf", "/etc/cfg/b.conf"])], {
            "/etc/cfg/a.conf": "a=1",
            "/etc/cfg/b.conf": "b=1",
        });
        await boot();
        const lib = world.makeLib(world.clientNode) as any;
        const fs = world.fs(world.clientNode);
        // b.conf sudah ada sebelum tpkg (mis. dari image) dengan isi lain.
        fs.files.set("/etc/cfg/b.conf", "b=lokal");

        await new TpkgClient().execute(lib, ["install", "cfg", "--from", "server"]);
        expect(fs.files.get("/etc/cfg/a.conf")).toBe("a=1");
        expect(fs.files.get("/etc/cfg/b.conf")).toBe("b=lokal");
        expect(fs.files.get("/etc/cfg/b.conf.tpkg-new")).toBe("b=1");

        setupRepo(world, [mkPkg("cfg", "2.0.0", ["/etc/cfg/a.conf", "/etc/cfg/b.conf"])], {
            "/etc/cfg/a.conf": "a=2",
            "/etc/cfg/b.conf": "b=2",
        });
        await new TpkgClient().execute(lib, ["install", "cfg", "--from", "server"]);
        expect(fs.files.get("/etc/cfg/a.conf")).toBe("a=2"); // tidak diubah → ikut versi baru
        expect(fs.files.get("/etc/cfg/b.conf")).toBe("b=lokal");
        expect(fs.files.get("/etc/cfg/b.conf.tpkg-new")).toBe("b=2");
    });

    it("P2.37 tpkg -v menampilkan versi klien, protokol, paket & repo", async () => {
        const fs = world.fs(world.clientNode);
        fs.files.set("/var/lib/tpkg/status.json", JSON.stringify({ tpkg: "1.0.3" }));
        fs.files.set("/etc/tpkg/config.json", JSON.stringify({ defaultRepo: "wintsix" }));

        await new TpkgClient().execute(world.makeLib(world.clientNode, { uid: 1000 }) as any, ["-v"]);

        const text = out(world);
        expect(text).toMatch(/^tpkg \d+\.\d+\.\d+ \(protocol 1\.0\)/);
        expect(text).toMatch(/Installed packages: tpkg 1\.0\.3/);
        expect(text).toMatch(/Default repository: wintsix/);
    });

    // ========================================================================
    // VARIAN BUNDLE: binary (default, .js) vs source (--source, .ts)
    // ========================================================================

    function setupAppRepo(version = "1.0.0", code = "export const greet = (n: string): string => `hi ${n}`;") {
        setupRepo(
            world,
            [
                mkPkg("app", version, ["/opt/app/app.ts", "/opt/app/setup.ts", "/lib/applib.ts"], {
                    onAfterDownload: "/sbin/transpile.ts",
                }),
            ],
            {
                "/opt/app/app.ts": code,
                "/opt/app/setup.ts": "export const setup = (): number => 1;",
                "/lib/applib.ts": "export const lib = (): number => 2;",
            },
        );
    }

    it("P2.38 default = binary: .js tanpa sourcemap, tanpa .ts; /lib tetap .ts; tanpa transpile", async () => {
        setupAppRepo();
        await boot();
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["install", "app", "--from", "server"]);

        const fs = world.fs(world.clientNode);
        const text = out(world);
        expect(text).toMatch(/\(Verified, binary\)/);
        expect(fs.files.has("/opt/app/app.ts")).toBe(false);
        expect(fs.files.get("/opt/app/app.js")).toMatch(/greet/);
        expect(fs.files.get("/opt/app/app.js")).not.toMatch(/sourceMappingURL/);
        expect(fs.files.get("/opt/app/app.js")).not.toMatch(/: string/); // tipe TS sudah dibuang
        expect(fs.modes.get("/opt/app/app.js")).toBe(0o755);
        // Kernel membaca /lib/*.ts langsung → tetap source.
        expect(fs.files.has("/lib/applib.ts")).toBe(true);
        // Tidak ada yang perlu di-build → transpile tidak ditanyakan / dijalankan.
        expect(text).toMatch(/prebuilt \.js — no build step needed/);
        expect(text).not.toMatch(/Run post-install script/);
        expect(world.execs).toHaveLength(0);
        // Manifest mencatat .js → tpkg remove membersihkan yang benar.
        const manifest = JSON.parse(fs.files.get("/var/lib/tpkg/installed/app.json")!);
        expect(manifest.files.map((f: any) => f.path)).toContain("/opt/app/app.js");
    });

    it("P2.39 --source: .ts apa adanya + transpile dengan daftar berkasnya", async () => {
        setupAppRepo();
        await boot();
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "install",
            "app",
            "--source",
            "--from",
            "server",
        ]);

        const fs = world.fs(world.clientNode);
        expect(out(world)).toMatch(/\(Verified, source\)/);
        expect(fs.files.get("/opt/app/app.ts")).toMatch(/: string/);
        expect(fs.files.has("/opt/app/app.js")).toBe(false);
        expect(world.execs.map((e) => e.cmd)).toEqual(["/sbin/transpile.ts"]);
        expect(out(world)).toMatch(/args: \/opt\/app\/app\.ts \/opt\/app\/setup\.ts \/lib\/applib\.ts/);
    });

    it("P2.40 source → binary: .ts lama dibuang (resolver mendahulukan .ts), yang diubah → .tpkg-old", async () => {
        setupAppRepo();
        await boot();
        const lib = world.makeLib(world.clientNode) as any;
        const fs = world.fs(world.clientNode);
        await new TpkgClient().execute(lib, ["install", "app", "--source", "--from", "server"]);
        fs.files.set("/opt/app/setup.ts", "export const setup = (): number => 42; // lokal");

        world.prints.length = 0;
        await new TpkgClient().execute(lib, ["install", "app", "--force", "--from", "server"]);

        expect(fs.files.has("/opt/app/app.ts")).toBe(false);
        expect(fs.files.has("/opt/app/app.js")).toBe(true);
        expect(fs.files.has("/opt/app/setup.ts")).toBe(false);
        expect(fs.files.get("/opt/app/setup.ts.tpkg-old")).toMatch(/42/);
        expect(fs.files.has("/lib/applib.ts")).toBe(true); // /lib tetap
        expect(out(world)).toMatch(/\/opt\/app\/setup\.ts was modified locally/);
    });

    it("P2.41 skrip post-install yang di-compile dipanggil lewat .js-nya", async () => {
        setupRepo(
            world,
            [mkPkg("cfgapp", "1.0.0", ["/opt/cfgapp/configure.ts"], { onAfterDownload: "/opt/cfgapp/configure.ts" })],
            { "/opt/cfgapp/configure.ts": "export const main = (): number => 0;" },
        );
        await boot();
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "install",
            "cfgapp",
            "--from",
            "server",
        ]);

        expect(world.execs.map((e) => e.cmd)).toEqual(["/opt/cfgapp/configure.js"]);
        expect(out(world)).toMatch(/shipped by the package itself/);
    });

    it("P2.42 dependensi yang terpasang sebagai binary (.js di disk) dianggap ada", async () => {
        setupRepo(
            world,
            [
                mkPkg("tool", "1.0.0", ["/opt/tool/tool.ts"]),
                mkPkg("user", "1.0.0", ["/opt/user/user.ts"], { depends: ["tool"] }),
            ],
            { "/opt/tool/tool.ts": "export const t = 1;", "/opt/user/user.ts": "export const u = 1;" },
        );
        // tool dari image produksi: hanya .js, tidak tercatat di status.json.
        world.fs(world.clientNode).files.set("/opt/tool/tool.js", "exports.t = 1;");
        await boot();

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["install", "user", "--from", "server"]);
        expect(out(world)).not.toMatch(/Additional packages required/);
    });

    it("P2.43 repo LAMA (bundle source tanpa `variant`) → klien compile sendiri ke .js", async () => {
        const client = new TpkgClient() as any;
        client.lib = world.makeLib(world.clientNode);
        const file = (p: string, content: string, extra: any = {}) => ({
            path: p,
            content,
            size: content.length,
            sha256: "",
            ...extra,
        });
        const data: any = { name: "nettools", version: "1.0.0", onAfter: "/usr/bin/setup.ts" };
        const result = await client.compileLocally(
            [
                file("/usr/bin/ifconfig.ts", "export const up = (i: string): string => i;"),
                file("/usr/bin/setup.ts", "export const s = 1;"),
                file("/lib/netlib.ts", "export const n = 1;"),
                file("/tmp/tpkg-stage/kernel/K.ts", "export const k = 1;", { hostDst: "src/kernel/K.ts" }),
            ],
            data,
        );

        const paths = result.map((f: any) => f.path);
        expect(paths).toEqual(["/usr/bin/ifconfig.js", "/usr/bin/setup.js", "/lib/netlib.ts", "/tmp/tpkg-stage/kernel/K.ts"]);
        const ifconfig = result[0];
        expect(ifconfig.content).not.toMatch(/: string/);
        expect(ifconfig.size).toBe(ifconfig.content.length);
        expect(ifconfig.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(data.variant).toBe("binary");
        expect(data.onAfter).toBe("/usr/bin/setup.js");
        expect(out(world)).toMatch(/older tpkgd\) — compiling 2 file\(s\) to \.js locally/);
    });

    // ========================================================================
    // IMAGE PRODUKSI (/etc/tsix-release VARIANT=production)
    // ========================================================================

    function setupBaseRepo() {
        setupRepo(
            world,
            [
                {
                    name: "base",
                    version: "2.0.0",
                    description: "base",
                    author: "test",
                    items: [
                        { src: "/bin/tool.ts", dst: "/bin/tool.ts", hostDst: "src/mirror/bin/tool.ts" },
                        { src: "/lib/Base.ts", dst: "/lib/Base.ts", hostDst: "src/mirror/lib/Base.ts" },
                        {
                            src: "/tmp/tpkg-stage/kernel/K.ts",
                            dst: "/tmp/tpkg-stage/kernel/K.ts",
                            hostDst: "src/kernel/K.ts",
                        },
                    ],
                },
            ],
            {
                "/bin/tool.ts": "export const tool = (x: number): number => x * 2;",
                "/lib/Base.ts": "export const base = 1;",
                "/tmp/tpkg-stage/kernel/K.ts": "export const kernel = 2;",
            },
        );
    }

    it("P2.44 produksi: hostDst src/mirror/ → VFS saja (.js); kernel tetap ke host", async () => {
        setupBaseRepo();
        world.fs(world.clientNode).files.set(
            "/etc/tsix-release",
            '# test\nNAME="TSIX Imut"\nVERSION="1.0.0"\nVARIANT=production\n',
        );
        await boot();
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["install", "base", "--from", "server"]);

        const fs = world.fs(world.clientNode);
        const text = out(world);
        // Tidak ada yang ditulis ke src/mirror/ di host…
        const toHost = world.hostSyncs.filter((s) => s.op === "to").map((s) => s.hostPath);
        expect(toHost).toEqual(["src/kernel/K.ts"]);
        expect([...world.hostFiles.keys()].some((k) => k.startsWith("src/mirror/"))).toBe(false);
        // …program mirror masuk ke VFS sebagai .js, /lib tetap .ts.
        expect(fs.files.has("/bin/tool.ts")).toBe(false);
        expect(fs.files.get("/bin/tool.js")).toMatch(/tool/);
        expect(fs.files.get("/lib/Base.ts")).toBe("export const base = 1;");
        // Hanya file kernel yang ditanyakan sebagai tulis-host.
        expect(text).toMatch(/writes to the HOST FS \(1 file\(s\)\)/);
        expect(text).toMatch(/Production image: 2 file\(s\) go to the system database only/);
        // Manifest: item hasil lipatan tidak lagi tercatat sebagai file host.
        const manifest = JSON.parse(fs.files.get("/var/lib/tpkg/installed/base.json")!);
        expect(manifest.files.filter((f: any) => f.hostDst).map((f: any) => f.hostDst)).toEqual(["src/kernel/K.ts"]);
    });

    it("P2.45 development (tanpa penanda): hostDst src/mirror/ tetap disinkron ke host seperti dulu", async () => {
        setupBaseRepo();
        await boot();
        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["install", "base", "--from", "server"]);

        const toHost = world.hostSyncs.filter((s) => s.op === "to").map((s) => s.hostPath);
        expect(toHost).toEqual(["src/mirror/bin/tool.ts", "src/mirror/lib/Base.ts", "src/kernel/K.ts"]);
        expect(world.fs(world.clientNode).files.has("/bin/tool.ts")).toBe(true);
        expect(out(world)).not.toMatch(/Production image/);
    });

    it("P2.46 tpkg -v menampilkan image produksi", async () => {
        world.fs(world.clientNode).files.set(
            "/etc/tsix-release",
            'NAME="TSIX Imut"\nVERSION="1.0.0"\nVARIANT=production\n',
        );
        await new TpkgClient().execute(world.makeLib(world.clientNode, { uid: 1000 }) as any, ["-v"]);
        expect(out(world)).toMatch(/Image: TSIX Imut 1\.0\.0 \(production\)/);
    });

    it("P2.29 --no-deps melewati resolusi dependensi", async () => {
        setupDepsRepo();
        await boot();

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "install",
            "appx",
            "--no-deps",
            "--from",
            "server",
        ]);

        expect(out(world)).not.toMatch(/Additional packages required/);
        expect(world.fs(world.clientNode).files.has("/lib/libx.ts")).toBe(false);
    });

    it("P2.30 remove memperingatkan bila paket masih dibutuhkan paket lain", async () => {
        setupDepsRepo();
        await boot();
        const lib = world.makeLib(world.clientNode) as any;
        await new TpkgClient().execute(lib, ["install", "appx", "--from", "server"]);

        world.prints.length = 0;
        world.answers = ["n"];
        await new TpkgClient().execute(lib, ["remove", "libx"]);

        expect(out(world)).toMatch(/required by installed package\(s\): appx/);
        expect(out(world)).toMatch(/Removal aborted/);
        expect(world.fs(world.clientNode).files.has("/lib/libx.ts")).toBe(true);
    });

    // ========================================================================
    // LIST --INSTALLED & UPGRADE
    // ========================================================================

    it("P2.31 list --installed menandai versi baru, upgrade memasangnya", async () => {
        setupRepo(world, [mkPkg("solo", "1.0.0", ["/opt/solo/solo.ts"])], { "/opt/solo/solo.ts": "export const v = 1;" });
        await boot();
        const lib = world.makeLib(world.clientNode) as any;
        const fs = world.fs(world.clientNode);
        await new TpkgClient().execute(lib, ["install", "solo", "--from", "server"]);
        await new TpkgClient().execute(lib, ["--set-repo", "server"]);

        // Rilis baru di repo + katalog klien sudah di-update.
        setupRepo(world, [mkPkg("solo", "1.1.0", ["/opt/solo/solo.ts"])], { "/opt/solo/solo.ts": "export const v = 11;" });

        world.prints.length = 0;
        await new TpkgClient().execute(lib, ["list", "--installed"]);
        expect(out(world)).toMatch(/solo.*1\.0\.0.*1\.1\.0 available/);
        expect(out(world)).toMatch(/1 upgradable/);

        world.prints.length = 0;
        await new TpkgClient().execute(lib, ["upgrade"]);
        expect(out(world)).toMatch(/1\.0\.0 → .*1\.1\.0/);
        expect(fs.files.get("/opt/solo/solo.js")).toMatch(/v = 11/);
        expect(JSON.parse(fs.files.get("/var/lib/tpkg/status.json")!)).toEqual({ solo: "1.1.0" });

        world.prints.length = 0;
        await new TpkgClient().execute(lib, ["upgrade"]);
        expect(out(world)).toMatch(/All packages are up to date/);
    });

    // ========================================================================
    // TPKGD --CHECK
    // ========================================================================

    it("P2.32 tpkgd --check melaporkan masalah manifest tanpa membuka socket", async () => {
        setupRepo(
            world,
            [
                mkPkg("ok", "1.0.0", ["/opt/ok/ok.ts"]),
                mkPkg("missing", "1.0.0", ["/opt/missing/gone.ts"]),
                mkPkg("orphan", "1.0.0", ["/opt/orphan/o.ts"], { depends: ["nope"] }),
                mkPkg("a", "1.0.0", ["/opt/a/a.ts"], { depends: ["b"] }),
                mkPkg("b", "1.0.0", ["/opt/b/b.ts", "/opt/ok/ok.ts"], {
                    depends: ["a"],
                    onAfterDownload: "/sbin/tidak-ada.ts",
                }),
            ],
            { "/opt/ok/ok.ts": "// ok", "/opt/orphan/o.ts": "//", "/opt/a/a.ts": "//", "/opt/b/b.ts": "//" },
        );

        await new TpkgDaemon().execute(world.makeLib(world.serverNode) as any, ["--check"]);

        const text = out(world);
        expect(text).toMatch(/missing: source file not found: \/opt\/missing\/gone\.ts/);
        expect(text).toMatch(/orphan: depends on unknown package 'nope'/);
        expect(text).toMatch(/dependency cycle: (a -> b -> a|b -> a -> b)/);
        expect(text).toMatch(/\/opt\/ok\/ok\.ts is shipped by several packages: ok, b/);
        expect(text).toMatch(/onAfterDownload '\/sbin\/tidak-ada\.ts' is not shipped/);
        expect(text).toMatch(/5 package\(s\) checked — 3 error\(s\), 2 warning\(s\)/);
        expect(world.ioctls).toHaveLength(0);
    });

    it("P2.33 tpkgd --check pada manifest bersih → 0 error", async () => {
        setupDepsRepo();
        await new TpkgDaemon().execute(world.makeLib(world.serverNode) as any, ["--check"]);
        expect(out(world)).toMatch(/✅ 2 package\(s\) checked — 0 error\(s\), 0 warning\(s\)/);
    });
});

describe("TpkgProtocol — mode & dependensi (murni)", () => {
    it("execModeForPath: sumber tunggal aturan mode", () => {
        expect(execModeForPath("/bin/ls.js")).toBe(0o755);
        expect(execModeForPath("/sbin/tpkg.js")).toBe(0o744);
        expect(execModeForPath("/bin/sudo.js")).toBe(0o4755);
        expect(execModeForPath("/opt/retroterm/retroterm.js")).toBe(0o755);
        expect(execModeForPath("/etc/x.conf")).toBeNull();
    });

    it("parseDependency: nama & versi minimum", () => {
        expect(parseDependency("emerald")).toEqual({ name: "emerald" });
        expect(parseDependency("emerald>=1.2.0")).toEqual({ name: "emerald", minVersion: "1.2.0" });
        expect(parseDependency("emerald >= 1.2")).toEqual({ name: "emerald", minVersion: "1.2" });
        expect(parseDependency("bad name")).toBeNull();
    });

    it("planInstall: urutan, transitif, versi minimum, siklus", () => {
        const catalog = [
            { name: "base", version: "1.0.0" },
            { name: "mid", version: "1.0.0", depends: ["base"] },
            { name: "top", version: "1.0.0", depends: ["mid", "base"] },
            { name: "needsNew", version: "1.0.0", depends: ["base>=2.0"] },
            { name: "x", version: "1.0.0", depends: ["y"] },
            { name: "y", version: "1.0.0", depends: ["x"] },
        ];
        const none = () => false;

        expect(planInstall(["top"], catalog, none).steps.map((s) => s.name)).toEqual(["base", "mid", "top"]);
        expect(planInstall(["top"], catalog, (d) => d.name === "base").steps.map((s) => s.name)).toEqual([
            "mid",
            "top",
        ]);
        expect(planInstall(["needsNew"], catalog, none).problems[0]).toMatch(/requires base>=2\.0/);
        expect(planInstall(["x"], catalog, none).problems[0]).toMatch(/dependency cycle/);
        expect(planInstall(["ghost"], catalog, none).problems[0]).toMatch(/not in the catalog/);
    });
});

/**
 * SEC-05 — pinning kunci repository.
 *
 * Kunci yang dipakai memverifikasi signature katalog/bundle adalah public key
 * dari handshake_ack. Kunci itu hanya boleh dipakai jika fingerprint-nya
 * (DIHITUNG klien) tercatat untuk host tersebut di /etc/tpkg/trusted_repos.
 * Field `fingerprint` kiriman server tidak boleh menentukan kepercayaan.
 *
 * Di dunia tiruan ini daemon di node "server" berperan sebagai repo PALSU:
 * kuncinya sendiri, bukan kunci repo asli yang sudah dipercaya klien.
 */
describe("SEC-05 pinning kunci repository", { timeout: 30_000 }, () => {
    let world: World;
    let daemonRun: Promise<void> | null = null;
    let realRepo: { publicKey: string; privateKey: string };
    const TRUST = "/etc/tpkg/trusted_repos";

    beforeEach(() => {
        world = new World();
        realRepo = SecurityAgent.generateKeyPair();
    });

    afterEach(async () => {
        world.onDeliver = null;
        if (daemonRun) await stopDaemon(world, daemonRun);
        daemonRun = null;
    });

    async function boot() {
        setupServer(world);
        daemonRun = (await startDaemon(world)).running;
    }

    /** Ubah handshake_ack yang sampai ke klien (meniru penyerang di broker). */
    function tamperAck(mutate: (ack: any) => void) {
        world.onDeliver = (to, _port, pkt) => {
            if (to !== world.clientNode || typeof pkt.data !== "string") return;
            if (!pkt.data.includes('"handshake_ack"')) return;
            const ack = JSON.parse(pkt.data);
            mutate(ack);
            pkt.data = JSON.stringify(ack);
        };
    }

    const update = () =>
        new TpkgClient().execute(world.makeLib(world.clientNode) as any, ["update", "server"]);
    const serverPub = () => world.fs(world.serverNode).files.get("/etc/keys/rsa/id_rsa.pub")!;
    const clientFile = (p: string) => world.fs(world.clientNode).files.get(p);

    it("repo palsu + fingerprint repo asli → ditolak tanpa prompt, katalog tidak diperbarui", async () => {
        // Instalasi lama: trusted_repos berisi fingerprint pendek repo asli.
        world.fs(world.clientNode).files.set(
            TRUST,
            `server ${SecurityAgent.publicKeyFingerprint(realRepo.publicKey)}\n${SecurityAgent.getFingerprint(realRepo.publicKey)}\n`,
        );
        await boot();
        tamperAck((ack) => {
            ack.fingerprint = SecurityAgent.getFingerprint(realRepo.publicKey);
        });
        world.answers = ["n"];

        await update();

        const text = out(world);
        expect(text).not.toContain("Successfully updated");
        expect(text).toMatch(/does not match|CHANGED/i);
        expect(world.answers).toEqual(["n"]); // tidak ada prompt yang dijawab
    });

    it("fingerprint kosong dari server tidak otomatis dipercaya", async () => {
        world.fs(world.clientNode).files.set(TRUST, "lain " + "a".repeat(64) + "\n");
        await boot();
        tamperAck((ack) => {
            ack.fingerprint = "";
        });
        world.answers = ["n"]; // operator menolak kunci baru

        await update();

        expect(out(world)).not.toContain("Successfully updated");
        expect(out(world)).toMatch(/Unknown Repository/);
    });

    it("TOFU menyimpan `<host> <fingerprint hasil hitung klien>`", async () => {
        await boot();
        world.answers = ["y"];

        await update();

        expect(out(world)).toContain("Successfully updated");
        expect(clientFile(TRUST)).toContain(`server ${SecurityAgent.publicKeyFingerprint(serverPub())}`);
    });

    it("kunci yang dipercaya untuk host lain tidak berlaku untuk host ini", async () => {
        await boot();
        world.fs(world.clientNode).files.set(TRUST, `lain ${SecurityAgent.publicKeyFingerprint(serverPub())}\n`);
        world.answers = ["n"];

        await update();

        expect(out(world)).not.toContain("Successfully updated");
        expect(out(world)).toMatch(/Unknown Repository/);
    });

    it("host yang sudah dipercaya dengan kunci yang sama → lolos tanpa prompt", async () => {
        await boot();
        world.fs(world.clientNode).files.set(TRUST, `server ${SecurityAgent.publicKeyFingerprint(serverPub())}\n`);
        world.answers = ["n"]; // kalau sampai ditanya, jawabannya menolak

        await update();

        expect(out(world)).toContain("Successfully updated");
        expect(world.answers).toEqual(["n"]);
    });
});

/**
 * SEC-16 — metadata yang memengaruhi eksekusi ikut ditandatangani.
 * Dulu signature hanya menutup path/hostDst/size/sha256, jadi `onAfter`
 * (dijalankan sebagai root) bisa diganti tanpa merusak signature.
 */
describe("SEC-16 cakupan tanda tangan bundle", { timeout: 30_000 }, () => {
    it("bundle sah lolos; onAfter / undoScript / permissions yang diubah ditolak", async () => {
        const { bundleSignatureDigest, sha256Hex } = await import("@tsix/TpkgProtocol");
        const repo = SecurityAgent.generateKeyPair();
        const content = "#!/bin/tsh\nprint ok\n";
        const reply: any = {
            type: "BUNDLE_REPLY",
            name: "hello",
            version: "1.0.0",
            variant: "ts",
            files: [{ path: "/opt/hello/a.ts", size: content.length, sha256: sha256Hex(content), content }],
            onAfter: "/opt/hello/a.ts",
            undoScript: undefined,
            needReboot: false,
        };
        reply.signature = SecurityAgent.sign(repo.privateKey, bundleSignatureDigest(reply));

        const world = new World();
        const client = new TpkgClient() as any;
        client.lib = world.makeLib(world.clientNode);
        const verify = (data: any) => client.verifyBundle(repo.publicKey, data);

        expect(await verify(reply)).not.toBeNull();
        expect(await verify({ ...reply, onAfter: "/tmp/evil-transpile.js" })).toBeNull();
        expect(await verify({ ...reply, undoScript: "/tmp/evil.js" })).toBeNull();
        expect(await verify({ ...reply, files: [{ ...reply.files[0], permissions: 0o4755 }] })).toBeNull();
    });
});
