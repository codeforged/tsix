# 🖌️ DDC — Direct Draw and Control (Native JS di Window TSIX)

**DDC** adalah framework untuk aplikasi animasi/visual yang berjalan **100% di browser** di dalam window TSIX, tapi tetap terhubung ke aplikasi TSIX (TGA) lewat **mekanisme PixelSpace**. Ini jawaban untuk app yang butuh reaksi cepat (game, particle, dashboard real-time) tanpa banjiri WebSocket per-frame.

Setara dengan pola `xterm.js` / `CodeMirror` di TSIX, tapi digeneralisasi jadi **"Native JavaScript widget"** yang bisa gambar bebas (canvas + Fabric.js) dan dianimasikan dengan RAF di browser.

```
┌────────────────────────────────────────────────────────────────────┐
│  DDC = 2 file:                                                     │
│    • TGA  (TSIX GUI App, Worker)  — window, komponen, file, audio  │
│    • NJ   (Native JavaScript, Browser) — animasi, logic game       │
└────────────────────────────────────────────────────────────────────┘
```

---

## 📌 Posisi DDC di TSIX Desktop Environment

```
┌──────────────────────────────────────────────────────────────────────────┐
│  TSIX Desktop                                                           │
│                                                                         │
│  ┌─────────────────────────┐          ┌──────────────────────────────┐  │
│  │  TGA (Worker)           │          │  Browser (DOME)             │  │
│  │  • Window/Screen        │          │                             │  │
│  │  • Cashew/Emerald UI    │          │  ┌────────────────────────┐ │  │
│  │  • fs baca/tulis file   │  DDC_MSG │  │  <ddc> → Shadow DOM    │ │  │
│  │  • play audio (PLAY_SOUND) ────────┼─►│   └─ <canvas>           │ │  │
│  │  • DDCApp.send()/on()   │  ddc_event│  │       └─ NJ (Fabric)   │ │  │
│  └────────────┬────────────┘          │  │          RAF loop       │ │  │
│               │ GUI_REQ               │  │          zero-WS/frame  │ │  │
│  ┌────────────▼────────────┐          │  └────────────────────────┘ │  │
│  │  Kernel (Ring 1)        │          │                             │  │
│  │  • syscall GUI_REQ      │  WS       │                             │  │
│  │  • routing GUI_EVENT    │◄────────►│                             │  │
│  └─────────────────────────┘          └──────────────────────────────┘  │
│                                                                         │
│  Stack: Emerald (IDOMNode) → DOME IPC → Browser DOM                    │
│  DDC:   memotong jalur — animasi di browser, TGA tetap otoritas         │
└──────────────────────────────────────────────────────────────────────────┘
```

### Komponen Arsitektur

| Bagian | File | Peran |
|:-------|:-----|:------|
| **Worker API** | `src/mirror/lib/ddc.ts` | `DDCApp` class + `mountDDC()` (import `@tsix/ddc`) |
| **Browser module** | `src/mirror/opt/dome/dome-client-ddc.js` | mount `<ddc>` + Shadow DOM + NJ runtime + inbound `DDC_*` |
| **DOM special-case** | `src/mirror/opt/dome/dome-client-dom.js` | `node.tag === "ddc"` di `buildDOM()` |
| **Server relay** | `src/mirror/opt/dome/dome.ts` | relay `DDC_MSG` / `DDC_RESIZE` / `DDC_STOP` + static asset |
| **HTML client** | `src/mirror/opt/dome/dome-client.html` | load Fabric.js (CDN) + `dome-client-ddc.js` |

### Alur Pesan (Protocol)

```
TGA → NJ :  DDC_MSG   { wid, targetId, data }        → NJ.onMessage(data)
TGA → NJ :  DDC_RESIZE{ wid, targetId, width, height} → NJ.onResize(w,h)
TGA → NJ :  DDC_STOP  { wid, targetId }              → NJ.onDestroy()

NJ → TGA :  ddc_event { wid, targetId, value: JSON }  → DDCApp.on("name", data)
NJ → TGA :  ddc_mouse { ... }                         → DDCApp.on("mouse", ev)
NJ → TGA :  ddc_key   { ... }                         → DDCApp.on("key", ev)
```

