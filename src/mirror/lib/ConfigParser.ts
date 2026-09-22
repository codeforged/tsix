import { fs } from "@tsix/Application";

/** Pembaca isi berkas — bisa disuntik untuk uji, atau sumber lain (shell/host). */
export type ConfigReader = (path: string) => Promise<string | null>;

/**
 * CONFIG PARSER (INI-style config reader)
 *
 * Mengurai berkas konfigurasi bergaya INI: `[section]` diikuti `key = value`.
 * Baris yang muncul sebelum `[section]` pertama masuk ke **global section** `""`.
 *
 * ATURAN NILAI — sengaja disamakan dengan parser kernel
 * (`src/kernel/FstabParser.ts`) supaya satu berkas `.conf` tidak punya dua arti
 * berbeda tergantung siapa yang membacanya:
 *
 *   - `"teks"` → string apa adanya (kutip dibuang). Isi berkutip TIDAK dipotong
 *     komentar dan TIDAK dipecah jadi array.
 *   - `a, b, c` → array; pemisahnya koma di LUAR tanda kutip.
 *   - `true/false`, `yes/no`, `on/off` (huruf besar-kecil bebas) → boolean.
 *     Dulu `false` jadi string `"false"` yang truthy — jebakan klasik di `if`.
 *   - angka → Number HANYA kalau bolak-baliknya utuh (`String(Number(x)) === x`).
 *     Karena itu `0755` tetap string `"0755"` (dipaksa jadi 755 desimal malah
 *     menghilangkan niat oktalnya), `0o755` → 493, `0x1f` → 31, dan kunci
 *     64 digit (mis. `--key` NetFS) tidak kehilangan presisi.
 *   - `#`/`;` memulai komentar: baris penuh ATAU ekor nilai, selama tidak di
 *     dalam kutip dan didahului spasi (jadi `kanal#1` tetap utuh).
 *
 * Peringatan (key sebelum `[section]`, baris tanpa `=`, dsb.) DIKUMPULKAN dan
 * bisa dibaca via `getStats().warnings` — modul `/lib` tidak menulis sendiri ke
 * console/TTY, biar pemanggil yang memutuskan tampilannya.
 */
export class ConfigParser {
  private configPath: string;
  private reader: ConfigReader;
  private parsedData: Record<string, Record<string, any>> = {};
  private isLoaded: boolean = false;

  // Stats & Metadata
  private totalSections: number = 0;
  private totalKeys: number = 0;
  private fileLength: number = 0;
  private lastLoadedTime: number = 0;
  private lastError: string | null = null;
  private warnings: string[] = [];

  constructor(path: string, options: { reader?: ConfigReader } = {}) {
    this.configPath = path;
    // Default: VFS (`fs.readFile`). `reader` disuntik di unit-test supaya logika
    // parsing bisa diuji tanpa menyalakan kernel.
    this.reader = options.reader ?? ((p: string) => fs.readFile(p));
  }

  /**
   * load(): Membaca file konfigurasi fisik dari VFS dan memproses isinya
   */
  public async load(): Promise<boolean> {
    this.isLoaded = false;
    this.lastError = null;
    this.warnings = [];

    try {
      const content = await this.reader(this.configPath);
      if (content === null || content === undefined) {
        // VFS memberi `null` untuk berkas yang tidak ada (bukan throw). Berkas
        // yang ADA tapi kosong tetap sah — isinya cuma tanpa key.
        throw new Error("berkas tidak ditemukan atau tidak dapat dibaca");
      }

      this.fileLength = content.length;
      this.parsedData = this.parseConfig(content);

      // Hitung statistik data terurai
      this.totalSections = Object.keys(this.parsedData).length;
      this.totalKeys = Object.values(this.parsedData).reduce(
        (acc, sec) => acc + Object.keys(sec).length,
        0,
      );

      this.lastLoadedTime = Date.now();
      this.isLoaded = true;
      return true;
    } catch (e: any) {
      // Sebabnya disimpan, bukan dicetak: pemanggil (`Program`) yang tahu
      // apakah perlu ditampilkan, dan ke mana.
      this.lastError = e?.message ?? String(e);
      this.isLoaded = false;
      return false;
    }
  }

  /**
   * get(): Mengambil nilai dari key di section tertentu.
   * Gunakan string kosong "" untuk mengambil nilai dari global section.
   */
  public get(section: string, key: string): any {
    if (!this.isLoaded) {
      throw new Error(`[ConfigParser] Jalankan .load() terlebih dahulu sebelum mengambil data.`);
    }

    const secData = this.parsedData[section];
    if (!secData) return undefined;
    
    return secData[key];
  }

  /**
   * has(): Cek keberadaan section (atau key di dalam section).
   * Beda dengan `get()` yang mengembalikan `undefined` untuk key bernilai
   * kosong/absen — `has()` menjawab "ada atau tidak" tanpa menebak.
   */
  public has(section: string, key?: string): boolean {
    const secData = this.parsedData[section];
    if (!secData) return false;
    return key === undefined
      ? true
      : Object.prototype.hasOwnProperty.call(secData, key);
  }

