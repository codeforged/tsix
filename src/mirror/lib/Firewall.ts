import { ConfigParser } from "@tsix/ConfigParser";

/**
 * FIREWALL PAKET FORWARDER (ACL untuk broker bridge)
 *
 * Membaca `/etc/packetforwarder/firewalltables.conf` dan memutuskan apakah
 * sebuah paket MQTNL boleh menyeberang dari satu broker ke broker lain.
 *
 * KENAPA DI FORWARDER: bridge melihat SEMUA paket yang lewat (JSON maupun
 * biner), jadi ia tempat paling wajar untuk menegakkan aturan — dan di sinilah
 * skenario "node X tidak boleh ke node Y" bisa disimulasikan secara edukatif.
 *
 * FORMAT BERKAS (INI, dibaca `ConfigParser` — semantiknya sama dengan
 * `sysconfig.conf`/`fstab.conf`, termasuk kutip, komentar `#`/`;`, dan array):
 *
 *   [address]
 *   allow     = "tsix-z", "tsix-c"   # dua arah: salah satu ujung harus cocok
 *   deny      = "tsix-y", "tsix-d"   # dua arah: salah satu ujung diblokir
 *   allow-src = "wintsix"            # hanya sumber ini
 *   allow-dst = "tsix-z", "tsix-c"   # hanya tujuan ini
 *   deny-src  = "tsix-d"             # sumber ini diblokir
 *   deny-dst  = "tsix-y"             # tujuan ini diblokir
 *
 *   [port]
 *   allow-dst = 24, 80           # hanya port tujuan ini
 *   allow-src = 11, 21           # hanya port sumber ini
 *   deny-dst  = 22               # port tujuan ini diblokir
 *   deny-src  = 23               # port sumber ini diblokir
 *
 * `"*"` berarti "semua". Key yang tidak ada / daftar kosong berarti "tidak ada
 * batasan" pada dimensi itu — jadi berkas tanpa aturan TIDAK memblokir apa pun
 * (perilaku forwarder lama tetap utuh).
 *
 * SEMANTIK (urut; yang pertama cocok menang):
 *   1. [address] deny / deny-src / deny-dst
 *      → blokir. `deny` memeriksa SUMBER **atau** TUJUAN; `deny-src` hanya
 *        sumber; `deny-dst` hanya tujuan. Sengaja deny `[address]` juga dua
 *        arah: "larang akses ke Y" harus sekaligus "larang akses dari Y",
 *        karena balasan Y→X akan lolos kalau hanya tujuan yang diperiksa.
 *   2. [address] allow / allow-src / allow-dst — semua yang DIISI harus lolos
 *      (AND), jadi `allow-src` + `allow-dst` = pasangan sumber→tujuan yang sah:
 *        - `allow`     : minimal salah satu ujung ada di daftar
 *        - `allow-src` : sumber WAJIB ada di daftar
 *        - `allow-dst` : tujuan WAJIB ada di daftar
 *   3. [port] deny-src / deny-dst → blokir bila port sumber/tujuan cocok.
 *      (Harfiah: `deny-dst=22` hanya melihat port tujuan.)
 *   4. [port] allow-src / allow-dst → bila diisi dan bukan "*": port sumber/
 *      tujuan WAJIB ada di daftar.
 *
 * Catatan penting soal aturan berarah: balasan selalu BERBALIK arahnya.
 * Paket X→Y punya src=X, dst=Y; balasannya src=Y, dst=X. Jadi:
 *
 *   allow-dst = "tsix-z"      → X→Z lolos, tetapi balasan Z→X DIBLOKIR
 *                                (dst balasan = X, bukan Z).
 *
 * Karena itu, untuk whitelist berarah biasanya kedua sisi perlu didaftarkan:
 *
 *   allow-dst = "tsix-z", "tsix-c"
 *   allow-src = "tsix-z", "tsix-c"
 *
 * Hal yang sama berlaku untuk `[port]`: port tujuan balasan = port aplikasi
 * klien, bukan port service.
 *
 * Nama alamat dibandingkan tanpa membedakan huruf besar/kecil. Hanya `"*"`
 * yang berarti wildcard; pola seperti `tsix-*` TIDAK didukung dan akan
 * diperingatkan saat parsing (supaya tidak ada blokir yang "diam-diam tidak
 * jalan").
 *
 * (c) 2026 TSIX Project
 */

