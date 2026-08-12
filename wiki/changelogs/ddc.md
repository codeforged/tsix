# Changelog DDC (Direct Draw & Control)

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-08

### ddc-sample0.ts — TForm object literal + maximizable: false

- **File:** `src/mirror/opt/ddc-sample/ddc-sample0.ts`
- **Perubahan:** Konstruktor `TForm` di-sample diubah ke bentuk object literal dengan `maximizable: false` (window tidak bisa di-maximize) — memanfaatkan fitur baru di `cashew.ts` (lihat changelog `cashew.md`).
- **Dampak:** Mendemonstrasikan pola object literal `TForm` pada sample DDC.
- **Oleh:** Copilot

## 2026-08-05

### DDC Sample 5 — 3D Walk (Three.js, humanoid jalan pakai keyboard + mouse)

- **File:** `src/mirror/opt/ddc-sample/ddc-sample5.ts` (TGA), `src/mirror/opt/ddc-sample/walk.js` (NJ), `src/mirror/opt/ddc-sample/level.json` (peta bangunan), `src/mirror/opt/ddc-sample/footstep.wav` (suara langkah, di-generate), `src/mirror/opt/asteracea/menu/ddc-sample5.menu`
- **Fitur:**
  - **Humanoid kotak-kotak prosedural** (torso/kepala/lengan/kaki dari box) — tanpa external model; lengan & kaki berayun saat jalan (walk cycle), body sedikit naik-turun.
  - **Kontrol halus (bukan 8 arah):** **Mouse menentukan arah hadap** — cukup gerakkan kursor di atas area (tanpa klik): raycast ke bidang tanah (`THREE.Raycaster` + `intersectPlane` y=0) → `heading` di-lerp halus (normalisasi selisih sudut ke [-π,π] biar gak muter jauh). **WASD gerak relatif** thd arah hadap: W maju, S mundur, D geser kanan, A geser kiri (vektor maju/kanan dihitung dari heading). _(Pointer Lock sempat dicoba lalu di-rollback — tidak bekerja andal di lingkungan ini.)_
  - Kamera **2 mode** — **toggle tombol V** (default mode 2 / third-person): **Mode 1 = FPV** — kamera di posisi mata player (y≈1.6, FOV 75), walker disembunyikan, **kursor mouse di-hide & gerakan mouse jadi rotasi heading (yaw relatif)** via `movementX` (fallback delta `clientX`), best-effort pointer lock di `document.body`; **Mode 2 = third-person** — walker terlihat, kursor normal (arah absolut dari raycast ke titik tanah di bawah kursor), kamera fixed 3/4 (FOV 60). `VIEW_MODE` (1/2) jadi nilai awal sebelum di-toggle V.
  - **Commit/release control (FPV):** klik body window → `steering` on (yaw aktif + kursor hidden + pointer lock). **ESC → `steering` off** — yaw disable + kursor visible, sampai user klik lagi untuk commit balik ke control game. `applyCursor()` nyetel kursor sesuai state; toggle V reset steering.
  - **Yaw + Pitch (FPV):** gerakan mouse horizontal → heading (yaw), gerakan vertikal → **pitch (lihat atas/bawah)** — `pitch` di-clamp ke ±`PITCH_LIMIT` (1.2 rad ≈ ±69°), pakai `movementY` (fallback delta `clientY`). Reset `pitch=0` saat toggle V masuk FPV.
  - Clamp posisi ke dalam peta (ground 60×60).
  - Scene: ground hijau, jalan, dan **bangunan kotak** dari `level.json` via **ResourceBank** (`resBank.ready("LEVEL")` → `getResource`).
  - **Suara langkah kaki**: NJ kirim `{ event: "sound", data: "step" }` tiap `STEP_INTERVAL` detik → TGA `PLAY_SOUND { name: "<wid>:STEP" }` → browser putar `footstep.wav` dari cache ResourceBank. `footstep.wav` (0.14s thud) di-generate via script (PCM 22050Hz 16-bit).
  - **`dome-client-res.js`**: handler `sfx` kini menghormati `mime` (default `audio/mpeg`) — jadi WAV (`audio/wav`) bisa diputar.
- **Oleh:** Copilot

### ResourceBank — abstraksi resource server→browser (audio, texture, text, JSON, bin)

