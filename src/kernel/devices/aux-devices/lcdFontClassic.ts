/**
 * lcdFontClassic.ts — font 5x8 KLASIK untuk PSEUDO-LCD (/dev/plcd)
 *
 * ⚠️  FILE INI DI-GENERATE — JANGAN DIEDIT MANUAL.
 *     Sumber: header C di repo addon, jadi byte-nya SAMA dengan yang dipakai
 *     panel fisik. Regenerate: `node scripts/gen-lcd-fonts.mjs`.
 *
 * Ini BUKAN font Adafruit_GFX (untuk itu lihat `lcdFonts.ts`), melainkan font
 * bitmap "klasik" — 5 byte KOLOM per glyph, sel 6x8 px — yaitu bentuk yang
 * dipakai jalur `setFont(0)` di Adafruit_GFX:
 *
 *   id 0 — `glcdfont.c` : font bawaan Adafruit_GFX. Inilah glyph yang tampil
 *          di panel fisik saat addon memakai `setFont(0)`/`setFont(NULL)`.
 *
 * ── Orientasi bit ──
 * Adafruit memakai byte glcdfont APA ADANYA (bit0 = baris paling atas), sama
 * dengan `_displayBuffer[page*128+x] |= 1 << (y%8)` di addon — jadi TIDAK ada
 * pembalikan bit di sini (beda dari font sample pabrik `defaultFont.h` yang
 * disimpan MSB-atas dan di-`reverse()` oleh driver pabrik).
 *
 * CATATAN: `ori-from-lcd-factory/defaultFont.h` ternyata adalah font yang sama
 * dengan glcdfont ini (255 glyph, urutan bit terbalik; 7 glyph beda ±1 px di
 * rentang Latin-1/block). Karena itu tidak ada entri font pabrik terpisah.
 *
 * (c) 2026 TSIX Project
 */

/** Satu font 5x8 klasik (bitmap byte-kolom, sel 6x8). */
export interface LcdClassicFont {
  /** Nama font (dipakai `GET_INFO.fontName`). */
  name: string;
  /** File sumber di repo addon (jejak asal data). */
  source: string;
  /** Lebar glyph dalam kolom. */
  glyphW: number;
  /** Tinggi sel dalam baris (termasuk baris descender). */
  cellH: number;
  /** Jarak maju cursor per karakter. */
  advance: number;
  /** Tinggi baris teks. */
  lineHeight: number;
  /** Jumlah glyph di tabel (index = kode karakter 0..glyphCount-1). */
  glyphCount: number;
  /** Bitmap 5 byte kolom per glyph, urut kode karakter (base64). */
  bitmaps: string;
}

/** Font 5x8 klasik per id (0 = glcdfont bawaan Adafruit_GFX). */
export const LCD_CLASSIC_FONTS: Record<number, LcdClassicFont> = {
  0: {
    name: "glcdfont 5x7 (Adafruit)",
    source: "raspi-lcd-addon/src/glcdfont.c",
    glyphW: 5,
    cellH: 8,
    advance: 6,
    lineHeight: 8,
    glyphCount: 256,
    // 256 glyph × 5 byte kolom (base64) — dari glcdfont.c
    bitmaps:
      "AAAAAAA+W09bPj5rT2s+HD58PhwYPH48GBxXfVccHF5/XhwAGDwYAP/nw+f/ABgkGAD/59vn/zBIOgYOJil5KSZAfwUFB0B/BSU/WjznPFp/PhwcCAgcHD5/FCJ/IhRfXwBfXwYJfwF/AGaJlWpgYGBgYJSi/6KUCAR+BAgQIH4gEAgIKhwICBwqCAgeEBAQEAweDB4MMDg+ODAGDj4OBgAAAAAAAABfAAAABwAHABR/FH8UJCp/KhIjEwhkYjZJViBQAAgHAwAAHCJBAABBIhwAKhx/HCoICD4ICACAcDAACAgICAgAAGBgACAQCAQCPlFJRT4AQn9AAHJJSUlGIUFJTTMYFBJ/ECdFRUU5PEpJSTFBIREJBzZJSUk2RklJKR4AABQAAABANAAAAAgUIkEUFBQUFABBIhQIAgFZCQY+QV1ZTnwSERJ8f0lJSTY+QUFBIn9BQUE+f0lJSUF/CQkJAT5BQVFzfwgICH8AQX9BACBAQT8BfwgUIkF/QEBAQH8CHAJ/fwQIEH8+QUFBPn8JCQkGPkFRIV5/CRkpRiZJSUkyAwF/AQM/QEBAPx8gQCAfP0A4QD9jFAgUYwMEeAQDYVlJTUMAf0FBQQIECBAgAEFBQX8EAgECBEBAQEBAAAMHCAAgVFR4QH8oREQ4OERERCg4REQofzhUVFQYAAh+CQIYpKSceH8IBAR4AER9QAAgQEA9AH8QKEQAAEF/QAB8BHgEeHwIBAR4OERERDj8GCQkGBgkJBj8fAgEBAhIVFRUJAQEP0QkPEBAIHwcIEAgHDxAMEA8RCgQKERMkJCQfERkVExEAAg2QQAAAHcAAABBNggAAgECBAI8JiMmPB6hoWESOkBAIHo4VFRVWSFVVXlBIlRUeEIhVVR4QCBUVXlADB5SchI5VVVVWTlUVFRZOVVUVFgAAEV8QQACRX1CAAFFfEB9EhESffAoJSjwfFRVRQAgVFR8VHwKCX9JMklJSTI6REREOjJKSEgwOkFBIXo6QkAgeACdoKB9PUJCQj09QEBAPTwk/yQkSH5JQ2YrL/wvK/8JKfYgwIh+CQMgVFR5QQAARH1BMEhISjI4QEAiegB6CgpyfQ0ZMX0mKSkvKCYpKSkmMEhNQCA4CAgICAgICAg4LxDIrLovECg0+gAAewAACBQqFCIiFCoUCFUAVQBVqlWqVar/Vf9V/wAAAP8AEBAQ/wAUFBT/ABAQ/wD/EBDwEPAUFBT8ABQU9wD/AAD/AP8UFPQE/BQUFxAfEBAfEB8UFBQfABAQEPAAAAAAHxAQEBAfEBAQEPAQAAAA/xAQEBAQEBAQEP8QAAAA/xQAAP8A/wAAHxAXAAD8BPQUFBcQFxQU9AT0AAD/APcUFBQUFBQU9wD3FBQUFxQQEB8QHxQUFPQUEBDwEPAAAB8QHwAAAB8UAAAA/BQAAPAQ8BAQ/xD/FBQU/xQQEBAfAAAAAPAQ///////w8PDw8P///wAAAAAA//8PDw8PDzhERDhE/EpKSjR+AgIGBgJ+An4CY1VJQWM4REQ8BEB+IB4gBgJ+AgKZpeelmRwqSSocTHIBckwwSk1NMDBIeEgwvGJaRj0+SUlJAH4BAQF+KioqKipERF9EREBRSkRAQERKUUAAAP8BA+CA/wAACAhrawg2EjYkNgYPCQ8GAAAYGAAAABAQADBA/wEBAB8BAR4AGR0XEgA8PDw8AAAAAAA=",
  },
};