/** Lokasi bawaan berkas aturan (bisa dioverride lewat `forward --fw-file`). */
export const FIREWALL_DEFAULT_PATH = "/etc/packetforwarder/firewalltables.conf";

/** Bagian paket yang diperiksa aturan. */
export interface FirewallPacket {
  srcAddress: string;
  srcPort: number;
  dstAddress: string;
  dstPort: number;
}

export interface FirewallVerdict {
  /** True = paket boleh diteruskan. */
  allowed: boolean;
  /** Penjelasan singkat aturan yang memutuskan (dipakai log & CLI). */
  reason: string;
}

interface AddressRules {
  /** `true` bila daftar berisi "*" (artinya semua alamat). */
  allowAny: boolean;
  denyAny: boolean;
  /** Dua arah: salah satu ujung (sumber ATAU tujuan). */
  allow: Set<string>;
  deny: Set<string>;
  /** Berarah: hanya sumber, atau hanya tujuan. */
  allowSrcAny: boolean;
  allowDstAny: boolean;
  denySrcAny: boolean;
  denyDstAny: boolean;
  allowSrc: Set<string>;
  allowDst: Set<string>;
  denySrc: Set<string>;
  denyDst: Set<string>;
}

interface PortRules {
  allowSrcAny: boolean;
  allowDstAny: boolean;
  denySrcAny: boolean;
  denyDstAny: boolean;
  allowSrc: Set<number>;
  allowDst: Set<number>;
  denySrc: Set<number>;
  denyDst: Set<number>;
}

const EMPTY_ADDRESS: AddressRules = {
  allowAny: false,
  denyAny: false,
  allow: new Set(),
  deny: new Set(),
  allowSrcAny: false,
  allowDstAny: false,
  denySrcAny: false,
  denyDstAny: false,
  allowSrc: new Set(),
  allowDst: new Set(),
  denySrc: new Set(),
  denyDst: new Set(),
};

const EMPTY_PORT: PortRules = {
  allowSrcAny: false,
  allowDstAny: false,
  denySrcAny: false,
  denyDstAny: false,
  allowSrc: new Set(),
  allowDst: new Set(),
  denySrc: new Set(),
  denyDst: new Set(),
};

/** Nilai ConfigParser (skalar atau array) → array. */
function asArray(value: any): any[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * normalizeAddresses(): daftar alamat → aturan alamat.
 * Nama dinormalisasi (trim + lower-case) supaya salah huruf besar/kecil tidak
 * membuat aturan "tidak pernah kena".
 */
function normalizeAddresses(
  value: any,
  label: string,
  warnings: string[],
): { any: boolean; set: Set<string> } {
  const set = new Set<string>();
  let any = false;

  for (const raw of asArray(value)) {
    if (typeof raw === "boolean") {
      warnings.push(
        `${label}: nilai boolean '${raw}' diabaikan (pakai nama alamat atau "*")`,
      );
      continue;
    }
    const text = String(raw).trim();
    if (text === "") continue;
    if (text === "*") {
      any = true;
      continue;
    }
    if (text.includes("*")) {
      warnings.push(
        `${label}: pola wildcard '${text}' tidak didukung (hanya "*" penuh) — diabaikan`,
      );
      continue;
    }
    set.add(text.toLowerCase());
  }

  return { any, set };
}

/**
 * normalizePorts(): daftar port → aturan port.
 * Menerima angka (`24`) maupun teks (`"24"`). Nilai di luar 0..65535 ditolak
 * dengan peringatan — lebih baik terlihat daripada diam-diam tidak pernah kena.
 */
function normalizePorts(
  value: any,
  label: string,
  warnings: string[],
): { any: boolean; set: Set<number> } {
  const set = new Set<number>();
  let any = false;

  for (const raw of asArray(value)) {
    if (typeof raw === "boolean") {
      warnings.push(
        `${label}: nilai boolean '${raw}' diabaikan (pakai nomor port atau "*")`,
      );
      continue;
    }
    const text = String(raw).trim();
    if (text === "") continue;
    if (text === "*") {
      any = true;
      continue;
    }
    const n = Number(text);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      warnings.push(`${label}: '${text}' bukan nomor port 0-65535 — diabaikan`);
      continue;
    }
    set.add(n);
  }

  return { any, set };
}

