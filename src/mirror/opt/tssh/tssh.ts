import { UserLib } from "@tsix/UserLib";
import { PacketFlags } from "@common/PacketFlags";
import { SecurityAgent } from "@common/SecurityAgent";
import { TSSHProtocol, TSSHOpcode, TSSHChannel } from "@common/protocols/TSSHProtocol";

export default class TSSHClient {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h") || args.length < 1) {
            await lib.std.print("Usage: tssh <remote_address> [port] [-c command]\nTSIX Secure Shell Client.\n");
            return;
        }

        const remoteAddr = args[0]; 
        const remotePort = parseInt(args[1]) || 22;
        const localPort = 4000 + Math.floor(Math.random() * 1000);

        lib.std.print(`[tssh] Connecting to ${remoteAddr}:${remotePort}...\n`);

        const fd = await lib.net.socket();
        await lib.net.bind(fd, localPort);
        await lib.net.ioctl(fd, 0x1002, true); 

        try {
            // --- PHASE 1: HANDSHAKE ---
            const reqPkt = TSSHProtocol.pack(TSSHOpcode.HANDSHAKE_REQ, TSSHChannel.CONTROL);
            await lib.net.sendto(fd, remoteAddr, remotePort, reqPkt, PacketFlags.FLAG_DATA, localPort);

            const resp = await this.waitForOpcode(lib, fd, TSSHOpcode.HANDSHAKE_RESP, 5000);
            if (!resp) {
                lib.std.print(`[tssh] Connection failed (No handshake response).\n`);
                return;
            }

            const [serverPubKey, serverFingerprint] = resp.payload.toString("utf8").split("::");
            if (!serverFingerprint) {
                lib.std.print(`[tssh] Security Error: Missing server fingerprint.\n`);
                return;
            }

            // Verify Known Hosts
            const verified = await this.verifyHost(lib, remoteAddr, serverFingerprint);
            if (!verified) return;

            // --- PHASE 2: KEY EXCHANGE ---
            const sessionKey = SecurityAgent.generateSessionKey();
            const encryptedKeyHex = SecurityAgent.encryptWithPublicKey(serverPubKey, sessionKey);

            const kexPkt = TSSHProtocol.pack(TSSHOpcode.KEY_EXCHANGE, TSSHChannel.CONTROL, encryptedKeyHex);
            await lib.net.sendto(fd, remoteAddr, remotePort, kexPkt, PacketFlags.FLAG_DATA, localPort);

            const ack = await this.waitForOpcode(lib, fd, TSSHOpcode.CONNECT_ACK, 5000);
            if (!ack) {
                lib.std.print(`[tssh] Key exchange failed.\n`);
                return;
            }

            // Upgrade local socket security
            await lib.net.ioctl(fd, 0x1001, { port: localPort, sessionKey });
            const agent = new SecurityAgent();
            agent.setSessionKey(sessionKey);

            // --- PHASE 3: SESSION CONNECT ---
            const cmdIdx = args.indexOf("-c");
            const remoteCommand = (cmdIdx !== -1 && cmdIdx + 1 < args.length) ? args[cmdIdx + 1] : "";

            const encryptedCmd = agent.securePacketOut(remoteCommand);
            const connReq = TSSHProtocol.pack(TSSHOpcode.CONNECT_REQ, TSSHChannel.CONTROL, encryptedCmd);
            await lib.net.sendto(fd, remoteAddr, remotePort, connReq, PacketFlags.FLAG_DATA, localPort);

            lib.std.print(`[tssh] Session encrypted. Requesting TTY...\n`);

            // --- PHASE 4: BINARY TERMINAL BRIDGE ---
            let active = true;

            // Send Initial Window Size
            await this.sendWindowSize(lib, fd, remoteAddr, remotePort, localPort);

            // Signal Relay (SIGWINCH & SIGINT)
            await lib.shell.onSignal("SIGWINCH", async () => {
                await this.sendWindowSize(lib, fd, remoteAddr, remotePort, localPort);
            });

            await lib.shell.onSignal("SIGINT", async () => {
                const encryptedInt = agent.securePacketOut("\x03");
                const intMsg = TSSHProtocol.pack(TSSHOpcode.DATA, TSSHChannel.SHELL, encryptedInt);
                await lib.net.sendto(fd, remoteAddr, remotePort, intMsg, PacketFlags.FLAG_DATA, localPort);
            });

            await lib.std.setRawMode(true);
            lib.std.print("\x1b[2J\x1b[H"); // Clear screen

            // Bridge Input (Keyboard -> Net)
            const bridgeIn = async () => {
                while (active) {
                    const char = await lib.std.getChar();
                    if (char) {
                        let sequence = char;
                        if (char === "\x1b") {
                            const n1 = await lib.std.getChar();
                            if (n1) sequence += n1;
                            if (n1 === "[") {
                                const n2 = await lib.std.getChar();
                                if (n2) sequence += n2;
                            }
                        }
                        const encryptedSeq = agent.securePacketOut(sequence);
                        const pkt = TSSHProtocol.pack(TSSHOpcode.DATA, TSSHChannel.SHELL, encryptedSeq);
                        await lib.net.sendto(fd, remoteAddr, remotePort, pkt, PacketFlags.FLAG_DATA, localPort);
                    }
                    await new Promise(r => setTimeout(r, 10));
                }
            };

            // Bridge Output (Net -> Terminal)
            const bridgeOut = async () => {
                while (active) {
                    const rawPkt = await lib.net.recv(fd);
                    if (rawPkt && rawPkt.data) {
                        const pkt = TSSHProtocol.unpack(rawPkt.data);
                        if (pkt) {
                            if (pkt.opcode === TSSHOpcode.DATA) {
                                const decrypted = agent.securePacketIn(pkt.payload.toString("utf8"));
                                if (decrypted) {
                                    await lib.std.print(decrypted);
                                }
                            } else if (pkt.opcode === TSSHOpcode.EXIT) {
                                active = false;
                                return;
                            }
                        }
                    }
                    await new Promise(r => setTimeout(r, 15));
                }
            };

            bridgeIn();
            await bridgeOut();

            await lib.std.setRawMode(false);
            lib.std.print("\n[tssh] Connection closed.\n");

        } catch (e: any) {
            await lib.std.setRawMode(false);
            lib.std.print(`\n[tssh] Error: ${e.message}\n`);
        }
    }

    private async sendWindowSize(lib: UserLib, fd: number, rAddr: string, rPort: number, lPort: number) {
        const rows = parseInt(await lib.shell.getenv("LINES") || "24");
        const cols = parseInt(await lib.shell.getenv("COLUMNS") || "80");
        const buf = Buffer.alloc(4);
        buf.writeUInt16BE(rows, 0);
        buf.writeUInt16BE(cols, 2);

        const pkt = TSSHProtocol.pack(TSSHOpcode.RESIZE, TSSHChannel.CONTROL, buf);
        await lib.net.sendto(fd, rAddr, rPort, pkt, PacketFlags.FLAG_DATA, lPort);
    }

    private async waitForOpcode(lib: UserLib, fd: number, expectedOpcode: TSSHOpcode, timeout: number) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const raw = await lib.net.recv(fd);
            if (raw && raw.data) {
                const pkt = TSSHProtocol.unpack(raw.data);
                if (pkt && pkt.opcode === expectedOpcode) return pkt;
            }
            await new Promise(r => setTimeout(r, 50));
        }
        return null;
    }

    private async verifyHost(lib: UserLib, host: string, fingerprint: string): Promise<boolean> {
        const home = (await lib.shell.getenv("HOME")) || "/root";
        const knownHostsPath = `${home}/.ssh/known_hosts`;
        let content = "";
        try { content = (await lib.fs.readFile(knownHostsPath)) || ""; } catch (_) {}

        const lines = content.split("\n").filter(l => l.trim());
        const entry = lines.find(l => l.startsWith(`${host} `));

        if (entry) {
            const knownFp = entry.split(" ")[1];
            if (knownFp !== fingerprint) {
                lib.std.print("\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n");
                lib.std.print("@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!   @\n");
                lib.std.print("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n");
                lib.std.print("Host identity mismatch! Aborting connection.\n");
                return false;
            }
            return true;
        }

        lib.std.print(`\nThe authenticity of host '${host}' can't be established.\n`);
        lib.std.print(`SHA256 fingerprint is ${fingerprint.substring(0, 16)}...\n`);
        lib.std.print("Are you sure you want to continue connecting (yes/no)? ");

        const answer = await lib.std.readLine();
        if (answer?.trim().toLowerCase() !== "yes") return false;

        try { await lib.fs.mkdir(`${home}/.ssh`); } catch (_) {}
        await lib.fs.writeFile(knownHostsPath, content + (content ? "\n" : "") + `${host} ${fingerprint}\n`);
        return true;
    }
}