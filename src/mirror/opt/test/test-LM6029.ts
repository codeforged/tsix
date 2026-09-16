/**
 * test-LM6029.ts — 🖥️ Demo & uji LCD monokrom 128x64 (LM6029ACW)
 *
 * Versi TSIX dari raspi-lcd-addon/examples/test_gfx.js: aplikasi TIDAK
 * menyentuh native addon sama sekali, cukup bicara ke /dev/lcd lewat HAL
 * ("Everything is a File") — buka fd → ioctl / write → tutup.
 *
 * ── PEMAKAIAN ──
 *   test-LM6029                       → suite visual lengkap (7 scene)
 *   test-LM6029 --fast                → suite dengan jeda lebih singkat
 *   test-LM6029 info                  → status driver (GET_INFO)
 *   test-LM6029 clear                 → bersihkan buffer
 *   test-LM6029 text "Halo TSIX"      → cetak satu baris teks
 *   test-LM6029 graph                 → plot gelombang sinus
 *   test-LM6029 fb                    → kirim framebuffer 1024 byte (dd-style)
 *   test-LM6029 contrast              → sweep kontras 0..63
 *   test-LM6029 contrast 40           → set kontras
 *   test-LM6029 backlight on|off      → backlight
 *   test-LM6029 invert on|off         → inversi warna
 *   test-LM6029 display on|off        → display on/off
 *   test-LM6029 speed                 → sweep kecepatan SPI
 *   test-LM6029 speed 32000000        → set kecepatan SPI
 *   test-LM6029 fps [detik]           → benchmark FPS 3 fase
 *
 * Konstanta ioctl sudah dibungkus src/mirror/lib/lcdLib.ts — aplikasi cukup
 * `import { lcd } from "@tsix/lcdLib"`, tanpa hardcode magic number.
 * 
 * (c) 2026 TSIX Project
 */

import { Program, std } from "@tsix/Application";
import {
  lcd,
  LcdFont,
  LCD_DEVICE_PATH,
  LCD_FONT_NAMES,
  LCD_WIDTH,
  LCD_HEIGHT,
} from "@tsix/lcdLib";

/** Geometri panel (dari lcdLib — biar tidak ada magic number). */
const W = LCD_WIDTH;
const H = LCD_HEIGHT;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Bingkai tipis di tepi layar — penanda area gambar. */
async function frame() {
  await lcd.drawRect(0, 0, W, H, 1);
}

// ================================================================
// SCENE
// ================================================================

/** Scene 1 — primitive geometri. */
async function sceneShapes(pause: number) {
  await std.println("1. Bentuk geometri dasar...");
  await lcd.clear();
  await frame();
  await lcd.drawRect(6, 8, 30, 20);
  await lcd.fillRect(42, 8, 30, 20);
  await lcd.drawCircle(86, 18, 10);
  await lcd.fillCircle(112, 18, 10);
  await lcd.drawLine(6, 36, 122, 36);
  await lcd.drawTriangle(20, 60, 35, 42, 50, 60);
  await lcd.drawRoundRect(70, 42, 50, 18, 6);
  await lcd.flush();
  await sleep(pause);
}

/** Scene 2 — font default 5x7 dalam berbagai ukuran. */
async function sceneDefaultFont(pause: number) {
  await std.println("2. Font default (glcdfont) ukuran 1x/2x...");
  await lcd.clear();
  await lcd.setFont(LcdFont.DEFAULT);
  await lcd.setTextColor(1);
  await lcd.printText("TSIX /dev/lcd", 2, 2, 1);
  await lcd.printText("Size 2x", 2, 14, 2);
  await lcd.printText("SPI + 74HC595", 2, 40, 1);
  await lcd.printText("128x64 mono", 2, 52, 1);
  await lcd.flush();
  await sleep(pause);
}

/** Scene 3 — teks ter-inversi di atas latar nyala penuh. */
async function sceneInverted(pause: number) {
  await std.println("3. Teks inversi (bg = piksel nyala)...");
  await lcd.clear();
  await lcd.fillScreen(1); // latar putih
  await lcd.setTextColor(0, 1);
  await lcd.printText("INVERTED TEXT", 4, 24, 1);
  await lcd.printText("bg=1 fg=0", 4, 36, 1);
  // Garis putus-putus gelap di tepi atas & bawah.
  for (let x = 0; x < W; x += 4) {
    await lcd.drawPixel(x, 0, 0);
    await lcd.drawPixel(x, H - 1, 0);
  }
  await lcd.flush();
  await sleep(pause);
  await lcd.setTextColor(1); // balik ke normal
}