/**
 * FIREWALL — hasil parsing berkas aturan + evaluator.
 *
 * Objek ini immutable setelah dibuat; untuk menerapkan aturan baru, muat ulang
 * (`Firewall.load()`) lalu pasang ke forwarder.
 */
export class Firewall {
  /** Path asal aturan (untuk log/CLI). */
  public readonly path: string;
  /** Peringatan parsing (key tak dikenal, nilai tidak valid, dsb). */
  public readonly warnings: string[];
  /** False = berkas tidak ada / tidak punya aturan → semua paket lolos. */
  public readonly active: boolean;

  private readonly address: AddressRules;
  private readonly port: PortRules;

  private constructor(
    path: string,
    address: AddressRules,
    port: PortRules,
    warnings: string[],
  ) {
    this.path = path;
    this.address = address;
    this.port = port;
    this.warnings = warnings;
    this.active = Firewall.hasAnyRule(address, port);
  }

  private static hasAnyRule(a: AddressRules, p: PortRules): boolean {
    return (
      a.allowAny ||
      a.denyAny ||
      a.allow.size > 0 ||
      a.deny.size > 0 ||
      a.allowSrcAny ||
      a.allowDstAny ||
      a.denySrcAny ||
      a.denyDstAny ||
      a.allowSrc.size > 0 ||
      a.allowDst.size > 0 ||
      a.denySrc.size > 0 ||
      a.denyDst.size > 0 ||
      p.allowSrcAny ||
      p.allowDstAny ||
      p.denySrcAny ||
      p.denyDstAny ||
      p.allowSrc.size > 0 ||
      p.allowDst.size > 0 ||
      p.denySrc.size > 0 ||
      p.denyDst.size > 0
    );
  }

  /** Firewall non-aktif (semua lolos) dengan satu peringatan. */
  public static inactive(path: string, warning: string): Firewall {
    return new Firewall(path, EMPTY_ADDRESS, EMPTY_PORT, [warning]);
  }

