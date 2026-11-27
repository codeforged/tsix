/**
 * ota-access — keputusan akses untuk otad (SEC-27, SEC-29).
 *
 * Dipisah dari `sbin/otad.ts` supaya bisa dites tanpa loop daemon.
 *
 * Aturan:
 *   - `ota.read` / `R <offset> <len>` hanya dilayani untuk sesi yang dibuka oleh
 *     `ota.info` dengan activation key (AK) yang valid, dan hanya untuk path yang
 *     divalidasi di `ota.info`. Firmware bisa memuat rahasia (WiFi, broker, API key),
 *     jadi tidak boleh diunduh tanpa AK.
 *   - Path firmware selalu di dalam direktori firmware.
 *   - Tebakan AK dibatasi secara global (alamat MQTNL bisa dipalsukan, jadi batas
 *     per alamat tidak berarti).
 *   - AK dibuat dari `crypto.randomInt`, bukan `Math.random`.
 */
import * as crypto from "crypto";

export const FIRMWARE_DIR = "/opt/esp-ota/firmwares";

/** resolveFirmwarePath(): path permintaan → path VFS di dalam `dir`, atau null. */
export function resolveFirmwarePath(requested: unknown, dir: string = FIRMWARE_DIR): string | null {
    const raw = requested === undefined || requested === null || requested === "" ? "/firmware.bin" : requested;
    if (typeof raw !== "string" || raw.length > 256) return null;
    if (/[\x00-\x1f\\]/.test(raw)) return null;

    const full = raw.startsWith(`${dir}/`) ? raw : `${dir}${raw.startsWith("/") ? "" : "/"}${raw}`;
    const parts = full.split("/");
    if (parts.some((p) => p === ".." || p === ".")) return null;
    if (!full.startsWith(`${dir}/`) || full.length <= dir.length + 1 || full.endsWith("/")) return null;
    return full.replace(/\/{2,}/g, "/");
}

export interface OtaSession {
    path: string;
    ak: string;
    mac: string;
    dc: string;
    offset: number;
    lastSeen: number;
    virtualBuffer?: Buffer;
    virtualSize?: number;
}

/** OtaSessions: sesi OTA per alamat sumber, dibuka hanya oleh `ota.info` yang lolos AK. */
export class OtaSessions {
    private sessions = new Map<string, OtaSession>();

    constructor(
        private readonly ttlMs: number = 10 * 60 * 1000,
        private readonly max: number = 64,
    ) {}

    get size(): number {
        return this.sessions.size;
    }

    begin(
        src: string,
        s: { path: string; ak: string; mac: string; dc: string; virtualBuffer?: Buffer; virtualSize?: number },
        now: number = Date.now(),
    ): OtaSession {
        this.prune(now);
        this.sessions.delete(src);
        while (this.sessions.size >= this.max) {
            // Map menyimpan urutan sisip; yang pertama = paling lama tidak dipakai.
            const oldest = this.sessions.keys().next().value as string;
            this.sessions.delete(oldest);
        }
        const session: OtaSession = { ...s, offset: 0, lastSeen: now };
        this.sessions.set(src, session);
        return session;
    }

    /** get(): sesi milik `src` untuk `path`, atau null. Memperpanjang masa berlaku. */
    get(src: string, path?: string, now: number = Date.now()): OtaSession | null {
        const s = this.sessions.get(src);
        if (!s) return null;
        if (now - s.lastSeen > this.ttlMs) {
            this.sessions.delete(src);
            return null;
        }
        if (path !== undefined && s.path !== path) return null;
        s.lastSeen = now;
        // Pindah ke belakang supaya urutan Map = urutan terakhir dipakai.
        this.sessions.delete(src);
        this.sessions.set(src, s);
        return s;
    }

    end(src: string): void {
        this.sessions.delete(src);
    }

    private prune(now: number) {
        for (const [k, s] of this.sessions) {
            if (now - s.lastSeen > this.ttlMs) this.sessions.delete(k);
        }
    }
}

/** AkLimiter: batas global tebakan AK salah per jendela waktu. */
export class AkLimiter {
    private failures: number[] = [];

    constructor(
        private readonly maxFailures: number = 20,
        private readonly windowMs: number = 60 * 1000,
    ) {}

    blocked(now: number = Date.now()): boolean {
        this.failures = this.failures.filter((t) => now - t < this.windowMs);
        return this.failures.length >= this.maxFailures;
    }

    fail(now: number = Date.now()): void {
        this.failures.push(now);
    }
}

const AK_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** Panjang AK yang diterima otad dan dipakai firmware (`OTA_AK`). */
export const AK_LENGTH = 6;

export function generateActivationKey(length: number = AK_LENGTH): string {
    let out = "";
    for (let i = 0; i < length; i++) out += AK_CHARS[crypto.randomInt(AK_CHARS.length)];
    return out;
}
