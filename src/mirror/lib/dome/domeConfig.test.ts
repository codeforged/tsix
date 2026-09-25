import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConfigParser } from "../ConfigParser";
import {
  DOME_CONFIG_DIR,
  DOME_CONFIG_PATH,
  DOME_DEFAULT_PORT,
  DOME_LEGACY_CONFIG_PATH,
  formatDomeConfig,
  loadDomeConfig,
  toPort,
} from "./domeConfig";

/**
 * DOME CONFIG (C11.80+) — port dari `/etc/dome/dome.conf`.
 *
 * Semua uji memakai VFS palsu in-memory (I/O disuntik), jadi TIDAK butuh kernel /
 * `global._tsixLib`: yang diuji adalah keputusannya — berkas mana yang dibuat,
 * port mana yang dipakai, dan apa yang dilaporkan ke pemanggil.
 *
 * Yang dijaga di sini:
 *   - C11.80: berkas belum ada → dibuat sendiri (isi = template, port 8080);
 *   - C11.81/C11.84: nilai sah dihormati (termasuk bentuk berkutip `"9090"`);
 *   - C11.82/C11.83: nilai tidak sah / key hilang → default + peringatan,
 *     bukan `listen()` dengan port ajaib;
 *   - C11.85: migrasi sekali-jalan dari `dome.json` (berkas lama TIDAK dihapus);
 *   - C11.86/C11.87: gagal menulis / gagal membaca TIDAK menimpa berkas admin;
 *   - C11.88/C11.89: template = salinan di repo (biar tidak menyimpang).
 */

/** fakeIo(): VFS palsu in-memory — cukup untuk menguji keputusan loader. */
function fakeIo(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();
  const writes: string[] = [];

  return {
    files,
    dirs,
    writes,
    stat: async (path: string) => (files.has(path) ? { type: "FILE" } : null),
    read: async (path: string) => files.get(path) ?? null,
    write: async (path: string, content: string) => {
      files.set(path, content);
      writes.push(path);
      return true;
    },
    mkdir: async (path: string) => {
      dirs.add(path);
      return true;
    },
  };
}