- **File:** `src/mirror/lib/resbank.ts` (lib, import `@tsix/resbank`), `src/mirror/opt/dome/dome-client-res.js` (client module), `src/mirror/opt/dome/dome.ts`, `src/mirror/opt/dome/dome-client.html`, `src/mirror/opt/dome/dome-client-ddc.js`, `src/mirror/opt/dome/dome-client-ui.js`, `src/mirror/opt/dome/dome-client-windows.js`, `src/mirror/opt/ddc-sample/ddc-sample2.ts`
- **Latar Belakang:** Audio yang tadinya manual (`SFX_PRELOAD`) membuktikan pola "kirim data besar SEKALI → browser cache → pakai berulang". Ini digeneralisasi jadi ResourceBank untuk SEMUA jenis resource (sfx, texture/image, teks cerita, data model/JSON, binary) agar tidak bolak-balik server↔client.
- **Server (`ResourceBank`):** `register(key, path, type, opts?)` → `loadAll()`/`load(key)` baca file VFS, ubah sesuai tipe (binary→base64, text/json→string/object), kirim **`RES_LOAD { wid, key, resType, mime, data }`** ke DOME sekali. `get(key)`/`isLoaded(key)` untuk sisi app. Key di-scope per-window via `wid`.
- **Client (`dome-client-res.js`):** cache `window._tsixResBank["<wid>:<key>"]`. `RES_LOAD` membangun resource by type: `sfx`→Audio, `image`→Image (dengan `mime`), `json`→object, `text`→string, `bin`→base64. Ekspor `TSIX.makeResBank(wid)` → `{ getResource(key), has(key) }`, `TSIX.getRes`, `TSIX.clearResByWid(wid)`.
- **Integrasi DDC NJ:** context NJ kini punya `ctx.resBank` → `resBank.getResource("SFX-Laser")` / `"TEXTURE-player1"` dst.
- **Playback audio:** `handlePlaySound` (dome-client-ui) kini juga mencari dari ResourceBank cache (selain SFX_PRELOAD lama) — `PLAY_SOUND { name }` cukup kirim nama.
- **Cleanup:** `handleDestroyWindow` memanggil `TSIX.clearResByWid(wid)` — cache resource window di-wipe saat ditutup.
- **Bukti pakai:** `ddc-sample2.ts` di-refactor memakai `ResourceBank` untuk 3 suara game (laser/explode/drop) — ganti pola manual `SFX_PRELOAD`/`preloadSfx`. `SFX_PRELOAD` tetap dipertahankan (backward compat).
- **Oleh:** Copilot

### Audio efisien — preload SFX sekali, PLAY_SOUND cukup kirim nama (hemat WS) + scoped per-window

- **File:** `src/mirror/opt/ddc-sample/ddc-sample2.ts`, `src/mirror/opt/dome/dome.ts`, `src/mirror/opt/dome/dome-client-ui.js`, `src/mirror/opt/dome/dome-client-windows.js`
- **Masalah:** `playSfx()` lama mengirim **base64 MP3 penuh** lewat WebSocket setiap kali suara diputar (tiap tembakan/ledakan) → traffic WS sibuk (bisa sampai 1.5MB/s saat game ramai). Cache lama juga **global** (`window._tsixSfxCache`) — tidak di-wipe saat app ditutup & bisa tabrakan antar-app dengan nama sama.
- **Perubahan:**
  - `ddc-sample2.ts`: `preloadSfx(name)` sekali di onSetup (baca MP3 → base64 → kirim **`SFX_PRELOAD { name, data }`**). Nama suara di-**prefix `"<wid>:"`** → cache browser per-app. `playSfx(name)` hanya mengirim **`PLAY_SOUND { name }`** (tanpa data). Prefix diisi dari `screen.wid` di onSetup.
  - `dome.ts`: relay baru `SFX_PRELOAD` + `PLAY_SOUND` meneruskan field `name`.
  - `dome-client-ui.js`: `handleSfxPreload` menyimpan `Audio` di cache (`window._tsixSfxCache[key]`); `handlePlaySound` memprioritaskan cache by name (`currentTime=0; play()`), fallback pola lama (data base64) untuk Asteracea dll. Ekspor `TSIX.clearSfxByWid(wid)` — hapus semua cache ber-prefix `<wid>:`.
  - `dome-client-windows.js`: `handleDestroyWindow` memanggil `TSIX.clearSfxByWid(wid)` → **cache suara milik window itu di-wipe saat ditutup** (memory audio dilepas).
- **Dampak:** 1 suara = 1 payload base64 (saat window dibuat), play selanjutnya hanya beberapa byte; cache ter-scope per-window & bersih saat close — tidak bocor antar-app.
- **Oleh:** Copilot

### DDC Framework v1 — Native JavaScript animation di dalam window TSIX

