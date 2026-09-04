/**
 * smartbulb/control.ts — 💡 Smart Bulb Control (GUI Cashew)
 *
 * Pengontrol lampu rumah ala `docs/jayalaras-iot/smartbulb/index.html`:
 * denah rumah (gambar) + lampu yang bisa diklik per ruangan.
 *
 * Denah:
 *   - Background = /opt/smartbulb/layoutrumah.png (TImage, auto-load dari VFS).
 *     Ukuran stage mengikuti dimensi gambar; posisi lampu = koordinat
 *     index.html (jadi pas di atas denah).
 *   - Bila gambar tidak ada → fallback: kotak ruangan skematik.
 *
 * Mode:
 *   control                    → SIMULASI (state di memori — aman dicoba tanpa chip)
 *   control --hw               → coba pakai MCP23017 relay (auto-detect device)
 *   control --hw /dev/relays   → paksa device tertentu
 *   (SERVICE)                  → bila /opt/smartbulb/service.js jalan, GUI
 *                                otomatis connect via IPC (jayalaras.service);
 *                                service pemilik hardware + logika saklar.
 *
 * Saat `--hw`, daemon membuka device MCP23017 (relay), memetakan port logika
 * → pin fisik (konvensi relay NOS: genap → bank A, ganjil → bank B), menulis
 * via ioctl DIGITAL_WRITE (active-low: ON = LOW), dan membaca status via
 * READ_ALL untuk sinkron (mis. bila ada saklar/remote lain).
 *
 * ⚠️ PENTING — mapping port masih turunan konfigurasi NOS (2020). Periksa &
 * sesuaikan array `LIGHTS.port` dengan wiring asli sebelum mengandalkan mode
 * `--hw`. Lihat `wiki/mcp23017-registration.md` untuk registrasi device.
 *
 * Cara memakai (dari shell TSIX, pastikan DOME berjalan):
 *   1. Sync folder ini ke VFS (host):   npm run vfs:bootstrap
 *      (atau sync per file: node -r esbuild-register -r tsconfig-paths/register scripts/sync-vfs.ts ...)
 *      Sync menghasilkan /opt/smartbulb/control.js (sama seperti dome/image-viewer).
 *   2. Denah: letakkan /opt/smartbulb/layoutrumah.png di bkfs (cp sudah cukup).
 *   3. Jalankan:   /opt/smartbulb/control.js [--hw]
 *      (atau tambahkan /opt/smartbulb ke PATH di /etc/profile → cukup `control`)
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, fs, shell } from "@tsix/Application";
import {
  TForm,
  TPanel,
  TLabel,
  TButton,
  TImage,
  TStatusBar,
  TTimer,
  HStack,
  Spacer,
} from "@tsix/cashew";

export const appMode = "gui";

// ── IOCTL MCP23017 (cocok dgn MCP23017Device.ts) ──
const IOCTL_SET_PIN_MODE = 0x3001;
const IOCTL_DIGITAL_WRITE = 0x3002;
const IOCTL_READ_ALL = 0x3004;
const MODE_OUTPUT = 0;

/** Device MCP23017 relay — coba urut sampai ketemu. */
const RELAY_DEV_CANDIDATES = ["/dev/relays", "/dev/mcp0", "/dev/mcp23017"];

/** File denah rumah (background) — sama seperti index.html. */
const LAYOUT_PATH = "/opt/smartbulb/layoutrumah.png";

/** Ikon lampu ON/OFF (PNG dari VFS). Fallback ke lingkaran + emoji bila absen. */
const BULB_ON_PATH = "/opt/smartbulb/bulbon.png";
const BULB_OFF_PATH = "/opt/smartbulb/bulboff.png";

/**
 * Definisi lampu — koordinat mengikuti tata letak index.html (0..432, 0..600).
 * `port` = port logika relay (konvensi NOS), di-map ke pin fisik via portToPin().
 * `parent` (opsional): lampu ikut satu relay dengan lampu lain (mis. paviliun
 * menempel di teras, port 9) — toggle parent akan menyalakan keduanya.
 */
