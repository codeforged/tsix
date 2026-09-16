#!/usr/bin/env node
/**
 * gen-lcd-fonts.mjs — konversi font Adafruit_GFX (.h dari addon lm6029acw)
 * menjadi modul TypeScript untuk PSEUDO-LCD (`/dev/plcd`).
 *
 * ── KENAPA GENERATOR, BUKAN SALIN MANUAL ──
 * Data glyph hanya boleh hidup di SATU tempat: header font milik addon
 * (`raspi-lcd-addon/src/Fonts/*.h`). Skrip ini membaca header itu dan menulis
 * `src/kernel/devices/aux-devices/lcdFonts.ts` — jadi kalau font di addon
 * diperbarui/ditambah, cukup jalankan ulang skrip ini; tidak ada risiko data
 * ganda yang saling menyimpang.
 *
 * ── CARA PAKAI ──
 *   node scripts/gen-lcd-fonts.mjs
 *   node scripts/gen-lcd-fonts.mjs --fonts-dir=/path/ke/Fonts
 *   LCD_FONTS_DIR=/path/ke/Fonts node scripts/gen-lcd-fonts.mjs
 *
 * Font yang dikonversi (id-nya sama dengan `setFont(id)` di driver):
 *   1 = FreeSans9pt7b, 2 = FreeSansBold12pt7b, 3 = FreeMono9pt7b
 *
 * Format GFXfont (tidak berubah sejak Adafruit_GFX 1.x):
 *   - `Bitmaps[]`          : 1 bpp MSB-first yang dibaca KONTINU oleh
 *                            Adafruit_GFX — satu byte untuk 8 piksel
 *                            berikutnya, TANPA padding per baris → kebutuhan
 *                            byte satu glyph = `ceil(width*height/8)`.
 *   - `Glyphs[]` (GFXglyph): { bitmapOffset, width, height, xAdvance,
 *                            xOffset (int8), yOffset (int8) }.
 *   - `GFXfont`            : { Bitmaps, Glyphs, first, last, yAdvance }.
 * Digambar pada `(cursor_x + xOffset, cursor_y + yOffset)` — di mana `cursor_y`
 * adalah BASELINE (beda dari font 5x7 bawaan yang memakai sudut kiri-atas).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

/** id font → nama file header di addon (id 0 = font 5x7 bawaan driver). */
const FONTS = [
  { id: 1, name: "FreeSans9pt7b", file: "FreeSans9pt7b.h" },
  { id: 2, name: "FreeSansBold12pt7b", file: "FreeSansBold12pt7b.h" },
  { id: 3, name: "FreeMono9pt7b", file: "FreeMono9pt7b.h" },
];

const OUT_FILE = path.join(
  REPO,
  "src/kernel/devices/aux-devices/lcdFonts.ts",
);

/** Cari folder header font: argumen → env → sibling repo (default dev). */
function resolveFontsDir() {
  const arg = process.argv.find((a) => a.startsWith("--fonts-dir="));
  if (arg) return path.resolve(arg.slice("--fonts-dir=".length));
  if (process.env.LCD_FONTS_DIR) return path.resolve(process.env.LCD_FONTS_DIR);
  return path.resolve(REPO, "..", "raspi-lcd-addon", "src", "Fonts");
}

