/**
 * lcdFonts.ts — font Adafruit_GFX untuk PSEUDO-LCD (/dev/plcd)
 *
 * ⚠️  FILE INI DI-GENERATE — JANGAN DIEDIT MANUAL.
 *     Sumber: `raspi-lcd-addon/src/Fonts/*.h` (data yang sama dengan yang
 *     dipakai addon native, sehingga teks di /dev/plcd tampil glyph-per-glyph
 *     sama seperti di panel hardware).
 *     Regenerate: `node scripts/gen-lcd-fonts.mjs`
 *     Folder lain: `--fonts-dir=/path/ke/Fonts` atau env `LCD_FONTS_DIR`.
 *
 * Kunci = id font yang dikenali `setFont(id)` (0 = font 5x7 bawaan
 * `plcdFont5x7.ts`, jadi tidak ada di tabel ini).
 *
 * Format glyph mengikuti Adafruit_GFX:
 *   - `bitmaps`: 1 bpp MSB-first, baris demi baris, per glyph
 *     `height` baris × `ceil(width/8)` byte.
 *   - `glyphs`: [bitmapOffset, width, height, xAdvance, xOffset, yOffset].
 *   - Digambar di `(cursor_x + xOffset, cursor_y + yOffset)` dengan
 *     `cursor_y` = BASELINE (beda dari font 5x7 yang pakai sudut kiri-atas),
 *     dan baris baru menambah `cursor_y` sebesar `yAdvance`.
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
  /** Tabel glyph, index = kode karakter - `first`. */
  glyphs: LcdGfxGlyphTuple[];
}