---

## 🚀 Quick Start — Aplikasi DDC Pertama

### 1. File NJ — `particles.js` (jalan di browser)

```js
DDC.onInit(function (ctx) {
  var W = ctx.width;
  var H = ctx.height;
  var canvas = new ctx.fabric.Canvas(ctx.canvas, { selection: false });

  var dot = new ctx.fabric.Circle({
    left: W / 2 - 10, top: H / 2 - 10, radius: 10, fill: "#4caf50",
  });
  canvas.add(dot);

  function frame() {
    dot.left += 2;               // gerak kanan
    if (dot.left > W) dot.left = 0;
    canvas.renderAll();
    ctx.raf(frame);              // loop RAF di browser — ZERO WebSocket
  }
  ctx.raf(frame);

  ctx.send({ event: "ready", data: { width: W, height: H } });
});
```

### 2. File TGA — `ddc-demo.ts` (Worker)

```typescript
import { Program, std, fs } from "@tsix/Application";
import { TForm, TPanel } from "@tsix/cashew";
import { mountDDC } from "@tsix/ddc";
import { theme } from "@tsix/theme";

export const main = Program(async () => {
  await theme.loadCurrent();
  const form = new TForm("DDC Demo", 480, 360);

  const stage = new TPanel("stage", {
    flex: "1", minHeight: "0", padding: "0", overflow: "hidden",
  });
  form.add(stage);

  form.onSetup = async (screen) => {
    const src = (await fs.readFile("/opt/ddc-demo/particles.js")) || "";
    const anim = await mountDDC(
      screen,
      { id: "ddc-canvas", source: src, width: 460, height: 300 },
      "stage",
    );
    anim.on("ready", (ev) => std.log("NJ siap: " + ev.width + "x" + ev.height));
  };

  await form.run();
});
```

> ⚠️ **Konvensi 2 file**: TGA dan NJ ditaruh **satu folder** (mis. `opt/ddc-demo/`), NJ ber-ekstensi `.js` (bukan TS) biar syntax highlighting normal & disimpan apa adanya di VFS.

---

## 🧱 Membuat Objek & Animasi

NJ bisa gambar dua cara: **raw 2D canvas** (ringan, pasti render) atau **Fabric.js** (object model, hit-testing, events).

### Raw 2D Canvas

```js
DDC.onInit(function (ctx) {
  var c2 = ctx.canvas.getContext("2d");
  function frame() {
    c2.clearRect(0, 0, ctx.width, ctx.height);
    c2.fillStyle = "#ff5252";
    c2.beginPath();
    c2.arc(ctx.width / 2, ctx.height / 2, 20, 0, Math.PI * 2);
    c2.fill();
    ctx.raf(frame);
  }
  ctx.raf(frame);
});
```

> Catatan: raw 2D digambar **setelah** `canvas.renderAll()` kalau dipakai bareng Fabric (biar gak ketimpa).

### Fabric.js (object model)

```js
DDC.onInit(function (ctx) {
  var canvas = new ctx.fabric.Canvas(ctx.canvas, {
    selection: false, preserveObjectStacking: true,
  });

  var ball = new ctx.fabric.Circle({
    left: 10, top: 10, radius: 20,
    fill: "#2196f3", stroke: "#fff", strokeWidth: 2,
  });
  canvas.add(ball);

  // animasi Fabric (object.animate) — jalan client-side
  ball.animate("left", ctx.width - 50, {
    duration: 1000, onChange: canvas.renderAll.bind(canvas),
  });
});
```

### API Konteks NJ (`ctx`)