describe("domeConfig (C11.80+)", () => {
  it("C11.80 berkas belum ada → dibuat otomatis dengan port 8080", async () => {
    const io = fakeIo();

    const result = await loadDomeConfig(io);

    expect(result.port).toBe(DOME_DEFAULT_PORT);
    expect(result.created).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(io.dirs.has(DOME_CONFIG_DIR)).toBe(true); // folder disiapkan lebih dulu
    expect(io.writes).toEqual([DOME_CONFIG_PATH]);
    expect(io.files.get(DOME_CONFIG_PATH)).toBe(formatDomeConfig());

    // Isi yang dibuat harus benar-benar terbaca parser yang sama dengan runtime.
    const parser = new ConfigParser(DOME_CONFIG_PATH, { reader: io.read });
    expect(await parser.load()).toBe(true);
    expect(parser.getStats().warnings).toEqual([]);
    expect(parser.get("dome", "port")).toBe(DOME_DEFAULT_PORT);
  });

  it("C11.81 berkas ada → port dari berkas dipakai dan berkas TIDAK ditulis", async () => {
    const io = fakeIo({
      [DOME_CONFIG_PATH]: "[dome]\nport = 9090\n",
    });

    const result = await loadDomeConfig(io);

    expect(result.port).toBe(9090);
    expect(result.created).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(io.writes).toEqual([]);
  });

  it("C11.82 port tidak sah → port default + peringatan", async () => {
    for (const [teks, isi] of [
      ["di luar rentang", "70000"],
      ["nol", "0"],
      ["bukan angka", "delapan"],
    ] as const) {
      const io = fakeIo({ [DOME_CONFIG_PATH]: `[dome]\nport = ${isi}\n` });

      const result = await loadDomeConfig(io);

      expect(result.port, teks).toBe(DOME_DEFAULT_PORT);
      expect(result.warnings.join(" "), teks).toContain("invalid port");
      expect(io.writes, teks).toEqual([]); // berkas sah → tidak ditimpa
    }
  });

  it("C11.83 key port hilang (atau section lain) → default + peringatan", async () => {
    const io = fakeIo({ [DOME_CONFIG_PATH]: "[dome]\nverbose = true\n" });

    const result = await loadDomeConfig(io);

    expect(result.port).toBe(DOME_DEFAULT_PORT);
    expect(result.warnings.join(" ")).toContain("missing 'port'");
  });

  it("C11.84 nilai berkutip tetap dimengerti (string numerik)", async () => {
    const io = fakeIo({ [DOME_CONFIG_PATH]: '[dome]\nport = "9090"\n' });

    const result = await loadDomeConfig(io);

    expect(result.port).toBe(9090);
    expect(result.warnings).toEqual([]);
  });

  it("C11.85 migrasi sekali-jalan dari dome.json (berkas lama tidak dihapus)", async () => {
    const io = fakeIo({
      [DOME_LEGACY_CONFIG_PATH]: '{ "port": 9090 }',
    });

    const result = await loadDomeConfig(io);

    expect(result.created).toBe(true);
    expect(result.port).toBe(9090); // port lama tidak hilang saat ganti nama berkas
    expect(result.warnings.join(" ")).toContain("migrated port 9090");
    expect(io.files.get(DOME_CONFIG_PATH)).toBe(formatDomeConfig(9090));
    expect(io.files.has(DOME_LEGACY_CONFIG_PATH)).toBe(true); // milik admin
  });

  it("C11.86 gagal membuat berkas → tetap jalan dengan port default", async () => {
    const io = fakeIo();
    const failing = {
      ...io,
      mkdir: async () => {
        throw new Error("read-only filesystem");
      },
    };

    const result = await loadDomeConfig(failing);

    expect(result.port).toBe(DOME_DEFAULT_PORT);
    expect(result.created).toBe(false);
    expect(result.warnings.join(" ")).toContain("cannot create");
  });

  it("C11.86b writeFile mengembalikan false → dilaporkan gagal (bukan 'created')", async () => {
    const io = fakeIo();
    const refusing = {
      ...io,
      write: async () => false, // VFS: OPEN "w" ditolak → writeFile = false
    };

    const result = await loadDomeConfig(refusing);

    expect(result.created).toBe(false);
    expect(result.port).toBe(DOME_DEFAULT_PORT);
    expect(result.warnings.join(" ")).toContain("writeFile returned false");
  });

  it("C11.87 berkas ada tapi tidak terbaca → TIDAK ditimpa, pakai default", async () => {
    const io = fakeIo({ [DOME_CONFIG_PATH]: "[dome]\nport = 9090\n" });
    const unreadable = {
      ...io,
      read: async () => null, // mis. izin ditolak / isi rusak
    };

    const result = await loadDomeConfig(unreadable);

    expect(result.port).toBe(DOME_DEFAULT_PORT);
    expect(result.warnings.join(" ")).toContain("cannot read");
    expect(io.files.get(DOME_CONFIG_PATH)).toBe("[dome]\nport = 9090\n");
    expect(io.writes).toEqual([]);
  });

  it("C11.88 template tetap di-parse parser yang sama tanpa peringatan", async () => {
    const parser = new ConfigParser(DOME_CONFIG_PATH, {
      reader: async () => formatDomeConfig(9090),
    });
    expect(await parser.load()).toBe(true);
    expect(parser.getStats().warnings).toEqual([]);
    expect(parser.get("dome", "port")).toBe(9090);
  });

  it("C11.89 salinan di repo = template (tidak menyimpang)", () => {
    const mirrorPath = fileURLToPath(
      new URL("../../etc/dome/dome.conf", import.meta.url),
    );
    expect(readFileSync(mirrorPath, "utf8")).toBe(formatDomeConfig());
  });

  it("C11.89b toPort() hanya menerima port yang sah", () => {
    expect(toPort(8080)).toBe(8080);
    expect(toPort("9090")).toBe(9090);
    expect(toPort(" 9090 ")).toBe(9090);
    expect(toPort(0)).toBeNull();
    expect(toPort(65536)).toBeNull();
    expect(toPort(8080.5)).toBeNull();
    expect(toPort(true)).toBeNull();
    expect(toPort(undefined)).toBeNull();
  });
});
