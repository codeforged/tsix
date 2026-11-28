import { Program, std, fs, shell, net } from "@tsix/Application";
import { PacketFlags } from "@common/PacketFlags";
import { SecurityAgent } from "@common/SecurityAgent";
import { scpBasename, scpDestination } from "@tsix/scp-access";
import { checkKnownHost, knownHostLine } from "@tsix/known-hosts";

/**
 * SCP Utility
 * 
 * Secure Copy (remote file copy program).
 */
export const main = Program(async (args) => {
    if (args.includes("--help") || args.includes("-h")) {
        await std.print("Usage: scp <src> <dest>\nCopy files between hosts using MQTNL.\n");
        return;
    }
    if (args.length < 2) return "Usage: scp <src> <dest>";

    const agent = new SecurityAgent();
    const arg1 = args[0], arg2 = args[1];

    let isUpload = false, localPath = "", remoteNode = "", remotePath = "", remoteUser = "";
    const parseRemote = (spec: string) => {
        if (!spec.includes(":")) return null;
        const [hostPart, path] = spec.split(":");
        let user = "root", host = hostPart;
        if (hostPart.includes("@")) {
            const [u, h] = hostPart.split("@");
            user = u; host = h;
        }
        return { user, host, path };
    };

    const r1 = parseRemote(arg1), r2 = parseRemote(arg2);
    if (r2) { isUpload = true; localPath = arg1; remoteUser = r2.user; remoteNode = r2.host; remotePath = r2.path; }
    else if (r1) { isUpload = false; remoteUser = r1.user; remoteNode = r1.host; remotePath = r1.path; localPath = arg2; }
    else return "Err: Invalid spec";

    // Tujuan berupa direktori (`./`, `.`, `dir/`, `host:`, atau direktori lokal
    // yang sudah ada) → pakai nama file sumber, seperti scp/cp Unix.
    if (isUpload) {
        const dest = scpDestination(remotePath, localPath);
        if (dest === null) return "Err: source has no file name";
        remotePath = dest;
    } else {
        let isDir = false;
        try {
            isDir = (await fs.stat(localPath))?.type === "DIRECTORY";
        } catch (_) { /* belum ada → nama file */ }
        const dest = scpDestination(localPath, remotePath, isDir);
        if (dest === null) return "Err: source has no file name";
        localPath = dest;
    }

    const remotePort = 2222, localPort = 5000 + Math.floor(Math.random() * 1000);

    const fd = await net.socket();
    await net.bind(fd, localPort);

    try {
        await std.println(`[scp] connecting to ${remoteNode}:${remotePort}...`);
        await net.sendto(fd, remoteNode, remotePort, "__request::key-exchange", PacketFlags.FLAG_DATA, localPort);

        let pkt = await waitForPrefix(agent, fd, "__pubkey::", 5000);
        if (!pkt) throw new Error("Handshake Failed (Timeout)");

        const pub = pkt.data.split("::")[1];
        // SEC-33: verifikasi kunci server (known_hosts, sama dengan tssh) SEBELUM
        // session key dan password dikirim. Dulu kunci apa pun diterima.
        if (!(await verifyServerKey(remoteNode, pub))) throw new Error("Host key verification failed");
        const sessionKey = SecurityAgent.generateSessionKey();
        await net.sendto(fd, remoteNode, remotePort, `__secretkey::${SecurityAgent.encryptWithPublicKey(pub, sessionKey)}`, PacketFlags.FLAG_DATA, localPort);

        if (!await waitForMatch(agent, fd, "__status::done", 5000)) throw new Error("Handshake Failed (Finalize)");
        agent.setSessionKey(sessionKey);

        const password = await (std as any).readPassword(`${remoteUser}@${remoteNode}'s password: `);
        if (!password && password !== "") throw new Error("Abort");

        await net.sendto(fd, remoteNode, remotePort, agent.securePacketOut(JSON.stringify({ type: "auth", username: remoteUser, password: password })), PacketFlags.FLAG_DATA, localPort);

        await std.print("[scp] Authenticating... ");
        pkt = await waitForJSON(agent, fd, "auth_ok", 15000);
        if (!pkt) throw new Error("Verification Failed (Timeout or Wrong Password)");
        await std.println("OK.");

        if (isUpload) {
            await std.println(`[scp] Uploading ${localPath} to ${remotePath}...`);
            const content = await fs.readFile(localPath);
            if (content === null) throw new Error("Read fail");
            await net.sendto(fd, remoteNode, remotePort, agent.securePacketOut(JSON.stringify({ type: "file", filename: remotePath, name: scpBasename(localPath), data: Buffer.from(content, 'binary').toString('base64') })), PacketFlags.FLAG_DATA, localPort);
            if (!await waitForJSON(agent, fd, "ok", 15000)) throw new Error("Upload acknowledgement failed");
        } else {
            await std.println(`[scp] Downloading ${remotePath} to ${localPath}...`);
            await net.sendto(fd, remoteNode, remotePort, agent.securePacketOut(JSON.stringify({ type: "getfile", filename: remotePath })), PacketFlags.FLAG_DATA, localPort);
            pkt = await waitForJSON(agent, fd, "file", 15000);
            if (!pkt) throw new Error("Download response failed");
            const m = JSON.parse(pkt.data);
            try { await fs.unlink(localPath); } catch (e) { }
            await fs.writeFile(localPath, Buffer.from(m.data, 'base64').toString('binary'));
        }
        await std.println("[scp] Done.");
        await net.sendto(fd, remoteNode, remotePort, agent.securePacketOut(JSON.stringify({ type: "bye" })), PacketFlags.FLAG_DATA, localPort);
    } catch (e: any) {
        await std.println(`\n[scp] Error: ${e.message}`);
    } finally {
        await net.close(fd);
    }
});

