/**
 * esp32-demo.ts — Simulator device Lantana V2.
 *
 * Meniru alur firmware ESP:
 *   HELLO → verifikasi fingerprint server → KEYSET (RSA-OAEP)
 *   → AUTH (accountId + deviceId + AccessKey, terenkripsi)
 *   → kirim bacaan terenkripsi.
 *
 * Usage:
 *   esp32-demo --account=<accountId> --device=<deviceId> --key=<accessKey>
 *              [--plain] [--interval=5000] [--host=tsix] [--port=1000]
 *
 * Tanpa --plain, payload dikirim sebagai frame biner V2.
 */

import { UserLib } from "@tsix/UserLib";
import { SecurityAgent } from "@common/SecurityAgent";
import {
    encodeBinaryPayload,
    encodePlainPayload,
} from "@tsix/lantana/lantana-core";

interface Challenge {
    type: string;
    nonce: string;
    publicKey: string;
    fingerprint: string;
}

export default class Esp32Demo {
    async execute(lib: UserLib, args: string[]) {
        const white = "\x1b[97m";
        const cyan = "\x1b[96m";
        const magenta = "\x1b[95m";
        const red = "\x1b[91m";
        const reset = "\x1b[0m";

        const opt = (name: string, fallback?: string) => {
            const hit = args.find((a) => a.startsWith(`--${name}=`));
            return hit ? hit.split("=").slice(1).join("=") : fallback;
        };

        const TARGET_HOST = opt("host", "jatitsix_3")!;
        const TARGET_PORT = parseInt(opt("port", "1000")!, 10);
        const MY_PORT = parseInt(opt("my-port", "1001")!, 10);
        const accountId = opt("account");
        const deviceId = opt("device");
        const accessKey = opt("key");
        const usePlain = args.includes("--plain");
        const interval = parseInt(opt("interval", "5000")!, 10);

        if (!accountId || !deviceId || !accessKey) {
            await lib.std.print(
                `${red}Usage: esp32-demo --account=<id> --device=<id> --key=<accessKey> [--plain]${reset}\n`,
            );
            return;
        }

        await lib.std.print(
            `${white}ESP32 Simulator V2 — akun=${accountId} device=${deviceId}${reset}\n`,
        );

        const socketFd = await lib.net.socket();
        if (!(await lib.net.bind(socketFd, MY_PORT))) {
            await lib.std.print(`${red}Gagal bind port ${MY_PORT}${reset}\n`);
            return;
        }
        if (args.includes("--binary")) {
            await lib.net.ioctl(socketFd, 0x1002, true);
        }

        const agent = new SecurityAgent();

        // ── 1. HELLO ──
        await lib.net.sendto(
            socketFd,
            TARGET_HOST,
            TARGET_PORT,
            JSON.stringify({ type: "LANTANA_HELLO", accountId, deviceId }),
            0,
            MY_PORT,
        );

        const challenge = await waitFor<Challenge>(lib, socketFd, (d) => isType(d, "LANTANA_CHALLENGE"), 5000);
        if (!challenge) {
            await lib.std.print(`${red}Tidak ada LANTANA_CHALLENGE dari server${reset}\n`);
            return;
        }
        await lib.std.print(`${cyan}Server fingerprint: ${challenge.fingerprint}${reset}\n`);

        // ── 2. KEYSET ──
        const sessionKey = SecurityAgent.generateSessionKey();
        const encryptedKey = SecurityAgent.encryptWithPublicKey(challenge.publicKey, sessionKey);
        await lib.net.sendto(
            socketFd,
            TARGET_HOST,
            TARGET_PORT,
            JSON.stringify({ type: "LANTANA_KEYSET", encryptedKey }),
            0,
            MY_PORT,
        );

        const keysetOk = await waitFor<any>(lib, socketFd, (d) => isType(d, "LANTANA_KEYSET_OK"), 5000);
        if (!keysetOk) {
            await lib.std.print(`${red}Key exchange gagal${reset}\n`);
            return;
        }
        agent.setSessionKey(sessionKey);

        // ── 3. AUTH (terenkripsi) ──
        const authPayload = agent.securePacketOut(
            JSON.stringify({ accountId, deviceId, accessKey, nonce: challenge.nonce }),
        );
        await lib.net.sendto(
            socketFd,
            TARGET_HOST,
            TARGET_PORT,
            JSON.stringify({ type: "LANTANA_AUTH", payload: authPayload }),
            0,
            MY_PORT,
        );

        const authOk = await waitFor<any>(
            lib,
            socketFd,
            (d) => isType(d, "LANTANA_AUTH_OK") || isType(d, "LANTANA_NACK"),
            5000,
            agent,
        );
        if (!authOk || isType(authOk, "LANTANA_NACK")) {
            const reason = authOk?.message || "tidak ada balasan";
            await lib.std.print(`${red}Autentikasi ditolak: ${reason}${reset}\n`);
            return;
        }
        await lib.std.print(`${cyan}Sesi terautentikasi. Mengirim data...${reset}\n`);

        // ── 4. Background listener (command dari server) ──
        (async () => {
            while (true) {
                const pkt = await lib.net.recv(socketFd);
                if (pkt && pkt.localPort === MY_PORT) {
                    const text = typeof pkt.data === "string" ? agent.securePacketIn(pkt.data) : "";
                    if (text) {
                        await lib.std.print(`${magenta}[HARDWARE] Command: ${text}${reset}\n`);
                    }
                }
                await new Promise((r) => setTimeout(r, 100));
            }
        })();

        // ── 5. Sender loop ──
        // Scheme default: 101 Suhu, 102 Kelembapan, 103 Tekanan, 104 Cahaya.
        // Nilai di-clamp ke rentang scheme supaya paket tidak ditolak validator.
        const readings = [
            { schemeId: 101, value: 27, min: -40, max: 125, step: 3 },
            { schemeId: 102, value: 60, min: 0, max: 100, step: 3 },
            { schemeId: 103, value: 1013, min: 800, max: 1100, step: 2 },
            { schemeId: 104, value: 60, min: 0, max: 100, step: 5 },
        ];

        // Nomor urut paket per sesi; server menolak seq yang sudah diterima.
        let seq = 0;
        while (true) {
            for (const r of readings) {
                const delta = Math.floor(Math.random() * (r.step * 2 + 1)) - r.step;
                r.value = Math.min(r.max, Math.max(r.min, r.value + delta));
            }

            seq++;
            const payload = usePlain
                ? encodePlainPayload(deviceId, readings, seq)
                : encodeBinaryPayload(deviceId, readings, seq);

            const encrypted = agent.securePacketOut(payload);
            const ok = await lib.net.sendto(
                socketFd,
                TARGET_HOST,
                TARGET_PORT,
                encrypted,
                0,
                MY_PORT,
            );

            await lib.std.print(
                `${cyan}[TX] ${ok ? "OK" : "GAGAL"} ${readings
                    .map((r) => `${r.schemeId}=${r.value}`)
                    .join(" ")}${reset}\n`,
            );

            await new Promise((r) => setTimeout(r, interval));
        }
    }
}

function isType(data: any, type: string): boolean {
    return !!data && typeof data === "object" && data.type === type;
}

/** Tunggu pesan kontrol; bila agent diberikan, coba dekripsi payload hex. */
async function waitFor<T>(
    lib: UserLib,
    fd: number,
    match: (data: any) => boolean,
    timeoutMs: number,
    agent?: SecurityAgent,
): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pkt = await lib.net.recv(fd);
        if (pkt && pkt.data) {
            const raw = typeof pkt.data === "string" ? pkt.data : Buffer.isBuffer(pkt.data) ? pkt.data.toString("utf8") : "";

            const asJson = tryJson(raw);
            if (asJson && match(asJson)) return asJson as T;

            if (agent) {
                const plain = agent.securePacketIn(raw);
                const decrypted = plain ? tryJson(plain) : null;
                if (decrypted && match(decrypted)) return decrypted as T;
            }
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    return null;
}

function tryJson(raw: string): any | null {
    const s = (raw || "").trim();
    if (!s.startsWith("{")) return null;
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}