  /**
   * fromText(): urai isi berkas aturan (tanpa I/O) — dipakai `load()` dan uji.
   *
   * Memakai `ConfigParser` supaya aturan nilai (kutip, komentar, array)
   * PERSIS sama dengan berkas `.conf` lain di TSIX.
   */
  public static async fromText(
    text: string,
    path: string = "<memory>",
  ): Promise<Firewall> {
    const warnings: string[] = [];
    const parser = new ConfigParser(path, { reader: async () => text });

    if (!(await parser.load())) {
      const err = parser.getStats().lastError ?? "tidak dapat diurai";
      return Firewall.inactive(path, `${path}: ${err} — firewall non-aktif`);
    }

    warnings.push(...parser.getStats().warnings);

    const data = parser.getAll();

    // Section & key boleh ditulis dengan huruf besar/kecil bebas.
    const section = (wanted: string) =>
      Object.entries(data).find(([name]) => name.toLowerCase() === wanted)?.[1] ?? {};
    const addrSection = section("address");
    const portSection = section("port");

    for (const name of Object.keys(data)) {
      if (name === "") {
        warnings.push(
          "key di luar section diabaikan — aturan harus berada di [address] atau [port]",
        );
        continue;
      }
      const lower = name.toLowerCase();
      if (lower !== "address" && lower !== "port") {
        warnings.push(
          `section [${name}] tidak dikenal (hanya [address] dan [port]) — diabaikan`,
        );
      }
    }

    const pick = (sec: Record<string, any>, name: string) =>
      Object.entries(sec).find(([k]) => k.toLowerCase() === name)?.[1];

    for (const key of Object.keys(addrSection)) {
      const k = key.toLowerCase();
      if (
        k !== "allow" &&
        k !== "deny" &&
        k !== "allow-src" &&
        k !== "allow-dst" &&
        k !== "deny-src" &&
        k !== "deny-dst"
      ) {
        warnings.push(
          `[address] key '${key}' tidak dikenal (allow/deny/allow-src/allow-dst/deny-src/deny-dst) — diabaikan`,
        );
      }
    }
    for (const key of Object.keys(portSection)) {
      const k = key.toLowerCase();
      if (k !== "allow-src" && k !== "allow-dst" && k !== "deny-src" && k !== "deny-dst") {
        warnings.push(
          `[port] key '${key}' tidak dikenal (allow-src/allow-dst/deny-src/deny-dst) — diabaikan`,
        );
      }
    }

    const normAddr = (name: string) =>
      normalizeAddresses(pick(addrSection, name), `[address] ${name}`, warnings);

    const allowAddr = normAddr("allow");
    const denyAddr = normAddr("deny");
    const addrAllowSrc = normAddr("allow-src");
    const addrAllowDst = normAddr("allow-dst");
    const addrDenySrc = normAddr("deny-src");
    const addrDenyDst = normAddr("deny-dst");

    const allowSrc = normalizePorts(pick(portSection, "allow-src"), "[port] allow-src", warnings);
    const allowDst = normalizePorts(pick(portSection, "allow-dst"), "[port] allow-dst", warnings);
    const denySrc = normalizePorts(pick(portSection, "deny-src"), "[port] deny-src", warnings);
    const denyDst = normalizePorts(pick(portSection, "deny-dst"), "[port] deny-dst", warnings);

    return new Firewall(
      path,
      {
        allowAny: allowAddr.any,
        denyAny: denyAddr.any,
        allow: allowAddr.set,
        deny: denyAddr.set,
        allowSrcAny: addrAllowSrc.any,
        allowDstAny: addrAllowDst.any,
        denySrcAny: addrDenySrc.any,
        denyDstAny: addrDenyDst.any,
        allowSrc: addrAllowSrc.set,
        allowDst: addrAllowDst.set,
        denySrc: addrDenySrc.set,
        denyDst: addrDenyDst.set,
      },
      {
        allowSrcAny: allowSrc.any,
        allowDstAny: allowDst.any,
        denySrcAny: denySrc.any,
        denyDstAny: denyDst.any,
        allowSrc: allowSrc.set,
        allowDst: allowDst.set,
        denySrc: denySrc.set,
        denyDst: denyDst.set,
      },
      warnings,
    );
  }

  /**
   * load(): baca berkas aturan dari VFS (default) atau sumber lain.
   *
   * Berkas tidak ada BUKAN error: hasilnya firewall non-aktif (semua lolos)
   * plus satu peringatan, supaya forwarder lama tetap berjalan seperti biasa.
   */
  public static async load(
    opts: {
      path?: string;
      reader?: (path: string) => Promise<string | null>;
    } = {},
  ): Promise<Firewall> {
    const path = opts.path ?? FIREWALL_DEFAULT_PATH;
    const reader = opts.reader ?? ((p: string) => readVfsFile(p));

    let text: string | null = null;
    try {
      text = await reader(path);
    } catch (e: any) {
      return Firewall.inactive(
        path,
        `${path}: gagal dibaca (${e?.message ?? e}) — firewall non-aktif`,
      );
    }

    if (text === null || text === undefined) {
      return Firewall.inactive(
        path,
        `${path}: berkas tidak ditemukan — firewall non-aktif (semua paket lolos)`,
      );
    }

    return Firewall.fromText(text, path);
  }