/** Ambil blok `const <type> <Name>[] PROGMEM = { … };` (tanpa parsing C penuh). */
function blockOf(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker tidak ditemukan: ${marker}`);
  return src.slice(start, start + 40000);
}

function parseFont(src, name) {
  // ── Bitmaps ──
  const bmBlock = blockOf(src, `uint8_t ${name}Bitmaps[] PROGMEM`);
  const bmEnd = bmBlock.indexOf("};");
  const bmHex = bmBlock.slice(0, bmEnd === -1 ? bmBlock.length : bmEnd);
  const bytes = [...bmHex.matchAll(/0x([0-9A-Fa-f]{1,2})/g)].map((m) =>
    parseInt(m[1], 16),
  );
  if (!bytes.length) throw new Error(`${name}: bitmaps kosong`);

  // ── Glyphs ──
  const glBlock = blockOf(src, `GFXglyph ${name}Glyphs[] PROGMEM`);
  const glyphs = [
    ...glBlock.matchAll(
      /\{\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\}/g,
    ),
  ].map((m) => m.slice(1, 7).map(Number));
  if (!glyphs.length) throw new Error(`${name}: glyphs kosong`);

  // ── Header GFXfont: first, last, yAdvance ──
  const fontBlock = blockOf(src, `GFXfont ${name} PROGMEM`);
  const m = /0x([0-9A-Fa-f]+)\s*,\s*0x([0-9A-Fa-f]+)\s*,\s*(\d+)\s*\}/.exec(
    fontBlock,
  );
  if (!m) throw new Error(`${name}: header GFXfont tidak terbaca`);
  const first = parseInt(m[1], 16);
  const last = parseInt(m[2], 16);
  const yAdvance = Number(m[3]);

  const expected = last - first + 1;
  if (glyphs.length !== expected) {
    throw new Error(
      `${name}: jumlah glyph ${glyphs.length} != rentang 0x${first.toString(16)}..0x${last.toString(16)} (${expected})`,
    );
  }

  // ── Validasi offset bitmap ──
  //
  // PENTING: Adafruit_GFX membaca bitmap glyph secara KONTINU — satu byte
  // dipakai untuk 8 piksel berikutnya, TANPA padding per baris (lihat loop
  // `if (!(bit++ & 7)) bits = pgm_read_byte(&bitmap[bo++])` di
  // Adafruit_GFX::write). Jadi kebutuhan byte satu glyph = ceil(w*h/8),
  // bukan height * ceil(width/8).
  let lastEnd = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const [offset, w, h] = glyphs[i];
    const need = Math.ceil((w * h) / 8);
    if (offset < lastEnd) {
      throw new Error(
        `${name}: glyph #${i} (0x${(first + i).toString(16)}) offset ${offset} < akhir glyph sebelumnya ${lastEnd} (data tumpang tindih?)`,
      );
    }
    if (offset + need > bytes.length) {
      throw new Error(
        `${name}: glyph #${i} (0x${(first + i).toString(16)}) butuh byte sampai ${offset + need}, bitmaps cuma ${bytes.length}`,
      );
    }
    lastEnd = offset + need;
  }

  return {
    name,
    first,
    last,
    yAdvance,
    bytes,
    glyphs,
    bitmapUsed: lastEnd,
  };
}

