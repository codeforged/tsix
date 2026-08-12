/**
 * ddc.ts — Direct Draw and Control (DDC) for TSIX
 *
 * Framework untuk aplikasi animasi Native JavaScript (NJ) di dalam
 * window TSIX. Animasi berjalan 100% di browser (zero WebSocket
 * per-frame), komunikasi tetap lewat mekanisme PixelSpace.
 *
 * Arsitektur (2 file):
 *   1. TGA (TSIX GUI App)      — bikin window, mount <ddc>, kirim pesan
 *   2. NJ (Native JavaScript)  — file .nj, di-load & dikirim ke browser,
 *      berjalan dalam konteks window TGA (Shadow DOM, hak gambar terbatas)
 *
 *      TGA (Worker) ──DDC_MSG──► DOME ──► Browser: NJ.onMessage()
 *      NJ (Browser)  ──ddc_event──► DOME ──► TGA: DDCApp.on()
 *
 * Pola pemakaian:
 *   import { mountDDC } from "@tsix/ddc";
 *
 *   const anim = await mountDDC(app, {
 *     id: "particles",
 *     source: (await fs.readFile("/opt/ddc/particles.nj")) || "",
 *     width: 400,
 *     height: 300,
 *   }, "stage-container");
 *
 *   // TGA → NJ
 *   anim.send({ cmd: "burst", x: 100, y: 100 });
 *
 *   // NJ → TGA
 *   anim.on("ready", (ev) => { ... });
 *   anim.on("click", (ev) => { ... });
 *   anim.on("count", (ev) => { ... });
 *
 *   anim.resize(600, 400);
 *   await anim.destroy();   // saat window tutup
 *
 * Catatan: protocol ini butuh DOME client (dome-client-ddc.js) yang
 * menangani tag "ddc" + relay DDC_MSG/DDC_RESIZE/DDC_STOP di dome.ts.
 */

import { Screen } from "@tsix/emerald";
import { shell, fs } from "@tsix/Application";
import { IDOMNode } from "../../common/GUITypes";

// ================================================================
// DDC TRUST GATE — hanya untuk aplikasi yang menjalankan NJ (mountDDC)
// ================================================================
// NJ dieksekusi sebagai JS native di browser (global scope), jadi ini
// satu-satunya titik yang benar-benar bisa mengakses DOM app lain.
// TGA (declarative) & CLI/daemon tidak di-gate.
//
// Aturan:
//   - Gate SEKALI per proses (cache approved/denied per app name).
//   - Fail-open: jika Asteracea/DOME tidak running → izinkan (anti-hang).
//   - Prompt via Asteracea: kirim DDC_TRUST → Asteracea confirm → balas.
//   - Persist ke /opt/asteracea/trust/ddc-trusted.list & ddc-blocked.list.

const DDC_TRUST_DIR = "/opt/asteracea/trust";
const DDC_TRUSTED = DDC_TRUST_DIR + "/ddc-trusted.list";
const DDC_BLOCKED = DDC_TRUST_DIR + "/ddc-blocked.list";
/** Asteracea WM UUID (sama dengan di asteracea.ts). */
const AST_UUID = "3ec3ffe9-e0a6-411f-b7e3-c9ff0b00556c";
/** Cache per-proses: appName → status. Gate hanya sekali per proses. */
const _ddcTrustCache = new Map<string, boolean>();

/** Baca list (satu baris per app name). */
async function _readDdcList(path: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path);
    if (!raw) return [];
    return String(raw)
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  } catch {
    return [];
  }
}

/** Tulis list. */
async function _writeDdcList(path: string, list: string[]): Promise<void> {
  try {
    await fs.mkdir(DDC_TRUST_DIR);
  } catch (_) { }
  try {
    await fs.writeFile(path, list.join("\n") + "\n");
  } catch (_) { }
}

/**
 * Tanyakan trust DDC ke Asteracea (blocking, dengan timeout).
 * @returns true = diizinkan, false = ditolak.
 */
async function _askAsteraceaTrust(appName: string): Promise<boolean> {
  const lib = (global as any)._tsixLib as any;
  if (!lib) return true; // fail-open
  return new Promise<boolean>((resolve) => {
    const requestId = "ddc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    let done = false;
    const handler = (msg: any) => {
      const ev = msg?.data || msg;
      const data = ev?.data || ev;
      if (data?.type === "DDC_TRUST_RESULT" && data.requestId === requestId) {
        done = true;
        if (typeof lib.offEvent === "function") lib.offEvent("ipc_message", handler);
        resolve(data.allowed === true);
      }
    };
    lib.onEvent("ipc_message", handler);
    lib.shell
      .send(AST_UUID, {
        type: "DDC_TRUST",
        requestId,
        appName,
        fromPid: lib.getPid ? lib.getPid() : 0,
      })
      .catch(() => { });
    // Timeout 30s → fail-CLOSED (tolak). Lebih aman menolak daripada
    // mengizinkan NJ tanpa keputusan. (DCC butuh WM/Asteracea — kalau WM
    // tidak ada, DDC tidak bisa berfungsi juga, jadi tolak lebih tepat.)
    setTimeout(() => {
      if (!done) {
        if (typeof lib.offEvent === "function") lib.offEvent("ipc_message", handler);
        resolve(false);
      }
    }, 30000);
  });
}