interface LightDef {
  idx: number; // id UI (cocok dgn bulb_N di index.html)
  name: string; // nama ruangan
  x: number;
  y: number;
  port: number; // port logika relay (NOS)
  parent?: number; // id lampu lain yang berbagi relay
}
const LIGHTS: LightDef[] = [
  { idx: 0, name: "Ruang Tengah Depan", x: 175, y: 355, port: 15 },
  { idx: 1, name: "Ruang Tengah Belakang", x: 320, y: 355, port: 8 },
  { idx: 2, name: "Dapur", x: 380, y: 180, port: 7 },
  { idx: 3, name: "Kamar Kakang", x: 185, y: 530, port: 3 },
  { idx: 4, name: "Kamar Utama", x: 355, y: 530, port: 4 },
  { idx: 5, name: "WC Kamar", x: 432, y: 600, port: 5 },
  { idx: 6, name: "WC Utama", x: 265, y: 135, port: 6 },
  { idx: 7, name: "Ruang Kerja", x: 175, y: 175, port: 10 },
  { idx: 8, name: "Taman", x: 425, y: 365, port: 12 },
  { idx: 9, name: "Teras", x: 70, y: 255, port: 9 },
  { idx: 10, name: "Paviliun", x: 380, y: 40, port: 9, parent: 9 },
];
const LIGHT = (idx: number) => LIGHTS.find((l) => l.idx === idx)!;

/** Ruangan denah (kotak latar belakang) — koordinat & ukuran belum diskalakan. */
interface RoomDef {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
const ROOMS: RoomDef[] = [
  { name: "Paviliun", x: 320, y: 20, w: 190, h: 70 },
  { name: "WC Utama", x: 215, y: 100, w: 105, h: 75 },
  { name: "Ruang Kerja", x: 105, y: 125, w: 108, h: 95 },
  { name: "Dapur", x: 310, y: 115, w: 205, h: 105 },
  { name: "Teras", x: 8, y: 200, w: 105, h: 120 },
  { name: "Ruang Tengah Depan", x: 60, y: 300, w: 185, h: 130 },
  { name: "Ruang Tengah Belakang", x: 250, y: 310, w: 175, h: 125 },
  { name: "Taman", x: 428, y: 330, w: 105, h: 130 },
  { name: "Kamar Kakang", x: 70, y: 480, w: 210, h: 135 },
  { name: "Kamar Utama", x: 285, y: 485, w: 135, h: 130 },
  { name: "WC Kamar", x: 425, y: 550, w: 110, h: 130 },
];

/** Coba baca dimensi PNG (width/height dari header IHDR) dari VFS. */
async function pngSize(path: string): Promise<{ w: number; h: number } | null> {
  try {
    const raw: any = await fs.readFile(path);
    if (!raw) return null;
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "latin1");
    // Signature PNG: 0x89 'P' 'N' 'G'
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (!(w > 0 && h > 0)) return null;
    return { w, h };
  } catch (_) {
    return null;
  }
}

/** Port logika NOS → pin fisik MCP23017 (genap → bank A, ganjil → bank B). */
function portToPin(port: number): number {
  if (port < 0 || port > 15) return 0;
  return port % 2 === 0 ? port / 2 : Math.floor(port / 2) + 8;
}