- **File:**
  - `src/mirror/lib/ddc.ts` (lib, import `@tsix/ddc`)
  - `src/mirror/opt/dome/dome-client-ddc.js` (client module, host via Shadow DOM)
  - `src/mirror/opt/dome/dome-client-dom.js` (special case `tag === "ddc"` di `buildDOM`)
  - `src/mirror/opt/dome/dome.ts` (relay `DDC_MSG` / `DDC_RESIZE` / `DDC_STOP` + daftar `DOME_CLIENT_JS`)
  - `src/mirror/opt/dome/dome-client.html` (CDN **fabric.js 5.3.1** + **three.js r128** + `<script>` ddc)
  - `src/mirror/opt/dome/dome-client-windows.js` (panggil `destroyDDCByWid(wid)` saat window ditutup)
- **Konsep:** App TSIX (TGA) membuat window berisi widget `<ddc>`; browser menjalankan kode **Native JavaScript (NJ)** animasi di dalam Shadow DOM, berkomunikasi lewat protocol PixelSpace (pola yang sama seperti adapter CodeMirror/xterm.js). **Fabric.js** sebagai library animasi default (MIT, via CDN).
- **API NJ context:** `canvas, width, height, dpr, fabric, now(), raf(cb), send(data), onMessage, onResize, onKey, onDestroy`.
- **API TGA:** `mountDDC(screen, opts, parentId?)` → handle `DDCApp`: `send(data)`, `on(event, cb)`, `off()`, `resize(w,h)`, `stop()`, `destroy()`. Event: `ready, score, life, gameover, highscore, sound, mouse, key`.
- **Deteksi kebutuhan Fabric:** regex `\bfabric\b` — NJ tanpa fabric langsung jalan tanpa menunggu CDN.
- **Sampel (`src/mirror/opt/ddc-sample/`):**
  - `ddc-sample0` + `hello.js` — teks bounce (raw canvas)
  - `ddc-sample1` + `particles.js` — partikel Fabric (tombol Burst/Clear)
  - `ddc-sample2` + `balloons.js` — **game balon penuh**: player segitiga, tembak (Space), skor +10/-5, 5 nyawa (hearts), game over + high score tersimpan ke file `/opt/ddc-sample/highscore.txt` (auto-create jika belum ada), audio `PLAY_SOUND` (laser-beam.mp3 / retro-explode.mp3), tombol **New Game** (TButton Cashew di luar panel)
  - `ddc-sample3` + `threecube.js` — kubus wireframe Three.js (drag-to-rotate, auto-rotate dengan 300ms grace)
  - `ddc-sample4` + `fire.js` — DOOM fire palette 37 warna (ImageData, `UPDATE_EVERY=3`)
- **Menu:** `src/mirror/opt/asteracea/menu/ddc-sample0-4.menu`
- **Dokumentasi:** `wiki/ddc-in-a-nutshell.md` (terhubung dari `wiki/Home.md`)
- **Catatan deploy:** file app (.ts/.js/.mp3) → `npm run vfs:bootstrap` + relaunch; file client (`dome-client-ddc.js`, `dome-client.html`) → sync + **restart DOME** + hard-refresh browser. File MP3 harus ikut di `src/mirror/opt/ddc-sample/` agar persist lewat `vfs:bootstrap`.
- **Oleh:** Copilot

### Fix penting dalam sampel game

- **File:** `src/mirror/opt/ddc-sample/balloons.js`, `src/mirror/opt/ddc-sample/particles.js`, `src/mirror/opt/dome/dome-client-ddc.js`, `src/mirror/opt/dome/dome-client-windows.js`
- **Perubahan:**
  - Skor tidak lagi pakai `fabric.Text` (bug textBaseline/inkonsisten) → raw 2D `drawScore`.
  - Balon & partikel digambar raw 2D (`ctx.ellipse`) karena `fabric.Circle` tidak andal untuk banyak objek (balon sempat tak terlihat walau collision bekerja).
  - RAF loop di-hardening (try/catch/finally + selalu reschedule) — cegah loop mati saat error.
  - Fokus keyboard: `ev.preventDefault()` + skip elemen interaktif (input/textarea/select/splitter/col-resize) biar panah/spasi jalan tanpa klik body.
  - New Game TButton: `setTimeout(0)` fokus balik ke canvas setelah klik — hindari tombol ter-click ulang oleh Space.
  - `destroyDDCByWid(wid)` dipanggil di `handleDestroyWindow` — stop RAF loop saat window ditutup (cegah resource leak / slow-down progresif saat buka-tutup berulang).
- **Oleh:** Copilot