/**
 * Gate utama: cek trust DDC untuk app pemanggil.
 * Dipanggil SEKALI per proses (cache).
 */
async function _ddcTrustGate(appName: string): Promise<boolean> {
  if (!appName) return true; // fail-open
  if (_ddcTrustCache.has(appName)) return _ddcTrustCache.get(appName)!;

  const [trusted, blocked] = await Promise.all([
    _readDdcList(DDC_TRUSTED),
    _readDdcList(DDC_BLOCKED),
  ]);

  let allowed: boolean;
  if (trusted.includes(appName)) {
    allowed = true;
  } else if (blocked.includes(appName)) {
    allowed = false;
  } else {
    // Unknown → prompt via Asteracea. Asteracea yang memutuskan & mengelola
    // persist (Yes → ddc-trusted, No → ddc-blocked, Cancel → tanpa diingat).
    allowed = await _askAsteraceaTrust(appName);
  }

  _ddcTrustCache.set(appName, allowed);
  return allowed;
}

/** Ambil nama proses pemanggil via `shell.ps()` (stabil antar panggilan). */
async function _currentAppName(): Promise<string> {
  try {
    const lib = (global as any)._tsixLib as any;
    const myPid = lib?.getPid ? lib.getPid() : 0;
    const procs = (await shell.ps()) || [];
    const me = procs.find((p: any) => p.pid === myPid);
    return me?.name || String(myPid);
  } catch {
    return "";
  }
}

// ================================================================
// OPTIONS
// ================================================================

export interface DDCAppOptions {
  /** ID unik elemen — dipakai sebagai targetId komunikasi DDC */
  id: string;
  /** Source code NJ (string) — biasanya dibaca dari VFS via fs.readFile */
  source: string;
  /** Ukuran awal (logical px). Default: ukuran container di window */
  width?: number;
  height?: number;
}

// ================================================================
// DDCAPP — handle satu widget <ddc>
// ================================================================

export class DDCApp {
  public readonly id: string;
  private screen: Screen;
  private wid: string;
  private lib: any;
  private opts: DDCAppOptions;
  private domePid = 0;
  private listeners = new Map<string, Set<(ev: any) => void>>();
  private stopped = false;
  private onIpcBound = false;
  /** Apakah sudah lolos trust gate (gate hanya sekali per DDCApp). */
  private _gatePassed = false;

  constructor(screen: Screen, opts: DDCAppOptions) {
    this.screen = screen;
    this.opts = opts;
    this.id = opts.id;
    this.wid = screen.wid;
    this.lib = (global as any)._tsixLib;
    if (!this.lib) {
      throw new Error("ddc: UserLib not found. Are you running in TSIX Worker?");
    }
  }

  // ============================================================
  // LIFECYCLE
  // ============================================================

  /** Pasang elemen <ddc> ke window (root window jika parentId tidak diisi) */
  async mount(parentId?: string): Promise<this> {
    // ── DDC TRUST GATE — hanya di sini (NJ dieksekusi di browser) ──
    // Prompt sekali per proses (cache di _ddcTrustCache). Fail-open hanya
    // jika Asteracea tidak merespon (timeout). Ditolak/Cancel → KILL app.
    if (!this._gatePassed) {
      const appName = await _currentAppName();
      this._gatePassed = await _ddcTrustGate(appName);
      if (!this._gatePassed) {
        // Ditolak / Cancel → hentikan proses TGA agar app TIDAK lanjut jalan.
        // shell.exit() non-blocking (cleanup async), jadi tutup window dulu
        // lalu SIGKILL diri sebagai jaminan.
        try {
          const lib = this.lib as any;
          // 1) Tutup window TGA biar UI tidak tersisa
          try { await this.screen?.win?.close?.(); } catch (_) { }
          // 2) Graceful exit
          try { if (typeof lib?.shell?.exit === "function") await lib.shell.exit(1); } catch (_) { }
          // 3) Force-kill diri (SIGKILL) — jamin worker benar-benar berhenti
          try {
            const myPid = lib?.getPid ? lib.getPid() : 0;
            if (typeof lib?.shell?.kill === "function" && myPid)
              await lib.shell.kill(myPid, 9);
          } catch (_) { }
        } catch (_) { }
        throw new Error(
          "DDC blocked by trust gate: app '" +
          (appName || "?") +
          "' is not allowed to run Native JS (NJ).",
        );
      }
    }

    const node: IDOMNode = {
      id: this.id,
      tag: "ddc" as any,
      props: {
        source: this.opts.source,
        width: this.opts.width,
        height: this.opts.height,
      },
      children: [],
    };
    await this.screen.mount(node, parentId);
    this.bindIpc();
    await this.resolveDomePid();
    return this;
  }