export const main = Program(async (args: string[]) => {
  await std.log("=== Smart Bulb Control (Cashew) ===");

  // ── Argumen ──
  let hwMode = args.includes("--hw");
  const devIdx = args.indexOf("--hw");
  let forcedDev: string | null = null;
  if (
    devIdx !== -1 &&
    devIdx + 1 < args.length &&
    !args[devIdx + 1].startsWith("--")
  ) {
    forcedDev = args[devIdx + 1];
  }
  const candidates = forcedDev ? [forcedDev] : RELAY_DEV_CANDIDATES;

  // ── Denah: baca dimensi gambar → hitung skala agar muat di window ──
  const dim = await pngSize(LAYOUT_PATH);
  const useImage = dim !== null;
  const NAT_W = dim?.w || 520;
  const NAT_H = dim?.h || 700;
  const scale = useImage
    ? Math.max(0.2, Math.min(1, 620 / NAT_H, 840 / NAT_W))
    : 1.15;
  const ox = useImage ? 0 : 24;
  const oy = useImage ? 0 : 10;
  const stageW = useImage
    ? Math.round(NAT_W * scale)
    : Math.round(520 * scale + ox * 2);
  const stageH = useImage
    ? Math.round(NAT_H * scale)
    : Math.round(670 * scale + oy);
  const X = (x: number) => Math.round(x * scale + ox);
  const Y = (y: number) => Math.round(y * scale + oy);
  // Posisi tombol lampu (kiri-atas di koordinat denah, seperti index.html).
  const bulbL = LIGHTS.map((l) => X(l.x));
  const bulbT = LIGHTS.map((l) => Y(l.y));

  // ── Form ──
  const form = new TForm({
    title: "💡 Smart Bulb — JayaLaras",
    icon: "💡",
    width: Math.min(1000, stageW + 80),
    height: useImage ? Math.min(960, stageH + 190) : 900,
    maximizable: true,
    resizable: true,
  });

  // Header
  const title = new TLabel("title", {
    caption: "💡 Smart Bulb — JayaLaras",
    fontSize: "18px",
    fontWeight: "700",
    color: "var(--accent, #4caf50)",
    margin: "0",
  });
  form.add(title);

  const modeLabel = new TLabel("mode", {
    caption: useImage
      ? `Mode: SIMULASI · denah ${NAT_W}x${NAT_H} (tambah --hw utk MCP23017)`
      : "Mode: SIMULASI · denah skematik (layoutrumah.png tak ditemukan)",
    fontSize: "11px",
    color: "var(--text-muted, #888)",
  });
  form.add(modeLabel);

  // Scroll container untuk denah
  const scroller = new TPanel("scroll", {
    style: {
      flex: "1",
      overflow: "auto",
      background: "transparent",
      border: "none",
      padding: "0",
      margin: "6px 0",
    },
  });

  // Stage (denah) — container relatif; isi background gambar atau skematik
  const stage = new TPanel("stage", {
    style: {
      position: "relative",
      width: `${stageW}px`,
      height: `${stageH}px`,
      background: "rgba(255, 255, 255, 0.35)",
      border: useImage ? "none" : "1px solid var(--border, #334155)",
      borderRadius: "10px",
      overflow: "hidden",
      padding: "0",
      flexShrink: "0",
    },
  });
  scroller.add(stage);

  // Background denah asli — dimuat eksplisit di onSetup (byte-safe),
  // lebih andal daripada auto-load `file` saat bind.
  let bgImage: TImage | null = null;
  if (useImage) {
    const bg = new TImage("bg-layout", {
      fit: "fill",
      style: {
        position: "absolute",
        left: "0",
        top: "0",
        width: `${stageW}px`,
        height: `${stageH}px`,
        objectFit: "fill",
        display: "block",
        userSelect: "none",
      },
    });
    stage.add(bg);
    bgImage = bg;
  } else {
    // Fallback: ruangan skematik (bila layoutrumah.png tak ditemukan)
    ROOMS.forEach((r, i) => {
      const box = new TPanel(`room-${i}`, {
        style: {
          position: "absolute",
          left: `${X(r.x)}px`,
          top: `${Y(r.y)}px`,
          width: `${Math.round(r.w * scale)}px`,
          height: `${Math.round(r.h * scale)}px`,
          background: "rgba(22,33,62,0.42)",
          border: "1px solid rgba(76,175,80,0.22)",
          borderRadius: "8px",
          padding: "4px 6px",
          display: "flex",
          alignItems: "flex-start",
          flexDirection: "column" as any,
        },
      });
      const lbl = new TLabel(`roomlbl-${i}`, {
        caption: r.name,
        fontSize: "10px",
        color: "var(--text-muted, #8fa0b5)",
        fontWeight: "600",
        lineHeight: "1.2",
      });
      box.add(lbl);
      stage.add(box);
    });
  }

  // State
  const onState = new Array<boolean>(LIGHTS.length).fill(false);
  let hwFd: number | null = null;
  let hwDevName = "";
  let running = true;

  // Ikon lampu bulbon/bulboff.png — cache data URI, dipakai sbg background tombol.
  let bulbImgOn = "";
  let bulbImgOff = "";
  let bulbImgOk = false;
  const loadBulbImages = async (): Promise<void> => {
    try {
      const readB64 = async (p: string): Promise<string> => {
        const raw: any = await fs.readFile(p);
        if (!raw) return "";
        const buf = Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(String(raw), "latin1");
        return `data:image/png;base64,${buf.toString("base64")}`;
      };
      const [on, off] = await Promise.all([
        readB64(BULB_ON_PATH),
        readB64(BULB_OFF_PATH),
      ]);
      if (on && off) {
        bulbImgOn = on;
        bulbImgOff = off;
        bulbImgOk = true;
        await std.log(
          `[smartbulb] Ikon lampu dimuat: bulbon (${Math.round(on.length / 1024)}KB), bulboff (${Math.round(off.length / 1024)}KB)`,
        );
      }
    } catch (_) {
      bulbImgOk = false;
    }
  };

  // Muat ikon lampu bulbon/bulboff.png SEBELUM membuat lampu (biar tahu pakai
  // TImage gambar atau fallback emoji). Bila gagal → fallback otomatis.
  await loadBulbImages();

  // ── IPC ke service /opt/smartbulb/service.js (identity jayalaras.service) ──
  const lib = (global as any)._tsixLib;
  const SERVICE_ID = "jayalaras.service";
  let ipcOk = false;
  const sendIpc = async (payload: Record<string, any>): Promise<boolean> => {
    try {
      await shell.send(SERVICE_ID, payload);
      return true;
    } catch (_) {
      ipcOk = false;
      return false;
    }
  };

  // ── Style lampu ──
  const bulbStyle = (on: boolean): Record<string, any> => {
    const base: Record<string, any> = {
      width: "40px",
      height: "40px",
      padding: "0",
      lineHeight: "1",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    };
    if (bulbImgOk) {
      // Pakai gambar bulbon.png / bulboff.png sebagai latar tombol.
      return {
        ...base,
        borderRadius: "0",
        border: "none",
        backgroundImage: `url(${on ? bulbImgOn : bulbImgOff})`,
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        backgroundSize: "contain",
        fontSize: "0", // sembunyikan emoji — visual sudah dari gambar
        filter: on ? "drop-shadow(0 0 6px rgba(255, 213, 79, 0.9))" : "none",
        opacity: on ? "1" : "0.8",
      };
    }
    // Fallback (tanpa bulbon/off.png): lingkaran glow + emoji 💡
    const emojiBase = {
      ...base,
      borderRadius: "50%",
      border: "2px solid",
      fontSize: "20px",
      backgroundImage: "none",
    };
    if (on) {
      return {
        ...emojiBase,
        background:
          "radial-gradient(circle at 50% 40%, #fff3b0 0%, #ffe082 35%, #ffb300 90%)",
        borderColor: "#ffd54f",
        color: "#effb13",
        boxShadow: "0 0 18px 4px rgba(247, 255, 3, 0.93)",
      };
    }
    return {
      ...emojiBase,
      background: "var(--button-bg, #0f3460)",
      borderColor: "var(--border, #475569)",
      color: "#9aa5b1",
      filter: "grayscale(1)",
      opacity: "0.6",
    };
  };

  // Posisi lampu di atas denah (kiri-atas = koordinat asli gambar, index.html)
  const bulbStyleAt = (l: LightDef, on: boolean) => ({
    position: "absolute",
    left: `${bulbL[l.idx]}px`,
    top: `${bulbT[l.idx]}px`,
    ...bulbStyle(on),
  });

  // ── Lampu: TImage (bulbon/off.png, bisa diklik) — tanpa label nama ──
  // Nama ruangan sudah ada di denah/background, jadi label bawah lampu dihapus.
  // Kalau bulbon/off.png ada → lampu = <img> asli (TImage.onClick); kalau
  // tidak → fallback tombol emoji (tetap bisa diklik).
  const useBulbImg = bulbImgOk;
  const bulbs: (TImage | TButton)[] = [];
  for (const l of LIGHTS) {
    let widget: TImage | TButton;
    if (useBulbImg) {
      const img = new TImage(`bulb-${l.idx}`, {
        width: 40,
        height: 40,
        fit: "contain",
        style: {
          position: "absolute",
          left: `${bulbL[l.idx] - 15}px`,
          top: `${bulbT[l.idx] - 15}px`,
          width: "40px",
          height: "40px",
          objectFit: "contain",
          cursor: "pointer",
          userSelect: "none",
        },
      });
      img.src = bulbImgOff; // state awal: semua lampu mati
      widget = img;
    } else {
      const btn = new TButton(`bulb-${l.idx}`, {
        caption: "💡",
        style: bulbStyleAt(l, false),
      });
      widget = btn;
    }
    bulbs.push(widget);
    stage.add(widget);
  }
  form.add(scroller);

  // ── Footer: tombol global ──
  const btnAllOn = new TButton("btn-allon", { caption: "🌕 Semua ON" });
  const btnAllOff = new TButton("btn-alloff", { caption: "🌑 Semua OFF" });
  const btnMode = new TButton("btn-mode", {
    caption: hwMode ? "🔄 Hubungkan HW" : "🎛️ Mode HW",
  });
  form.add(
    HStack({ padding: "2px 0 4px" }, btnAllOn, btnAllOff, Spacer(), btnMode),
  );

  const bar = new TStatusBar("bar");
  bar.leftText = hwMode ? "⏳ mencoba hardware..." : "Simulasi — state lokal";
  bar.rightText = `0/${LIGHTS.length} lampu nyala`;
  form.add(bar);

  // ── Helper update ──
  const upd = async (id: string, props: Record<string, any>) => {
    if (form.screen) await form.update(id, props);
  };

  const refreshBulb = async (l: LightDef) => {
    const on = onState[l.idx];
    const w = bulbs[l.idx];
    if (w instanceof TImage) {
      // Ganti gambar bulbon/bulboff langsung (src update via screen)
      w.src = on ? bulbImgOn : bulbImgOff;
    } else if (w instanceof TButton) {
      w.style = bulbStyleAt(l, on);
      await upd(`bulb-${l.idx}`, { style: w.style });
    }
  };

  const refreshAll = async () => {
    for (const l of LIGHTS) await refreshBulb(l);
    const n = onState.filter(Boolean).length;
    bar.rightText = `${n}/${LIGHTS.length} lampu nyala`;
    if (form.screen) {
      // status bar right span id = bar_right (lihat TStatusBar)
      await upd("bar_right", { text: bar.rightText });
    }
  };

  // ── Hardware write/read ──
  const hwWrite = async (port: number, on: boolean): Promise<boolean> => {
    if (hwFd === null) return false;
    try {
      const pin = portToPin(port);
      const value = on ? 0 : 1; // relay active-low
      return (
        (await fs.ioctl(hwFd, IOCTL_DIGITAL_WRITE, { pin, value })) === true
      );
    } catch (_) {
      return false;
    }
  };

  const hwReadAll = async (): Promise<number | null> => {
    if (hwFd === null) return null;
    try {
      return (await fs.ioctl(hwFd, IOCTL_READ_ALL, {})) as number | null;
    } catch (_) {
      return null;
    }
  };

  const toggle = async (idx: number) => {
    const l = LIGHT(idx);
    const targets = [l.idx];
    if (l.parent !== undefined) targets.push(l.parent);

    for (const t of targets) onState[t] = !onState[t];

    const primary = targets[0];
    const newOn = onState[primary];
    // Kalau service jalan → biarkan service yang menulis hardware.
    let okHw: boolean | null = null;
    if (ipcOk) {
      await sendIpc({ type: "SET", port: l.port, on: newOn });
    } else {
      okHw = hwFd !== null ? await hwWrite(l.port, newOn) : null;
    }

    await refreshAll();
    const lampu = l.name;
    const status = newOn ? "ON 🔆" : "OFF 🌑";
    const hwNote = ipcOk
      ? " • IPC ✓"
      : hwFd !== null
        ? okHw
          ? " • HW ✓"
          : " • HW ✗"
        : "";
    bar.leftText = `💡 ${lampu} → ${status} (port ${l.port})${hwNote}`;
    await upd("bar_left", { text: bar.leftText });
  };

  const setAll = async (val: boolean) => {
    for (let i = 0; i < LIGHTS.length; i++) onState[i] = val;
    if (ipcOk) {
      await sendIpc({ type: "SETALL", on: val });
    } else if (hwFd !== null) {
      for (let i = 0; i < LIGHTS.length; i++) {
        const l = LIGHT(i);
        if (l.parent === undefined) await hwWrite(l.port, val); // tulis sekali per relay
      }
    }
    await refreshAll();
    bar.leftText = val ? "🌕 Semua lampu ON" : "🌑 Semua lampu OFF";
    await upd("bar_left", { text: bar.leftText });
  };

  // Poll status hardware (sinkron bila ada saklar/remote lain)
  const poll = async () => {
    if (!running || hwFd === null) return;
    const raw = await hwReadAll();
    if (raw === null) return;
    for (const l of LIGHTS) {
      if (l.parent !== undefined) continue; // ikut parent
      const pin = portToPin(l.port);
      const bit = (raw >> pin) & 0x01;
      const want = bit === 0; // LOW = ON (active-low)
      if (onState[l.idx] !== want) {
        onState[l.idx] = want;
        if (l.parent !== undefined) continue;
      }
    }
    // sinkronkan anak (parent) dgn induknya
    for (const l of LIGHTS) {
      if (l.parent !== undefined) onState[l.idx] = onState[l.parent!];
    }
    await refreshAll();
  };

  const timer = new TTimer("tmr-hw", 1500, false);
  timer.onTimer = () => {
    void poll();
  };
  form.add(timer);

  // ── Connect hardware (jika --hw) ──
  const connectHw = async () => {
    if (!hwMode) return;
    for (const dev of candidates) {
      try {
        const fd = await fs.open(dev, "w+");
        if (fd !== null) {
          hwFd = fd as number;
          hwDevName = dev;
          // Pastikan pin output + tulis sesuai state awal (default semua off)
          const pins = new Set<number>();
          for (const l of LIGHTS) {
            if (l.parent === undefined) pins.add(portToPin(l.port));
          }
          for (const pin of pins) {
            await fs.ioctl(fd, IOCTL_SET_PIN_MODE, { pin, mode: MODE_OUTPUT });
          }
          const raw = await hwReadAll();
          if (raw !== null) {
            for (const l of LIGHTS) {
              if (l.parent === undefined) {
                onState[l.idx] = ((raw >> portToPin(l.port)) & 0x01) === 0;
              }
            }
            for (const l of LIGHTS) {
              if (l.parent !== undefined) onState[l.idx] = onState[l.parent!];
            }
            await refreshAll();
          }
          modeLabel.caption = `Mode: HARDWARE — ${dev} (active-low relay)`;
          bar.leftText = `🔌 Terhubung ke ${dev}`;
          await upd("mode", { text: modeLabel.caption });
          await upd("bar_left", { text: bar.leftText });
          timer.enabled = true;
          await std.log(`[smartbulb] Hardware connected: ${dev}`);
          return;
        }
      } catch (e: any) {
        await std.log(`[smartbulb] ${dev} tidak tersedia: ${e?.message || e}`);
      }
    }
    hwMode = false;
    modeLabel.caption = "Mode: SIMULASI (device MCP23017 tidak ditemukan)";
    bar.leftText = "Simulasi — state lokal";
    await upd("mode", { text: modeLabel.caption });
    await upd("bar_left", { text: bar.leftText });
  };

  // ── Event binding ──
  for (const l of LIGHTS) {
    const btn = bulbs[l.idx];
    btn.onClick = () => {
      void toggle(l.idx).catch(() => {});
    };
  }
  btnAllOn.onClick = () => {
    void setAll(true).catch(() => {});
  };
  btnAllOff.onClick = () => {
    void setAll(false).catch(() => {});
  };
  btnMode.onClick = () => {
    hwMode = true;
    modeLabel.caption = "⏳ menghubungkan hardware...";
    void upd("mode", { text: modeLabel.caption });
    void connectHw().catch(() => {});
  };

  // Muat denah — baca file VFS lalu konversi ke data URI (byte-safe: Buffer
  // atau latin1 string → base64). Dipanggil beberapa kali dengan jeda: sama
  // seperti image-viewer (gambar dimuat setelah DOM settle), update yang
  // dikirim terlalu dini saat mount bisa hilang.
  const loadLayoutImage = async () => {
    if (!bgImage) return;
    try {
      const raw: any = await fs.readFile(LAYOUT_PATH);
      if (!raw) return;
      const buf = Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(String(raw), "latin1");
      bgImage.setBase64(buf.toString("base64"), "image/png");
      await std.log(`[smartbulb] Denah dimuat: ${buf.length} byte`);
    } catch (e: any) {
      await std.log(`[smartbulb] Gagal memuat denah: ${e?.message || e}`);
    }
  };

  // Dengarkan update dari service (push state → tampil di denah).
  lib?.onEvent?.("ipc_message", (msg: any) => {
    const p = msg?.data || msg;
    if (!p || p.type !== "SMARTBULB_STATE" || !Array.isArray(p.ports)) return;
    if (!form.screen || !running) return;
    let changed = false;
    for (const l of LIGHTS) {
      const want = !!p.ports[l.port];
      if (onState[l.idx] !== want) {
        onState[l.idx] = want;
        changed = true;
      }
    }
    if (changed) {
      bar.leftText = "📡 Update dari service";
      void upd("bar_left", { text: bar.leftText });
      void refreshAll();
    }
  });

  form.onSetup = async () => {
    await refreshAll();
    // Coba sambung ke service (kalau berjalan). Gagal → mode lama (sim/--hw).
    const ok = await sendIpc({ type: "REGISTER" });
    ipcOk = ok;
    if (ok) {
      modeLabel.caption = "Mode: SERVICE — jayalaras.service (IPC)";
      bar.leftText = "🔌 Terhubung ke jayalaras.service";
      await upd("mode", { text: modeLabel.caption });
      await upd("bar_left", { text: bar.leftText });
    }
    const s = form.screen;
    // Coba sekarang, lalu ulangi setelah DOM settle (idempotent).
    await new Promise((r) => setTimeout(r, 80));
    await loadLayoutImage();
    if (s) {
      s.setTimeout(() => {
        void loadLayoutImage();
      }, 400);
      s.setTimeout(() => {
        void loadLayoutImage();
      }, 1200);
    }
    if (!ipcOk && hwMode) await connectHw();
  };

  form.onClose = () => {
    running = false;
    if (ipcOk) void sendIpc({ type: "UNREGISTER" });
    try {
      if (hwFd !== null && fs.close) void fs.close(hwFd);
    } catch (_) {
      /* ignore */
    }
  };

  await form.run();
});
