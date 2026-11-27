/**
 * account-manager.ts — Akun berjenjang (parent-child) + AccessKey.
 *
 * Aturan V2:
 *  - `accountId` adalah identitas otorisasi.
 *  - AccessKey diterbitkan per akun, dipakai banyak device milik akun itu.
 *  - Key mentah TIDAK disimpan: hanya salt + hash scrypt (verifier).
 *  - Tidak ada inheritance izin: child hanya punya izin yang diberikan.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import * as crypto from "crypto";
import { derivePsk } from "@tsix/lantana/lantana-psk";
import {
    AccountRecord,
    EMPTY_PERMISSIONS,
    MAX_ACCOUNT_ID_LENGTH,
    Permissions,
    StoredCredential,
} from "@tsix/lantana/lantana-core";

const KEY_BYTES = 32;
const SCRYPT_KEYLEN = 32;

export class AccountError extends Error {}

function hashAccessKey(accessKey: string, saltHex: string): string {
    return crypto
        .scryptSync(accessKey, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN)
        .toString("hex");
}

/** Normalisasi izin: buang duplikat & entri tidak valid. */
export function normalizePermissions(input?: Partial<Permissions> | null): Permissions {
    const ranges = (list: any): Permissions["allowedInjectSchemes"] => {
        if (!Array.isArray(list)) return [];
        const out: Permissions["allowedInjectSchemes"] = [];
        for (const entry of list) {
            if (typeof entry === "number" && Number.isInteger(entry) && entry > 0) {
                out.push(entry);
            } else if (
                entry &&
                typeof entry === "object" &&
                Number.isInteger(entry.from) &&
                Number.isInteger(entry.to) &&
                entry.from > 0 &&
                entry.to >= entry.from
            ) {
                out.push({ from: entry.from, to: entry.to });
            }
        }
        return out;
    };

    const devices = Array.isArray(input?.allowedCommandDevices)
        ? Array.from(
              new Set(
                  input!.allowedCommandDevices
                      .filter((d): d is string => typeof d === "string")
                      .map((d) => d.trim())
                      .filter(Boolean),
              ),
          )
        : [];

    return {
        allowedInjectSchemes: ranges(input?.allowedInjectSchemes),
        allowedQuerySchemes: ranges(input?.allowedQuerySchemes),
        allowedCommandDevices: devices,
    };
}

export class AccountManager {
    private accounts: Map<string, AccountRecord> = new Map();

    /** Buat akun root (parentId = null). */
    createRoot(accountId: string, permissions?: Partial<Permissions>): AccountRecord {
        return this.create(accountId, null, permissions);
    }

    /** Buat akun child di bawah parent yang sudah ada. */
    createChild(
        parentId: string,
        accountId: string,
        permissions?: Partial<Permissions>,
    ): AccountRecord {
        if (!parentId) throw new AccountError("parentId wajib diisi");
        return this.create(accountId, parentId, permissions);
    }

    private create(
        accountId: string,
        parentId: string | null,
        permissions?: Partial<Permissions>,
    ): AccountRecord {
        const id = (accountId || "").trim();
        if (!id) throw new AccountError("accountId wajib diisi");
        if (id.length > MAX_ACCOUNT_ID_LENGTH) {
            throw new AccountError(`accountId maksimal ${MAX_ACCOUNT_ID_LENGTH} karakter`);
        }
        if (this.accounts.has(id)) throw new AccountError(`akun sudah ada: ${id}`);
        if (parentId !== null && !this.accounts.has(parentId)) {
            throw new AccountError(`parent tidak ditemukan: ${parentId}`);
        }

        const record: AccountRecord = {
            accountId: id,
            parentId,
            permissions: normalizePermissions(permissions),
            credential: null,
            createdAt: Date.now(),
        };
        this.accounts.set(id, record);
        return record;
    }

    get(accountId: string): AccountRecord | undefined {
        return this.accounts.get(accountId);
    }

    require(accountId: string): AccountRecord {
        const acc = this.accounts.get(accountId);
        if (!acc) throw new AccountError(`akun tidak ditemukan: ${accountId}`);
        return acc;
    }

    has(accountId: string): boolean {
        return this.accounts.has(accountId);
    }

    list(): AccountRecord[] {
        return Array.from(this.accounts.values());
    }

    listChildren(parentId: string): AccountRecord[] {
        return this.list().filter((a) => a.parentId === parentId);
    }

    /**
     * Terbitkan AccessKey baru (32 byte hex 64 karakter) dan simpan verifier-nya.
     * Key mentah hanya dikembalikan sekali di sini; tidak bisa dibaca lagi.
     */
    issueAccessKey(accountId: string): string {
        const acc = this.require(accountId);
        const accessKey = crypto.randomBytes(KEY_BYTES).toString("hex");
        acc.credential = this.buildCredential(accessKey);
        return accessKey;
    }

