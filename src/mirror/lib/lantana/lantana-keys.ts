/**
 * lantana-keys.ts — Identitas kriptografis server Lantana.
 *
 * Public key server dipin (fingerprint) di firmware device. Karena itu key
 * harus stabil antar restart; file disimpan di /etc/lantana/keys/.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { fs } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";

export const LANTANA_KEY_DIR = "/etc/lantana/keys";
export const LANTANA_SERVER_KEY_PATH = `${LANTANA_KEY_DIR}/server-key.json`;

export interface ServerKeyPair {
    publicKey: string;
    privateKey: string;
    fingerprint: string;
}

function withFingerprint(pair: { publicKey: string; privateKey: string }): ServerKeyPair {
    return {
        ...pair,
        fingerprint: SecurityAgent.getFingerprint(pair.publicKey),
    };
}

/**
 * Muat key server dari VFS; buat dan simpan bila belum ada.
 * Bila penyimpanan gagal, tetap kembalikan key in-memory (daemon mencatat
 * peringatan bahwa fingerprint akan berubah saat restart).
 */
export async function loadOrCreateServerKey(): Promise<ServerKeyPair> {
    try {
        const raw = await fs.readFile(LANTANA_SERVER_KEY_PATH);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed?.publicKey && parsed?.privateKey) {
                return withFingerprint(parsed);
            }
        }
    } catch {
        /* belum ada / rusak → buat baru */
    }

    const pair = withFingerprint(SecurityAgent.generateKeyPair());

    try {
        await fs.mkdir(LANTANA_KEY_DIR);
    } catch {
        /* sudah ada */
    }
    try {
        await fs.writeFile(
            LANTANA_SERVER_KEY_PATH,
            JSON.stringify({ publicKey: pair.publicKey, privateKey: pair.privateKey }, null, 2) + "\n",
        );
    } catch {
        /* tidak persisten — tetap dipakai selama proses hidup */
    }

    return pair;
}
