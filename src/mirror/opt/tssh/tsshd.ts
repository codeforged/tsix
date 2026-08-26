import { UserLib } from "@tsix/UserLib";
import { PacketFlags } from "@common/PacketFlags";
import { SecurityAgent } from "@common/SecurityAgent";
import { TSSHProtocol, TSSHOpcode, TSSHChannel } from "@common/protocols/TSSHProtocol";
import * as crypto from "crypto";

interface Session {
    id: string;
    fd: number;
    src: string;
    port: number;
    localPort: number;
    agent: SecurityAgent;
    active: boolean;
    shellPid: number;
    ttyId: number;
    lastSeen: number;
}

export default class TSSHDaemon {
    private sessions: Map<string, Session> = new Map();
    private publicKey!: string;
    private privateKey!: string;
    private fingerprint!: string;

    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: tsshd [port]\nTSIX Secure Shell Daemon.\n");
            return;
        }
        const port = args.length > 0 ? parseInt(args[0]) : 24;

        const keyDir = "/etc/keys/rsa";
        try {
            this.publicKey = (await lib.fs.readFile(`${keyDir}/id_rsa.pub`)) || "";
            this.privateKey = (await lib.fs.readFile(`${keyDir}/id_rsa`)) || "";
        } catch (e) {
            lib.std.print(`[tsshd] CRITICAL: Keys missing at ${keyDir}.\n`);
            return;
        }

        this.fingerprint = crypto.createHash("sha256").update(this.publicKey).digest("hex");

        // --- 1. DAEMONIZE FIRST ---
        // Panggil daemonize terlebih dahulu SEBELUM membuat socket IPC agar FD tidak terputus
        if (await lib.shell.daemonize("TSIX SSH Daemon")) {
            await lib.std.log(`[tsshd] Service running on MQTNL port ${port}...`, "tsshd");
        }

        // --- 2. BIND SOCKET AFTER DAEMONIZE ---
        const socket = await lib.net.socket();
        await lib.net.bind(socket, port);
        await lib.net.ioctl(socket, 0x1002, true); // Aktifkan MQTNL v1.1 Binary Mode

        // Signal Handler
        (lib as any).onEvent("signal", async (sig: any) => {
            if (sig === "SIGTERM") {
                for (const [_, sess] of this.sessions.entries()) {
                    if (sess.active) {
                        sess.active = false;
                        const byePkt = TSSHProtocol.pack(TSSHOpcode.EXIT, TSSHChannel.CONTROL, "Host rebooting...");
                        await lib.net.sendto(sess.fd, sess.src, sess.port, byePkt, PacketFlags.FLAG_DATA, sess.localPort);
                    }
                }
                await new Promise(r => setTimeout(r, 300));
                await lib.shell.exit(0);
            }
        });

        // --- 3. DISPATCHER LOOP ---
        while (true) {
            const raw = await lib.net.recv(socket);
            if (raw) {
                // Ekstrak buffer payload baik dari raw.data maupun raw.payload (toleransi IPC Kernel)
                const payloadRaw = raw.data || raw.payload || raw;
                const sid = `${raw.src}:${raw.port}`;
                const pkt = TSSHProtocol.unpack(payloadRaw);

                if (pkt) {
                    await this.handlePacket(lib, socket, sid, raw, pkt);
                }
            }

            // Cleanup sessions
            const now = Date.now();
            for (const [sid, sess] of this.sessions.entries()) {
                if (now - sess.lastSeen > 60000 && !sess.active) {
                    // Session belum aktif (handshake belum selesai) → buang
                    this.sessions.delete(sid);
                } else if (now - sess.lastSeen > 90000 && sess.active) {
                    // Client mati / tidak respons (keep-alive PING berhenti) → putus
                    sess.active = false;
                    try { await lib.shell.kill(sess.shellPid, 9); } catch (_) { }
                    const byePkt = TSSHProtocol.pack(TSSHOpcode.EXIT, TSSHChannel.CONTROL, "Connection timed out");
                    await lib.net.sendto(socket, sess.src, sess.port, byePkt, PacketFlags.FLAG_DATA, sess.localPort);
                    this.sessions.delete(sid);
                }
            }
            await new Promise(r => setTimeout(r, 10));
        }
    }

    private async handlePacket(lib: UserLib, fd: number, sid: string, raw: any, pkt: any) {
        let sess = this.sessions.get(sid);

        if (pkt.opcode === TSSHOpcode.HANDSHAKE_REQ) {
            sess = {
                id: sid,
                fd,
                src: raw.src,
                port: raw.port,
                localPort: raw.localPort || raw.dstPort,
                agent: new SecurityAgent(),
                active: false,
                shellPid: -1,
                ttyId: -1,
                lastSeen: Date.now()
            };
            this.sessions.set(sid, sess);

            const payload = Buffer.from(`${this.publicKey}::${this.fingerprint}`, "utf8");
            const resp = TSSHProtocol.pack(TSSHOpcode.HANDSHAKE_RESP, TSSHChannel.CONTROL, payload);
            await lib.net.sendto(fd, raw.src, raw.port, resp, PacketFlags.FLAG_DATA, sess.localPort);
            return;
        }

        if (!sess) return;
        sess.lastSeen = Date.now();

        if (pkt.opcode === TSSHOpcode.KEY_EXCHANGE && !sess.active) {
            try {
                const encryptedHex = pkt.payload.toString("utf8");
                const sessionKey = SecurityAgent.decryptWithPrivateKey(this.privateKey, encryptedHex);
                sess.agent.setSessionKey(sessionKey);

                // JANGAN upgrade ioctl 0x1001 di sini: binary protocol driver sudah
                // bypass security saat TX & auto-decrypt saat RX, sedangkan payload
                // TSSH sudah dienkripsi manual oleh agent. Lapisan driver ganda hanya
                // merusak frame / mengandalkan fallback authTag-fail. (Pola sama dgn airtermd.)

                const ack = TSSHProtocol.pack(TSSHOpcode.CONNECT_ACK, TSSHChannel.CONTROL, "OK");
                await lib.net.sendto(fd, raw.src, raw.port, ack, PacketFlags.FLAG_DATA, sess.localPort);
            } catch (e: any) {
                this.sessions.delete(sid);
            }
            return;
        }

        if (pkt.opcode === TSSHOpcode.CONNECT_REQ && !sess.active) {
            try {
                const encryptedCmd = pkt.payload.toString("utf8").trim();
                const customCmd = sess.agent.securePacketIn(encryptedCmd);
                const ttyId = await this.allocateTTY(lib);
                sess.ttyId = ttyId;

                let procInfo;
                if (customCmd) {
                    const parts = customCmd.split(" ");
                    procInfo = await lib.shell.exec(parts[0], parts.slice(1), undefined, undefined, ttyId);
                } else {
                    procInfo = await lib.shell.exec("/bin/login.ts", [], undefined, undefined, ttyId);
                }

                if (!procInfo) throw new Error("Spawn Failed");

                sess.shellPid = procInfo.pid;
                sess.active = true;

                this.startBridges(lib, sess);
            } catch (e: any) {
                this.sessions.delete(sid);
            }
            return;
        }

        if (sess.active) {
            switch (pkt.opcode) {
                case TSSHOpcode.DATA: {
                    const decrypted = sess.agent.securePacketIn(pkt.payload.toString("utf8"));
                    if (decrypted) await lib.shell.write(sess.shellPid, decrypted);
                    break;
                }
                case TSSHOpcode.RESIZE: {
                    if (pkt.payload.length >= 4) {
                        const rows = pkt.payload.readUInt16BE(0);
                        const cols = pkt.payload.readUInt16BE(2);
                        try {
                            const ttyFd = await lib.fs.open(`/dev/tty${sess.ttyId}`, "w+");
                            if (ttyFd >= 0) {
                                await lib.fs.ioctl(ttyFd, 3, { lines: rows, columns: cols });
                                await lib.fs.close(ttyFd);
                            }
                        } catch (_) { }
                    }
                    break;
                }
                case TSSHOpcode.PING: {
                    const pong = TSSHProtocol.pack(TSSHOpcode.PING, TSSHChannel.CONTROL);
                    await lib.net.sendto(fd, sess.src, sess.port, pong, PacketFlags.FLAG_DATA, sess.localPort);
                    break;
                }
                case TSSHOpcode.EXIT: {
                    sess.active = false;
                    await lib.shell.kill(sess.shellPid, 9);
                    this.sessions.delete(sid);
                    break;
                }
            }
        }
    }

    private startBridges(lib: UserLib, sess: Session) {
        (async () => {
            try {
                // Adaptive sleep: 10ms saat ada output (responsif), 50ms saat idle
                // (hemat CPU — shell.read TTY bersifat non-blocking).
                let idle = false;
                while (sess.active) {
                    const output = await lib.shell.read(sess.shellPid);
                    if (output && sess.active) {
                        idle = false;
                        const encrypted = sess.agent.securePacketOut(output);
                        const pkt = TSSHProtocol.pack(TSSHOpcode.DATA, TSSHChannel.SHELL, encrypted);
                        await lib.net.sendto(sess.fd, sess.src, sess.port, pkt, PacketFlags.FLAG_DATA, sess.localPort);
                        await new Promise(r => setTimeout(r, 10));
                    } else {
                        await new Promise(r => setTimeout(r, idle ? 50 : 10));
                        idle = true;
                    }
                }
            } catch (_) { }
        })();

        (async () => {
            await lib.shell.waitpid(sess.shellPid);
            if (sess.active) {
                sess.active = false;
                const exitPkt = TSSHProtocol.pack(TSSHOpcode.EXIT, TSSHChannel.CONTROL);
                await lib.net.sendto(sess.fd, sess.src, sess.port, exitPkt, PacketFlags.FLAG_DATA, sess.localPort);
                this.sessions.delete(sess.id);
            }
        })();
    }

    private async allocateTTY(lib: UserLib): Promise<number> {
        const activeTtys = Array.from(this.sessions.values()).map(s => s.ttyId);
        try {
            const allProcs = await lib.shell.ps();
            const usedTtys = new Set<number>(
                allProcs
                    .filter((p: any) => p.ttyId >= 7 && p.ttyId <= 12 && p.state !== "EXITED")
                    .map((p: any) => Number(p.ttyId))
            );
            for (const t of usedTtys) { if (!activeTtys.includes(t)) activeTtys.push(t); }
        } catch (_) { }

        for (let i = 7; i <= 12; i++) {
            if (!activeTtys.includes(i)) return i;
        }
        return 7;
    }
} 