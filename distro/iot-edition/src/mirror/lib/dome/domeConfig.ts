/**
 * domeConfig.ts — konfigurasi DOME (`/etc/dome/dome.conf`)
 *
 * Port DOME disimpan di berkas INI gaya `/etc/fstab.conf` (`[section]` +
 * `key = value`) dan dibaca `/lib/ConfigParser.ts` — aturan nilainya sama dengan
 * parser kernel, jadi satu berkas `.conf` tidak punya dua arti berbeda.
 *
 * Modul ini memutuskan PORT yang dipakai SEKALIGUS membuat berkasnya kalau belum
 * ada: admin langsung dapat contoh yang bisa diedit, bukan daemon yang jalan
 * dengan nilai diam-diam tanpa jejak di disk.
 *
 * I/O disuntik (`DomeConfigIO`) supaya keputusan di atas bisa diuji tanpa kernel —
 * pola yang sama dengan `ConfigParser.test.ts`.
 *
 * (c) 2026 TSIX Project — DOME
 */

import { fs } from "@tsix/Application";
import { ConfigParser } from "@tsix/ConfigParser";

// ─── Konstanta ────────────────────────────────────────────────────────────

export const DOME_CONFIG_PATH = "/etc/dome/dome.conf";
export const DOME_CONFIG_DIR = "/etc/dome";
/** Berkas konfigurasi LAMA (JSON). Dibaca sekali untuk migrasi, TIDAK dihapus. */
export const DOME_LEGACY_CONFIG_PATH = "/etc/dome/dome.json";
/** Port bawaan: dipakai saat berkas belum ada atau nilainya tidak sah. */
export const DOME_DEFAULT_PORT = 8080;
export const DOME_PORT_MIN = 1;
export const DOME_PORT_MAX = 65535;

/** Pembaca isi berkas — bentuknya sama dengan `ConfigReader` di `/lib/ConfigParser.ts`. */
export type DomeConfigReader = (path: string) => Promise<string | null>;

/** I/O yang bisa disuntik (unit test memakai VFS palsu in-memory). */
export interface DomeConfigIO {
  stat?: (path: string) => Promise<any>;
  read?: DomeConfigReader;
  write?: (path: string, content: string) => Promise<boolean>;
  mkdir?: (path: string) => Promise<any>;
}

export interface DomeConfigResult {
  /** Port yang harus dipakai DOME (selalu angka yang sah). */
  port: number;
  /** true kalau berkas konfigurasi baru dibuat oleh DOME sendiri. */
  created: boolean;
  /**
   * Hal yang perlu terlihat pemanggil (berkas gagal dibuat, port tidak sah,
   * peringatan parser, migrasi dari JSON, …). Modul `/lib` tidak mencetak sendiri
   * ke TTY — pemanggil (`dome.ts`) yang memutuskan tampilannya.
   */
  warnings: string[];
}

// ─── Template berkas ──────────────────────────────────────────────────────

/**
 * formatDomeConfig(): Isi berkas konfigurasi (komentar + `[dome] port`).
 *
 * Dipakai DUA tempat: berkas yang dibuat OTOMATIS saat `dome.conf` belum ada, dan
 * salinan rujukan di repo (`src/mirror/etc/dome/dome.conf`) — jaga keduanya tetap
 * sama supaya admin melihat contoh yang persis sama dengan hasil otomatis.
 */
export function formatDomeConfig(port: number = DOME_DEFAULT_PORT): string {
  return [
    "# /etc/dome/dome.conf — konfigurasi DOME (PixelSpace Display Server)",
    "#",
    "# Format: INI sederhana — `[section]` lalu `key = value`.",
    "# Aturan nilai (lihat /lib/ConfigParser.ts):",
    '#   - nilai berkutip = string apa adanya ("8080" tetap string)',
    "#   - koma di luar kutip = array",
    "#   - true/false & yes/no & on/off = boolean",
    "#   - angka desimal utuh = Number",
    "#",
    "# Berkas ini dibuat otomatis oleh DOME kalau belum ada (lihat",
    "# /lib/dome/domeConfig.ts). Node yang masih memakai /etc/dome/dome.json",
    "# dibaca SEKALI saat migrasi — berkas lama dibiarkan.",
    "",
    "[dome]",
    "# port = port HTTP + WebSocket untuk klien browser (1..65535)",
    `port = ${port}`,
    "",
  ].join("\n");
}

// ─── Helper ───────────────────────────────────────────────────────────────

/**
 * toPort(): Nilai config → port yang sah, atau `null` kalau tidak bisa dipakai.
 *
 * Menerima angka (`8080`, hasil parser) maupun string numerik (`"8080"`) —
 * admin yang menulis nilai berkutip tetap dimengerti, dan yang penting tidak ada
 * port "ajaib" seperti `0` / `70000` yang lolos ke `listen()`.
 */