| Property | Keterangan |
|:---------|:-----------|
| `ctx.canvas` | `<canvas>` element (di dalam Shadow DOM window ini) |
| `ctx.width`, `ctx.height` | Ukuran logical (CSS px) |
| `ctx.dpr` | Device pixel ratio (buat retina manual) |
| `ctx.fabric` | Fabric.js namespace (MIT, di-load CDN) |
| `ctx.now()` | `performance.now()` |
| `ctx.raf(cb)` | `requestAnimationFrame` (loop animasi) |
| `ctx.send(data)` | Kirim pesan ke TGA (sparse — jangan per-frame) |
| `ctx.onMessage` | Setter: terima pesan dari TGA |
| `ctx.onResize` | Setter: dipanggil saat ukuran berubah |
| `ctx.onKey` | Setter: keyboard langsung di browser (zero-WS) |
| `ctx.onDestroy` | Setter: cleanup saat DDC di-stop |

---

## 🧰 Library Bebas — Bring Your Own Library

NJ adalah **plain JS murni** yang dievaluasi di global scope browser. Artinya DDC **tidak mengikat ke library manapun** — programmer bebas pakai library animasi/rendering favoritnya. Cukup tambah CDN library di `dome-client.html`, lalu akses langsung dari NJ:

```html
<!-- dome-client.html — tambah library favorit -->
<script src="https://.../three.min.js"></script>  <!-- global THREE -->
<script src="https://.../pixi.min.js"></script>   <!-- global PIXI -->
<script src="https://.../gsap.min.js"></script>   <!-- global gsap -->
```

```js
DDC.onInit(function (ctx) {
  var scene = new THREE.Scene();          // 3D
  // atau
  gsap.to(el, { x: 100, duration: 1 });   // tween
});
```

| Kebutuhan | Library | Akses di NJ |
|:----------|:--------|:------------|
| 2D object model | Fabric.js (default) | `ctx.fabric` |
| 3D | Three.js | global `THREE` |
| 2D game/rendering | PixiJS | global `PIXI` |
| Animasi tween | GSAP | global `gsap` |
| Data viz | D3 | global `d3` |
| Murni ringan | Canvas biasa | `ctx.canvas.getContext("2d")` |

**Satu-satunya syarat**: library di-load di `dome-client.html` (NJ tidak bisa `import`/`require`).

> Deteksi otomatis: kalau source NJ **tidak menyebut `fabric`**, DDC langsung start tanpa menunggu CDN Fabric — jadi NJ canvas murni tetap ringan & cepat.

---

## 🔌 Interfacing NJ ↔ TGA

### TGA → NJ (`DDCApp.send`)

```typescript
anim.send({ cmd: "burst", x: 100, y: 200 });  // objek → JSON.stringify
anim.send("raw string");                      // atau string langsung
```

NJ menerima di `ctx.onMessage`:

```js
ctx.onMessage = function (msg) {
  if (msg.cmd === "burst") spawnParticles(msg.x, msg.y);
};
```

### NJ → TGA (`ctx.send` → `anim.on`)

```js
// NJ — event bernama
ctx.send({ event: "score", data: 42 });
ctx.send({ event: "ready", data: { width: W, height: H } });
```

```typescript
// TGA — terima di handler sesuai nama event
anim.on("ready", (ev) => console.log(ev.width, ev.height)); // ev = data
anim.on("score", (ev) => console.log("Score:", ev));        // ev = 42
```

> Aturan: `ctx.send({ event: "nama", data: X })` → `anim.on("nama", (ev) => ...)` dengan `ev === X`.
> Tanpa field `event`, dipancarkan sebagai `anim.on("event", ...)` dengan objek penuh.

### Keyboard (game) — langsung di browser

```js
ctx.onKey = function (k) {
  // k = { key, code, ctrl, shift, alt, down, repeat }
  if (k.key === "ArrowLeft") keys.left = k.down;   // held-state via keyup
  if ((k.key === " " || k.code === "Space") && k.down && !k.repeat) shoot();
};
```

- `down: true/false` → tracking tombol ditahan
- `repeat` → cegah shoot berulang saat tombol di-tahan
- DDC **auto-focus** canvas + **fokus balik** setelah klik tombol (Spasi gak nge-click ulang button)
- Keyboard tetap di-forward ke TGA (`anim.on("key", ...)`) sebagai opsi