/** Scene 4 — font Adafruit kustom. */
async function sceneCustomFonts(pause: number) {
  await std.println("4. Font Adafruit kustom...");
  const fonts = [LcdFont.FREE_SANS_9, LcdFont.FREE_SANS_BOLD_12, LcdFont.FREE_MONO_9];
  for (const id of fonts) {
    await lcd.clear();
    await lcd.setFont(id);
    await lcd.setTextColor(1);
    await lcd.printText(LCD_FONT_NAMES[id], 2, 16, 1);
    await lcd.printText("Aa Bb 0123", 2, 46, 1);
    await lcd.flush();
    await std.println(`   → font ${id}: ${LCD_FONT_NAMES[id]}`);
    await sleep(pause);
  }
  await lcd.setFont(LcdFont.DEFAULT); // kembali ke font default
}

/** Scene 5 — plot gelombang sinus (ala kalkulator grafik). */
async function sceneGraph(pause: number) {
  await std.println("5. Plot gelombang sinus...");
  await lcd.clear();
  // Sumbu X di tengah + garis skala tiap 16 px.
  await lcd.drawLine(0, 32, W - 1, 32);
  for (let x = 0; x < W; x += 16) {
    await lcd.drawPixel(x, 31);
  }
  // sin(x) + sin(3x)/2, amplitudo 24 px.
  for (let x = 0; x < W; x++) {
    const phase = (x / W) * 4 * Math.PI;
    const y = 32 - Math.round((24 * (Math.sin(phase) + 0.5 * Math.sin(3 * phase))) / 1.5);
    await lcd.drawPixel(x, Math.max(0, Math.min(H - 1, y)));
  }
  await lcd.printText("sin(x)+sin(3x)/2", 2, 2, 1);
  await lcd.flush();
  await sleep(pause);
}

/** Scene 6 — banyak objek digambar, lalu 1x flush (hemat syscall). */
async function sceneBars(pause: number) {
  await std.println("6. Animasi bar (render banyak, flush sekali)...");
  await lcd.clear();
  await lcd.printText("Frame bufer + flush", 2, 2, 1);
  for (let i = 0; i < 8; i++) {
    const h = 4 + i * 5;
    await lcd.fillRect(8 + i * 14, 58 - h, 10, h);
  }
  await lcd.drawRect(4, 22, 118, 38);
  await lcd.flush();
  await sleep(pause);
}

/** Scene 7 — framebuffer 1 bpp 1024 byte via blit() (ala `dd`). */
async function sceneFramebuffer(pause: number) {
  await std.println("7. Framebuffer 1 bpp 1024 byte via blit()...");
  const fb = lcd.framebuffer();

  // Pola papan catur 8x8 di kiri.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < 64; x++) {
      if (((x >> 3) + (y >> 3)) % 2 === 0) fb.setPixel(x, y, 1);
    }
  }
  // Rampa diagonal di kanan (uji urutan bit MSB-first).
  fb.line(64, 0, W - 1, H - 1, 1).line(64, H - 1, W - 1, 0, 1);

  const t0 = Date.now();
  const ok = await lcd.blit(fb); // blit penuh: MENGGANTI seluruh isi layar
  // Auto-flush mengikuti setAutoFlush(). Di suite auto-flush dimatikan, jadi
  // frame ini harus di-flush manual — kalau tidak, panel tetap menampilkan
  // scene sebelumnya.
  await lcd.flush();
  await std.println(
    `   → blit(${fb.bytes.length} byte) = ${ok} dalam ${Date.now() - t0} ms`,
  );
  await sleep(pause);
}

/** Suite lengkap. */
async function runSuite(pause: number) {
  // Auto-flush dimatikan supaya tiap scene bisa menggambar banyak objek
  // lalu di-flush sekali (jauh lebih cepat).
  await lcd.setAutoFlush(false);
  await std.println("autoFlush OFF — flush manual tiap akhir scene.");
  await std.println("");

  await sceneShapes(pause);
  await sceneDefaultFont(pause);
  await sceneInverted(pause);
  await sceneCustomFonts(pause);
  await sceneGraph(pause);
  await sceneBars(pause);
  await sceneFramebuffer(pause);

  await lcd.setAutoFlush(true);
  await sleep(300);
  await lcd.clear();
  await frame();
  await lcd.printText("SUKSES", 40, 20, 2);
  await lcd.printText("7 scene selesai", 20, 44, 1);
  await lcd.flush();
  await std.println("");
  await std.println("✅ Suite selesai.");
}