  /** Kirim pesan ke NJ (→ browser via DDC_MSG) */
  async send(data: any): Promise<void> {
    if (this.stopped || !this.domePid) return;
    try {
      await shell.send(this.domePid, {
        type: "DDC_MSG",
        wid: this.wid,
        targetId: this.id,
        data: typeof data === "string" ? data : JSON.stringify(data),
      });
    } catch (_) {
      /* DOME tidak running / sudah tutup */
    }
  }

  /** Ubah ukuran canvas dari luar (programmatic). Auto-resize window
   *  sudah ditangani ResizeObserver di browser — ini untuk kasus khusus. */
  async resize(width: number, height: number): Promise<void> {
    if (this.stopped || !this.domePid) return;
    try {
      await shell.send(this.domePid, {
        type: "DDC_RESIZE",
        wid: this.wid,
        targetId: this.id,
        width,
        height,
      });
    } catch (_) {
      /* ignore */
    }
  }

  /** Hentikan NJ (stop RAF + panggil NJ onDestroy + cleanup) */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.domePid) {
      try {
        await shell.send(this.domePid, {
          type: "DDC_STOP",
          wid: this.wid,
          targetId: this.id,
        });
      } catch (_) {
        /* ignore */
      }
    }
    this.listeners.clear();
  }

  /** Hentikan + lepas elemen dari window */
  async destroy(): Promise<void> {
    await this.stop();
    try {
      await this.screen.win.unmount(this.id);
    } catch (_) {
      /* sudah tidak ada */
    }
  }

  // ============================================================
  // EVENTS — dari NJ (melalui PixelSpace)
  // ============================================================

  /** Daftarkan listener event dari NJ.
   *  - NJ kirim { event: "ready", data: ... } → anim.on("ready", cb)
   *  - Mouse forwarded → anim.on("mouse", cb)   ({ type, x, y, button })
   *  - Keyboard forwarded → anim.on("key", cb)  ({ key, code, ctrl, ... }) */
  on(event: string, cb: (ev: any) => void): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(cb);
    return this;
  }

  off(event: string, cb: (ev: any) => void): this {
    this.listeners.get(event)?.delete(cb);
    return this;
  }

  // ============================================================
  // PRIVATE
  // ============================================================

  private emit(event: string, data: any): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(data);
      } catch (_) {
        /* handler error — jangan matikan app */
      }
    }
  }

  private bindIpc(): void {
    if (this.onIpcBound) return;
    this.onIpcBound = true;
    this.lib.onEvent("ipc_message", (msg: any) => {
      const ev = msg?.data || msg;
      if (!ev || ev.type !== "GUI_EVENT") return;
      if (ev.wid !== this.wid || ev.targetId !== this.id) return;

      let data: any;
      try {
        data = ev.value ? JSON.parse(ev.value) : undefined;
      } catch (_) {
        data = ev.value;
      }

      if (ev.eventType === "ddc_event") {
        // NJ.send({ event: "name", data: ... }) → on("name")
        const name =
          data && typeof data === "object" && data.event
            ? String(data.event)
            : "event";
        const payload =
          data && typeof data === "object" && "data" in data
            ? data.data
            : data;
        this.emit(name, payload);
        this.emit("event", { event: name, data: payload });
      } else if (ev.eventType === "ddc_mouse") {
        this.emit("mouse", data);
      } else if (ev.eventType === "ddc_key") {
        this.emit("key", data);
      }
    });
  }

  private async resolveDomePid(): Promise<void> {
    try {
      const ps = await shell.ps();
      this.domePid =
        (ps.find((p: any) => p.name?.includes("dome")) || {}).pid || 0;
    } catch (_) {
      this.domePid = 0;
    }
  }
}

// ================================================================
// MOUNTDDC — helper convenience
// ================================================================

/**
 * mountDDC(): Buat + pasang widget <ddc> dalam satu panggilan.
 *
 * @param screen   Screen/Window tempat NJ berjalan (konteks window TGA)
 * @param opts     Konfigurasi DDC (id, source, width, height)
 * @param parentId ID container tempat elemen dipasang (default: root)
 */
export async function mountDDC(
  screen: Screen,
  opts: DDCAppOptions,
  parentId?: string,
): Promise<DDCApp> {
  const app = new DDCApp(screen, opts);
  await app.mount(parentId);
  return app;
}