  /**
   * evaluate(): putuskan satu paket.
   *
   * Urutan mengikuti dokumentasi di kepala berkas ini: deny selalu menang,
   * allow hanya membatasi bila memang diisi.
   */
  public evaluate(packet: FirewallPacket): FirewallVerdict {
    if (!this.active) return { allowed: true, reason: "firewall non-aktif" };

    const srcAddr = String(packet.srcAddress ?? "").toLowerCase();
    const dstAddr = String(packet.dstAddress ?? "").toLowerCase();
    const srcPort = Number(packet.srcPort);
    const dstPort = Number(packet.dstPort);
    const a = this.address;
    const p = this.port;

    // ── 1. [address] deny: dua arah, lalu berarah ──
    // Semua bentuk deny dicek LEBIH DULU: allow tidak boleh "menyelamatkan"
    // alamat yang sudah dilarang.
    if (a.denyAny) {
      return { allowed: false, reason: `[address] deny = "*"` };
    }
    if (a.deny.has(srcAddr)) {
      return {
        allowed: false,
        reason: `[address] deny cocok di sumber ("${packet.srcAddress}")`,
      };
    }
    if (a.deny.has(dstAddr)) {
      return {
        allowed: false,
        reason: `[address] deny cocok di tujuan ("${packet.dstAddress}")`,
      };
    }
    if (a.denySrcAny) {
      return { allowed: false, reason: `[address] deny-src = "*"` };
    }
    if (a.denySrc.has(srcAddr)) {
      return {
        allowed: false,
        reason: `[address] deny-src memuat "${packet.srcAddress}"`,
      };
    }
    if (a.denyDstAny) {
      return { allowed: false, reason: `[address] deny-dst = "*"` };
    }
    if (a.denyDst.has(dstAddr)) {
      return {
        allowed: false,
        reason: `[address] deny-dst memuat "${packet.dstAddress}"`,
      };
    }

    // ── 2. [address] allow: SEMUA yang diisi harus lolos (AND) ──
    // `allow` dua arah: cukup salah satu ujung terdaftar.
    if (!a.allowAny && a.allow.size > 0) {
      if (!a.allow.has(srcAddr) && !a.allow.has(dstAddr)) {
        return {
          allowed: false,
          reason: `[address] allow tidak memuat "${packet.dstAddress}" maupun "${packet.srcAddress}"`,
        };
      }
    }
    if (!a.allowSrcAny && a.allowSrc.size > 0 && !a.allowSrc.has(srcAddr)) {
      return {
        allowed: false,
        reason: `[address] allow-src tidak memuat "${packet.srcAddress}"`,
      };
    }
    if (!a.allowDstAny && a.allowDst.size > 0 && !a.allowDst.has(dstAddr)) {
      return {
        allowed: false,
        reason: `[address] allow-dst tidak memuat "${packet.dstAddress}"`,
      };
    }

    // ── 3. [port] deny ──
    if (p.denySrcAny) {
      return { allowed: false, reason: `[port] deny-src = "*"` };
    }
    if (p.denySrc.has(srcPort)) {
      return { allowed: false, reason: `[port] deny-src memuat ${srcPort}` };
    }
    if (p.denyDstAny) {
      return { allowed: false, reason: `[port] deny-dst = "*"` };
    }
    if (p.denyDst.has(dstPort)) {
      return { allowed: false, reason: `[port] deny-dst memuat ${dstPort}` };
    }

    // ── 4. [port] allow ──
    if (!p.allowSrcAny && p.allowSrc.size > 0 && !p.allowSrc.has(srcPort)) {
      return { allowed: false, reason: `[port] allow-src tidak memuat ${srcPort}` };
    }
    if (!p.allowDstAny && p.allowDst.size > 0 && !p.allowDst.has(dstPort)) {
      return { allowed: false, reason: `[port] allow-dst tidak memuat ${dstPort}` };
    }

    return { allowed: true, reason: "lolos semua aturan" };
  }

