import { UserLib } from "../lib/UserLib";
import { PacketFlags } from "@common/PacketFlags";
import { SecurityAgent } from "@common/SecurityAgent";
import * as crypto from "crypto";

/**
 * AIRTERMD (v2.2 Unified Multiplexer)
 * 
 * Secure terminal server for TSIX.
 * Multiplexes multiple encrypted sessions on port 25 without port migration.
 */

interface Session {
    id: string; // "srcAddr:srcPort"
    step: number;
    fd: number;
    src: string;
    port: number;
    localPort: number;
    agent: SecurityAgent;
    active: boolean;
    shellPid: number;
    inputQueue: string[];
    lastSeen: number;
}

export default class Airtermd {
    private sessions: Map<string, Session> = new Map();
    private publicKey!: string;
    private privateKey!: string;
    private fingerprint!: string;

    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: airtermd [port]\nSecure Terminal Server Daemon.\n");
            return;
        }
        const port = args.length > 0 ? parseInt(args[0]) : 22; // SSH standard port

        // --- PRE-LOAD CORE IDENTITY ---
        const keyDir = "/etc/keys/rsa";
        try {
            this.publicKey = (await lib.fs.readFile(`${keyDir}/id_rsa.pub`)) || "";
            this.privateKey = (await lib.fs.readFile(`${keyDir}/id_rsa`)) || "";
        } catch (e) {
            lib.std.print(`[airtermd] CRITICAL: System Identity not found at ${keyDir}. Please ensure 'init' has run successfully.\n`);
            return;
        }

        if (!this.publicKey || !this.privateKey) {
            lib.std.print(`[airtermd] CRITICAL: System Identity files are empty.\n`);
            return;
        }

        this.fingerprint = crypto.createHash('sha256').update(this.publicKey).digest('hex');
        await lib.std.log(`Identity Loaded. Fingerprint: ${this.fingerprint}`, "airtermd");
        await lib.std.log(`Unified Server Listening on MQTNL port ${port}...`, "airtermd");

        const socket = await lib.net.socket();
        await lib.net.bind(socket, port);

        // --- DAEMONIZE ---
        if (await lib.shell.daemonize("Airterm Server")) {
            await lib.std.log("Server daemonized and moved to background.", "airtermd");
        }

        (lib as any).onEvent("signal", async (sig: any) => {
            if (sig === "SIGTERM") {
                const activeSessions = Array.from(this.sessions.entries()).filter(([_, sess]) => sess.active);

                await Promise.all(activeSessions.map(async ([sid, sess]) => {
                    try {
                        sess.active = false; // STOP THE BRIDGE FIRST
                        const msg = sess.agent.securePacketOut("\r\n[Host is rebooting...]\r\nBye...\r\n");
                        await lib.net.sendto(sess.fd, sess.src, sess.port, msg, PacketFlags.FLAG_DATA, sess.localPort);

                        const exitSignal = sess.agent.securePacketOut("!exit!");
                        // Triple send to ensure delivery on very slow/jank hardware links
                        await lib.net.sendto(sess.fd, sess.src, sess.port, exitSignal, PacketFlags.FLAG_DATA, sess.localPort);
                        await lib.net.sendto(sess.fd, sess.src, sess.port, exitSignal, PacketFlags.FLAG_DATA, sess.localPort);
                        await lib.net.sendto(sess.fd, sess.src, sess.port, exitSignal, PacketFlags.FLAG_DATA, sess.localPort);
                    } catch (e: any) { }
                }));

                // Small delay to ensure packets are flushed from Node.js event loop
                await new Promise(r => setTimeout(r, 1500));
                await lib.shell.exit(0);
            }
        });

        // --- MAIN DISPATCHER LOOP ---
        while (true) {
            const pkt = await lib.net.recv(socket);
            if (pkt) {
                const sid = `${pkt.src}:${pkt.port}`;
                await this.routePacket(lib, socket, sid, pkt);
            }

            // Maintenance: Cleanup stale/dead sessions
            const now = Date.now();
            for (const [sid, sess] of this.sessions.entries()) {
                if (now - sess.lastSeen > 60000 && !sess.active) {
                    this.sessions.delete(sid);
                }
            }
            await new Promise(r => setTimeout(r, 10));
        }
    }

    /**
     * Centralized packet router for all port 25 traffic
     */
    private async routePacket(lib: UserLib, fd: number, sid: string, pkt: any) {
        let sess = this.sessions.get(sid);

        // A. NEW HANDSHAKE (Step 1)
        if (pkt.data === "__request::key-exchange") { // Step 1: Client hello
            await lib.std.log(`[${sid}] Handshake started (Step 1).`, "airtermd");
            sess = {
                id: sid,
                step: 1,
                fd: fd,
                src: pkt.src,
                port: pkt.port,
                localPort: pkt.localPort,
                agent: new SecurityAgent(),
                active: false,
                shellPid: -1,
                inputQueue: [],
                lastSeen: Date.now()
            };
            this.sessions.set(sid, sess);

            // Step 2: Send PubKey (Plain)
            const pubKeyPayload = `__pubkey::${this.publicKey}::${this.fingerprint}`;
            await lib.net.sendto(fd, pkt.src, pkt.port, pubKeyPayload, PacketFlags.FLAG_DATA, pkt.localPort);
            sess.step = 2;
            return;
        }

        if (!sess) return; // Ignore packets for unknown sessions
        sess.lastSeen = Date.now();

        // B. SESSION IS ACTIVE: Feed the bridge loop
        if (sess.step >= 4) {
            sess.inputQueue.push(pkt.data);
            return;
        }

        // C. HANDSHAKE PROGRESSION (Step 3: Secret Key Received)
        if (sess.step === 2 && typeof pkt.data === "string" && pkt.data.startsWith("__secretkey::")) {
            await lib.std.log(`[${sid}] Session key received (Step 3).`, "airtermd");
            const encryptedKeyHex = pkt.data.replace("__secretkey::", "");
            try {
                const sessionKey = SecurityAgent.decryptWithPrivateKey(this.privateKey, encryptedKeyHex);
                sess.agent.setSessionKey(sessionKey);

                // Step 4: done (Plain)
                await lib.net.sendto(fd, pkt.src, pkt.port, "__status::done", PacketFlags.FLAG_DATA, pkt.localPort);
                sess.step = 4;

                // Fire off the background session handler
                (async () => {
                    await this.runSession(lib, sess!);
                    this.sessions.delete(sid);
                })();
            } catch (e: any) {
                await lib.std.log(`[${sid}] Handshake Error: ${e.message}`, "airtermd");
                this.sessions.delete(sid);
            }
            return;
        }
    }

    /**
     * Isolated background handler for a single session
     */
    private async runSession(lib: UserLib, sess: Session) {
        try {
            // Wait for Encrypted "requestConnect" (Step 5)
            const rawReq = await this.readSess(sess, 5000);
            if (!rawReq) {
                await lib.std.log(`[${sess.id}] Timeout waiting for connect request.`, "airtermd");
                return;
            }

            const decReq = sess.agent.securePacketIn(rawReq);
            const json = JSON.parse(decReq);
            if (json.payload !== "requestConnect") throw new Error("Invalid Connect Payload");

            const customCmd = json.command; // Optional: e.g. "scpd --put /root/test.txt"

            // Step 6: accept (Encrypted)
            const acceptMsg = sess.agent.securePacketOut("!connectAccept!");
            await lib.net.sendto(sess.fd, sess.src, sess.port, acceptMsg, PacketFlags.FLAG_DATA, sess.localPort);

            // --- ALLOCATE & CLEAR ISOLATED TTY (7-12) ---
            // Scavenge for an available TTY — cek juga proses lain via ps biar gak tabrakan
            let ttyId = 7;
            const activeTtys = Array.from(this.sessions.values()).map(s => (s as any).ttyId).filter(id => id !== undefined);
            // Tambahin TTY yang dipake proses lain (misal pixelterm)
            try {
                const allProcs = await lib.shell.ps();
                const usedTtys = new Set(allProcs
                    .filter((p: any) => p.ttyId && p.ttyId >= 7 && p.ttyId <= 12 && p.state !== "EXITED")
                    .map((p: any) => p.ttyId)
                );
                for (const t of usedTtys) { if (!activeTtys.includes(t)) activeTtys.push(t); }
            } catch (_) {}
            for (let i = 7; i <= 12; i++) {
                if (!activeTtys.includes(i)) {
                    ttyId = i;
                    break;
                }
            }
            (sess as any).ttyId = ttyId;

            try {
                const ttyFd = await lib.fs.open(`/dev/tty${ttyId}`, "w+");
                if (ttyFd >= 0) {
                    await lib.fs.ioctl(ttyFd, 1, null); // Clear Scrollback/Buffer
                    await lib.fs.close(ttyFd);
                }
            } catch (e) { }

            await lib.std.log(`[${sess.id}] Secure session established on TTY${ttyId}.`, "airtermd");

            // --- SPAWN PROCESS (LOGIN OR CUSTOM COMMAND) ---
            let procInfo;
            if (customCmd) {
                const parts = customCmd.split(" ");
                const bin = parts[0];
                const args = parts.slice(1);
                procInfo = await lib.shell.exec(bin, args, undefined, undefined, ttyId);
                await lib.std.log(`[${sess.id}] Executing remote command: ${customCmd} (PID ${procInfo?.pid})`, "airtermd");
            } else {
                procInfo = await lib.shell.exec("/bin/login.ts", [], undefined, undefined, ttyId);
                await lib.std.log(`[${sess.id}] Remote login shell spawned (PID ${procInfo?.pid}, TTY${ttyId})`, "airtermd");
            }

            if (!procInfo) {
                await lib.std.log(`[${sess.id}] Failed to spawn process.`, "airtermd");
                throw new Error("Failed to spawn process.");
            }
            sess.shellPid = procInfo.pid;
            sess.active = true;

            // --- BRIDGE: Output (Shell -> Network) ---
            const bridgeOut = async () => {
                try {
                    while (sess.active) {
                        const output = await lib.shell.read(procInfo.pid);
                        if (output && sess.active) { // Final check before sending to avoid racing with SIGTERM handler
                            // Manual Encryption (Staying on port 25)
                            const encrypted = sess.agent.securePacketOut(output);
                            await lib.net.sendto(sess.fd, sess.src, sess.port, encrypted, PacketFlags.FLAG_DATA, sess.localPort);
                        }
                        await new Promise(r => setTimeout(r, 10));
                    }
                } catch (e: any) {
                    if (sess.active) await lib.std.log(`[${sess.id}] bridgeOut Error: ${e.message}`, "airtermd");
                }
            };

            // --- BRIDGE: Input (Network -> Shell) ---
            const bridgeIn = async () => {
                try {
                    while (sess.active) {
                        const raw = await this.readSess(sess);
                        if (raw && sess.active) { // Final check before processing to avoid race during shutdown
                            // Manual Decryption
                            const decrypted = sess.agent.securePacketIn(raw);
                            if (decrypted) {
                                try {
                                    const msg = JSON.parse(decrypted);
                                    if (msg.payload === "io" && msg.io) {
                                        const input = msg.io.char || msg.io.data || msg.io.key?.sequence;
                                        if (input !== undefined) await lib.shell.write(procInfo.pid, input);
                                    } else if (msg.payload === "resize") {
                                        const { rows, cols } = msg;
                                        try {
                                            const ttyFd = await lib.fs.open(`/dev/tty${ttyId}`, "w+");
                                            if (ttyFd >= 0) {
                                                await lib.fs.ioctl(ttyFd, 3, { lines: rows, columns: cols });
                                                await lib.fs.close(ttyFd);
                                            }
                                        } catch (e) { }
                                    }
                                } catch (e) {
                                    // Fallback to raw string input if not JSON
                                    await lib.shell.write(procInfo.pid, decrypted);
                                }
                            }
                        }
                        await new Promise(r => setTimeout(r, 10));
                    }
                } catch (e: any) {
                    if (sess.active) await lib.std.log(`[${sess.id}] bridgeIn Error: ${e.message}`, "airtermd");
                }
            };

            bridgeIn();
            bridgeOut();

            await lib.shell.waitpid(procInfo.pid);
            sess.active = false;

            // --- GRACEFUL EXIT ---
            await lib.std.log(`[${sess.id}] Client disconnected.`, "airtermd");

            const byeMsg = sess.agent.securePacketOut("Bye...\r\n");
            await lib.net.sendto(sess.fd, sess.src, sess.port, byeMsg, PacketFlags.FLAG_DATA, sess.localPort);

            const exitSignal = sess.agent.securePacketOut("!exit!");
            await lib.net.sendto(sess.fd, sess.src, sess.port, exitSignal, PacketFlags.FLAG_DATA, sess.localPort);
        } catch (e: any) {
            await lib.std.log(`[${sess.id}] Runtime Crash: ${e.message}`, "airtermd");
        } finally {
            sess.active = false;
            this.sessions.delete(sess.id);
        }
    }

    /**
     * Internal helper to read from the session's packet queue
     */
    private async readSess(sess: Session, timeout: number = 0): Promise<string | null> {
        const start = Date.now();
        while (sess.inputQueue.length === 0) {
            if (timeout > 0 && Date.now() - start > timeout) return null;
            if (!sess.active && sess.step >= 4 && timeout === 0) return null; // Early exit detection
            await new Promise(r => setTimeout(r, 50));
        }
        return sess.inputQueue.shift() || null;
    }
}