  /**
   * getAll(): Mengambil seluruh object konfigurasi yang telah di-parse
   */
  public getAll(): Record<string, Record<string, any>> {
    return this.parsedData;
  }

  /**
   * getStats(): Mengambil statistik pembacaan file konfigurasi
   */
  public getStats() {
    return {
      path: this.configPath,
      isLoaded: this.isLoaded,
      totalSections: this.totalSections,
      totalKeys: this.totalKeys,
      fileLength: this.fileLength,
      lastLoaded: this.lastLoadedTime > 0 ? new Date(this.lastLoadedTime).toISOString() : "never",
      lastError: this.lastError,
      warnings: [...this.warnings],
    };
  }

  /**
   * parseConfig(): Logika internal untuk pemecahan baris teks
   */
  private parseConfig(content: string): Record<string, Record<string, any>> {
    const config: Record<string, Record<string, any>> = {};
    const lines = content.split(/\r?\n/);

    // `""` = global section, menampung key sebelum `[section]` pertama.
    let currentSection = "";
    let sectionSeen = false;
    config[currentSection] = {};

    for (let i = 0; i < lines.length; i++) {
      // Komentar dibuang DULU (baris penuh maupun ekor), baru di-trim: dulu
      // `key = nilai # catatan` menyimpan `nilai # catatan` sebagai nilainya.
      const line = stripComment(lines[i]).trim();
      if (!line) continue;

      // Deteksi Section: [section_name]
      if (line.startsWith("[")) {
        if (!line.endsWith("]")) {
          this.warnings.push(`baris ${i + 1}: '[' tanpa ']' → dilewati (${line})`);
          continue;
        }
        currentSection = line.slice(1, -1).trim();
        sectionSeen = true;
        if (!currentSection) {
          this.warnings.push(`baris ${i + 1}: nama section kosong → dilewati`);
          continue;
        }
        config[currentSection] = config[currentSection] || {};
        continue;
      }

      // Deteksi Key = Value
      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) {
        this.warnings.push(`baris ${i + 1}: bukan 'key = value' → dilewati (${line})`);
        continue;
      }

      const key = line.slice(0, eqIdx).trim();
      if (!key) {
        this.warnings.push(`baris ${i + 1}: nama key kosong → dilewati`);
        continue;
      }
      if (!sectionSeen) {
        // Bukan error, tapi hampir selalu salah tempat: nilai ini tertimpa
        // global section yang tidak dibaca siapa pun.
        this.warnings.push(
          `baris ${i + 1}: key '${key}' muncul sebelum [section] pertama → masuk global section ("")`,
        );
      }

      config[currentSection][key] = parseValue(line.slice(eqIdx + 1));
    }

    // Bersihkan global section kalau ternyata tidak ada key yang masuk ke sana
    if (Object.keys(config[""]).length === 0) delete config[""];

    return config;
  }
}

/**
 * stripComment(): Buang komentar `#`/`;` yang berada di LUAR tanda kutip.
 *
 * Penanda komentar harus di awal baris atau didahului spasi — jadi nilai seperti
 * `kanal#1` atau `a;b` tidak rusak (aturan sama dengan parser kernel).
 */
function stripComment(line: string): string {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === "#" || ch === ";") && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * splitList(): Pecah koma di luar tanda kutip → `a, "b,c", d` = 3 bagian.
 *
 * Pengganti regex lama `/,(?=(?:(?:[^\"]*\"){2})*[^\"]*\$)/` yang salah:
 * `\$` di situ adalah karakter dolar LITERAL (bukan anchor `$`), jadi koma tidak
 * pernah dianggap pemisah dan `123, 456, 789` selalu jadi satu string tunggal.
 */
function splitList(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of input) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** parseScalar(): Satu potong teks → string | number | boolean. */
function parseScalar(raw: string): any {
  const trimmed = raw.trim();
  if (trimmed === "") return "";

  // Berkurip = string literal: tipenya TIDAK ditebak lagi ("1234" tetap string).
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }

  // Boolean: `false`/`no`/`off` harus jadi false, bukan string yang truthy.
  const lower = trimmed.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "false" || lower === "no" || lower === "off") return false;

  // Basis eksplisit: `0o755` (oktal) dan `0x1f` (hex).
  if (/^0o[0-7]+$/i.test(trimmed)) return parseInt(trimmed.slice(2), 8);
  if (/^-?0x[0-9a-f]+$/i.test(trimmed)) return parseInt(trimmed, 16);

  // Angka desimal — hanya kalau bolak-baliknya UTUH. `0755` gagal syarat ini
  // (Number → 755, String → "755"), jadi tetap string: niat oktalnya selamat.
  if (/^-?\d+(\.\d+)?$/.test(trimmed) && String(Number(trimmed)) === trimmed) {
    return Number(trimmed);
  }

  return trimmed;
}

/** parseValue(): Nilai mentah → array (kalau ada koma di luar kutip) atau scalar. */
function parseValue(raw: string): any {
  const parts = splitList(raw);
  if (parts.length > 1) return parts.map((p) => parseScalar(p));
  return parseScalar(raw);
}
