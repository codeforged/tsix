/**
 * FSTAB PARSER — pembacaan `/etc/fstab.conf` (INI) + jalur migrasi `.json` lama
 *
 * Dipisah dari `Kernel.ts` supaya bisa di-unit-test tanpa menyalakan kernel —
 * berkas ini murni teks → objek, tanpa I/O dan tanpa efek samping (peringatan
 * dikembalikan sebagai daftar string, bukan di-log dari sini).
 *
 * `parseFstabContent()` juga mengenali isi JSON (array `[{ "vfsPath": ... }]`).
 * Itu BUKAN sumber konfigurasi: dipakai kernel hanya untuk memigrasi node yang
 * masih punya `/etc/fstab.json` → ditulis ulang ke `.conf` via
 * `formatFstabIni()` saat boot. Format lama yang butuh perilaku khusus:
 *   - `mode` di JSON lama ditulis DESIMAL (`1023` = 0o1777), bukan oktal.
 *
 * FORMAT `.conf` (gaya INI, satu `[section]` = satu mount):
 *
 *     # komentar pakai # atau ;
 *     [/tmp]
 *     hostPath = RAM              ; ramfs tidak butuh hostPath
 *     type     = ramfs
 *     uid      = 0
 *     gid      = 100
 *     mode     = 0o1777           ; sticky + rwx rwx rwx
 *     active   = true
 *
 *     [/mnt/net]
 *     hostPath = jatitsix:7777
 *     type     = netfs
 *     via      = 8888             ; port netfsd --client lokal
 *     key      = c50f...c65       ; 64 hex (biarkan TANPA kutip juga aman)
 *
 * ATURAN NILAI yang penting diketahui:
 *   - `mode`  : oktal WAJIB ditulis `0o775` atau `0775` (awalan nol). Angka
 *     telanjang dibaca DESIMAL, sama seperti `fstab.json` lama (mis. `509` =
 *     0o775, `1023` = 0o1777). Kalau nilainya > 0o777 padahal niatnya oktal,
 *     parser memberi PERINGATAN — itu kasus klasik `mode = 755` yang tanpa
 *     sadar jadi 0o1363.
 *   - hanya key numerik (`uid`, `gid`, `mode`, `via`, `timeoutMs`, `cacheTtlMs`)
 *     yang diubah jadi Number. `key` (64 hex) tetap STRING walau isinya angka —
 *     dulu ini bisa berubah jadi Number dan merusak handshake NetFS.
 *   - boolean menerima `true/false`, `yes/no`, `on/off`, `1/0`.
 *   - komentar sebaris (`nilai  # catatan`) ikut dibuang SELAMA nilainya tidak
 *     dikutip — nilai berkutip dianggap apa adanya.
 *
 * (c) 2026 TSIX Project
 */

/** Satu entri mount hasil pembacaan fstab. */
export interface FstabEntry {
    /** Mount point di VFS (dari nama `[section]`). */
    vfsPath: string;
    [key: string]: unknown;
}

export interface FstabParseResult {
    format: "ini" | "json";
    entries: FstabEntry[];
    /** Masalah yang ditemukan — KERNEL yang memutuskan cara melaporkannya. */
    warnings: string[];
}

/** Tipe driver yang dikenali kernel (selain ini = kemungkinan typo). */
export const FSTAB_MOUNT_TYPES = ["bkfs", "host", "ramfs", "netfs"] as const;

/** Key yang nilainya memang angka; SISANYA selalu string. */
const NUMBER_KEYS = new Set(["uid", "gid", "mode", "via", "timeoutMs", "cacheTtlMs"]);

/** Key boolean (menerima true/false, yes/no, on/off, 1/0). */
const BOOL_KEYS = new Set(["readOnly", "active"]);

const TRUE_WORDS = new Set(["true", "yes", "on", "1"]);
const FALSE_WORDS = new Set(["false", "no", "off", "0"]);

/**
 * parseFstabContent(): Urai isi fstab apa pun formatnya.
 *
 * Deteksi format memakai percobaan `JSON.parse` — INI tidak akan pernah lolos
 * sebagai JSON, jadi cara ini deterministik (tanpa menebak dari ekstensi).
 */
export function parseFstabContent(content: string): FstabParseResult {
    const warnings: string[] = [];

    const asJson = tryParseJsonArray(content);
    if (asJson) {
        const entries = normalizeEntries(asJson, warnings);
        return { format: "json", entries, warnings };
    }

    return { format: "ini", entries: parseIni(content, warnings), warnings };
}

