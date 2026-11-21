/**
 * INI PARSER (generik, murni, tanpa I/O)
 *
 * Mengurai berkas konfigurasi bergaya INI: `[section]` diikuti `key = value`.
 * Dipakai `src/sysconfig.conf` (lihat `SysConfigIni.ts`) dan aturan nilainya
 * SENGAJA disamakan dengan `/etc/fstab.conf` (`src/kernel/FstabParser.ts`)
 * serta pembaca userland `/lib/ConfigParser.ts` — supaya satu berkas `.conf`
 * tidak punya dua arti berbeda tergantung siapa yang membacanya.
 *
 * ATURAN NILAI:
 *   - `"teks"` / `'teks'` → string apa adanya (kutip dibuang). Isi berkutip
 *     tidak dipotong komentar dan tidak dipecah jadi array.
 *   - `a, b, c`            → array; pemisahnya koma di LUAR tanda kutip.
 *   - `true/false`, `yes/no`, `on/off` → boolean. (`1`/`0` SENGAJA bukan
 *     boolean di sini — di berkas konfigurasi angka itu jauh lebih sering
 *     berarti angka, mis. `uid = 1`. Key boolean yang memang menerima `1`/`0`
 *     menormalkannya sendiri, lihat `SysConfigIni.ts`.)
 *   - angka                → Number HANYA kalau bolak-baliknya utuh
 *     (`String(Number(x)) === x`). Karena itu `0755` tetap string `"0755"`
 *     (memaksa jadi 755 desimal malah menghilangkan niat oktalnya), sedangkan
 *     `0o755` → 493 dan `0x1f` → 31 (bentuk ini eksplisit, jadi dihormati).
 *     Efek samping yang diinginkan: versi seperti `0.3.2.20260923.1` tetap
 *     string (bukan angka yang terpotong).
 *   - `#` / `;`            → komentar: baris penuh ATAU ekor nilai, selama
 *     tidak di dalam kutip dan didahului spasi (jadi `kanal#1` tetap utuh).
 *
 * Section `""` = baris yang muncul sebelum `[section]` pertama. Parser TIDAK
 * membuangnya diam-diam: pemanggil diberi peringatan (lihat `warnings`).
 */

export type IniValue = string | number | boolean | string[];

export interface IniParseResult {
    /** Nama section → key → nilai. `""` = global (sebelum section pertama). */
    sections: Record<string, Record<string, IniValue>>;
    /** Urutan kemunculan section (untuk pesan & formatter). */
    order: string[];
    /** Masalah yang ditemukan — PEMANGGIL yang memutuskan cara melaporkannya. */
    warnings: string[];
}

const TRUE_WORDS = new Set(["true", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "no", "off"]);

/** true kalau string dibungkus kutip ganda/tunggal yang sepadan. */
export function isQuoted(s: string): boolean {
    return (
        (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
        (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
    );
}

/** Buang kutip pembungkus (kalau ada). */
export function unquote(s: string): string {
    return isQuoted(s) ? s.slice(1, -1) : s;
}

/**
 * stripInlineComment(): Buang komentar ekor (` # ...`) TANPA menyentuh nilai
 * berkutip. Sengaja hanya memotong kalau komentar didahului spasi, sehingga
 * nilai seperti `mqtt://host/kanal#1` tidak rusak.
 */
export function stripInlineComment(raw: string): string {
    const s = raw.trim();
    if (isQuoted(s)) return s;
    const cut = s.search(/\s[#;]/);
    return cut === -1 ? s : s.slice(0, cut).trim();
}

/**
 * splitList(): Pecah `a, b, c` jadi array — koma di dalam kutip tidak memecah.
 */
function splitList(s: string): string[] {
    const out: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;

    for (const ch of s) {
        if (quote) {
            if (ch === quote) quote = null;
            current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === ",") {
            out.push(current.trim());
            current = "";
            continue;
        }
        current += ch;
    }
    out.push(current.trim());

    return out.filter((item) => item !== "").map(unquote);
}

/**
 * parseIniScalar(): Satu nilai (kanan `=`) → string | number | boolean | array.
 *
 * Nilai kosong (`key =`) menghasilkan string kosong — bukan undefined, supaya
 * "sengaja dikosongkan" tetap bisa dibedakan dari "key tidak ada".
 */
export function parseIniScalar(raw: string): IniValue {
    const s = stripInlineComment(raw);
    if (s === "") return "";
    if (isQuoted(s)) return unquote(s);
    if (s.includes(",")) return splitList(s);

    const lower = s.toLowerCase();
    if (TRUE_WORDS.has(lower)) return true;
    if (FALSE_WORDS.has(lower)) return false;

    // Bentuk angka eksplisit (oktal/hex) selalu dihormati…
    if (/^[+-]?0[oOxX]/.test(s)) {
        const explicit = Number(s);
        if (Number.isFinite(explicit)) return explicit;
    }
    // …selain itu hanya kalau bolak-baliknya utuh (lihat catatan di atas).
    const n = Number(s);
    if (Number.isFinite(n) && String(n) === s) return n;

    return s;
}

/**
 * parseIni(): Urai seluruh isi berkas.
 *
 * Baris yang tidak dikenali TIDAK menggagalkan parsing (satu baris rusak tidak
 * boleh membuat node kehilangan seluruh konfigurasinya) — semuanya masuk
 * `warnings` agar bisa dilaporkan pemanggil.
 */
export function parseIni(content: string): IniParseResult {
    const sections: Record<string, Record<string, IniValue>> = {};
    const order: string[] = [];
    const warnings: string[] = [];

    let current = "";

    const lines = content.replace(/\r\n?/g, "\n").split("\n");
    lines.forEach((rawLine, index) => {
        const lineNo = index + 1;
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#") || line.startsWith(";")) return;

        // --- [section] ---
        const section = /^\[(.+?)\]$/.exec(line);
        if (section) {
            current = section[1].trim();
            if (current === "") {
                warnings.push(`L${lineNo}: empty section name → ignored`);
                current = "";
                return;
            }
            if (!sections[current]) {
                sections[current] = {};
                order.push(current);
            }
            return;
        }

        // --- key = value ---
        const eq = line.indexOf("=");
        if (eq === -1) {
            warnings.push(`L${lineNo}: unrecognized line (no '='): '${line}'`);
            return;
        }
        const key = line.slice(0, eq).trim();
        if (key === "") {
            warnings.push(`L${lineNo}: empty key → ignored`);
            return;
        }
        if (!sections[current]) {
            sections[current] = {};
            order.push(current);
        }
        sections[current][key] = parseIniScalar(line.slice(eq + 1));
    });

    if (Object.prototype.hasOwnProperty.call(sections, "")) {
        const keys = Object.keys(sections[""]).join(", ");
        warnings.push(`keys outside any [section] → moved to global section: ${keys}`);
    }

    return { sections, order, warnings };
}