### Mouse

NJ bisa baca mouse via Fabric (`canvas.on("mouse:down", ...)`), dan browser juga **auto-forward** ke TGA:

```typescript
anim.on("mouse", (ev) => {
  // ev = { type: "mousedown"|"mouseup"|"click"|"dblclick", x, y, button }
});
```

---

## 🔊 Play Audio

Pola `PLAY_SOUND` (sama seperti Asteracea): **TGA baca MP3 → base64 → kirim ke DOME → browser mainin**.

```typescript
import { Program, std, fs, shell } from "@tsix/Application";

const DOME_UUID = "da8711c2-5ca9-4f00-ad13-f1226f95594c";
const sfxCache: Record<string, string> = {};

async function loadSfx(name: string): Promise<string | null> {
  if (sfxCache[name]) return sfxCache[name];
  const path = `/opt/ddc-demo/${name}.mp3`;
  try {
    const raw = await fs.readFile(path);
    if (raw) {
      sfxCache[name] = Buffer.from(raw, "latin1").toString("base64");
      return sfxCache[name];
    }
  } catch (_) {}
  return null;
}

async function playSfx(name: string) {
  const b64 = await loadSfx(name);
  if (!b64) return;
  await shell.send(DOME_UUID, { type: "PLAY_SOUND", data: b64 });
}
```

NJ cukup trigger event sparse:

```js
// NJ
shoot();   →  ctx.send({ event: "sound", data: "laser" });
explode(); →  ctx.send({ event: "sound", data: "explode" });
```

```typescript
// TGA
anim.on("sound", async (ev) => {
  if (ev === "laser" || ev === "explode") await playSfx(ev);
});
```

> Di browser, `PLAY_SOUND` dimainkan via `new Audio("data:audio/mpeg;base64," + data)`. Preload MP3 di startup biar bunyi pertama gak nunggu baca file.

---

## 💾 Akses Baca/Tulis File

File diakses **di sisi TGA** (Worker punya akses VFS; NJ di browser tidak). Pola: baca di startup → kirim ke NJ via handshake `ready` → NJ kabari TGA saat mau persist.

### Baca + buat kalau belum ada

```typescript
const HS_PATH = "/opt/ddc-demo/highscore.txt";
let persistedHigh = 0;
let hsExists = true;
try {
  const raw = await fs.readFile(HS_PATH);
  if (raw) persistedHigh = parseInt(String(raw).trim(), 10) || 0;
  else hsExists = false;               // null = belum ada
} catch (e) { hsExists = false; }       // throw "File not found" = belum ada
if (!hsExists) await fs.writeFile(HS_PATH, "0");  // buat default
```

### Tulis

```typescript
await fs.writeFile(HS_PATH, String(score));
```

### Kirim nilai awal ke NJ (handshake)

```typescript
anim.on("ready", () => {
  void anim?.send({ cmd: "initHighScore", value: persistedHigh });
});
```

```js
// NJ
ctx.onMessage = function (msg) {
  if (msg.cmd === "initHighScore") highScore = Number(msg.value) || 0;
};
```

> Kenapa handshake lewat `ready`? NJ butuh ~100ms+ untuk init di browser. Kalau TGA kirim langsung abis mount, pesan bisa kedrop karena `onMessage` belum terpasang.

---

## 🧪 Contoh Lengkap

### Contoh 1 — Particle sederhana (Fabric)

