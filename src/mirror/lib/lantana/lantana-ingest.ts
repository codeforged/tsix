/**
 * lantana-ingest.ts — Pipeline ingest: autentikasi → otorisasi → validasi.
 *
 * Urutan ini disengaja: data tidak boleh menyentuh DeviceBank/DataBank sebelum
 * sesi terautentikasi, device terdaftar pada akun, dan setiap scheme diizinkan
 * serta valid. Paket ditolak utuh (all-or-nothing) bila ada satu bacaan gagal.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import * as crypto from "crypto";
import { AccountManager } from "@tsix/lantana/account-manager";
import { DeviceRegistry } from "@tsix/lantana/device-registry";
import { PermissionPolicy } from "@tsix/lantana/permission-policy";
import { SchemeRegistry } from "@tsix/lantana/scheme-registry";
import { SessionManager } from "@tsix/lantana/session-manager";
import {
    AcceptedReading,
    Endpoint,
    LantanaError,
    RawReading,
} from "@tsix/lantana/lantana-core";

export interface IngestDeps {
    accounts: AccountManager;
    devices: DeviceRegistry;
    schemes: SchemeRegistry;
    policy: PermissionPolicy;
    sessions: SessionManager;
}

export interface IngestInput {
    /** ID sesi MQTNL (`address:port` sumber device). */
    sessionId: string;
    /** deviceId dari payload; harus sama dengan yang diikat ke sesi. */
    deviceId: string;
    readings: RawReading[];
    receivedAt?: number;
    endpoint: Endpoint;
    /**
     * ID unik paket dari transport (hex IV ChaCha20). Bila ada, `readingId`
     * diturunkan darinya sehingga paket yang sama selalu menghasilkan
     * `readingId` yang sama dan dedup DataBank tetap berlaku.
     */
    packetId?: string;
}

export type IngestResult =
    | {
          ok: true;
          accountId: string;
          deviceId: string;
          readings: AcceptedReading[];
      }
    | {
          ok: false;
          error: LantanaError;
          message: string;
          schemeId?: number;
      };

export function newReadingId(): string {
    return crypto.randomUUID();
}

/**
 * readingId deterministik: SHA-256(account|device|packet|scheme), 16 byte
 * pertama diformat seperti UUID (36 karakter) agar cocok dengan kolom
 * `reading_id` yang sudah ada.
 */
export function packetReadingId(
    accountId: string,
    deviceId: string,
    packetId: string,
    schemeId: number,
): string {
    const h = crypto
        .createHash("sha256")
        .update(`${accountId}|${deviceId}|${packetId}|${schemeId}`, "utf8")
        .digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export class IngestPipeline {
    constructor(private deps: IngestDeps) {}

    ingest(input: IngestInput): IngestResult {
        const { sessions, accounts, devices, schemes, policy } = this.deps;
        const ts = input.receivedAt ?? Date.now();

        const session = sessions.get(input.sessionId);
        if (!session || !session.authenticated || !session.accountId || !session.deviceId) {
            return {
                ok: false,
                error: LantanaError.UNAUTHENTICATED,
                message: "sesi belum terautentikasi",
            };
        }

        const account = accounts.get(session.accountId);
        if (!account) {
            return {
                ok: false,
                error: LantanaError.UNKNOWN_ACCOUNT,
                message: `akun tidak dikenal: ${session.accountId}`,
            };
        }

        // deviceId di payload tidak boleh menyimpang dari sesi yang sudah
        // diautentikasi — mencegah satu device mengaku sebagai device lain.
        if (input.deviceId !== session.deviceId) {
            return {
                ok: false,
                error: LantanaError.UNKNOWN_DEVICE,
                message: `deviceId payload (${input.deviceId}) tidak cocok dengan sesi (${session.deviceId})`,
            };
        }

        if (!devices.belongsTo(account.accountId, input.deviceId)) {
            return {
                ok: false,
                error: LantanaError.UNKNOWN_DEVICE,
                message: `device ${input.deviceId} tidak terdaftar pada akun ${account.accountId}`,
            };
        }

        if (input.readings.length === 0) {
            return {
                ok: false,
                error: LantanaError.PAYLOAD_INVALID,
                message: "tidak ada bacaan",
            };
        }

        const accepted: AcceptedReading[] = [];
        const seen = new Set<number>();

        for (const reading of input.readings) {
            if (seen.has(reading.schemeId)) {
                return {
                    ok: false,
                    error: LantanaError.PAYLOAD_INVALID,
                    message: `scheme ${reading.schemeId} duplikat dalam satu paket`,
                    schemeId: reading.schemeId,
                };
            }
            seen.add(reading.schemeId);

            const def = schemes.get(reading.schemeId);
            if (!def) {
                return {
                    ok: false,
                    error: LantanaError.UNKNOWN_SCHEME,
                    message: `scheme ${reading.schemeId} tidak dikenal`,
                    schemeId: reading.schemeId,
                };
            }

            const allowed = policy.canInject(account.accountId, reading.schemeId);
            if (!allowed.ok) {
                return {
                    ok: false,
                    error: allowed.error || LantanaError.UNAUTHORIZED_INJECT,
                    message: allowed.message || "inject tidak diizinkan",
                    schemeId: reading.schemeId,
                };
            }

            const valid = schemes.validate(reading.schemeId, reading.value);
            if (!valid.ok) {
                return {
                    ok: false,
                    error: valid.error || LantanaError.INVALID_VALUE,
                    message: valid.message || "nilai tidak valid",
                    schemeId: reading.schemeId,
                };
            }

            accepted.push({
                readingId: input.packetId
                    ? packetReadingId(account.accountId, input.deviceId, input.packetId, def.schemeId)
                    : newReadingId(),
                accountId: account.accountId,
                deviceId: input.deviceId,
                schemeId: def.schemeId,
                value: reading.value,
                label: def.label,
                unit: def.unit || "",
                receivedAt: ts,
            });
        }

        sessions.touch(input.sessionId, ts);

        return {
            ok: true,
            accountId: account.accountId,
            deviceId: input.deviceId,
            readings: accepted,
        };
    }
}