// ================================================================
// PERINTAH KONTROL
// ================================================================

async function cmdInfo() {
  const info = await lcd.getInfo();
  await std.println("");
  await std.println("ℹ Status /dev/lcd:");
  for (const [k, v] of Object.entries(info || {})) {
    await std.println(`   ${k.padEnd(16)}: ${v}`);
  }
  await std.println(`   kontras aktual  : ${await lcd.getContrast()}`);
}

async function cmdContrast(value?: string) {
  if (value !== undefined) {
    const used = await lcd.setContrast(parseInt(value, 10));
    await std.println(`✔ Kontras → ${used}`);
    return;
  }

  await std.println("Sweep kontras 0..63 (pola gradasi sederhana)...");
  // Pola: 8 blok dithering sebagai referensi — digambar di framebuffer
  // lokal, lalu di-blit sekali (contoh pemakaian LcdFramebuffer). blit()
  // mengganti seluruh layar, jadi pola lama tidak menumpuk.
  const fb = lcd.framebuffer();
  for (let i = 0; i < 8; i++) {
    const density = i + 1;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 15; x++) {
        if ((x + y) % (9 - density) === 0) {
          fb.setPixel(4 + i * 15 + x, 16 + y, 1);
        }
      }
    }
  }
  await lcd.blit(fb);
  await lcd.flush();

  const levels = [0, 10, 20, 28, 31, 38, 48, 56, 63];
  for (const lv of levels) {
    const used = await lcd.setContrast(lv);
    await std.println(`   EVR ${String(lv).padStart(2)} → terpakai ${used}`);
    await sleep(700);
  }
  await lcd.setContrast(31);
  await std.println("✔ Kembali ke kontras default (31).");
}

async function cmdSpeed(value?: string) {
  const speeds = value !== undefined
    ? [parseInt(value, 10)]
    : [8_000_000, 16_000_000, 32_000_000, 64_000_000];

  for (const hz of speeds) {
    if (hz <= 0) {
      await std.error(`Kecepatan tidak valid: ${value}`);
      return;
    }
    const used = await lcd.setSpiSpeed(hz);
    await std.println(
      `   minta ${(hz / 1e6).toFixed(0)} MHz → aktual ${(used / 1e6).toFixed(3)} MHz`,
    );

    // Pola integritas: papan catur halus + garis 1 px.
    const fb = lcd.framebuffer();
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < W; x++) {
        if ((x + y) % 2 === 0) fb.setPixel(x, y, 1);
      }
    }
    for (let y = 34; y < 40; y += 2) fb.hLine(0, y, W, 1);

    await lcd.blit(fb);
    await lcd.printText(`${(hz / 1e6).toFixed(0)} MHz`, 2, 50, 1);
    await lcd.flush();
    await sleep(1200);
  }
}

async function cmdFps(seconds: number) {
  const dur = Math.max(1, seconds) * 1000;
  await std.println(`Benchmark FPS ${seconds}s (4 fase)...`);

  // 1) Render-only: banyak ioctl gambar, tanpa flush.
  await lcd.setAutoFlush(false);
  let n = 0;
  let t = Date.now();
  while (Date.now() - t < dur) {
    await lcd.fillRect((n % 10) * 12, 8, 10, 8);
    await lcd.drawRect(0, 0, W, H);
    n++;
  }
  const renderFps = (n / (seconds || 1)).toFixed(1);

  // 2) Flush-only: hanya display().
  n = 0;
  t = Date.now();
  while (Date.now() - t < dur) {
    await lcd.flush();
    n++;
  }
  const flushFps = (n / (seconds || 1)).toFixed(1);

  // 3) Full frame: bersihkan, gambar, flush.
  n = 0;
  t = Date.now();
  while (Date.now() - t < dur) {
    await lcd.clear();
    await lcd.fillCircle(64, 32, 10 + (n % 8));
    await lcd.flush();
    n++;
  }
  const fullFps = (n / (seconds || 1)).toFixed(1);

  // 4) Framebuffer blit: gambar di memori, kirim 1x 1024 byte (mengganti
  //    seluruh layar). Auto-flush masih OFF di fase ini, jadi yang diukur
  //    adalah biaya menulis frame — bukan present ke panel.
  const fb = lcd.framebuffer().fillCircle(64, 32, 20, 1);
  n = 0;
  t = Date.now();
  while (Date.now() - t < dur) {
    await lcd.blit(fb);
    n++;
  }
  const blitFps = (n / (seconds || 1)).toFixed(1);
  await lcd.setAutoFlush(true);

  await std.println("");
  await std.println(`   render-only : ${renderFps} iter/s`);
  await std.println(`   flush-only  : ${flushFps} fps`);
  await std.println(`   full frame  : ${fullFps} fps`);
  await std.println(`   blit 1024B   : ${blitFps} fps`);
  await std.println("   (bottleneck biasanya overhead syscall, bukan SPI)");
}

