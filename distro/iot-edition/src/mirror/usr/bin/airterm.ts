import { UserLib } from "@tsix/UserLib";
import { PacketFlags } from "@common/PacketFlags";
import { SecurityAgent } from "@common/SecurityAgent";

/**
 * AIRTERM Utility
 * 
 * TSIX Secure Terminal Client.
 */
export default class Airterm {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: airterm <remote_address> [port] [-c command]\nSecure terminal client.\n");
            return;
        }
        if (args.length < 1) {
            lib.std.print("Usage: airterm <remote_address> [port]\n");
            return;
        }

        const remoteAddr = args[0];
        const remotePort = parseInt(args[1]) || 22; // SSH standard port
        const localPort = 4000 + Math.floor(Math.random() * 1000);

        lib.std.print(`[airterm] Connecting to ${remoteAddr}:${remotePort}...\n`);

        const fd = await lib.net.socket();
        await lib.net.bind(fd, localPort);

        try {
            // --- PHASE A: HANDSHAKE ---
            await lib.net.sendto(fd, remoteAddr, remotePort, "__request::key-exchange", PacketFlags.FLAG_DATA, localPort);

            lib.std.print(`[airterm] Requesting Public Key...\n`);
            let pkt = await this.waitForStart(lib, fd, "__pubkey::", 5000);
            if (!pkt) {
                lib.std.print(`[airterm] Handshake Failed (No public key from server).\n`);
                return;
            }

            const parts = pkt.data.split("::");
            const serverPubKey = parts[1];
            const serverFingerprint = parts[2];

            if (!serverFingerprint) {
                lib.std.print(`[airterm] Security Error: Server did not provide fingerprint.\n`);
                return;
            }

            // Verify fingerprint against known_hosts
            const knownHostsPath = (await lib.shell.getenv("HOME") || "/root") + "/.ssh/known_hosts";
            let knownHosts = "";
            try {
                knownHosts = await lib.fs.readFile(knownHostsPath) || "";
            } catch (e) {
                // File doesn't exist yet, will be created
            }

            const hostEntry = `${remoteAddr} ${serverFingerprint}`;
            const lines = knownHosts.split("\n").filter(l => l.trim());
            const existingEntry = lines.find(l => l.startsWith(remoteAddr + " "));

            if (existingEntry) {
                const knownFingerprint = existingEntry.split(" ")[1];
                if (knownFingerprint !== serverFingerprint) {
                    await lib.std.setRawMode(false);
                    lib.std.print(`\n`);
                    lib.std.print(`@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n`);
                    lib.std.print(`@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!   @\n`);
                    lib.std.print(`@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n`);
                    lib.std.print(`IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\n`);
                    lib.std.print(`Someone could be eavesdropping on you right now (man-in-the-middle attack)!\n`);
                    lib.std.print(`The fingerprint for the RSA key sent by the remote host is:\n`);
                    lib.std.print(`SHA256:${serverFingerprint.substring(0, 16)}...\n`);
                    lib.std.print(`\nConnection aborted.\n`);
                    return;
                }
                lib.std.print(`[airterm] Host identity verified (known host).\n`);
            } else {
                // First time connecting to this host
                await lib.std.setRawMode(false);
                lib.std.print(`\nThe authenticity of host '${remoteAddr}' can't be established.\n`);
                lib.std.print(`RSA key fingerprint is SHA256:${serverFingerprint.substring(0, 16)}...\n`);
                lib.std.print(`Are you sure you want to continue connecting (yes/no)? `);

                const answer = await lib.std.readLine();
                if (answer?.trim().toLowerCase() !== "yes") {
                    lib.std.print(`Connection aborted.\n`);
                    return;
                }

                // Save to known_hosts
                try {
                    const sshDir = (await lib.shell.getenv("HOME") || "/root") + "/.ssh";
                    await lib.fs.mkdir(sshDir);
                } catch (e) { }

                const newContent = knownHosts + (knownHosts ? "\n" : "") + hostEntry + "\n";
                await lib.fs.writeFile(knownHostsPath, newContent);
                lib.std.print(`Warning: Permanently added '${remoteAddr}' (RSA) to the list of known hosts.\n`);
            }

            lib.std.print(`[airterm] Public Key received. Generating Session Key...\n`);

            const sessionKey = SecurityAgent.generateSessionKey();
            const encryptedKeyHex = SecurityAgent.encryptWithPublicKey(serverPubKey, sessionKey);

            await lib.net.sendto(fd, remoteAddr, remotePort, `__secretkey::${encryptedKeyHex}`, PacketFlags.FLAG_DATA, localPort);

            pkt = await this.waitForPayload(lib, fd, "__status::done", 5000);
            if (!pkt) {
                lib.std.print(`[airterm] Handshake Failed (No __status::done received).\n`);
                return;
            }

            await lib.net.ioctl(fd, 0x1001, { port: localPort, sessionKey });
            await new Promise(r => setTimeout(r, 200));

            lib.std.print(`[airterm] Authenticating session...\n`);

            const cmdIdx = args.indexOf("-c");
            let remoteCommand: string | undefined;
            if (cmdIdx !== -1 && cmdIdx + 1 < args.length) {
                remoteCommand = args[cmdIdx + 1];
            }

            const connectReq = {
                payload: "requestConnect",
                command: remoteCommand
            };

            await lib.net.sendto(fd, remoteAddr, remotePort, JSON.stringify(connectReq), PacketFlags.FLAG_DATA, localPort);

            pkt = await this.waitForPayload(lib, fd, "!connectAccept!", 5000);
            if (!pkt) {
                lib.std.print(`[airterm] Connection Failed (No !connectAccept! from server).\n`);
                return;
            }

            lib.std.print(`[airterm] Handshake Successful. Session Encrypted.\n`);

            // Bridge local SIGINT to remote \x03
            await lib.shell.onSignal("SIGINT", async () => {
                await lib.std.print("\n[airterm] Sending Interrupt (^C)...\n");
                const interruptMsg = {
                    payload: "io",
                    io: {
                        key: {
                            name: "c",
                            sequence: "\x03",
                            ctrl: true,
                            meta: false,
                            shift: false
                        },
                        char: "\x03",
                        data: "\x03"
                    }
                };
                await lib.net.sendto(fd, remoteAddr, remotePort, JSON.stringify(interruptMsg), PacketFlags.FLAG_DATA, localPort);
            });

            const rows = parseInt(await lib.shell.getenv("LINES") || "24");
            const cols = parseInt(await lib.shell.getenv("COLUMNS") || "80");
            await lib.net.sendto(fd, remoteAddr, remotePort, JSON.stringify({ payload: "resize", rows, cols }), PacketFlags.FLAG_DATA, localPort);

            // Handle local SIGWINCH and forward it to remote
            await lib.shell.onSignal("SIGWINCH", async () => {
                const newRows = parseInt(await lib.shell.getenv("LINES") || "24");
                const newCols = parseInt(await lib.shell.getenv("COLUMNS") || "80");
                const resizeMsg = { payload: "resize", rows: newRows, cols: newCols };
                await lib.net.sendto(fd, remoteAddr, remotePort, JSON.stringify(resizeMsg), PacketFlags.FLAG_DATA, localPort);
            });

            // --- PHASE B: TERMINAL BRIDGE ---
            await lib.std.setRawMode(true);
            lib.std.print(`\x1b[2J\x1b[H`); // Clear screen

            let active = true;

            const bridgeIn = async () => {
                while (active) {
                    const char = await lib.std.getChar();
                    if (char) {
                        let sequence = char;
                        let keyName = char;

                        // Detect escape sequences (arrow keys, function keys, etc.)
                        if (char === "\x1b") {
                            const next1 = await lib.std.getChar();
                            if (next1 === "[") {
                                const next2 = await lib.std.getChar();
                                sequence = char + next1 + next2;

                                // Map common sequences to key names
                                switch (next2) {
                                    case "A": keyName = "up"; break;
                                    case "B": keyName = "down"; break;
                                    case "C": keyName = "right"; break;
                                    case "D": keyName = "left"; break;
                                    case "H": keyName = "home"; break;
                                    case "F": keyName = "end"; break;
                                    default: keyName = sequence; break;
                                }
                            } else if (next1) {
                                sequence = char + next1;
                                keyName = sequence;
                            }
                        }

                        const msg = {
                            payload: "io",
                            io: {
                                key: {
                                    name: keyName,
                                    sequence: sequence,
                                    ctrl: false,
                                    meta: sequence.startsWith("\x1b"),
                                    shift: false
                                },
                                char: sequence,
                                data: sequence
                            }
                        };
                        const payloadStr = JSON.stringify(msg);
                        await lib.net.sendto(fd, remoteAddr, remotePort, payloadStr, PacketFlags.FLAG_DATA, localPort);
                    }
                    await new Promise(r => setTimeout(r, 10));
                }
            };

            const bridgeOut = async () => {
                while (active) {
                    const pkt = await lib.net.recv(fd);
                    if (pkt && pkt.data) {
                        if (typeof pkt.data === 'string') {
                            // Check for exit signal
                            if (pkt.data.includes("!exit!")) {
                                // Print everything BEFORE the !exit! signal if present
                                const parts = pkt.data.split("!exit!");
                                if (parts[0]) await lib.std.print(parts[0]);

                                active = false;
                                return;
                            }

                            if (pkt.data.includes('{"payload":"io"')) {
                                try {
                                    const msg = JSON.parse(pkt.data);
                                    if (msg.io && msg.io.data) {
                                        await lib.std.print(msg.io.data);
                                    }
                                } catch (e) { }
                            } else {
                                await lib.std.print(pkt.data);
                            }
                        }
                    }
                    await new Promise(r => setTimeout(r, 20));
                }
            };

            bridgeIn();
            await bridgeOut();

            active = false;
            await lib.std.setRawMode(false);
            // lib.std.print(`\n[airterm] Connection closed.\n`);

        } catch (e: any) {
            await lib.std.setRawMode(false);
            lib.std.print(`\n[airterm] Error: ${e.message}\n`);
        }
    }

    private async waitForPayload(lib: UserLib, fd: number, expected: string, timeout: number): Promise<any> {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const pkt = await lib.net.recv(fd);
            if (pkt && pkt.data === expected) return pkt;
            await new Promise(r => setTimeout(r, 100));
        }
        return null;
    }

    private async waitForStart(lib: UserLib, fd: number, prefix: string, timeout: number): Promise<any> {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const pkt = await lib.net.recv(fd);
            if (pkt && typeof pkt.data === 'string' && pkt.data.startsWith(prefix)) return pkt;
            await new Promise(r => setTimeout(r, 100));
        }
        return null;
    }
}