  /** Ringkasan aturan untuk CLI (`forward --fw`) dan banner start. */
  public describe(): string[] {
    const a = this.address;
    const p = this.port;
    const list = (any: boolean, set: Set<string | number>) =>
      any ? "*" : set.size === 0 ? "-" : [...set].join(", ");

    return [
      `Firewall : ${this.path}`,
      `Status   : ${this.active ? "AKTIF" : "non-aktif (tidak ada aturan)"}`,
      `[address]`,
      `  allow     : ${list(a.allowAny, a.allow)}   (dua arah)`,
      `  deny      : ${list(a.denyAny, a.deny)}   (dua arah)`,
      `  allow-src : ${list(a.allowSrcAny, a.allowSrc)}`,
      `  allow-dst : ${list(a.allowDstAny, a.allowDst)}`,
      `  deny-src  : ${list(a.denySrcAny, a.denySrc)}`,
      `  deny-dst  : ${list(a.denyDstAny, a.denyDst)}`,
      `[port]`,
      `  allow-dst : ${list(p.allowDstAny, p.allowDst)}`,
      `  allow-src : ${list(p.allowSrcAny, p.allowSrc)}`,
      `  deny-dst  : ${list(p.denyDstAny, p.denyDst)}`,
      `  deny-src  : ${list(p.denySrcAny, p.denySrc)}`,
    ];
  }

  /** Ringkasan satu baris (dipakai log & monitor forwarder). */
  public summary(): string {
    const parts: string[] = [];
    const a = this.address;
    const p = this.port;

    if (a.denyAny || a.deny.size > 0) {
      parts.push(`deny=${a.denyAny ? "*" : [...a.deny].join(",")}`);
    }
    if (!a.allowAny && a.allow.size > 0) {
      parts.push(`allow=${[...a.allow].join(",")}`);
    }
    if (a.denySrcAny || a.denySrc.size > 0) {
      parts.push(`addr-deny-src=${a.denySrcAny ? "*" : [...a.denySrc].join(",")}`);
    }
    if (a.denyDstAny || a.denyDst.size > 0) {
      parts.push(`addr-deny-dst=${a.denyDstAny ? "*" : [...a.denyDst].join(",")}`);
    }
    if (!a.allowSrcAny && a.allowSrc.size > 0) {
      parts.push(`addr-allow-src=${[...a.allowSrc].join(",")}`);
    }
    if (!a.allowDstAny && a.allowDst.size > 0) {
      parts.push(`addr-allow-dst=${[...a.allowDst].join(",")}`);
    }
    if (p.denySrcAny || p.denySrc.size > 0) {
      parts.push(`deny-src=${p.denySrcAny ? "*" : [...p.denySrc].join(",")}`);
    }
    if (p.denyDstAny || p.denyDst.size > 0) {
      parts.push(`deny-dst=${p.denyDstAny ? "*" : [...p.denyDst].join(",")}`);
    }
    if (!p.allowSrcAny && p.allowSrc.size > 0) {
      parts.push(`allow-src=${[...p.allowSrc].join(",")}`);
    }
    if (!p.allowDstAny && p.allowDst.size > 0) {
      parts.push(`allow-dst=${[...p.allowDst].join(",")}`);
    }

    return parts.length === 0 ? "(tanpa aturan)" : parts.join(" ");
  }
}

/** Pembacaan VFS lewat Application (dipisah agar mudah dimock di uji). */
async function readVfsFile(path: string): Promise<string | null> {
  const { fs } = await import("@tsix/Application");
  const content = await fs.readFile(path);
  return content ?? null;
}

export default Firewall;
