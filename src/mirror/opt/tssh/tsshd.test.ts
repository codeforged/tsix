import { describe, it, expect, vi, beforeAll } from "vitest";
import { SecurityAgent } from "@common/SecurityAgent";
import { TSSHProtocol, TSSHOpcode, TSSHChannel } from "@common/protocols/TSSHProtocol";
import TSSHDaemon from "./tsshd";

/**
 * tsshd — CONNECT_REQ selalu berakhir di /bin/login.js.
 *
 * Mode perintah langsung (`tssh -c`) dihapus: daemon berjalan sebagai root,
 * jadi apa pun yang di-spawn tanpa lewat login ikut berjalan sebagai root.
 * Payload CONNECT_REQ diabaikan; autentikasi selalu dilakukan oleh login.
 */

let keys: { publicKey: string; privateKey: string };

beforeAll(() => {
    keys = SecurityAgent.generateKeyPair();
});

function makeLib() {
    return {
        net: { sendto: vi.fn(async () => undefined) },
        pty: {
            alloc: vi.fn(async () => ({ id: 7 })),
            free: vi.fn(async () => undefined),
        },
        shell: { exec: vi.fn(async () => ({ pid: 42 })) },
        std: { print: vi.fn(), log: vi.fn(async () => undefined) },
    } as any;
}

function makeDaemon() {
    const d = new TSSHDaemon() as any;
    d.publicKey = keys.publicKey;
    d.privateKey = keys.privateKey;
    d.fingerprint = SecurityAgent.getFingerprint(keys.publicKey);
    // Bridge I/O shell <-> jaringan tidak diuji di sini.
    d.startBridges = vi.fn();
    return d;
}

/** Jalankan HANDSHAKE_REQ → KEY_EXCHANGE → CONNECT_REQ(payload) dari satu klien. */
async function connectWith(command: string) {
    const lib = makeLib();
    const d = makeDaemon();
    const raw = { src: "client", port: 4500, localPort: 24 };
    const sid = `${raw.src}:${raw.port}`;
    const send = async (opcode: TSSHOpcode, payload?: any) => {
        const pkt = TSSHProtocol.unpack(TSSHProtocol.pack(opcode, TSSHChannel.CONTROL, payload));
        await d.handlePacket(lib, 3, sid, raw, pkt);
    };

    await send(TSSHOpcode.HANDSHAKE_REQ);

    const sessionKey = SecurityAgent.generateSessionKey();
    await send(TSSHOpcode.KEY_EXCHANGE, SecurityAgent.encryptWithPublicKey(keys.publicKey, sessionKey));

    const agent = new SecurityAgent();
    agent.setSessionKey(sessionKey);
    await send(TSSHOpcode.CONNECT_REQ, agent.securePacketOut(command));

    return { lib, d, sid };
}

describe("tsshd CONNECT_REQ", () => {
    it("payload kosong → spawn /bin/login.js di PTY sesi", async () => {
        const { lib, d, sid } = await connectWith("");
        expect(lib.shell.exec).toHaveBeenCalledTimes(1);
        const call = lib.shell.exec.mock.calls[0];
        expect(call[0]).toBe("/bin/login.js");
        expect(call[1]).toEqual(["--remote"]); // login tahu sesinya remote (SEC-20)
        expect(call[5]).toBe(7);
        expect(d.sessions.get(sid).active).toBe(true);
    });

    it("payload berisi perintah → perintah TIDAK dijalankan; tetap /bin/login.js", async () => {
        const { lib } = await connectWith("cat /etc/shadow");
        expect(lib.shell.exec).toHaveBeenCalledTimes(1);
        const [path, args] = lib.shell.exec.mock.calls[0];
        expect(path).toBe("/bin/login.js");
        expect(args).toEqual(["--remote"]);
        for (const c of lib.shell.exec.mock.calls) {
            expect(c[0]).not.toBe("cat");
        }
    });
});

/** SEC-14 — siklus hidup & kuota sesi tsshd. */
describe("tsshd sesi (SEC-14)", () => {
    function rig() {
        const lib = makeLib();
        const d = makeDaemon();
        const agents = new Map<string, SecurityAgent>();
        const send = async (src: string, port: number, opcode: TSSHOpcode, payload?: any) => {
            const raw = { src, port, localPort: 24 };
            const pkt = TSSHProtocol.unpack(TSSHProtocol.pack(opcode, TSSHChannel.CONTROL, payload));
            await d.handlePacket(lib, 3, `${src}:${port}`, raw, pkt);
        };
        const connect = async (src: string, port: number) => {
            await send(src, port, TSSHOpcode.HANDSHAKE_REQ);
            const key = SecurityAgent.generateSessionKey();
            await send(src, port, TSSHOpcode.KEY_EXCHANGE, SecurityAgent.encryptWithPublicKey(keys.publicKey, key));
            const a = new SecurityAgent();
            a.setSessionKey(key);
            agents.set(`${src}:${port}`, a);
            await send(src, port, TSSHOpcode.CONNECT_REQ, a.securePacketOut(""));
        };
        return { lib, d, send, connect };
    }

    it("HANDSHAKE_REQ ke sid yang sesinya aktif → sesi lama tetap (tidak digusur)", async () => {
        const { d, send, connect } = rig();
        await connect("admin", 4500);
        const before = d.sessions.get("admin:4500");
        expect(before.active).toBe(true);

        await send("admin", 4500, TSSHOpcode.HANDSHAKE_REQ); // paket palsu dengan src:port korban

        const after = d.sessions.get("admin:4500");
        expect(after).toBe(before);
        expect(after.active).toBe(true);
    });

    it("melebihi batas sesi global → handshake baru diabaikan, tidak ada spawn tambahan", async () => {
        const { lib, d, connect } = rig();
        const max = (d.constructor as any).MAX_SESSIONS as number;
        expect(typeof max).toBe("number");
        for (let i = 0; i < max + 3; i++) await connect(`n${i}`, 5000 + i);

        expect(d.sessions.size).toBe(max);
        expect(lib.shell.exec).toHaveBeenCalledTimes(max);
    });

    it("melebihi batas per alamat sumber → sesi berikutnya dari alamat itu ditolak", async () => {
        const { d, connect } = rig();
        const perSrc = (d.constructor as any).MAX_SESSIONS_PER_SOURCE as number;
        for (let i = 0; i < perSrc + 2; i++) await connect("banjir", 6000 + i);
        await connect("lain", 7000);

        const fromBanjir = [...d.sessions.values()].filter((s: any) => s.src === "banjir").length;
        expect(fromBanjir).toBe(perSrc);
        expect(d.sessions.has("lain:7000")).toBe(true);
    });

    it("handshake ulang pada sesi PENDING membebaskan PTY yang sempat dialokasikan", async () => {
        const { lib, d, send } = rig();
        await send("x", 4600, TSSHOpcode.HANDSHAKE_REQ);
        d.sessions.get("x:4600").ptyId = 9; // simulasi PTY yatim pada sesi pending
        await send("x", 4600, TSSHOpcode.HANDSHAKE_REQ);
        expect(lib.pty.free).toHaveBeenCalledWith(9);
    });
});
