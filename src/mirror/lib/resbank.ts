/**
 * ResourceBank — bank sumber daya aplikasi (TGA) → browser.
 *
 * Memuat resource (audio, texture/gambar, teks cerita, data model/JSON, binary)
 * dari VFS dan mengirimnya SEKALI ke browser via DOME (RES_LOAD). Browser
 * menyimpan di cache per-window (`window._tsixResBank["<wid>:<key>"]`), lalu
 * NJ/client tinggal konsumsi via `resBank.getResource(key)` — tanpa bolak-balik
 * server ↔ client untuk data yang sama.
 *
 * Pola ini menggantikan kirim data besar berulang (mis. audio tiap diputar).
 *
 * Contoh (sisi TGA):
 *   const res = new ResourceBank({ wid: screen.wid, domeUuid: DOME_UUID });
 *   res.register("laser",   "/opt/game/sfx/laser.mp3",  "sfx");
 *   res.register("player",  "/opt/game/tex/player.png", "image", { mime: "image/png" });
 *   res.register("story",   "/opt/game/text/story.txt", "text");
 *   res.register("levels",  "/opt/game/data/levels.json","json");
 *   await res.loadAll();
 *
 * Sisi NJ (browser): ctx.resBank.getResource("player") → Image, dst.
 */

import { fs, shell } from "@tsix/Application";

export type ResType = "sfx" | "image" | "text" | "json" | "bin";

export interface ResItem {
  path: string;
  type: ResType;
  /** Untuk image: "image/png" dst (default "image/png") */
  mime?: string;
}

export class ResourceBank {
  private domeUuid: string;
  private wid: string;
  private items: Map<string, ResItem> = new Map();
  private done: Set<string> = new Set();
  /** Cache hasil baca di sisi server (untuk app yang juga butuh datanya) */
  private raw: Map<string, any> = new Map();

  constructor(opts: { wid: string; domeUuid: string }) {
    this.wid = opts.wid;
    this.domeUuid = opts.domeUuid;
  }

  /** Daftarkan resource: key unik, path VFS, tipe. */
  register(key: string, path: string, type: ResType, opts?: { mime?: string }) {
    this.items.set(key, { path, type, mime: opts?.mime });
  }

  /** Baca file VFS → ubah sesuai tipe → kirim RES_LOAD ke browser (sekali). */
  async load(key: string): Promise<void> {
    const item = this.items.get(key);
    if (!item || this.done.has(key)) return;
    try {
      const raw = await fs.readFile(item.path);
      if (raw == null) return;
      let data: string;
      if (item.type === "text" || item.type === "json") {
        data = raw;
      } else {
        data = Buffer.from(raw, "latin1").toString("base64");
      }
      // Cache server side (untuk app yang mau akses langsung)
      if (item.type === "json") {
        try { this.raw.set(key, JSON.parse(raw)); } catch (_) {}
      } else {
        this.raw.set(key, item.type === "text" ? raw : data);
      }
      await shell
        .send(this.domeUuid, {
          type: "RES_LOAD",
          wid: this.wid,
          key,
          resType: item.type,
          mime: item.mime,
          data,
        })
        .catch(() => {});
      this.done.add(key);
    } catch (_) {
      /* file tidak ada / rusak — skip */
    }
  }

  /** Muat & kirim semua resource terdaftar. */
  async loadAll(): Promise<void> {
    await Promise.all([...this.items.keys()].map((k) => this.load(k)));
  }

  /** Sudahkah resource dikirim ke browser? */
  isLoaded(key: string): boolean {
    return this.done.has(key);
  }

  /** Ambil resource di sisi server (hasil baca). text→string, json→object,
   *  binary→base64. */
  get(key: string): any {
    return this.raw.get(key);
  }
}
