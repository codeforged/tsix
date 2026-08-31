/**
 * ISECURITYAGENT — Kontrak agent enkripsi MQTNL (Jalur A)
 *
 * Kontrak ini adalah SATU-SATUNYA yang dipakai SimpleMQTNLDriver di jalur
 * RX/TX (`portSecurity`). Dengan interface ini, driver tidak lagi meng-hardcode
 * `new SecurityAgent()` — aplikasi/system bisa mendaftarkan agent enkripsi
 * kustom via `SimpleMQTNLDriver.registerAgent(name, factory)` lalu memilihnya
 * lewat ioctl UPGRADE_SECURITY (`agent` field) / `NetSocket.upgradeSecurity(key, { agent })`.
 *
 * Catatan kompatibilitas:
 *  - Signature harus PERSIS seperti SecurityAgent asli supaya jalur RX/TX
 *    (yang sudah stabil) tetap bekerja tanpa perubahan.
 *  - `securePacketInRaw` saat ini mengembalikan `string` — agent biner yang
 *    ingin mengembalikan Buffer perlu ditangani terpisah (belum didukung).
 *
 * (c) 2026 TSIX Project
 */
export interface ISecurityAgent {
  /** True kalau session key sudah dipasang (dipakai driver utk auto-decrypt). */
  hasSessionKey(): boolean;

  /** Pasang session key (Buffer 32-byte atau string hex 64 karakter). */
  setSessionKey(key: Buffer | string): void;

  /** Enkripsi data → string HEX (dipakai driver saat TX). */
  securePacketOut(data: string | Buffer): string;

  /**
   * Enkripsi data → Buffer mentah (opsional). Dipakai protocol biner
   * terenkripsi (mis. "Binfeo") saat TX supaya byte >= 0x80 tidak rusak.
   * Tanpa session key → passthrough (plain).
   */
  securePacketOutRaw?(data: string | Buffer): Buffer | string;

  /** Dekripsi string HEX → string (dipakai driver saat RX, jalur JSON). */
  securePacketIn(data: string): string;

  /** Dekripsi Buffer mentah → string (dipakai driver saat RX, jalur biner). */
  securePacketInRaw(data: Buffer): string;

  /**
   * Dekripsi Buffer mentah → Buffer utuh (opsional). Dipakai protocol biner
   * terenkripsi (mis. "Binfeo") supaya byte >= 0x80 TIDAK rusak oleh konversi
   * utf8. Return null kalau gagal / data rusak.
   */
  securePacketInRawBuffer?(data: Buffer): Buffer | null;
}