`opt/ddc-demo/particles.js`:
```js
DDC.onInit(function (ctx) {
  var W = ctx.width, H = ctx.height;
  var canvas = new ctx.fabric.Canvas(ctx.canvas, { selection: false });
  var dots = [];
  var colors = ["#ff5252", "#ffb300", "#4caf50", "#2196f3", "#e040fb"];

  function add(x, y) {
    var c = new ctx.fabric.Circle({ left: x, top: y, radius: 8, fill: colors[(Math.random()*colors.length)|0] });
    c.vx = (Math.random() - 0.5) * 4;
    c.vy = (Math.random() - 0.5) * 4;
    canvas.add(c);
    dots.push(c);
  }

  function frame() {
    for (var i = 0; i < dots.length; i++) {
      dots[i].left += dots[i].vx;
      dots[i].top  += dots[i].vy;
    }
    canvas.renderAll();
    ctx.raf(frame);
  }

  canvas.on("mouse:down", function (opt) {
    add(opt.pointer.x, opt.pointer.y);
    ctx.send({ event: "count", data: dots.length });
  });

  ctx.onMessage = function (msg) {
    if (msg.cmd === "clear") { dots.length = 0; canvas.clear(); }
  };

  for (var i = 0; i < 10; i++) add(Math.random()*W, Math.random()*H);
  ctx.send({ event: "ready", data: { width: W, height: H } });
  ctx.raf(frame);
});
```

### Contoh 2 — Game Balloon Pop (ringkas)

Fitur: balon turun, player gerak (panah), tembak (spasi), collision, nyawa, game over, high score, audio.

```js
DDC.onInit(function (ctx) {
  var W = ctx.width, H = ctx.height;
  var canvas = new ctx.fabric.Canvas(ctx.canvas, { selection: false });
  var balloons = [], bullets = [], score = 0, lives = 5, gameOver = false;
  var keys = { left: false, right: false };
  var colors = ["#ff5252", "#ffb300", "#4caf50", "#2196f3", "#e040fb", "#00e5ff"];

  // Player (segitiga)
  var player = new ctx.fabric.Triangle({ left: W/2-15, top: H-48, width: 30, height: 38, fill: "#fff", stroke: "#4caf50", strokeWidth: 2 });
  canvas.add(player);

  function spawn() { // balon = objek plain, digambar manual (raw 2D lebih andal)
    var r = 10 + Math.random()*10;
    balloons.push({ x: W/2 + (Math.random()-0.5)*140, y: -r*2-5, r: r, vx: (Math.random()-0.5)*0.7, vy: 0.6+Math.random()*0.9, color: colors[(Math.random()*colors.length)|0] });
  }

  function shoot() {
    var u = new ctx.fabric.Rect({ left: player.left+13, top: player.top-14, width: 4, height: 14, fill: "#ffd54f", selectable: false, evented: false });
    u.vy = -7.5; canvas.add(u); bullets.push(u);
    ctx.send({ event: "sound", data: "laser" });           // 🔊
  }

  function explode(b) { /* partikel */ ctx.send({ event: "sound", data: "explode" }); }

  function drawBalloons() { /* raw 2D: ellipse + stroke gelap */ }
  function drawLives()    { /* ♥ di kiri atas */ }
  function drawScore()    { /* skor di kanan atas */ }
  function drawGameOver() { /* overlay + high score di tengah */ }

  function frame() {
    if (gameOver) { canvas.renderAll(); drawGameOver(); ctx.raf(frame); return; }
    if (keys.left) player.left -= 4.5;
    if (keys.right) player.left += 4.5;
    player.left = Math.max(0, Math.min(W - 30, player.left));

    for (var i = balloons.length-1; i >= 0; i--) {
      var b = balloons[i]; b.x += b.vx; b.y += b.vy;
      if (b.y - b.r > H) { balloons.splice(i,1); score = Math.max(0, score-5); }
    }
    for (var i = bullets.length-1; i >= 0; i--) {
      var u = bullets[i]; u.top += u.vy;
      for (var j = balloons.length-1; j >= 0; j--) {
        var b = balloons[j];
        if (Math.hypot(u.left+2-b.x, u.top+7-b.y) < b.r+3) {
          explode(b); balloons.splice(j,1); canvas.remove(u); bullets.splice(i,1);
          score += 10; ctx.send({ event: "score", data: score }); break;
        }
      }
    }
    canvas.renderAll(); drawBalloons(); drawScore(); drawLives();
    ctx.raf(frame);
  }

  ctx.onKey = function (k) {
    if (k.key === "ArrowLeft") keys.left = k.down;
    if (k.key === "ArrowRight") keys.right = k.down;
    if ((k.key === " " || k.code === "Space") && k.down && !k.repeat) shoot();
  };

  ctx.onMessage = function (msg) {
    if (msg.cmd === "newGame") { /* reset: score, lives, gameOver, balon */ }
  };

  for (var i = 0; i < 3; i++) spawn();
  ctx.send({ event: "ready", data: { width: W, height: H } });
  ctx.raf(frame);
});
```

