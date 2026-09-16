/**
 * plcdFont5x7.ts — glyph EKSTENSI untuk PSEUDO LCD (/dev/plcd)
 *
 * Font utama driver `PLCDDevice` BUKAN file ini: karakter 0x00..0xFF diambil
 * byte-per-byte dari data font asli (`lcdFontClassic.ts` ← `glcdfont.c` addon),
 * sehingga rasternya sama dengan yang tampil di panel fisik.
 *
 * File ini hanya menyediakan glyph untuk karakter yang TIDAK BISA dialamatkan
 * font hardware — kode di luar 0x00..0xFF, mis. panah U+2192 yang banyak
 * dipakai UI LCD. Karakter yang tidak ada di tabel digambar kotak kosong
 * (placeholder), sama seperti perilaku sebelumnya.
 *
 * ── EDIT GLYPH ──
 * Tiap glyph = 7 baris x 5 kolom, ditulis "rrrrr/rrrrr/rrrrr/rrrrr/rrrrr/rrrrr/rrrrr"
 * ('#' = piksel nyala, '.' = mati). Tinggal tambah/ubah baris di tabel —
 * tidak ada file biner, tidak perlu regenerate apa pun.
 *
 * (c) 2026 TSIX Project
 */

/** Lebar glyph (kolom). */
export const PLCD_FONT_W = 5;
/** Tinggi glyph (baris). */
export const PLCD_FONT_H = 7;
/** Jarak antar-glyph (cell) — 5 px glyph + 1 px gap, sama seperti glcdfont. */
export const PLCD_FONT_ADVANCE = 6;
/** Tinggi satu baris teks (8 px, sama seperti glcdfont). */
export const PLCD_FONT_LINE_HEIGHT = 8;

/**
 * Tabel glyph EKSTENSI — HANYA karakter yang tidak bisa dialamatkan font
 * hardware (kode > 0xFF), mis. panah untuk UI LCD.
 *
 * Karakter 0x00..0xFF sengaja TIDAK ada di sini: itu ditangani data font asli
 * `glcdfont.c` (`lcdFontClassic.ts`) supaya hasilnya identik dengan panel fisik
 * — termasuk "°" (0xB0) yang di hardware dirender sebagai blok shade.
 */
export const PLCD_FONT_EXTRA: Record<string, string> = {
  // ── Panah (dipakai banyak UI LCD) ──
  "→": "...../..#../...#./#####/...#./..#../.....",
  "←": "...../..#../.#.../#####/.#.../..#../.....",
  "↑": "..#../.###./#.#.#/..#../..#../..#../.....",
  "↓": "..#../..#../..#../#.#.#/.###./..#../.....",
};

/**
 * Konversi definisi glyph ("rrrrr/rrrrr/...") jadi 5 byte kolom
 * (bit y = baris y, bit0 = baris paling atas). Dipakai tabel di atas maupun
 * fallback di driver.
 */
export function rowsToGlyph(rows: string): Uint8Array {
  const parts = rows.split("/");
  const out = new Uint8Array(PLCD_FONT_W);
  for (let c = 0; c < PLCD_FONT_W; c++) {
    let bits = 0;
    for (let y = 0; y < PLCD_FONT_H; y++) {
      const row = parts[y];
      if (row && row[c] === "#") bits |= 1 << y;
    }
    out[c] = bits;
  }
  return out;
}

/** Cache glyph yang sudah dikonversi ke kolom (bit0 = baris paling atas). */
const _glyphCache = new Map<string, Uint8Array | null>();

/**
 * Ambil glyph sebagai 5 byte kolom (bit y = baris y, bit0 = paling atas).
 * Return null kalau karakter tidak ada di tabel.
 */
export function plcdGlyph(ch: string): Uint8Array | null {
  const cached = _glyphCache.get(ch);
  if (cached !== undefined) return cached;

  const rows = PLCD_FONT_EXTRA[ch];
  const out = rows ? rowsToGlyph(rows) : null;
  _glyphCache.set(ch, out);
  return out;
}
