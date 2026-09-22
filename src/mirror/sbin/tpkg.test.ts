import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Main as TpkgClient } from "./tpkg";
import { Main as TpkgDaemon } from "./tpkgd";
import type { TpkgPackage } from "./TpkgProtocol";

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

    constructor(public readonly clientNode = "client", public readonly serverNode = "server") {
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
                read: async () => world.answers.shift() ?? "y",
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
                readFile: async (path: string) => (fs.files.has(path) ? fs.files.get(path)! : null),
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

        expect(out(world)).toMatch(/--port tidak valid/);
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

    it("P2.04 tpkg install → file ditulis, mode 755, status & backup dibuat, post-install jalan", async () => {
        setupServer(world);
        await boot();

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "install",
            "hello-world",
            "--from",
            "server",
        ]);

        const fs = world.fs(world.clientNode);
        const text = out(world);

        expect(text).toContain("(Verified)");
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
        const backups = await world.makeLib(world.clientNode).fs.ls("/var/lib/tpkg/backup/hello-world");
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
        expect(text).toMatch(/file sumber tidak ada/);

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

        expect(out(world)).toMatch(/melebihi batas/);
        expect(world.fs(world.clientNode).files.has("/opt/test/hello-pkg.ts")).toBe(false);
    });

    it("P2.07 tpkg rollback memulihkan isi file sebelum instalasi", async () => {
        setupServer(world);
        await boot();

        const lib = world.makeLib(world.clientNode) as any;

        // Kondisi awal di klien (harus kembali seperti ini setelah rollback).
        world.fs(world.clientNode).files.set("/etc/pkg-demo.conf", "SIDANG-LAMA");
        world.fs(world.clientNode).files.set("/etc/hanya-lokal.conf", "jangan dihapus");

        await new TpkgClient().execute(lib, ["install", "hello-world", "--from", "server"]);
        expect(world.fs(world.clientNode).files.get("/etc/pkg-demo.conf")).toBe("version=1.0\nmode=demo");

        world.prints.length = 0;
        await new TpkgClient().execute(lib, ["rollback", "hello-world"]);

        const fs = world.fs(world.clientNode);
        expect(out(world)).toMatch(/Rollback selesai/);
        // File lama kembali…
        expect(fs.files.get("/etc/pkg-demo.conf")).toBe("SIDANG-LAMA");
        // …file yang tadinya tidak ada dihapus…
        expect(fs.files.has("/opt/test/hello-pkg.ts")).toBe(false);
        // …dan file lain tidak tersentuh.
        expect(fs.files.get("/etc/hanya-lokal.conf")).toBe("jangan dihapus");
        // status versi dibersihkan supaya instalasi berikutnya bersih
        expect(JSON.parse(fs.files.get("/var/lib/tpkg/status.json")!)).toEqual({});
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
        expect(text).toMatch(/Disimpan \(terverifikasi\)/);

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

        await new TpkgClient().execute(world.makeLib(world.clientNode) as any, [
            "update",
            "server:8090",
        ]);
        expect(out(world)).toContain("Successfully updated");
        expect((daemon as any).sessions.size).toBe(1);
    });
});
