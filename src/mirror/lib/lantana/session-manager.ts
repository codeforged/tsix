/**
 * session-manager.ts — Sesi MQTNL yang sudah terautentikasi.
 *
 * Keamanan V2 bersifat per sesi (bukan per port), sehingga banyak device
 * dengan AccessKey berbeda bisa memakai port layanan yang sama.
 *
 * Manajer ini hanya menyimpan state; operasi kripto handshake ada di listener.
 *
 * (c) 2026 TSIX Project — Lantana
 */

export interface LantanaSession {
    /** Kunci sesi: `address:port` sumber device. */
    id: string;
    accountId: string | null;
    deviceId: string | null;
    /** Nonce challenge yang sedang menunggu jawaban auth. */
    nonce: string | null;
    /** Terisi setelah LANTANA_KEYSET + LANTANA_AUTH berhasil. */
    authenticated: boolean;
    createdAt: number;
    lastSeenAt: number;
}

export const SESSION_IDLE_TTL_MS = 5 * 60 * 1000;

export class SessionManager {
    private sessions: Map<string, LantanaSession> = new Map();

    open(id: string, now: number = Date.now()): LantanaSession {
        const existing = this.sessions.get(id);
        if (existing) {
            existing.lastSeenAt = now;
            return existing;
        }
        const session: LantanaSession = {
            id,
            accountId: null,
            deviceId: null,
            nonce: null,
            authenticated: false,
            createdAt: now,
            lastSeenAt: now,
        };
        this.sessions.set(id, session);
        return session;
    }

    get(id: string): LantanaSession | undefined {
        return this.sessions.get(id);
    }

    isAuthenticated(id: string): boolean {
        const s = this.sessions.get(id);
        return !!s && s.authenticated && s.accountId !== null && s.deviceId !== null;
    }

    setNonce(id: string, nonce: string): void {
        const s = this.sessions.get(id);
        if (s) s.nonce = nonce;
    }

    /** Tandai sesi terautentikasi dan ikat ke akun + device. */
    bind(id: string, accountId: string, deviceId: string, now: number = Date.now()): void {
        const s = this.sessions.get(id) || this.open(id, now);
        s.accountId = accountId;
        s.deviceId = deviceId;
        s.nonce = null;
        s.authenticated = true;
        s.lastSeenAt = now;
    }

    touch(id: string, now: number = Date.now()): void {
        const s = this.sessions.get(id);
        if (s) s.lastSeenAt = now;
    }

    close(id: string): void {
        this.sessions.delete(id);
    }

    /** Hapus sesi yang idle (device hilang tanpa logout). */
    cleanup(now: number = Date.now(), ttl: number = SESSION_IDLE_TTL_MS): string[] {
        const removed: string[] = [];
        for (const [id, s] of this.sessions.entries()) {
            if (now - s.lastSeenAt > ttl) {
                this.sessions.delete(id);
                removed.push(id);
            }
        }
        return removed;
    }

    list(): LantanaSession[] {
        return Array.from(this.sessions.values());
    }

    get size(): number {
        return this.sessions.size;
    }
}