async function verifyServerKey(host: string, pub: string): Promise<boolean> {
    const home = (await (shell as any).getenv("HOME")) || "/root";
    const path = `${home}/.ssh/known_hosts`;
    let content = "";
    try { content = (await fs.readFile(path)) || ""; } catch (_) { }

    const trust = checkKnownHost(content, host, pub);
    if (trust === "trusted") return true;
    if (trust === "mismatch") {
        await std.println("\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@");
        await std.println("@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!   @");
        await std.println("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@");
        await std.println(`Host key for '${host}' does not match ${path}. Aborting.`);
        return false;
    }
    await std.println(`\nThe authenticity of host '${host}' can't be established.`);
    await std.println(`SHA256 fingerprint is ${SecurityAgent.publicKeyFingerprint(pub)}`);
    await std.print("Are you sure you want to continue connecting (yes/no)? ");
    const answer = await (std as any).readLine();
    if (String(answer ?? "").trim().toLowerCase() !== "yes") return false;
    try { await fs.mkdir(`${home}/.ssh`); } catch (_) { }
    await fs.writeFile(path, content + (content && !content.endsWith("\n") ? "\n" : "") + knownHostLine(host, pub));
    return true;
}

async function waitForMatch(agent: any, fd: number, exp: string, timeout: number) {
    const s = Date.now();
    while (Date.now() - s < timeout) {
        const p = await net.recv(fd);
        if (p && agent.securePacketIn(p.data) === exp) return p;
        await new Promise(r => setTimeout(r, 100));
    }
    return null;
}
async function waitForPrefix(agent: any, fd: number, pref: string, timeout: number) {
    const s = Date.now();
    while (Date.now() - s < timeout) {
        const p = await net.recv(fd);
        if (p) {
            const d = agent.securePacketIn(p.data);
            if (typeof d === 'string' && d.startsWith(pref)) return { ...p, data: d };
        }
        await new Promise(r => setTimeout(r, 100));
    }
    return null;
}
async function waitForJSON(agent: any, fd: number, type: string, timeout: number) {
    const s = Date.now();
    while (Date.now() - s < timeout) {
        const p = await net.recv(fd);
        if (p) {
            try {
                const d = agent.securePacketIn(p.data);
                const m = JSON.parse(d);
                if (m.type === type || m.status === type) return { ...p, data: d };
                if (m.type === "error" || m.type === "auth_fail" || m.status === "error") throw new Error(m.message || m.type);
            } catch (e: any) { if (e.message !== "Not JSON" && !(e instanceof SyntaxError)) throw e; }
        }
        await new Promise(r => setTimeout(r, 100));
    }
    return null;
}