/** Font per id (id 0 = font 5x7 bawaan, lihat `plcdFont5x7.ts`). */
export const LCD_GFX_FONTS: Record<number, LcdGfxFont> = {
  1: {
    name: "FreeSans9pt7b",
    first: 0x20,
    last: 0x7e,
    yAdvance: 22,
    // 1 bpp MSB-first row-major (base64) — langsung dari FreeSans9pt7bBitmaps[]
    bitmaps:
      "///4wN73IAmGQZH/EwTDIMj/iYJhkBAfFNo9HoNAeBcI9Ho1M/BAIDgQ7CDGIMZAxkBsgDkAATwCdwJjBGMEdwg8DgZgzBmB4BgPAzbC2HMGMePE/hMmbMzMxGYjEIxGYzMzMmZMgCV+pQAwwz8wwwzW8MAIRCEQhEIRCAA8ZkLDw8PDw8PDQmY8ET8zMzMzMD4xsHgwGBwcHBgYEAgH+Dxmw8MDBhwHA8PDZjwMGHFiyaNG/hgwYMB/IBAICAfzjAMBgPBsY+AeMZh4DAbzjYPB4NBsY+D/AwIGBAwIGBgYEDAwPjGweDwbGPjGweDwbGPgPGbCw8PDZzsDA8JmPMAAMMAAAGSgAIHHjgwHgHAOAYD/gAAf8ABwDgHAGDhxwIAAPjGweDAYGDgYGAwAAAGAA/AGDgYBhgBmHbsxzxjHmGPMMeYRs5nM94YAAYAAcEAP4AYA8A8AkBmBmBCDDD/CBGBmBsAw/xgzA2BsDYM/xgbAeA8B4G/4H4YZgaA8AYAwBgDAaA2DGGHw/xgzA2A8B4DwHgPAeA8DYM/w/+AwGAwGA/2AwGAwGA/4/8DAwMDA/sDAwMDAwA+DDmBmA8AMAMH8A8A2A2BzDw8QwHgPAeA8B4D//gPAeA8B4DwG////wAYMGDBgwYMHjx4ngMDYMwxjDMG4PwcwwxhjBmBsDMDAwMDAwMDAwMDAwP/gPwH8H+D9BexvY3kTzZ5s8UeOPHGA4HwPweg9h5jxHjPDeG8H4HwOD4GDGAzAbAHgDwB4A8AbAZgMYMD4AP8wbA8DwPBv8wDAMAwDAMAAD4GDGAzAbAHgDwB4A8AbAZhsYMD7AAj/jA7AbAbAbAz/jA7AbAbAbAbAcD8YbA8DwB4B8A4A8DwNhj8A/4YDAYDAYDAYDAYDAYDAwHgPAeA8B4DwHgPAeA8BsGHwwGwNgRBjDGEEYMwZAWA8BwBgwYEw4ZhwzChmJiETMMiYbEwUNAoaBwcDA4CBgGBjDDDBmA8A4AYA8BkBmDDGDmBgwDYGMMMMGYHYDwBgBgBgBgBgBgD/wGAwDAYDAcBgMBgGAwD/wPtttttttuCEEIQQhBCEEIDtttttttvgMGCiRNihgP/AxjB+cbDAYPPbDYbHPcDAYDAbzjYPB4PB4PB8beA8ZsPAwMDAw2Y8AwMDO2fDw8PDw8NnOzxmw8P/wMDDZjw2b2ZmZmZgO2fDw8PDw8NnOwMDxnzAwMDe48PDw8PDw8PDw///wDADMzMzMzMz4MBgMBhMRmNh8OxiMZhsMP///8De9xzwx4Y8MeGPDHhjwx4YwN7jw8PDw8PDw8M8ZsPDw8PDw2Y83nGweDweDweD428wGAwAO2fDw8PDw8NnOwMDA98xjGMYxgA+48DA4DwHw+N+ZvZmZmZnw8PDw8PDw8PHe8GgmMxCIbDQKBwMAMYeOJHEymbTFtCmhxw4wMYAQ2I2HBgcPCZiQ8EhmMxCYbDQOBwMBgMBAwD+DDDBhhggwfw2ZmZuzmZmZjD/////wMZmZmc3ZmZmwGEkOA==",
    // [bitmapOffset, width, height, xAdvance, xOffset, yOffset]
    glyphs: [
    [0,0,0,5,0,1], [0,2,13,6,2,-12], [4,5,4,6,1,-12], [7,10,12,10,0,-11], [22,9,16,10,1,-13],
    [40,16,13,16,1,-12], [66,11,13,12,1,-12], [84,2,4,4,1,-12], [85,4,17,6,1,-12],
    [94,4,17,6,1,-12], [103,5,5,7,1,-12], [107,6,8,11,3,-7], [113,2,4,5,2,0], [114,4,1,6,1,-4],
    [115,2,1,5,1,0], [116,5,13,5,0,-12], [125,8,13,10,1,-12], [138,4,13,10,3,-12],
    [145,9,13,10,1,-12], [160,8,13,10,1,-12], [173,7,13,10,2,-12], [185,9,13,10,1,-12],
    [200,9,13,10,1,-12], [215,8,13,10,0,-12], [228,9,13,10,1,-12], [243,8,13,10,1,-12],
    [256,2,10,5,1,-9], [259,3,12,5,1,-8], [264,9,9,11,1,-8], [275,9,4,11,1,-5],
    [280,9,9,11,1,-8], [291,9,13,10,1,-12], [306,17,16,18,1,-12], [340,12,13,12,0,-12],
    [360,11,13,12,1,-12], [378,11,13,13,1,-12], [396,11,13,13,1,-12], [414,9,13,11,1,-12],
    [429,8,13,11,1,-12], [442,12,13,14,1,-12], [462,11,13,13,1,-12], [480,2,13,5,2,-12],
    [484,7,13,10,1,-12], [496,11,13,12,1,-12], [514,8,13,10,1,-12], [527,13,13,15,1,-12],
    [549,11,13,13,1,-12], [567,13,13,14,1,-12], [589,10,13,12,1,-12], [606,13,14,14,1,-12],
    [629,12,13,13,1,-12], [649,10,13,12,1,-12], [666,9,13,11,1,-12], [681,11,13,13,1,-12],
    [699,11,13,12,0,-12], [717,17,13,17,0,-12], [745,12,13,12,0,-12], [765,12,13,12,0,-12],
    [785,10,13,11,1,-12], [802,3,17,5,1,-12], [809,5,13,5,0,-12], [818,3,17,5,0,-12],
    [825,7,7,8,1,-12], [832,10,1,10,0,3], [834,4,3,5,0,-12], [836,9,10,10,1,-9],
    [848,9,13,10,1,-12], [863,8,10,9,1,-9], [873,8,13,10,1,-12], [886,8,10,10,1,-9],
    [896,4,13,5,1,-12], [903,8,14,10,1,-9], [917,8,13,10,1,-12], [930,2,13,4,1,-12],
    [934,4,17,4,0,-12], [943,9,13,9,1,-12], [958,2,13,4,1,-12], [962,13,10,15,1,-9],
    [979,8,10,10,1,-9], [989,8,10,10,1,-9], [999,9,13,10,1,-9], [1014,8,13,10,1,-9],
    [1027,5,10,6,1,-9], [1034,8,10,9,1,-9], [1044,4,12,5,1,-11], [1050,8,10,10,1,-9],
    [1060,9,10,9,0,-9], [1072,13,10,13,0,-9], [1089,8,10,9,0,-9], [1099,9,14,9,0,-9],
    [1115,7,10,9,1,-9], [1124,4,17,6,1,-12], [1133,2,17,4,2,-12], [1138,4,17,6,1,-12],
    [1147,7,3,9,1,-7],
    ],
  },
  2: {
    name: "FreeSansBold12pt7b",
    first: 0x20,
    last: 0x7e,
    yAdvance: 29,
    // 1 bpp MSB-first row-major (base64) — langsung dari FreeSansBold12pt7bBitmaps[]
    bitmaps:
      "/////3ZmYP/w8/z/P89hmGAOcHODGP/3/7/8c4MYGMf/v/3/4xg5wc4OcAIAfg/4f+evuT3ID0A/AP8A/AX/J/k/6+/+P+B8AIAEADwGD8GB/DBzjAwxgc5gH8wD8wA8Z4AZ+AJ/gM5wEYYGOcGH+DB+DAeAB4AfwD/gPOA84D7gD8AHAD+Mf8zx/PD48Hj4+H/8P94fjv//ZgxzjnHHOOOOOOOOHHHDjhhww4ccOOOHHHHHHHHOOOccY4AQI1/zhxsUDgHAOAcP////+HAOAcA4AP/zNsD//8D/8AwwhhhhDDDCGGGEMMAfg/x/557w/w/w/w/w/w/w/w/w955/4/wPAAYcf//jx48ePHjx48ePHh+D/H/vn/D/DwDwDwHgPA+B4DwDgH/3/3/wHwf8/+8e8eAeA8B4B8AeAPAP8P8ff+f8H4ADwPgfB+G8J4zzHmPYe/////4HgPAeA8A/5/5/5wBgBvh/z/7x8A8A8A8A/h7/5/w/AA+D/H/nn/APeP/P/vn/D/D/D/D3n3/j/A+A/////4DgHAcB4DgPAcB4DwHgOA8B4DwADwP8f8eecOcOOcH4P8ee8P8P8P+ff+P8H4AfA/x/757w7w/w/w/59/8/8e8A7x5/5/wfAP/wAAAP///wAAAP/xFsABAHA/H8fg+A4A/AP4B/APAD//////AAAAAA//////AADgD8B/AP4B8A8H8fj+DwCAAfB/x/75/w/w8A8A8B4DwHgPAOAOAAAPAPAPAA/gAf/APA8DgBw4AHGD2Zh+xsccPDBh4YMPGBh4wYfGDDY447j9+MPPBwAAHAAAeAgB/+AB/AAAPgA+AD4AfwB/AHcA94DngOOB48HDw//D/+P/54DngPcA/wB//D/8//PD7we8HvD7/8/+P/zwe8D/A/wP8H//7/+/+AB+Af+D/8fD54H/gP8ADwAPAA8ADwAPAA+A94H3w+P/4f/Afw/+H/4//ng+8D3gf8B/gP8B/gP8B/gP8D/ge8H3/8//H/gP/3/7/94A8AeAPAH/z/5/88AeAPAHgDwB//////wP//////APAPAPAP/v/v/vAPAPAPAPAPAPAPAAPwD/w//j4feAd4APAA8ADwf/B/8H/wB3gHfA8+Hz/7D/sD4/A/wP8D/A/wP8D/A////////wP8D/A/wP8D/A/wP8Dw////////////AeA8B4DwHgPAeA8B4DwH+P8f4/x7/n/D4PA+8DzwePDw8eDzwPeA/wD/gP+A+8Dx4PDw8PDwePA88D7wHvAeA8B4DwHgPAeA8B4DwHgPAeA8B/////z4H/4P/w//h//D/+H/+f/87/53+zv93f78/35/nz/Pn+eP88f448DwH/A/8H/g/+H/w/3H+4/zn+c/x3+P/w/+H/wf+B/wP+A8A+AP/A//h8fHgPPAe8Af4A/wB/gD/AH+APeA88B48Ph//B/8A/gA/+P/7/+8H/A/wP8D/B//+//P/jwA8APADwA8APADwAAD4A/8D/+Hx8eA88B7wB/gD/AH+AP8Af4E94fzw/jw+H/8H/+D8YAAAP/4//z//PA+8B7wHvAe8Dz/+P/w//jwPPA88DzwPPA88DzwHw/Af+H/58PvA94APAB/AH/wP/gP+AHwAf4D3g+//j/4H8D/////8PAPAPAPAPAPAPAPAPAPAPAPAPAPAPDwP8D/A/wP8D/A/wP8D/A/wP8D/A/wP8D3h5/+P/A/AHAO8D3gecDjgceHhw4OHB54HOA5wHOAfgD8AfgB4APAB4BwOBzg8Hnh8PPD4eOHw4cPhw47nh53OBzucDnM4HOZwG4/APx+Afj8A/D4A+HgB4PADweA8Dzw+eHh54PPA/wD8AfgB4APAD8A/wH+B54PHjw8+D3gePAeeB54PDw8PHgeeA5wD/AH4AfgA8ADwAPAA8ADwAPAA8ADwP/////+AfAPAPAPAPgHgHgHgHwDwDwDwB//////wP///PPPPPPPPPPPPPPPPP//wMGBAwYEDBgQMGBAwYEDBv//zzzzzzzzzzzzzzzzz///wA8A8A8B+BuDnDnDDHDnDuBw/////OYwH4P/H/3h4A8D+f/fHvD3j7/8/+PPgPAHgDwB4A8Ae8P/n/7494P8H+D/B/g/49/+/+e+AA+D/n/3j/B/APAPAPB3j3/z/g+AAHgDwB4A8AePvP/v/3j/g/wf4P8H+D3j7/8/+PvAH4H+H/nxzwd/+//eAPADw5/8f8D4AD79+8efvzx48ePHjx48ePAeefvf/vH/B/g/wf4P8H/H3/5/8feAPAH/Hn/w/gDwDwDwDwDwD3z/7//5/w/w/w/w/w/w/w/w/w//8A////////8888AA88888888888888///4DwDwDwDwDwDw/x7zz3j/D/D/j/jzzxzx7w7w/////////////3j5/7+////Pj/Hh/jw/x4f48P8eH+PD/Hh/jw/x4e98/+//+f8P8P8P8P8P8P8P8P8PAPgf8f/PHvB/g/wf4P8HvHn/x/wPgA98f/P/3x7wf4P8H+D/B/x7/9/894eAPAHgDwB4AAD3n/3/7x/wf4P8H+D/B7x9/+f/H3gDwB4A8AeAPA8/f/+PDw8PDw8PDw8B+H/P/vD/gP8H/g/wH/D//n/h+Aeee//eeeeeeeffPA8P8P8P8P8P8P8P8P8P8f//f/PvDwe4OeHPHjjhxwd4O4HcB+A+AfAHAA8OHceHcfPefPebOObOO7OO78Hz8Hx8Hx8Hx4Dh4AePPHj3g7gfwHwB4B8B/A7w948eeHAPB7g54cceOOHnBzg7gfwH4D4A8AcAOAPAfAPgHgAP////wPB4PB4PB4PA/////AHPPOOOOOOOO88OOOOOOOPPHA///////w448ccccccccPPccccccc884AeA/gzzB/AeA=",
    // [bitmapOffset, width, height, xAdvance, xOffset, yOffset]
    glyphs: [
    [0,0,0,7,0,1], [0,4,17,8,3,-16], [9,10,6,11,1,-17], [17,13,16,13,0,-15],
    [43,13,20,13,0,-17], [76,19,17,21,1,-16], [117,16,17,17,1,-16], [151,4,6,6,1,-17],
    [154,6,22,8,1,-17], [171,6,22,8,1,-17], [188,7,8,9,1,-17], [195,11,11,14,2,-10],
    [211,4,7,6,1,-2], [215,6,3,8,1,-7], [218,4,3,6,1,-2], [220,6,17,7,0,-16],
    [233,12,17,13,1,-16], [259,7,17,14,3,-16], [274,12,17,13,1,-16], [300,12,17,13,1,-16],
    [326,11,17,13,1,-16], [350,12,17,13,1,-16], [376,12,17,13,1,-16], [402,11,17,13,1,-16],
    [426,12,17,13,1,-16], [452,12,17,13,1,-16], [478,4,12,6,1,-11], [484,4,16,6,1,-11],
    [492,12,12,14,1,-11], [510,12,9,14,1,-9], [524,12,12,14,1,-11], [542,12,18,15,2,-17],
    [569,21,21,23,1,-17], [625,16,18,17,0,-17], [661,14,18,17,2,-17], [693,16,18,17,1,-17],
    [729,15,18,17,2,-17], [763,13,18,16,2,-17], [793,12,18,15,2,-17], [820,16,18,18,1,-17],
    [856,14,18,18,2,-17], [888,4,18,7,2,-17], [897,11,18,14,1,-17], [922,16,18,17,2,-17],
    [958,11,18,15,2,-17], [983,17,18,21,2,-17], [1022,15,18,18,2,-17], [1056,17,18,19,1,-17],
    [1095,14,18,16,2,-17], [1127,17,19,19,1,-17], [1168,16,18,17,2,-17], [1204,15,18,16,1,-17],
    [1238,12,18,15,2,-17], [1265,14,18,18,2,-17], [1297,15,18,16,0,-17], [1331,23,18,23,0,-17],
    [1383,15,18,16,1,-17], [1417,16,18,15,0,-17], [1453,13,18,15,1,-17], [1483,6,23,8,2,-17],
    [1501,7,17,7,0,-16], [1516,6,23,8,0,-17], [1534,12,11,14,1,-16], [1551,15,2,13,-1,4],
    [1555,4,3,6,0,-17], [1557,13,13,14,1,-12], [1579,13,18,15,2,-17], [1609,12,13,13,1,-12],
    [1629,13,18,15,1,-17], [1659,13,13,14,1,-12], [1681,7,18,8,1,-17], [1697,13,18,15,1,-12],
    [1727,12,18,14,2,-17], [1754,4,18,7,2,-17], [1763,6,23,7,0,-17], [1781,12,18,14,2,-17],
    [1808,4,18,6,2,-17], [1817,19,13,21,2,-12], [1848,12,13,15,2,-12], [1868,13,13,15,1,-12],
    [1890,13,18,15,2,-12], [1920,13,18,15,1,-12], [1950,8,13,9,2,-12], [1963,12,13,13,1,-12],
    [1983,6,15,8,1,-14], [1995,12,13,15,2,-12], [2015,13,13,13,0,-12], [2037,18,13,19,0,-12],
    [2067,13,13,13,0,-12], [2089,13,18,13,0,-12], [2119,10,13,12,1,-12], [2136,6,23,9,1,-17],
    [2154,2,22,7,2,-17], [2160,6,23,9,3,-17], [2178,12,5,12,0,-7],
    ],
  },
  3: {
    name: "FreeMono9pt7b",
    first: 0x20,
    last: 0x7e,
    yAdvance: 18,
    // 1 bpp MSB-first row-major (base64) — langsung dari FreeMono9pt7bBitmaps[]
    bitmaps:
      "qqgM7SSSSCRIkS/kiX8oUSJACD5iQDAOAYHDvggIcRIjgCO4DiJEcDiBAgYaZUbI7OkkWqqpQKlVWoAQIkvjBREAECBH8QIEAGtI/wDwAggQYIEECCBBAggAOIoMGDBgwYKI4CcoQhCEIT44iggQIIIIYQP4fAYCAhwGAQEBQjwYopKKKL8IIcB8gQPkQECBA4jgHkEEC5iwwcKI4P4ECCBAggQIIEA4igwURxFBg4zgOIocGGjOgQQTwPAPbADS0gADBBhgYBgEA/+AAB/wQBgDAGAgYMCAPYQIMMIAAAAwPEaCjrKiop+AgEA8PAFAKAkBEEIPwQRAnjz+IZBIZ+IJAoFB/4A+sPAwCAQCAIBgj4D+IZBoFAoFAoNDfwD/IJAIh8IhAIFA/8D/oFAIh8IhAIBAeAAemGwKAIAg+AsCYIfA46CQSCfyCQSCQXHA+QhCEIQnwB8CAgICAoKCxnjjoREJBYMhCIRBcMDgQEBAQEBBQUH/4OwZRSikpJSREgJAXBzDsJRKJJJJFIpDcIAeMZBQGAwGAoJjDwD+Q0FBQnxAQEDwHDGQUBgMBgKCYx8EB5Iw/iGQSCQj4RCEQXDAOs0KAwGAwcd4/8RiIQCAQCAQCB8A46CQSCQSCQSCIg4A8egQghBCECIEgFAMAIDx6AkRJUSoVQyhjDGEMOOgiIKAgMCQREFxwOOgiIKBQEAgEAgfAP0KIIEEECGD/OqqqsCAgQMCBAQICBAQICDVVVXAEFEiKCD/4IiAfgCAR+wUCgz7wCAQC8YSBQKBQLC3gDqODAgQEJ4DAIBHpDQKBQKBIY9gPEOB/4CAYT49BD5BBBBBD4A9oaBQKBQJDHoBAYeAwCAQC8YyCQSCQSC44BABwIECBAgR/BA+EIQhCEI/AMBAQE9EWHBIRELHcCBAgQIECBAj+LdkYjEYjEYjkV4xkEgkEgkFxz4xoDAYDAWMfN4wkCgUCgWEvEAgOAA9oaBQKBQJDHoBAIDgzqGCBAgQfDqNC4DwcN5AQPxAQEBAQEE+w0FBQUFBQz3joJCEQiCgUBDjwJJLJZKpmETjMQUBAUERBcfjoJCEQkCgYBAQCD4A/QgggggQvykkokkm//iJJIpJLGEkMA==",
    // [bitmapOffset, width, height, xAdvance, xOffset, yOffset]
    glyphs: [
    [0,0,0,11,0,1], [0,2,11,11,4,-10], [3,6,5,11,2,-10], [7,7,12,11,2,-10], [18,8,12,11,1,-10],
    [30,7,11,11,2,-10], [40,7,10,11,2,-9], [49,3,5,11,4,-10], [51,2,13,11,5,-10],
    [55,2,13,11,4,-10], [59,7,7,11,2,-10], [66,7,7,11,2,-8], [73,3,5,11,2,-1],
    [75,9,1,11,1,-5], [77,2,2,11,4,-1], [78,7,13,11,2,-11], [90,7,11,11,2,-10],
    [100,5,11,11,3,-10], [107,7,11,11,2,-10], [117,8,11,11,1,-10], [128,6,11,11,3,-10],
    [137,7,11,11,2,-10], [147,7,11,11,2,-10], [157,7,11,11,2,-10], [167,7,11,11,2,-10],
    [177,7,11,11,2,-10], [187,2,8,11,4,-7], [189,3,11,11,3,-7], [194,8,8,11,1,-8],
    [202,9,4,11,1,-6], [207,9,8,11,1,-8], [216,7,10,11,2,-9], [225,8,12,11,2,-10],
    [237,11,10,11,0,-9], [251,9,10,11,1,-9], [263,9,10,11,1,-9], [275,9,10,11,1,-9],
    [287,9,10,11,1,-9], [299,9,10,11,1,-9], [311,10,10,11,1,-9], [324,9,10,11,1,-9],
    [336,5,10,11,3,-9], [343,8,10,11,2,-9], [353,9,10,11,1,-9], [365,8,10,11,2,-9],
    [375,11,10,11,0,-9], [389,9,10,11,1,-9], [401,9,10,11,1,-9], [413,8,10,11,1,-9],
    [423,9,13,11,1,-9], [438,9,10,11,1,-9], [450,7,10,11,2,-9], [459,9,10,11,1,-9],
    [471,9,10,11,1,-9], [483,11,10,11,0,-9], [497,11,10,11,0,-9], [511,9,10,11,1,-9],
    [523,9,10,11,1,-9], [535,7,10,11,2,-9], [544,2,13,11,5,-10], [548,7,13,11,2,-11],
    [560,2,13,11,4,-10], [564,7,5,11,2,-10], [569,11,1,11,0,2], [571,3,3,11,3,-11],
    [573,9,8,11,1,-7], [582,9,11,11,1,-10], [595,7,8,11,2,-7], [602,9,11,11,1,-10],
    [615,8,8,11,1,-7], [623,6,11,11,3,-10], [632,9,11,11,1,-7], [645,9,11,11,1,-10],
    [658,7,10,11,2,-9], [667,5,13,11,3,-9], [676,8,11,11,2,-10], [687,7,11,11,2,-10],
    [697,9,8,11,1,-7], [706,9,8,11,1,-7], [715,9,8,11,1,-7], [724,9,11,11,1,-7],
    [737,9,11,11,1,-7], [750,7,8,11,3,-7], [757,7,8,11,2,-7], [764,8,10,11,2,-9],
    [774,8,8,11,1,-7], [782,9,8,11,1,-7], [791,9,8,11,1,-7], [800,9,8,11,1,-7],
    [809,9,11,11,1,-7], [822,7,8,11,2,-7], [829,3,13,11,4,-10], [834,1,13,11,5,-10],
    [836,3,13,11,4,-10], [841,7,3,11,2,-6],
    ],
  },
};

/** Nama font untuk log/CLI (termasuk id 0 yang bukan GFX). */
export const LCD_GFX_FONT_NAMES: Record<number, string> = {
  0: "default 5x7",
  1: "FreeSans9pt7b",
  2: "FreeSansBold12pt7b",
  3: "FreeMono9pt7b",
};