/** Tulis array angka rapi (beberapa baris) supaya diff-nya enak dibaca. */
function formatGlyphs(glyphs) {
  const lines = [];
  let line = "    ";
  for (const g of glyphs) {
    const item = `[${g.join(",")}], `;
    if (line.length + item.length > 96) {
      lines.push(line.trimEnd());
      line = "    ";
    }
    line += item;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join("\n");
}

function main() {
  const dir = resolveFontsDir();
  if (!fs.existsSync(dir)) {
    console.error(
      `[gen-lcd-fonts] folder font tidak ada: ${dir}\n` +
        `  Pakai --fonts-dir=<path> atau env LCD_FONTS_DIR kalau repo addon\n` +
        `  (raspi-lcd-addon) tidak berada di sebelah repo TSIX.`,
    );
    process.exit(1);
  }

  const parsed = FONTS.map((f) => {
    const file = path.join(dir, f.file);
    if (!fs.existsSync(file)) {
      console.error(`[gen-lcd-fonts] header tidak ada: ${file}`);
      process.exit(1);
    }
    const font = parseFont(fs.readFileSync(file, "utf8"), f.name);
    console.log(
      `  id ${f.id} ${f.name.padEnd(20)} glyphs ${String(font.glyphs.length).padStart(3)}` +
        ` · bitmaps ${String(font.bytes.length).padStart(5)} byte` +
        ` (terpakai ${font.bitmapUsed})` +
        ` · range 0x${font.first.toString(16)}..0x${font.last.toString(16)}` +
        ` · yAdvance ${font.yAdvance}`,
    );
    return { id: f.id, ...font };
  });

  const entries = parsed
    .map((f) => {
      const b64 = Buffer.from(Uint8Array.from(f.bytes)).toString("base64");
      return [
        `  ${f.id}: {`,
        `    name: ${JSON.stringify(f.name)},`,
        `    first: 0x${f.first.toString(16)},`,
        `    last: 0x${f.last.toString(16)},`,
        `    yAdvance: ${f.yAdvance},`,
        `    // 1 bpp MSB-first row-major (base64) — langsung dari ${f.name}Bitmaps[]`,
        `    bitmaps:`,
        `      ${JSON.stringify(b64)},`,
        `    // [bitmapOffset, width, height, xAdvance, xOffset, yOffset]`,
        `    glyphs: [`,
        formatGlyphs(f.glyphs),
        `    ],`,
        `  },`,
      ].join("\n");
    })
    .join("\n");

  const out = `/**
 * lcdFonts.ts — font Adafruit_GFX untuk PSEUDO-LCD (/dev/plcd)
 *
 * ⚠️  FILE INI DI-GENERATE — JANGAN DIEDIT MANUAL.
 *     Sumber: \`raspi-lcd-addon/src/Fonts/*.h\` (data yang sama dengan yang
 *     dipakai addon native, sehingga teks di /dev/plcd tampil glyph-per-glyph
 *     sama seperti di panel hardware).
 *     Regenerate: \`node scripts/gen-lcd-fonts.mjs\`
 *     Folder lain: \`--fonts-dir=/path/ke/Fonts\` atau env \`LCD_FONTS_DIR\`.
 *
 * Kunci = id font yang dikenali \`setFont(id)\` (0 = font 5x7 bawaan
 * \`plcdFont5x7.ts\`, jadi tidak ada di tabel ini).
 *
 * Format glyph mengikuti Adafruit_GFX:
 *   - \`bitmaps\`: 1 bpp MSB-first, baris demi baris, per glyph
 *     \`height\` baris × \`ceil(width/8)\` byte.
 *   - \`glyphs\`: [bitmapOffset, width, height, xAdvance, xOffset, yOffset].
 *   - Digambar di \`(cursor_x + xOffset, cursor_y + yOffset)\` dengan
 *     \`cursor_y\` = BASELINE (beda dari font 5x7 yang pakai sudut kiri-atas),
 *     dan baris baru menambah \`cursor_y\` sebesar \`yAdvance\`.
 *
 * (c) 2026 TSIX Project
 */

/** Satu glyph Adafruit_GFX: [bitmapOffset, width, height, xAdvance, xOffset, yOffset]. */
export type LcdGfxGlyphTuple = [
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Satu font Adafruit_GFX siap-raster (data mentah dari header C). */
export interface LcdGfxFont {
  /** Nama font di addon, mis. "FreeMono9pt7b". */
  name: string;
  /** Karakter pertama yang ada di tabel. */
  first: number;
  /** Karakter terakhir yang ada di tabel. */
  last: number;
  /** Tinggi baris (baseline ke baseline). */
  yAdvance: number;
  /** Bitmap 1 bpp MSB-first row-major, base64. */
  bitmaps: string;
  /** Tabel glyph, index = kode karakter - \`first\`. */
  glyphs: LcdGfxGlyphTuple[];
}

/** Font per id (id 0 = font 5x7 bawaan, lihat \`plcdFont5x7.ts\`). */
export const LCD_GFX_FONTS: Record<number, LcdGfxFont> = {
${entries}
};

/** Nama font untuk log/CLI (termasuk id 0 yang bukan GFX). */
export const LCD_GFX_FONT_NAMES: Record<number, string> = {
  0: "default 5x7",
${parsed.map((f) => `  ${f.id}: ${JSON.stringify(f.name)},`).join("\n")}
};
`;

  fs.writeFileSync(OUT_FILE, out);
  const kb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
  console.log(`[gen-lcd-fonts] ${path.relative(REPO, OUT_FILE)} (${kb} KB)`);
}

main();