// ================================================================
// MAIN
// ================================================================

export const main = Program(async (args: string[]) => {
  // Pisahkan flag (--fast) dari argumen perintah.
  const positional = args.filter((a) => !a.startsWith("--"));
  const cmd = (positional[0] || "suite").toLowerCase();
  const fast = args.includes("--fast");
  const pause = fast ? 500 : 1800;

  await std.println("");
  await std.println("╔════════════════════════════════════════════╗");
  await std.println("║ 🖥️  test-LM6029 — LCD 128x64 via /dev/lcd   ║");
  await std.println("╚════════════════════════════════════════════╝");
  await lcd.setDevicePath("/dev/plcd");
  // ── Semua akses lewat lcdLib (FD + ioctl diurus di dalam) ──
  try {
    // Pastikan device ada DAN panelnya benar-benar siap.
    if (!(await lcd.isAvailable())) {
      await std.error(`❌ ${LCD_DEVICE_PATH} belum siap (available=false).`);
      await std.error("   Cek: SPI aktif? paket lm6029acw sudah terpasang?");
      await std.error("   Lihat /var/log/syslog (driver mencatat alasannya).");
      return;
    }

    const info = await lcd.getInfo();
    await std.println(
      `✔ ${LCD_DEVICE_PATH} siap — ${info?.width}x${info?.height}, ` +
        `SPI ${(Number(info?.spiSpeed) / 1e6).toFixed(2)} MHz, ` +
        `kontras ${info?.contrast}, backlight ${info?.backlight}` +
        (info?.spiDevice ? `\n   bus ${info.spiDevice}` : ""),
    );
    await std.println("");

    switch (cmd) {
      case "suite":
        await runSuite(pause);
        break;

      case "info":
        await cmdInfo();
        break;

      case "clear":
        await lcd.clear();
        await lcd.flush();
        await std.println("✔ Layar dibersihkan.");
        break;

      case "text": {
        const msg = positional.slice(1).join(" ") || "Halo TSIX";
        await lcd.clear();
        await frame();
        await lcd.setFont(LcdFont.DEFAULT);
        await lcd.setTextColor(1);
        await lcd.printText(msg.slice(0, 20), 2, 2, 1);
        await lcd.printText(msg.slice(20, 40), 2, 14, 1);
        await lcd.printText(msg.slice(40, 60), 2, 26, 2);
        await lcd.flush();
        await std.println(`✔ Teks dikirim: "${msg}"`);
        break;
      }

      case "graph":
        await sceneGraph(pause);
        break;

      case "fb":
        await sceneFramebuffer(pause);
        break;

      case "contrast":
        await cmdContrast(positional[1]);
        break;

      case "backlight": {
        const on = (positional[1] || "on").toLowerCase() !== "off";
        await lcd.setBacklight(on);
        await std.println(`✔ Backlight ${on ? "ON" : "OFF"}.`);
        break;
      }

      case "invert": {
        const on = (positional[1] || "on").toLowerCase() !== "off";
        await lcd.setInvert(on);
        await std.println(`✔ Inversi ${on ? "ON" : "OFF"}.`);
        break;
      }

      case "display": {
        const on = (positional[1] || "on").toLowerCase() !== "off";
        await lcd.setDisplayOn(on);
        await std.println(`✔ Display ${on ? "ON" : "OFF"}.`);
        break;
      }

      case "speed":
        await cmdSpeed(positional[1]);
        break;

      case "fps":
        await cmdFps(parseInt(positional[1], 10) || 3);
        break;

      default:
        await std.println(`❓ Perintah tidak dikenal: ${cmd}`);
        await std.println("   suite | info | clear | text | graph | fb | contrast");
        await std.println("   backlight | invert | display | speed | fps");
        break;
    }
  } catch (e: any) {
    await std.error(`❌ Error: ${e.message}`);
  } finally {
    await lcd.close();
  }

  await std.println("");
});