    /** Rotasi = terbitkan key baru, key lama langsung tidak berlaku. */
    rotateAccessKey(accountId: string): string {
        return this.issueAccessKey(accountId);
    }

    /** Cabut kredensial; akun tetap ada tetapi tidak bisa autentikasi. */
    revokeAccessKey(accountId: string): void {
        this.require(accountId).credential = null;
    }

    hasAccessKey(accountId: string): boolean {
        return !!this.accounts.get(accountId)?.credential;
    }

    /** Verifikasi AccessKey terhadap verifier tersimpan (timing-safe). */
    verifyAccessKey(accountId: string, accessKey: string): boolean {
        const acc = this.accounts.get(accountId);
        if (!acc || !acc.credential || !accessKey) return false;
        const candidate = hashAccessKey(accessKey, acc.credential.salt);
        const stored = Buffer.from(acc.credential.hash, "hex");
        const found = Buffer.from(candidate, "hex");
        if (stored.length !== found.length) return false;
        return crypto.timingSafeEqual(stored, found);
    }

    setPermissions(accountId: string, permissions: Partial<Permissions>): Permissions {
        const acc = this.require(accountId);
        acc.permissions = normalizePermissions(permissions);
        return acc.permissions;
    }

    /** Apakah `actorId` boleh mengelola `targetId` (dirinya sendiri atau keturunannya). */
    canManage(actorId: string, targetId: string): boolean {
        if (!this.accounts.has(actorId)) return false;
        let current = this.accounts.get(targetId);
        while (current && current.parentId !== null) {
            if (current.parentId === actorId) return true;
            current = this.accounts.get(current.parentId);
        }
        return false;
    }

    remove(accountId: string): void {
        if (this.listChildren(accountId).length > 0) {
            throw new AccountError(`akun masih punya child: ${accountId}`);
        }
        if (!this.accounts.delete(accountId)) {
            throw new AccountError(`akun tidak ditemukan: ${accountId}`);
        }
    }

    private buildCredential(accessKey: string): StoredCredential {
        const salt = crypto.randomBytes(16).toString("hex");
        return {
            salt,
            hash: hashAccessKey(accessKey, salt),
            // Dipakai handshake PSK (ESP8266): SHA-256 dari string key.
            psk: derivePsk(accessKey).toString("hex"),
            issuedAt: Date.now(),
        };
    }

    /** PSK untuk handshake mode "psk"; null bila akun belum punya kredensial. */
    getPsk(accountId: string): Buffer | null {
        const pskHex = this.accounts.get(accountId)?.credential?.psk;
        if (!pskHex) return null;
        return Buffer.from(pskHex, "hex");
    }

    /**
     * Isi accounts.json: TANPA PSK. PSK = rahasia yang langsung bisa dipakai
     * handshake sebagai device akun itu, jadi disimpan terpisah lewat
     * `pskTable()` (file 0600 milik root, SEC-15).
     */
    toJSON(): AccountRecord[] {
        return this.list().map((acc) => {
            if (!acc.credential) return acc;
            const { psk: _psk, ...credential } = acc.credential;
            return { ...acc, credential };
        });
    }

    /** Tabel PSK per akun (hex), hanya untuk akun yang punya kredensial. */
    pskTable(): Record<string, string> {
        const out: Record<string, string> = {};
        for (const acc of this.accounts.values()) {
            if (acc.credential?.psk) out[acc.accountId] = acc.credential.psk;
        }
        return out;
    }

    /** true bila ada PSK yang dibaca dari accounts.json format lama (perlu ditulis ulang). */
    hasLegacyPsk = false;

    static fromJSON(
        records: AccountRecord[] | undefined | null,
        pskTable?: Record<string, string> | null,
    ): AccountManager {
        const mgr = new AccountManager();
        const table = pskTable && typeof pskTable === "object" ? pskTable : {};
        for (const rec of records || []) {
            if (!rec || typeof rec.accountId !== "string") continue;
            let psk: string | undefined;
            if (rec.credential) {
                const fromTable = table[rec.accountId];
                if (typeof fromTable === "string") {
                    psk = fromTable;
                } else if (typeof rec.credential.psk === "string") {
                    // Format lama: PSK masih di accounts.json.
                    psk = rec.credential.psk;
                    mgr.hasLegacyPsk = true;
                }
            }
            mgr.accounts.set(rec.accountId, {
                accountId: rec.accountId,
                parentId: rec.parentId ?? null,
                permissions: normalizePermissions(rec.permissions),
                credential: rec.credential
                    ? {
                          salt: rec.credential.salt,
                          hash: rec.credential.hash,
                          psk,
                          issuedAt: rec.credential.issuedAt,
                      }
                    : null,
                createdAt: rec.createdAt || Date.now(),
            });
        }
        return mgr;
    }
}

export { EMPTY_PERMISSIONS };