/**
 * stripQuotes(): Buang kutip ganda/p tunggal pembungkus, dan komentar sebaris.
 *
 * Komentar sebaris hanya dibuang kalau nilainya TIDAK dikutip — supaya nilai
 * yang sengaja memuat `#` (mis. kunci/path aneh) bisa ditulis dengan kutip.
 */
function stripQuotes(raw: string): string {
    const s = raw.trim();
    if (
        (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
        (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
    ) {
        return s.slice(1, -1);
    }
    // Komentar sebaris: hanya kalau didahului spasi (hindari memotong "a#b").
    const cut = s.search(/\s[#;]/);
    return cut === -1 ? s : s.slice(0, cut).trim();
}

/**
 * readNumber(): Angka untuk key numerik. Nilai tidak sah → undefined + warning.
 */
function readNumber(raw: string, key: string, warn: (m: string) => void): number | undefined {
    const s = stripQuotes(raw);
    if (s === "") return undefined;
    const n = Number(s);
    if (!Number.isFinite(n)) {
        warn(`${key}='${s}' bukan angka → diabaikan`);
        return undefined;
    }
    return n;
}

/**
 * readBool(): Boolean dengan kata-kata yang lazim di berkas konfigurasi.
 * `active = no` dulu tetap dianggap AKTIF (karena "no" itu string truthy).
 */
function readBool(raw: string, key: string, warn: (m: string) => void): boolean | undefined {
    const s = stripQuotes(raw).toLowerCase();
    if (TRUE_WORDS.has(s)) return true;
    if (FALSE_WORDS.has(s)) return false;
    warn(`${key}='${s}' bukan boolean (true/false, yes/no, on/off, 1/0) → diabaikan`);
    return undefined;
}

/**
 * readMode(): Mode oktal — SATU-SATUNYA tempat di mana "angka" ambigu.
 *
 * `0o775`/`0775` = oktal eksplisit. Angka telanjang = desimal (kompatibel
 * dengan `fstab.json` lama: 509 = 0o775, 1023 = 0o1777). Nilai > 0o777 yang
 * ditulis telanjang diberi peringatan karena hampir selalu salah tulis
 * (`mode = 775` → 0o1363).
 */
function readMode(raw: string, warn: (m: string) => void): number | undefined {
    const s = stripQuotes(raw);
    if (s === "") return undefined;

    const octal = /^0o([0-7]+)$/i.exec(s) ?? /^0([0-7]+)$/.exec(s);
    let value: number;
    if (octal) {
        value = parseInt(octal[1], 8);
    } else if (/^[0-9]+$/.test(s)) {
        value = Number(s);
        if (value > 0o777) {
            warn(
                `mode=${s} (> 0o777) — kalau maksudmu oktal, tulis '0o${s}' ` +
                    `atau '0${s}'; sebagai desimal hasilnya 0o${value.toString(8)}`,
            );
        }
    } else {
        warn(`mode='${s}' bukan angka → diabaikan`);
        return undefined;
    }

    if (!Number.isInteger(value) || value < 0 || value > 0o7777) {
        warn(`mode='${s}' di luar rentang 0..0o7777 → diabaikan`);
        return undefined;
    }
    return value;
}

/** normalizeEntries(): Samakan bentuk entri dari JSON & INI (type coercion). */
function normalizeEntries(raw: unknown[], warnings: string[]): FstabEntry[] {
    const warn = (m: string) => warnings.push(m);
    const entries: FstabEntry[] = [];

    for (const item of raw) {
        if (!item || typeof item !== "object") {
            warn("entri bukan object → dilewati");
            continue;
        }
        const source = item as Record<string, unknown>;
        const vfsPath = typeof source.vfsPath === "string" ? source.vfsPath.trim() : "";
        if (!vfsPath) {
            warn("entri tanpa 'vfsPath' → dilewati");
            continue;
        }

        const entry: FstabEntry = { vfsPath };

        for (const [key, value] of Object.entries(source)) {
            if (key === "vfsPath" || value === undefined || value === null) continue;

            if (BOOL_KEYS.has(key)) {
                if (typeof value === "boolean") entry[key] = value;
                else if (typeof value === "number") entry[key] = value !== 0;
                else entry[key] = readBool(String(value), key, warn);
                continue;
            }

            if (key === "mode") {
                entry[key] = typeof value === "number" ? value : readMode(String(value), warn);
                if (typeof value === "number" && (!Number.isInteger(value) || value < 0 || value > 0o7777)) {
                    warn(`mode=${value} di luar rentang 0..0o7777 → diabaikan`);
                    delete entry[key];
                }
                continue;
            }

            if (NUMBER_KEYS.has(key) && typeof value !== "string") {
                // JSON: angka sudah bertipe benar (via mis. 8888).
                entry[key] = Number(value);
                continue;
            }

            if (typeof value === "string") {
                entry[key] = NUMBER_KEYS.has(key) ? readNumber(value, key, warn) : stripQuotes(value);
                if (entry[key] === undefined) delete entry[key];
                continue;
            }

            entry[key] = value;
        }

        // Tipe driver diperiksa di sini supaya typo tidak diam-diam jatuh ke HostVFS.
        const type = entry.type;
        if (type !== undefined && !FSTAB_MOUNT_TYPES.includes(String(type) as any)) {
            warn(
                `[${vfsPath}] type='${String(type)}' tidak dikenal ` +
                    `(harus salah satu: ${FSTAB_MOUNT_TYPES.join(", ")}) → entri dilewati`,
            );
            continue;
        }

        entries.push(entry);
    }

    return entries;
}

/** parseIni(): Urai teks INI/conf → daftar entri (satu `[section]` = satu mount). */
function parseIni(content: string, warnings: string[]): FstabEntry[] {
    const raw: Array<Record<string, unknown>> = [];
    let current: Record<string, unknown> | null = null;

    for (const original of content.split(/\r?\n/)) {
        const line = original.trim();
        if (!line || line.startsWith(";") || line.startsWith("#")) continue;

        if (line.startsWith("[") && line.endsWith("]")) {
            const vfsPath = line.slice(1, -1).trim();
            current = { vfsPath };
            raw.push(current);
            continue;
        }

        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) {
            warnings.push(`baris tidak dikenal (tanpa '='): '${line}'`);
            continue;
        }

        if (!current) {
            // Baris key-value sebelum section pertama: dulu hilang DIAM-DIAM.
            warnings.push(`key '${line.slice(0, eqIdx).trim()}' muncul sebelum [section] → diabaikan`);
            continue;
        }

        const key = line.slice(0, eqIdx).trim();
        const value = line.slice(eqIdx + 1).trim();
        if (key) current[key] = value;
    }

    const entries = normalizeEntries(raw, warnings);
    if (entries.length === 0 && raw.length > 0) {
        warnings.push("tidak ada section yang valid — periksa format [vfsPath] & key=value");
    }
    return entries;
}

/** tryParseJsonArray(): Array JSON (format lama) atau null kalau bukan JSON. */
function tryParseJsonArray(content: string): unknown[] | null {
    const trimmed = content.trim();
    // FSTAB lama SELALU array (`[{ "vfsPath": ... }]`); object tunggal juga diterima.
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === "object") return [parsed];
        return null;
    } catch {
        return null;
    }
}

/** Urutan key yang enak dibaca manusia (sisanya alfabetis). */
const KEY_ORDER = ["hostPath", "type", "readOnly", "active", "uid", "gid", "mode"];

/**
 * formatFstabIni(): Serialisasi entri → teks INI.
 *
 * Dipakai dua tempat: MIGRASI `/etc/fstab.json` lama (sekali-jalan, dari kernel)
 * dan templat image baru. `mode` SELALU ditulis oktal eksplisit (`0o755`) supaya
 * tidak ada ambiguitas desimal/oktal saat berkasnya dibaca manusia lagi; string
 * yang memuat spasi/`#`/`;` dikutip supaya bisa dibaca ulang apa adanya.
 */
export function formatFstabIni(entries: FstabEntry[], header?: string): string {
    const lines: string[] = [];
    if (header) lines.push(...header.trimEnd().split("\n"));

    for (const entry of entries) {
        lines.push("", `[${entry.vfsPath}]`);
        const keys = Object.keys(entry)
            .filter((k) => k !== "vfsPath" && entry[k] !== undefined)
            .sort((a, b) => {
                const pa = KEY_ORDER.indexOf(a);
                const pb = KEY_ORDER.indexOf(b);
                if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
                return a.localeCompare(b);
            });
        for (const key of keys) {
            lines.push(`${key} = ${formatValue(key, entry[key])}`);
        }
    }

    return lines.join("\n").replace(/^\n+/, "") + "\n";
}

/** formatValue(): Nilai JS → teks siap tulis (khusus `mode` selalu oktal). */
function formatValue(key: string, value: unknown): string {
    if (key === "mode" && typeof value === "number") return `0o${value.toString(8)}`;
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return String(value);
    const s = String(value);
    return /[\s#;]/.test(s) ? `"${s}"` : s;
}
