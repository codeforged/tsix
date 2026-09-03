import { IProgram, OSContext } from "../../lib/IProgram";
import { NetworkLib, SMQTNL_IOCTL } from "../../lib/NetworkLib";
import { PacketFlags } from "@common/PacketFlags";

/** 
 * NMAP Utility
 * 
 * Network exploration tool and security scanner.
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std } = os;
        const net = new NetworkLib(os);

        if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
            await std.print("\x1B[1;36mNMAP for TSIX\x1B[0m (Standard MQTNL Scanner)\n");
            await std.print("Usage: nmap [options] <target>\n\n");
            await std.print("Options:\n");
            await std.print("  -sn             Discovery scan (Check online nodes via Broadcast)\n");
            await std.print("  -p <ports>      Port scan (Check specific ports - e.g. -p 80,443 or -p 1-100)\n");
            await std.print("  -v              Verbose output\n\n");
            await std.print("Example:\n");
            await std.print("  nmap -sn \"*\"      (Scan all nodes - GUNAKAN KUTIP agar tidak di-expand shell)\n");
            await std.print("  nmap -sn          (Default scan ke '*')\n");
            return;
        }

        const isDiscovery = args.includes("-sn");
        const verbose = args.includes("-v");
        let argTargets = args.filter(a => !a.startsWith("-"));

        // --- SMART EXPANSION DETECTION ---
        if (isDiscovery && argTargets.length > 2) {
            await std.print("\x1B[33m[NOTICE]\x1B[0m Deteksi ekspansi wildcard oleh Shell.\n");
            await std.print("Jika om ingin BROADCAST, gunakan kutip: \x1B[36mnmap -sn \"*\"\x1B[0m\n");

            // Balikkan ke mode broadcast saja kalau targetnya terdeteksi list file lokal
            if (!args.includes("--force")) {
                await std.print("Mendeteksi file lokal sebagai target. Mengalihkan ke mode Broadcast (*) otomatis... 😂\n\n");
                argTargets = ["*"];
            }
        }

        // If discovery and no target, use '*'
        const targets = argTargets.length > 0 ? argTargets : [(isDiscovery ? "*" : "")];

        if (targets.length === 1 && targets[0] === "") {
            await std.print("nmap: target required (e.g. '*' or 'node-name')\n");
            return;
        }

        if (isDiscovery) {
            for (const target of targets) {
                await std.print(`Starting TSIX Node Discovery on \x1B[33m${target}\x1B[0m...\n`);

                const fd = await net.socket();
                const localPort = await net.bind(fd, 49152 + Math.floor(Math.random() * 1000));
                await net.ioctl(fd, SMQTNL_IOCTL.SET_BINARY_MODE, {
                    port: localPort,
                    protocol: "Binfeo",
                });

                const scanStart = Date.now();
                const isBroadcast = target === "*";
                const port = isBroadcast ? 65534 : 200; // Use 65534 for broadcast (NOS standard), 200 for specific
                const flag = isBroadcast ? PacketFlags.FLAG_BROADCAST_PING : PacketFlags.FLAG_PING_REQUEST;
                await net.sendTo(fd, target, port, isBroadcast ? "TSIX_DISCOVERY" : "PROBE", flag, localPort);

                const found: Set<string> = new Set();
                const start = Date.now();
                const timeout = 2500;

                while (Date.now() - start < timeout) {
                    const reply = await net.recvFrom(fd, 500);
                    if (reply && reply.src) {
                        const rtt = Date.now() - scanStart;
                        if (!found.has(reply.src)) {
                            found.add(reply.src);
                            let identity = reply.data || 'Unknown';
                            try {
                                JSON.parse(identity);
                            } catch {
                                if (identity !== 'Unknown') identity = 'encrypted device';
                            }
                            await std.print(`Found node: \x1B[1;32m${reply.src.padEnd(15)}\x1B[0m | Identity: ${identity} | RTT: ${rtt}ms\n`);
                        }
                    }
                }

                if (found.size === 0 && target !== "*") {
                    await std.print(`No response from target: ${target}\n`);
                }
            }

            await std.print(`\nScan complete. \x1B[1;36mDiscovery session ended.\x1B[0m\n`);
            await std.print(`\x1B[33mTip:\x1B[0m Gunakan kutip \x1B[36m"*" \x1B[0m jika tidak ingin di-expand oleh shell ke file lokal.\n`);
        } else {
            // Port Scan
            for (const target of targets) {
                await std.print(`Scanning ports on \x1B[33m${target}\x1B[0m...\n`);

                const fd = await net.socket();
                const localPort = await net.bind(fd, 54321 + Math.floor(Math.random() * 100));
                await net.ioctl(fd, SMQTNL_IOCTL.SET_BINARY_MODE, {
                    port: localPort,
                    protocol: "Binfeo",
                });

                // Default ports to scan
                let ports = [21, 22, 23, 80, 443, 1883, 3306, 8080, 65535];

                // Check for -p flag
                const pIdx = args.indexOf("-p");
                if (pIdx !== -1 && pIdx + 1 < args.length) {
                    const pArg = args[pIdx + 1];
                    if (pArg && pArg.includes("-")) {
                        const [s, e] = pArg.split("-").map(p => parseInt(p));
                        if (!isNaN(s) && !isNaN(e)) {
                            ports = [];
                            for (let p = s; p <= e; p++) ports.push(p);
                        }
                    } else if (pArg) {
                        ports = pArg.split(",").map(p => parseInt(p)).filter(p => !isNaN(p));
                    }
                }

                let openCount = 0;
                for (const port of ports) {
                    if (verbose) await std.print(`Checking ${target}:${port}... `);

                    const start = Date.now();
                    await net.sendTo(fd, target, port, "PROBE", PacketFlags.FLAG_PING_REQUEST, localPort);

                    const reply = await net.recvFrom(fd, 1000);
                    if (reply) {
                        const rtt = Date.now() - start;
                        if (verbose) await std.print(`\x1B[32mUP\x1B[0m\n`);
                        await std.print(`PORT \x1B[1m${port.toString().padEnd(5)}\x1B[0m: \x1B[32mOPEN\x1B[0m (Response in ${rtt}ms from ${reply.src})\n`);
                        openCount++;
                    } else if (verbose) {
                        await std.print(`\x1B[31mTIMEOUT\x1B[0m\n`);
                    }
                }

                await std.print(`\nNmap done: ${target} scanned. ${openCount} ports responded.\n`);
            }
        }
    }
}
