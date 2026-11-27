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
        expect(call[5]).toBe(7);
        expect(d.sessions.get(sid).active).toBe(true);
    });

    it("payload berisi perintah → perintah TIDAK dijalankan; tetap /bin/login.js", async () => {
        const { lib } = await connectWith("cat /etc/shadow");
        expect(lib.shell.exec).toHaveBeenCalledTimes(1);
        const [path, args] = lib.shell.exec.mock.calls[0];
        expect(path).toBe("/bin/login.js");
        expect(args).toEqual([]);
        for (const c of lib.shell.exec.mock.calls) {
            expect(c[0]).not.toBe("cat");
        }
    });
});