TGA lengkapnya lihat `src/mirror/opt/ddc-sample/ddc-sample2.ts` (termasuk TButton New Game di luar panel, persist high score, dan play audio).

---

## 📦 Instalasi & Deploy

### Menyiapkan DDC (sekali saja)

1. Sudah termasuk di source TSIX — tidak ada npm install.
2. `dome-client.html` memuat Fabric.js via CDN (MIT) + `dome-client-ddc.js`.
3. File di `src/mirror/opt/dome/` otomatis disajikan DOME sebagai `/dome/*.js`.

### Deploy perubahan

| Perubahan | Cara deploy |
|:----------|:------------|
| File **app/NJ** (`.ts`, `.js`, `.mp3`) | Sync VFS (`npm run vfs:bootstrap` atau `sync-vfs.ts`) + relaunch app |
| File **client DOME** (`dome-client-ddc.js`, `dom.js`, `dome.ts`, `dome-client.html`) | Sync VFS → **restart DOME** → hard-refresh browser (static asset dibaca sekali saat startup) |

### Menjalankan app

- Jalankan `ddc-sample` / `ddc-sample2` dari terminal/menu Asteracea
- Pastikan **DOME running** dulu: `dome`
- App bisa ditambah ke launcher via `opt/asteracea/menu/<app>.menu`

---

## 🛡️ Keamanan & Trust Model

DDC membatasi NJ ke **hak gambar dalam window-nya sendiri**:

| Mekanisme | Perlindungan |
|:----------|:-------------|
| **Shadow DOM** | Isolasi id/class & style dari window/app lain |
| **`overflow: hidden` + canvas scoped** | Secara fisik tidak bisa menggambar keluar window |
| **API `ctx` terbatas** | Hanya canvas, raf, send, onMessage/onKey/... — bukan `window`/`document` penuh |
| **Event routing per `wid`+`targetId`** | Event hanya sampai ke pemilik window |

> ⚠️ Trust model sama seperti `xterm`/`codemirror`: NJ dievaluasi via `new Function("DDC", source)` — **Shadow DOM = isolasi style/DOM, BUKAN sandbox JS penuh**. Untuk enforcement kuat (NJ benar-benar tidak bisa akses `window`), upgrade path-nya ke **sandboxed iframe** atau **Web Worker + OffscreenCanvas**.

---

## 🧭 Referensi Cepat

### TGA side (`@tsix/ddc`)

```typescript
const anim = await mountDDC(screen, {
  id: "widget-id", source: njSource, width: 400, height: 300,
}, "parent-container"); // parentId opsional

anim.send({ cmd: "..." });      // TGA → NJ
anim.on("eventName", (ev) => {});  // NJ → TGA (sparse)
anim.on("mouse", (ev) => {});
anim.on("key", (ev) => {});
anim.resize(600, 400);          // ubah ukuran programmatic
await anim.destroy();           // stop + unmount (saat window tutup)
```

### NJ side

```js
DDC.onInit(function (ctx) {
  // gambar: ctx.canvas / ctx.fabric
  // animasi: ctx.raf(frame)
  // komunikasi: ctx.send(...), ctx.onMessage = fn
  // input: ctx.onKey = fn (zero-WS), mouse via fabric
  // lifecycle: ctx.onResize, ctx.onDestroy
});
```

### File DDC

```
src/mirror/lib/ddc.ts                  ← @tsix/ddc (Worker API)
src/mirror/opt/dome/dome-client-ddc.js ← client browser
src/mirror/opt/ddc-sample/             ← contoh (particles.js + balloons.js)
```

Selamat berkarya! 🚀