export function toPort(raw: any): number | null {
  const n = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof n !== "number" || !Number.isInteger(n)) return null;
  if (n < DOME_PORT_MIN || n > DOME_PORT_MAX) return null;
  return n;
}

/**
 * readLegacyPort(): Port dari konfigurasi LAMA (`/etc/dome/dome.json`).
 *
 * Node yang sudah menyesuaikan port di format lama tidak boleh diam-diam kembali
 * ke default hanya karena berkasnya berganti nama. Berkas JSON-nya SENGAJA tidak
 * dihapus — sama seperti migrasi fstab/sysconfig: sumber lama milik admin.
 */
async function readLegacyPort(read: DomeConfigReader): Promise<number | null> {
  try {
    const raw = await read(DOME_LEGACY_CONFIG_PATH);
    if (!raw) return null; // tidak ada (VFS memberi null / melempar)
    const parsed = JSON.parse(String(raw));
    return toPort(parsed?.port);
  } catch (_) {
    return null; // bukan JSON yang sah → anggap tidak ada
  }
}

// ─── Loader ───────────────────────────────────────────────────────────────

/**
 * loadDomeConfig(): Tentukan port DOME dari `/etc/dome/dome.conf`.
 *
 * - **Berkas belum ada** → dibuat dari `formatDomeConfig()` lengkap dengan
 *   komentar; port diambil dari `/etc/dome/dome.json` lama kalau ada (migrasi),
 *   selain itu `DOME_DEFAULT_PORT`.
 * - **Berkas ada** → dibaca `ConfigParser`; `[dome] port` tidak ada / tidak sah →
 *   port default + peringatan (daemon tetap jalan, tapi alasannya terlihat).
 *
 * Keberadaan berkas diuji lewat `stat()`, BUKAN dari hasil pembacaan: berkas yang
 * ada tapi gagal dibaca (izin, kerusakan) tidak boleh ditimpa — bisa jadi itu
 * setelan milik admin.
 */
export async function loadDomeConfig(
  io: DomeConfigIO = {},
): Promise<DomeConfigResult> {
  const stat = io.stat ?? ((path: string) => fs.stat(path));
  const read = io.read ?? ((path: string) => fs.readFile(path));
  const write =
    io.write ?? ((path: string, content: string) => fs.writeFile(path, content));
  const mkdir = io.mkdir ?? ((path: string) => fs.mkdir(path));

  const warnings: string[] = [];

  const node = await stat(DOME_CONFIG_PATH).catch(() => null);

  if (!node) {
    const legacy = await readLegacyPort(read);
    const port = legacy ?? DOME_DEFAULT_PORT;

    try {
      // `mkdir` rekursif: aman dipanggil walau `/etc/dome` sudah ada.
      await mkdir(DOME_CONFIG_DIR);
      // `fs.writeFile` mengembalikan `false` (bukan melempar) kalau OPEN gagal —
      // itu tetap "berkas tidak dibuat", jadi jangan dilaporkan sebagai sukses.
      const written = await write(DOME_CONFIG_PATH, formatDomeConfig(port));
      if (written === false) throw new Error("writeFile returned false");
    } catch (e: any) {
      warnings.push(
        `cannot create ${DOME_CONFIG_PATH} (${e?.message ?? e}) — using port ${port}`,
      );
      return { port, created: false, warnings };
    }

    if (legacy !== null) {
      warnings.push(
        `migrated port ${legacy} from ${DOME_LEGACY_CONFIG_PATH} — the old file is left in place`,
      );
    }
    return { port, created: true, warnings };
  }

  // `ConfigParser` mencatat sebab kegagalan di `getStats()`, bukan mencetak.
  const config = new ConfigParser(DOME_CONFIG_PATH, { reader: read });
  if (!(await config.load())) {
    warnings.push(
      `cannot read ${DOME_CONFIG_PATH} (${config.getStats().lastError}) — using default port ${DOME_DEFAULT_PORT}`,
    );
    return { port: DOME_DEFAULT_PORT, created: false, warnings };
  }

  for (const warning of config.getStats().warnings) {
    warnings.push(`${DOME_CONFIG_PATH}: ${warning}`);
  }

  const raw = config.get("dome", "port");
  const port = toPort(raw);

  if (port === null) {
    warnings.push(
      raw === undefined
        ? `missing 'port' in [dome] of ${DOME_CONFIG_PATH} — using default port ${DOME_DEFAULT_PORT}`
        : `invalid port '${String(raw)}' in [dome] of ${DOME_CONFIG_PATH} — using default port ${DOME_DEFAULT_PORT}`,
    );
    return { port: DOME_DEFAULT_PORT, created: false, warnings };
  }

  return { port, created: false, warnings };
}
