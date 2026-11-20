import { Program, std, fs, shell, net } from "@tsix/Application";
import { PacketFlags } from "@common/PacketFlags";
import { SecurityAgent } from "@common/SecurityAgent";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";

/**
 * SCPD Utility
 * 
 * Secure Copy Protocol Daemon.
 */
export const main = Program(async (args) => {
    if (args.includes("--help") || args.includes("-h")) {
        await std.print("Usage: scpd [--debug]\nSecure Copy Protocol Daemon.\n");
        return;
    }

    // SECURITY: Only root can start scpd
    const user = await shell.whoami();
    if (user.uid !== 0) {
        await std.print("Permission Denied: Only root can start the SCP daemon. Use sudo.\n");
        return;
    }
    await std.log("SCPD Starting...", "scpd");
    const port = 2222;
    const keyDir = "/etc/keys/rsa";
    const pub = (await fs.readFile(`${keyDir}/id_rsa.pub`)) || "";
    const priv = (await fs.readFile(`${keyDir}/id_rsa`)) || "";
    if (!pub || !priv) return;

    const finger = crypto.createHash('sha256').update(pub).digest('hex');
    const socket = await net.socket();
    await net.bind(socket, port);

    if (!args.includes("--debug")) await shell.daemonize("SCP Server");

    const sessions = new Map();

    while (true) {
        const pkt = await net.recv(socket);
        if (!pkt || !pkt.data) { await new Promise(r => setTimeout(r, 100)); continue; }

        const id = `${pkt.src}:${pkt.port}`;
        let sess = sessions.get(id);

        if (!sess) {
            if (pkt.data === "__request::key-exchange") {
                sess = { id, fd: socket, agent: new SecurityAgent(), authed: false };
                sessions.set(id, sess);
                await net.sendto(socket, pkt.src, pkt.port, `__pubkey::${pub}::${finger}`, PacketFlags.FLAG_DATA, port);
            }
            continue;
        }

        if (pkt.data.startsWith("__secretkey::")) {
            try {
                const key = SecurityAgent.decryptWithPrivateKey(priv, pkt.data.split("::")[1]);
                sess.agent.setSessionKey(key);
                await net.sendto(socket, pkt.src, pkt.port, "__status::done", PacketFlags.FLAG_DATA, port);
            } catch (e) { sessions.delete(id); }
            continue;
        }

        const dec = sess.agent.securePacketIn(pkt.data);
        if (!dec) continue;

        let msg: any;
        try {
            msg = JSON.parse(dec);
            if (!sess.authed && msg.type === "auth") {
                let ok = false;
                try {
                    const shadow = await fs.readFile("/etc/shadow");
                    if (shadow) {
                        for (const line of shadow.split("\n")) {
                            const p = line.split(":");
                            if (p[0] === msg.username && bcrypt.compareSync(msg.password, p[1])) { ok = true; break; }
                        }
                    }
                } catch (e) { }
                if (ok) {
                    sess.authed = true;
                    await net.sendto(socket, pkt.src, pkt.port, sess.agent.securePacketOut(JSON.stringify({ type: "auth_ok" })), PacketFlags.FLAG_DATA, port);
                    await std.log(`[${id}] Auth OK: ${msg.username}`, "scpd");
                } else {
                    await net.sendto(socket, pkt.src, pkt.port, sess.agent.securePacketOut(JSON.stringify({ type: "auth_fail", message: "Invalid credentials" })), PacketFlags.FLAG_DATA, port);
                    await std.log(`[${id}] Auth Failed: ${msg.username}`, "scpd");
                }
                continue;
            }

            if (!sess.authed) continue;

            if (msg.type === "file") {
                await fs.writeFile(msg.filename, Buffer.from(msg.data, 'base64').toString('binary'));
                await net.sendto(socket, pkt.src, pkt.port, sess.agent.securePacketOut(JSON.stringify({ type: "ok" })), PacketFlags.FLAG_DATA, port);
            } else if (msg.type === "getfile") {
                try {
                    const c = await fs.readFile(msg.filename);
                    if (c !== null) {
                        await net.sendto(socket, pkt.src, pkt.port, sess.agent.securePacketOut(JSON.stringify({ type: "file", data: Buffer.from(c, 'binary').toString('base64') })), PacketFlags.FLAG_DATA, port);
                    } else {
                        throw new Error("Empty file or read failure");
                    }
                } catch (err: any) {
                    await net.sendto(socket, pkt.src, pkt.port, sess.agent.securePacketOut(JSON.stringify({ type: "error", message: err.message })), PacketFlags.FLAG_DATA, port);
                    await std.log(`[${id}] Download error: ${err.message}`, "scpd");
                }
            } else if (msg.type === "bye") {
                sessions.delete(id);
            }
        } catch (e: any) {
            await std.log(`[${id}] Message processing error: ${e.message}`, "scpd");
            continue;
        }
    }
});
