# Changelog Kernel TSIX

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-17

### EXEC mendukung shebang — skrip executable dijalankan lewat interpreter-nya

- **File:** `src/common/Shebang.ts` (baru), `src/common/Shebang.test.ts` (baru), `src/kernel/Syscalls.ts` (kasus `EXEC` + `resolveShebangInterpreter()`).
- **Perubahan:** kalau file yang di-`exec` **bukan** aplikasi `.ts`/`.js` (jadi tidak dibaca sebagai program) tapi isinya diawali `#!`, kernel menjalankan interpreter-nya — persis `execve` di Unix:

  ```
  exec("/etc/rc.local")  →  exec("/bin/tsh.js", ["/etc/rc.local", ...args])
  exec("./start-netfs.sh") →  exec("/bin/tsh.js", ["./start-netfs.sh", ...args])
  ```

- **Detail resolusi interpreter:** `#!/bin/tsh` boleh menunjuk file yang belum ada namanya — runtime mengeksekusi sidecar `.js` sedangkan source-nya `.ts`, jadi tiap kandidat dicoba apa adanya, lalu `.js`, lalu `.ts` (preferensi sama dengan EXEC biasa). Nama telanjang (`#!/bin/tsh` vs `#!/usr/bin/env tsh`) dinormalkan, dan direktori `/bin`, `/usr/bin`, `/sbin` dicoba untuk interpreter tanpa path.
- **Urutan & keamanan:** permission `EXECUTE` diperiksa pada **skrip** (seperti sebelumnya), lalu juga pada **interpreter** — jadi setuid/izin `/bin/tsh.js` tidak bisa dilewati lewat skrip. `appContent` yang dimuat adalah milik interpreter (DME tetap jalan), sedangkan path skrip disisipkan sebagai argumen pertama sehingga `tsh` masuk mode non-interaktif.
- **Gagal jelas, bukan aneh:** interpreter di luar `tsh`/`sh`/`bash` ditolak `interpreter tidak didukung: '<x>' (didukung: tsh, sh, bash)`; kalau interpreter tidak ada di VFS → `interpreter tidak ditemukan untuk '<x>' (path)`.
- **Verifikasi:** `Shebang.test.ts` (13 test: shebang dasar, argumen, idiom `env`, BOM/CRLF, kandidat path) + 4 test kernel di `Syscalls.test.ts` (`A1.114b` skrip shebang → spawn `tsh.js` dengan args `["/etc/rc.local"]`; `A1.114c` argumen diteruskan; `A1.114d/e` dua jalur gagal yang spesifik). Catatan: PCB anak cepat hilang karena worker stub langsung exit, jadi asersi memakai spy `scheduler.createProcess` — bukan `getProcess()`.
- **Dampak:** semua jalur peluncuran (init saat boot, `tsh`, cron, Asteracea) bisa menjalankan skrip executable tanpa tahu isinya. Boot: `init` memakai ini untuk `/etc/rc.local` gaya skrip (lihat changelog init).
- **Oleh:** Copilot

### Perbaikan: import relatif modul framework BERSARANG gagal (`Cannot find module './X'`)

- **File:** `src/userland/WorkerEntry.ts`, `src/userland/WorkerEntry.js`, `scripts/test/worker-dme-smoke.mjs` (baru).
- **Gejala (dilaporkan dari lapangan):** menjalankan `netfsd` → `[Worker 14] Direct Execution Error: Cannot find module './NetFSProtocol'`, dengan require stack `@common_netfs/NetFSServer.js` → `/sbin/netfsd.js`.
- **Akar masalah:** saat memuat modul framework dari memory (DME), `WorkerEntry` men-_compile() modul dengan nama file buatan: `path.join(cwd, normalizedRequest.replace("/", "_") + ".js")`. `String.replace("/", "_")` **hanya mengganti garis miring PERTAMA**, jadi id `@common/netfs/NetFSServer` menjadi folder `@common_netfs/` + file `NetFSServer.js`. Untuk import relatif, kode lama memakai `path.basename(parent.filename)` dan mencocokkan awalan `@tsix_`/`@common_`: pada modul bersarang basename-nya **tidak** berawalan itu, sehingga `./NetFSProtocol` dibiarkan apa adanya dan diserahkan ke `require()` Node → tidak ketemu. Modul bersarang lain di repo (`@common/protocols/*`, mis. `TSSHProtocol`) selama ini aman **hanya karena** file-nya tidak punya import relatif di dalamnya — jadi bug ini laten, menunggu modul bersarang pertama yang punya import relatif (yaitu `@common/netfs/NetFSServer`, dipakai NetFS).
- **Perbaikan:** resolusi relatif dipindah ke **ruang module-id**, bukan nama file:
  - peta `moduleIdByFile` (dummyFilename → id, mis. `@common/netfs/NetFSServer`);
  - helper `resolveRelativeModuleId(parentId, request)` yang melipat `./` dan `../` di ruang id (`@common/netfs/NetFSServer` + `./NetFSProtocol` → `@common/netfs/NetFSProtocol`; `../Logger` → `@common/Logger`), dengan penjaga agar segmen scope (`@tsix`/`@common`) tidak pernah habis terlipat;
  - peta didaftarkan **SEBELUM** `_compile()` — kesalahan pertama saat mengerjakan ini adalah mendaftarkannya sesudah, padahal isi modul me-require anaknya **saat** `_compile` berjalan;
  - logika lama (basename) tetap dipakai sebagai fallback bila parent tidak dikenal (mis. modul dimuat `require()` biasa).
- **Verifikasi (dengan reproduksi lebih dulu):** harness baru `scripts/test/worker-dme-smoke.mjs` menjalankan `WorkerEntry.js` **asli** di worker thread dengan `vfsCache` yang dibangun dari source repo (persis cara kernel: `mirror/lib`→`/lib`, `common`→`/lib/common`, app ditranspile seperti sidecar `.js`), lalu menjawab syscall minimal (PRINT/SCREEN_INFO/WHOAMI/GETCWD). Sebelum perbaikan harness **mereproduksi persis** error lapangan; sesudah perbaikan `netfsd --help` ✅ (mencetak usage), dan tidak ada regresi untuk jalur lama: `netfs --help`, `lsblk --help`, `scpd --help`, `iot-listener --help` semuanya ✅. `npm run typecheck` bersih untuk `src/userland/**`; 37 test NetFS tetap lulus.
- **Dampak:** semua modul framework bersarang (`@common/<dir>/<mod>`) kini boleh memakai import relatif pada kedalaman berapa pun; jalur top-level (`@tsix/Application` → `./Emerald`, dsb.) tidak berubah. Catat juga: error loader dikirim ke parent lewat syscall `PRINT` (bukan stderr), jadi harness/skrip apa pun harus memeriksa keduanya — kalau tidak, kegagalan lolos sebagai “sukses”.
- **Deploy:** `WorkerEntry.js` dibaca dari **host** (`sysconfig.scheduler.workerEntryPath` = `../userland/WorkerEntry.js`), bukan dari VFS → cukup restart `npm start` (tidak perlu `npm run install`).
- **Oleh:** Copilot

---

## 2026-09-16

### Perbaikan: Alt+1..6 tidak lagi memindahkan TTY di console native (regresi `fd3be6e`) + dukungan macOS & Ctrl+1..6

- **File:** `src/kernel/Kernel.ts` (`handleKeyboardHotkey`), `src/kernel/Kernel.test.ts`.
- **Gejala:** di console native (host terminal), `Alt+1..6` sudah tidak memindahkan TTY, padahal dulu bisa. `Ctrl+1..6` juga tidak.
- **Akar masalah (dibuktikan dengan `git log -S`):** commit **`fd3be6e` "switch tty hotkey in mac keyboard"** (2026-08-28) **mengganti** — bukan menambah — enam entri `"\x1b1".."\x1b6"` (ESC + digit, bentuk yang dikirim xterm / GNOME Terminal / VS Code / iTerm2 untuk Alt+digit) dengan enam karakter macOS `¡ ™ £ ¢ ∞ §`. Sejak commit itu, Alt+digit hanya cocok di Terminal.app (opsi *Use Option as Meta key* mati), dan di Linux tak ada lagi entri yang cocok. `Ctrl+digit` **tidak pernah** ada di kode mana pun (`git log -S 'Ctrl+1' --all` → kosong), jadi itu memang belum pernah didukung.
- **Perubahan 1 — Alt+digit dikembalikan, macOS tetap:** `"\x1b" + d` (Alt+digit native) **dan** `¡™£¢∞§` sama-sama dipetakan, jadi kedua platform jalan bersamaan tanpa saling mengorbankan.
- **Perubahan 2 — Ctrl+1..6 untuk terminal modern:** ditambah varian **CSI-u** (`\x1b[<49-54>;5u` untuk Ctrl, `;3u` untuk Alt) dan **modifyOtherKeys=2** (`\x1b[27;5;<49-54>~` / `\x1b[27;3;<49-54>~`) — dipakai kitty, wezterm, Ghostty, foot, iTerm2 (Report modifiers), dan xterm dengan `modifyOtherKeys=2`.
- **Perubahan 3 — Ctrl+4..6 lewat caret notation:** `0x1C/0x1D/0x1E` (FS/GS/RS) → TTY 4/5/6. Ini byte yang **benar-benar** dikirim terminal klasik (xterm, GNOME Terminal, Terminal.app) untuk Ctrl+4..Ctrl+6. Karena byte-nya sama, `Ctrl+\`, `Ctrl+]`, `Ctrl+^` ikut memindahkan TTY — tidak ada userland TSIX yang memakai ketiganya, jadi alokasinya aman (dan ini konsekuensi bawaan caret notation, bukan pilihan kita).
- **Sengaja TIDAK dipetakan** (tak mau menabrak tombol inti aplikasi): `Ctrl+3` = `0x1B` (ESC — dipakai atto/vim), `Ctrl+2` = `0x00` (NUL — sama dengan `Ctrl+Space`/`Ctrl+@`), `Ctrl+8` = `0x7F` (DEL — sama dengan Backspace), `Ctrl+7` = `0x1F` (US — sama dengan `Ctrl+/`), dan `Ctrl+1` (terminal tidak mengirim byte apa pun untuk ini).
- **Perubahan 4 — Ctrl+Alt+1..6.** Terukur di xterm.js 5.3.0 (mesin yang sama dengan dome/pixelterm **dan** VS Code): `Ctrl+Alt+1` → `1b 31` (`\x1b1`), `Ctrl+Alt+4` → `1b 34` (`\x1b4`, **bukan** FS seperti `Ctrl+4`), `Ctrl+Alt+A` → `1b 01` — jadi di sana encoding Ctrl+Alt+digit **identik dengan Alt+digit** (modifier Alt menang, Ctrl diabaikan untuk tombol digit) dan sudah tertangani entri `"\x1b" + d`. Di VTE/GNOME Terminal hanya `Ctrl+Alt+1` yang begini; sisanya jadi caret notation (lihat tabel pengukuran di bawah). Untuk terminal ber-protokol keyboard ditambah **CSI-u `;7u`** dan **modifyOtherKeys `27;7;<code>~`** (modifier 7 = 1 + Alt 2 + Ctrl 4).
- **Perubahan 5 — lookup map tidak lagi menelan kata warisan prototype:** pengecekan diganti dari `if (hotkeys[seq])` menjadi `typeof targetTtyId === "number"`. Sebelumnya, satu chunk input yang kebetulan berisi `"constructor"`/`"toString"` menghasilkan nilai truthy dari `Object.prototype` → dianggap hotkey (tombol ditelan tanpa efek).
- **Verifikasi:** `npx vitest run src/kernel/Kernel.test.ts` → **13 lulus** (9 lama + 4 baru): A3.12 Alt+digit + urutan tujuan TTY `1,2,3,4,5,6`; A3.13 tabel 21 encoding (macOS, Alt+F1..F6, CSI-u `;3u/;5u/;7u`, modifyOtherKeys `;3/;5/;7`, caret notation) lewat `ttyManager.switch` palsu; A3.14 Ctrl+Alt+digit = encoding Alt+digit; A3.15 `ESC` tunggal, tombol biasa, dan `"constructor"` tetap diteruskan ke aplikasi (harus `false`, `switch` tidak pernah dipanggil).
- **Deploy:** file kernel (bukan `src/mirror/**`) → tidak perlu sync VFS, cukup restart `npm start`.
- **Catatan lapangan — `Ctrl+digit` telanjang memang tidak bisa dipakai:** GNOME Terminal (Ubuntu) memakainya untuk pindah tab dan VS Code untuk "focus editor group"; **meng-unbind shortcut-nya pun tidak menolong**, karena byte yang sampai sudah kehilangan info modifier. Terukur di **GNOME Terminal/VTE** dengan `cat -v` (laporan andriansah, 2026-09-16):

  | Kombinasi | Byte | Hasil di TSIX |
  |---|---|---|
  | `Alt+1..6` | `^[1` .. `^[6` (ESC + digit) | **TTY 1..6** — jalur utama yang dipakai |
  | `Ctrl+Alt+1` | `^[1` | TTY 1 ✅ (VTE memperlakukan sama seperti Alt+1) |
  | `Ctrl+Alt+4/5/6` | `^\` `^]` `^^` (FS/GS/RS) | TTY 4/5/6 ✅ lewat caret notation |
  | `Ctrl+Alt+2` / `Ctrl+Alt+3` | `^@` (NUL) / `^[` (ESC) | sengaja tidak dipetakan |
  | `Ctrl+1` | `1` | mustahil: tak terbedakan dari mengetik "1" |
  | `Ctrl+2` / `Ctrl+3` / `Ctrl+4` | `^@` / `^[` / `^\` | caret notation; `^\` (0x1C) = **SIGQUIT** → `Quit (core dumped)` di shell biasa |

  SIGQUIT itu urusan line discipline host, bukan TSIX: TSIX men-set `stdin.setRawMode(true)` (lihat `KeyboardDevice`), jadi `0x1C` tiba sebagai data dan dipakai untuk pindah TTY — bukan membunuh proses. Di browser (pixelterm/retroterm) xterm.js hanya mengirim `Ctrl+3..7` (ESC/FS/GS/RS/US): `Ctrl+4..6` bekerja, `Ctrl+1/2` tidak. **Kesimpulan:** pakai `Alt+1..6` (dan biarkan GNOME Terminal 1 tab per window); `Ctrl+Alt+1` serta `Ctrl+4..6` ikut jalan sebagai bonus.
- **Oleh:** Copilot · **Laporan:** andriansah

### Device baru: pseudo-LCD `/dev/plcd` (`PLCDDevice`) — uji app LCD tanpa hardware

- **File:** `src/kernel/devices/aux-devices/PLCDDevice.ts` **(baru)**, `plcdFont5x7.ts` **(baru)**, `PLCDDevice.test.ts` **(baru)**, `LM6029Device.ts` (helper argumen ioctl diekspor + tes C10.50e).
- **Ringkas:** aux-device yang meniru `LM6029Device` seluruhnya di software — nomor ioctl (`LCDIOCTL`) & bentuk argumen sama persis, tapi gambar diraster ke framebuffer RAM 1024 byte (1 bpp MSB-first). Tanpa addon native, tanpa SPI. Dua ioctl khas emulator: `GET_REV` (0x4c51, murah untuk polling) & `GET_FRAME` (0x4c50, base64 1024 byte + flag tampilan).
- **Terdaftar sebagai `/dev/plcd`:** `kernel.devices.plcd` (autoRegister + auto-load aux-device) → `Syscalls` me-resolve `/dev/<name>` langsung dari registry, jadi tidak perlu entry/bootstrap tambahan.
- **Hardware tidak tersentuh:** `/dev/lcd` tetap milik driver asli; ioctl 0x4c50/0x4c51 di `LM6029Device` diabaikan (`null`) dan `GET_INFO`-nya tidak mengisi flag `pseudo`. Dijaga tes **C10.50e** (fake addon: perintah khas pseudo → `null`, `GET_INFO.pseudo` undefined, `drawRect` normal tetap diteruskan ke addon).
- **Perubahan pendukung:** `positional`/`num`/`bool`/`boolFrom`/`toByteBuffer`/`asBuffer` di `LM6029Device.ts` kini diekspor — dipakai bersama pseudo-device supaya kontrak argumen ioctl hanya hidup di satu tempat.
- **Font asli hardware:** `setFont(1..3)` (FreeSans9, FreeSansBold12, FreeMono9)
  kini meraster **data glyph asli addon** — `scripts/gen-lcd-fonts.mjs` membaca
  `raspi-lcd-addon/src/Fonts/*.h` dan menulis `lcdFonts.ts` (bitmaps base64 +
  tabel glyph), jadi tidak ada data font ganda yang bisa basi. Dua detail
  hardware yang ditiru: bitmap dibaca **kontinu** (tanpa padding antar-baris,
  seperti loop `Adafruit_GFX::write`) dan `cursorY` = **baseline** + `yAdvance`
  untuk baris baru.
- **Font 5x8 bawaan (id 0) juga byte-exact:** jalur `setFont(0)` memakai data
  `glcdfont.c` addon → `src/kernel/devices/aux-devices/lcdFontClassic.ts`
  (256 glyph × 5 byte kolom, sel 6x8 px) — bukan lagi glyph 5x7 buatan sendiri.
  Ikut ditiru: kuirk Adafruit `_cp437 = false` (kode ≥ 176 digeser +1) dan sel
  setinggi 8 baris (descender `g`/`y` sampai baris 7). `plcdFont5x7.ts` kini
  hanya berisi glyph ekstensi di luar 0x00..0xFF (panah) + placeholder.
- **Temuan (tidak perlu kode):** font sample **pabrik**
  `ori-from-lcd-factory/defaultFont.h` ternyata **font yang sama** dengan
  glcdfont — hanya urutan bitnya terbalik (`reverse()` di driver pabrik),
  255 glyph, dan 7 glyph beda ±1 px (0x84 0x8E 0x94 0x99 0xB0 0xB2 0xE1).
  Jadi tidak ada entri font pabrik terpisah di pseudo-LCD.
- **Verifikasi:** 41 tes baru (C10.60–C10.100) + 30 tes LM6029Device lulus; DD-RAM di-render sebagai ASCII-art untuk memeriksa rasterisasi (dari situ ketemu & diperbaiki bug `roundRect`: dua garis horizontal palsu) dan untuk verifikasi ketiga font GFX; suite kernel tidak menambah kegagalan (6 pre-existing tetap 6).
- **Detail lengkap:** `wiki/changelogs/lcd.md` (2026-09-16); sisi viewer/DDC: `wiki/changelogs/ddc.md`.
- **Deploy:** **restart kernel** (device didaftarkan saat boot) — file kernel, bukan `src/mirror/**`.
- **Oleh:** Copilot · **Laporan:** andriansah

---

## 2026-09-14

### Perbaikan: `ps --mem` / `mem --per-proc` kosong di macOS & Ubuntu (Node < 22.16)

- **File:** `src/kernel/Scheduler.ts`, `src/userland/WorkerEntry.ts`, `src/mirror/bin/ps.ts`, `src/mirror/sbin/mem.ts`
- **Versi:** kernel `0.2.6.20260912.1` → `0.2.7.20260914.1`.
- **Gejala:** di Windows kolom `HEAP+EXT(MB)` terisi; di macOS dan Ubuntu **semua** proses menampilkan `-` (`Total (0/13 processes read)`, `unreadable procs : 13`) **tanpa pesan apa pun** — terbaca seperti fitur rusak.
- **Akar masalah:** jalur baca memori per-proses hanya memakai **`worker.getHeapStatistics()`**, dan method itu **baru ada di Node ≥ 22.16 / ≥ 24** (dok Node: *"Added in: v24.0.0, v22.16.0"*). Di Node 20 — versi yang dipakai `@types/node` proyek ini — `worker.getHeapStatistics` bernilai **`undefined`**, sehingga `await worker.getHeapStatistics()` melempar `TypeError`, tertangkap `catch`, dan jadi `null` untuk tiap proses. Windows kebetulan memakai Node yang lebih baru, jadi gejalanya tampak "jalan hanya di Windows". **Terverifikasi di mesin dev (Node v20.20.2):** `typeof Worker.prototype.getHeapStatistics === "undefined"`.
- **Perubahan 1 — fallback IPC.** `Scheduler.getProcessMemory()` sekarang punya dua jalur:
  1. **pull** — `worker.getHeapStatistics()` bila tersedia (Node ≥ 22.16). Bebas-blocking: tetap terbaca walau worker sedang sinkron.
  2. **ipc** — bila tidak ada, kernel mengirim `{__tsixMemStatRequest}` dan menunggu balasan `{__tsixMemStat, stats}` dengan timeout **400 ms** (timer di-`unref()`, jadi tidak menahan event loop kernel). Balasan ini **dicegat di handler pesan Scheduler** dan tidak pernah diteruskan ke `syscallHandler`.
  - Hasil kini membawa `source: "pull" | "ipc"`, dan `ps --mem` mencetak berapa proses yang dibaca lewat IPC.
- **Perubahan 2 — kenapa responder diletakkan di `WorkerEntry`, bukan `UserLib`.** `WorkerEntry` **selalu** jalan (bahkan untuk app yang gagal dimuat), sedangkan `UserLib` baru hidup setelah app meng-import framework — tanpa itu, proses bermasalah justru kehilangan angka memorinya. Responder juga melaporkan `heapLimit` (`v8.getHeapStatistics().heap_size_limit`). `rss` sengaja **tidak** dikirim: di dalam worker nilainya process-wide dan menyesatkan.
- **Perubahan 3 — berhenti diam-diam.** `ps --mem` & `mem --per-proc` kini menjelaskan diri saat tak ada angka sama sekali: Node ≥ 22.16 memberi jalur pull, Node lama bergantung pada worker yang sempat memutar event loop, dan proses yang baru spawn mungkin belum online. `ps --mem` juga mencetak versi Node host.
- **Verifikasi:**
  - **Sistem nyata (Ubuntu, Node 20 — kasus yang dilaporkan):** `mem --per-proc` kini menampilkan **13 proses** lengkap dan `unreadable procs : 0`; `ps --mem` melaporkan **`Total (13/13 processes read)`** plus baris `Read via worker reply (IPC): 13/13`. Angka total 114.7 MB (79.9 heap + 34.8 external) konsisten antara kedua utilitas.
  - Responder (memakai `WorkerEntry.js` asli, worker hidup) → `{heapUsed: 5.4 MB, heapTotal: 9.9 MB, external: 2.5 MB, arrayBuffers: 10 KB, heapLimit: 4.3 GB}`.
  - `Scheduler` nyata di Node 20 (jadi menempuh jalur IPC): worker idle → angka + `source: 'ipc'`; worker sibuk sinkron (`while` 3 s) → `null` setelah **401 ms**; PID tanpa worker → `null`.
- **Batasan yang disengaja:** di Node < 22.16, worker yang sedang sinkron/blocking **tidak bisa** dibaca (event loop-nya tak berputar). Ini kompromi yang lebih jujur daripada kolom kosong tanpa penjelasan; solusi penuhnya adalah memakai Node ≥ 22.16.
- **Oleh:** Copilot · **Laporan:** kakang

---

## 2026-09-12

### Hasil verifikasi di sistem nyata + peluang yang diukur & ditolak

- **Konteks:** penutup rangkaian optimasi memori hari ini. Bagian ini mencatat **angkanya di mesin nyata**, dan — sama pentingnya — **daftar ide yang sudah diuji dan ditolak**, supaya tidak diinvestigasi ulang tanpa alasan baru.
- **Hasil terukur (12 proses, `mem --per-proc`):**
  | Titik | RSS | Per worker | `heapTotal`/worker |
  |---|---|---|---|
  | Awal | 564 MB | ~30.6 MB | ~18 MB |
  | Setelah fase 1 | 370 MB | 16.2 MB | 18.1 MB |
  | Setelah fase 2 | **250.9 MB** | **7.3 MB** | **10.5 MB** |
  | **Total** | **−313 MB (−56%)** | **−76%** | −42% |
  - 12 worker total: 144.7 MB → **89.1 MB**.
- **Temuan penting — RSS bukan angka stabil.** Dua perintah berturut-turut (`mem` lalu `mem --per-proc`, tanpa membuka app apa pun) melaporkan **292.7 MB** vs **250.9 MB** — selisih **42 MB** hanya dari halaman mmap V8 yang di-*reclaim* OS. Inilah alasan label `unattributed` di `mem` sengaja tidak diklaim sebagai "ukuran main thread": angka itu bergerak tanpa perubahan beban. Untuk perbandingan antar-proses, pakai `ps --sort-mem`.
- **Peluang yang DIUKUR lalu DITOLAK** (jangan diulang tanpa data baru):
  - **Berbagi `module.exports` framework antar-worker** — framework hanya ~2 MB/worker (trivial 10.5 → require emerald+cashew 12.3 → 300 DOM node 12.7 MB). Harness IPC + scoping per-proses tidak sepadan.
  - **`arena: true`** (berbagi heap antar-worker) — **berbahaya**: `WorkerEntry` menyabotase `global.require`/`process.exit` dan menyimpan `moduleCache` per-thread; heap bersama membuat proses saling menimpa dan membongkar isolasi.
  - **Membuang `*.test.ts` dari `/lib`** — setelah cache hanya `.ts`, bobot test tinggal **84 KB** (18 file); hemat ~1 MB untuk 12 worker. Tidak sepadan.
  - **Kebocoran `windowStates` (dome.ts) & `notifHistory` (asteracea.ts)** — memang tumbuh tanpa batas (prune hanya saat UNMOUNT/DESTROY), tapi lajunya kecil: clock taskbar 1 hari = 1.09 MB; dashboard 4 gauge 1 jam = 0.42 MB (~63 byte/entri). Bukan penyebab lonjakan ratusan MB. Tetap layak dibatasi someday (tumbuh monoton + snapshot dikirim ulang tiap klien reconnect), prioritas rendah.
  - **Peta main thread (terukur per-modul):** baseline node 58.2 → SyscallDispatcher +14.9 → BKFS +6.2 → Kernel +3.3 → SerialDeviceManager +2.8 → **total 89.3 MB**. Dari situ, data kita hanya ~20 MB (`heapUsed` 16.9 + `malloced` 0.7 + `external` 2.1); **sisa ~70 MB adalah V8 code space (JIT) + stack + mmap** — konsekuensi mengompilasi ~90 MB modul JS, bukan data yang bisa dibebaskan.
- **Peluang yang masih terbuka (belum dikerjakan):**
  - Resolve `.ts` `/lib` dari sidecar `.js` yang sudah ada → hemat **96 ms CPU boot** (semua 16 sidecar segar, nol basi). Wajib pakai **guard `modified_at`** (jangan pakai `.js` bila lebih tua dari `.ts`), dan `scripts/vfs-bootstrap.ts` sebaiknya ikut `sourcemap: false` (sidecar 1.25 MB → 0.33 MB karena masih inline sourcemap). Menyentuh jalur eksekusi → perlu uji penuh.
  - `scheduler.defaultShell: "tsh.ts"` di `sysconfig.json` adalah **setelan mati** (tidak ada pembacanya; `Kernel.runInit()` memakai `scheduler.bootEntry` = `init.js`). Perlu dibersihkan agar tidak menyesatkan.
  - Akun runtime (`useradd`) pernah hilang dari `/etc/passwd` di `system.db`. **`vfs:bootstrap` TERBUKTI bukan penyebabnya** (lihat `wiki/changelogs/vfs.md`). Pemicu belum teridentifikasi.
- **Sisa selisih `unattributed` (~125 MB)** kemungkinan besar V8 code space + mmap + overhead isolate, **bukan** kebocoran — dibuktikan oleh inkonsistensi 42 MB di atas. Bila muncul pertumbuhan **monoton** saat idle (bukan naik-turun), itu baru indikasi kebocoran nyata; gunakan `mem --per-proc` berulang untuk memastikan.
- **Oleh:** Copilot · **Laporan:** kakang

### Optimasi memori fase 2 — buang beban mati `vfsCache` + lepas thread esbuild

- **File:** `src/kernel/Kernel.ts` (`rebuildVFSCache`), `src/mirror/sbin/mem.ts`, `src/mirror/bin/ps.ts`
- **Latar:** setelah fase 1 (lihat bagian berikutnya), komposisi RSS bergeser — worker sudah ~12 MB, main thread menjadi komponen terbesar (~134 MB dari 298 MB).
- **Perubahan 1 — cache hanya `.ts`.** `fetchDir()` sebelumnya memasukkan `.ts`, `.js`, **dan** `.json`. `WorkerEntry` memetakan `@tsix/X` → `/lib/X.ts` dan `@common/Y` → `/lib/common/Y.ts`, jadi entri `.js` (51 file, 1.70 MB) **tidak pernah di-lookup** tetapi tetap di-clone ke setiap worker via `workerData`.
  - **Ukur (12 worker, app yang benar-benar `require` emerald+cashew+Application):**
    - cache lama (2.16 MB): **16.44 MB/worker**
    - cache baru (0.46 MB): **12.57 MB/worker**
    - → hemat **3.86 MB/worker** (~46 MB untuk 12 worker)
  - **Bukti kesetaraan:** kedua varian melaporkan framework identik lengkap — `OK emerald=48 cashew=46` (confirmed 12/12). Tidak ada framework yang meng-`import` `.js`/`.json` secara eksplisit (diverifikasi dengan grep), jadi pembuangan ini tidak memutus apa pun.
- **Perubahan 2 — `esbuild.stop()` setelah cache dibangun.** `esbuild.transformSync` men-spawn worker thread native yang bertahan seumur proses.
  - **Ukur:** `require('esbuild')` +2.4 MB; `transformSync` pertama **+11.9 MB** (thread lahir); `stop()` membebaskan **~10–12 MB**. Pemanggilan `transformSync` berikutnya tidak menumbuhkan lagi (reuse).
  - Setelah boot, kernel tidak memakai esbuild lagi — transpile app terjadi di dalam worker (yang punya instance sendiri).
  - **Risiko diuji & bersih:** (a) worker tetap bisa `require("esbuild")` dan `transformSync` **setelah** main thread `stop()` — jalur DME app `.ts` aman; (b) main thread bisa memanggil lagi (lazy restart); (c) `stop()` hanya dipanggil di blok `finally` `rebuildVFSCache`, dan itu satu-satunya pemakai esbuild di `src/kernel`.
- **Perubahan 3 — label `mem`/`ps` diperbaiki (akurasi diagnosis).** Sebelumnya `difference <- main thread + native libraries` terlalu percaya diri. Terukur pada 12 worker: `sum(heapUsed+external)` = **161.8 MB** sementara RSS naik **144.7 MB** — artinya angka itu bisa **lebih besar** dari RSS (karena `heapTotal` termasuk halaman terpesan yang belum resident). Label kini `unattributed` + catatan eksplisit bahwa angkanya campuran (main thread, V8 code space/JIT, stack, mmap, overhead isolate) dan harus dibaca sebagai tren, bukan ukuran presisi.
- **Dampak:** ~46 MB (worker) + ~12 MB (thread esbuild) dari basis 12 worker.
- **Oleh:** Copilot · **Laporan:** kakang

### Optimasi memori worker thread — RSS turun ~40% (fase 1)

- **File:** `src/kernel/Scheduler.ts`, `src/kernel/Kernel.ts`, `src/common/Config.ts`, `src/sysconfig.json`
- **Masalah:** RSS TSIX membengkak (564 MB pada 16 proses) lalu naik terus setiap aplikasi dijalankan.
- **Pengukuran (Node v22.20.0, benchmark isolat nyata):** biaya per worker setelah boot penuh `WorkerEntry` + UserLib:
  | Varian spawn | RSS/worker |
  |---|---|
  | Worker polos | +10.7 MB |
  | `-r esbuild-register -r tsconfig-paths/register` | **+25.9 MB** |
  | `WorkerEntry` + app biasa (`execArgv` kosong) | **+16.2 MB** |
  | `WorkerEntry` + app `.ts` (preload transpiler) | **+30.6 MB** |
- **Perubahan:**
  - **Preload transpiler hanya untuk jalur `.ts` mentah.** Jalur `.js` (yang dipakai runtime normal) kini `execArgv: []` → hemat ~14.4 MB/worker. `tsconfig-paths/register` dihapus (impor relatif userland sudah di-resolve hook `Module._load` di `WorkerEntry`). Log peringatan ditambahkan bila ada app `.ts` mentah.
  - **`rebuildVFSCache()`: `sourcemap: "inline"` → `false`.** Cache di-clone ke setiap worker via `workerData`; inline sourcemap menambah ~70% ukuran (terukur 1.45 MB → 0.43 MB). Sourcemap inline tidak menambah akurasi stack trace karena konten dieksekusi via `_compile()` dari string, bukan `require()`.
  - **`resourceLimits` per worker** (`scheduler.workerMaxOldGenMb` default 192, `workerMaxYoungGenMb` default 32). Pagar agar satu app nakal tidak membengkakkan RSS proses host. Set `0` untuk menonaktifkan.
  - **Lifecycle worker diperbaiki** (akar "RSS naik tiap kali run aplikasi"): `pcb.worker` tidak pernah dilepas di handler `exit`; handler `error` hanya men-set state sementara worker dibiarkan hidup. Kini `pcb.worker = undefined` + `removeAllListeners()` di kedua jalur, plus jaring pengaman di `reap()`.
  - Handler `message` memakai referensi `worker` lokal (bukan `pcb.worker`) agar balasan tidak nyasar ke worker baru saat proses di-`reexec`.
- **Dampak:** Per worker app `.js`: +16.2 MB (sebelumnya ~30 MB untuk shell `.ts`). Pengurangan terukur pada sistem nyata: 564 MB → 370 MB.
- **Oleh:** Copilot · **Laporan:** kakang

### `scheduler.workerMaxOldGenMb` & `workerMaxYoungGenMb` — pagar memori per worker

- **File:** `src/sysconfig.json`, `src/common/Config.ts`, `src/kernel/Scheduler.ts`, `scripts/install.ts`
- **Apa ini:** batas atas heap V8 **per worker**, diteruskan apa adanya ke `new Worker(..., { resourceLimits })`:
  - **`workerMaxOldGenMb` (default 192)** → `resourceLimits.maxOldGenerationSizeMb`. Membatasi **old generation** (heap panjang-umur).
  - **`workerMaxYoungGenMb` (default 32)** → `resourceLimits.maxYoungGenerationSizeMb`. Membatasi **young generation** (ruang objek berumur pendek, tempat GC muda/scavenge bekerja).
- **Tujuannya KETAHANAN, bukan penghematan.** Kalau satu app bocor atau menumpuk objek tanpa batas, worker itu **gagal** (`Worker terminated due to reaching memory limit: JS heap out of memory`) alih-alih membengkakkan seluruh proses host.
- **Penting:** parameter ini **tidak mengubah pemakaian normal**. Diukur: `heapTotal` per worker 9.11 MB tanpa limit vs 9.13 MB dengan limit — praktis sama. Yang diatur hanyalah **batas atas**.
- **Angka default aman:** heap idle TSIX hanya ~8–10 MB/worker, jadi 192 MB ≈ 20× idle. App GUI berat (emerald/cashew + banyak widget) tetap longgar.
- **Menonaktifkan:** set `workerMaxOldGenMb: 0` → blok `resourceLimits` tidak dipasang sama sekali (`if (maxOldMb > 0)` di `Scheduler.ts`), kembali ke default Node. Berguna untuk diagnosis kalau ada app yang dicurigai kena limit secara keliru.
- **Sudah diuji:** pemakaian `resourceLimits` (192/32, 512/64, 64/8, atau tanpa limit) tidak mempengaruhi `heapTotal`/`heapUsed` per worker — hanya memasang pagar.
- **Oleh:** Copilot · **Laporan:** kakang

### DIHAPUS: `scheduler.workerReapGraceMs` (parameter mati)

- **File:** `src/common/Config.ts`, `src/sysconfig.json`, `scripts/install.ts`
- **Masalah:** parameter ini dideklarasikan dan disetel (`2000`) tapi **tidak pernah dibaca di mana pun** — hanya ada 2 kemunculan di seluruh `src/`: deklarasi tipe dan komentar dokumentasi. Tidak ada reaper yang memakainya.
- **Keputusan:** **dihapus**, bukan diimplementasikan. Alasannya: lifecycle worker sekarang sudah menangani `exit` + `error` + jaring pengaman di `reap()`, dan belum ada bukti ada worker yang benar-benar menggantung. Menambah reaper periodik berarti menambah kode yang harus diuji tanpa kasus nyata.
- **Rencana asalnya** (untuk catatan bila nanti dibutuhkan): memberi tenggang waktu sebelum worker yang PCB-nya sudah `EXITED` tapi thread-nya masih hidup di-`force-terminate`.
- **Oleh:** Copilot · **Laporan:** kakang

### Utilitas `ps --mem` / `mem --per-proc` — atribusi memori per-proses

- **File:** `src/kernel/Scheduler.ts`, `src/kernel/Syscalls.ts`, `src/mirror/lib/UserLib.ts`, `src/mirror/bin/ps.ts`, `src/mirror/sbin/mem.ts`
- **Masalah:** `process.memoryUsage().rss` bersifat **process-wide** — bahkan bila dibaca dari dalam worker (worker dengan buffer 128 MB melaporkan `rss` 180 MB). Jadi `mem` lama tidak bisa menjelaskan siapa memakai berapa.
- **Temuan kunci:** Node menyediakan **`worker.getHeapStatistics()`** — API **pull** yang dipanggil dari main thread **tanpa** `postMessage`, sehingga tetap merespons walau worker sedang sinkron/blocking (`while(true)` — terverifikasi). Mengembalikan `Promise<HeapInfo>` dengan angka **per-isolate** (`used_heap_size`, `total_heap_size`, `external_memory`, `heap_size_limit`).
- **Perubahan:**
  - `Scheduler.getProcessMemory(pid)` → `{heapUsed, heapTotal, external, heapLimit} | null`; `null` bila proses tanpa worker atau worker tak dapat dibaca. Cast `as any` karena `@types/node` v20 belum mendeklarasikan method ini.
  - Syscall `PS` menerima `args.includeMemory` (opsional) → membaca statistik heap tiap worker. **Tidak** diambil pada `ps` biasa agar tetap ringan; `SyscallCode.PS` tidak ada di `validateArgs`, jadi argumen objek aman.
  - `UserLib.ShellLib.ps(options?)` meneruskan `{includeMemory:true}`; tambah `memoryUsage()`.
  - `ps --mem` / `ps --sort-mem` + ringkasan total heap semua worker; `mem --per-proc` menampilkan tabel per-proses dan **rekonsiliasi** (worker terukur vs RSS → selisih = main thread + library native).
- **Verifikasi:** uji e2e dengan worker nyata — `leak.js` tumbuh 19.7 → 42.3 MB sementara dua worker `calm` tetap datar di 10.2 MB; kebocoran teratribusi tepat. Uji itu juga membuktikan `resourceLimits` 192 MB benar-benar mematikan worker yang OOM.
- **Catatan:** teks keluaran `ps`/`mem` berbahasa Inggris agar konsisten dengan utilitas Unix lain.
- **Oleh:** Copilot · **Laporan:** kakang

### Koreksi penting — `vfs:bootstrap` TIDAK menimpa `/etc/passwd`

- **Konteks:** saat mengerjakan optimasi di atas, sempat diduga `npm run vfs:bootstrap` menimpa `/etc/passwd` (karena akun runtime `joe` hilang dari file itu di `system.db`).
- **Hasil verifikasi (uji A/B langsung):** dugaan itu **SALAH**. `syncDir()` di `scripts/vfs-bootstrap.ts` melewati file tanpa ekstensi (`if (!isTarget) continue;`), sehingga `passwd`/`group`/`shadow`/`motd`/`profile` **identik** sebelum & sesudah bootstrap.
- **Yang memang menimpa:** `scripts/install.ts` lewat daftar `CRITICAL_ETC` — ini perilaku yang didesain untuk fresh install, bukan bug. Sumber `src/mirror/etc/passwd` & `shadow` hanya berisi `root` (di git sejak awal).
- **Pemicu** hilangnya entri `passwd` pada `system.db` kerja belum teridentifikasi; yang pasti bukan `vfs:bootstrap` dan bukan seed kernel (`Kernel.ts` hanya menulis bila file belum ada).
- **Peluang terpisah yang masih terbuka:** `Kernel.ts` menyalin `defaultShell` dari `sysconfig.json`, tapi `Kernel.runInit()` memakai `scheduler.bootEntry` (`init.js`) — jadi `scheduler.defaultShell: "tsh.ts"` adalah setelan mati yang perlu dibersihkan agar tidak menyesatkan.
- **Oleh:** Copilot · **Laporan:** kakang

### Audit lanjutan: beban mati di `vfsCache` (temuan, belum dikerjakan)

- **File:** `src/kernel/Kernel.ts` (`rebuildVFSCache`)
- **Temuan:** `fetchDir` memasukkan `.ts`, `.js`, **dan** `.json` dari `/lib`, padahal `WorkerEntry` **hanya** mencari `/lib/X.ts` (`@tsix/X` → `/lib/X.ts`). Entri `.js` (51 file, **1.70 MB**) tidak pernah di-lookup, tetapi di-clone ke setiap worker.
- **Ukur empiris** (4 worker, app yang benar-benar `require` `emerald`+`cashew`+`Application`):
  - cache lengkap: **+16.9 MB/worker**
  - tanpa `.js` mentah: **+12.5 MB/worker**, framework tetap lengkap (`FRAMEWORK-OK` 4/4)
  - → potensi hemat **−4.4 MB/worker** (~84 MB untuk 19 worker), tanpa mengubah perilaku.
- **Temuan tambahan:** `*.test.ts` di `/lib` (354 KB, `.ts`+`.js`) ikut di-transpile saat boot & ikut dikirim ke setiap worker, padahal tidak pernah di-`require` aplikasi. Transpile 16 file `*.ts` saat boot memakan **96 ms CPU di main thread** (memblokir), sedangkan membaca sidecar `.js` yang sudah ada = **0 ms** (semua sidecar segar, nol yang basi).
- **Status:** belum diimplementasikan — menunggu keputusan (lihat rekomendasi di `wiki/changelogs/vfs.md`).
- **Oleh:** Copilot

## 2026-09-07

### Device HTTP & WebSocket di kernel land (`/dev/httpd`, `/dev/wsd`)

- **File:** `src/kernel/devices/aux-devices/HttpServerDevice.ts`, `src/kernel/devices/aux-devices/WebSocketDevice.ts`
- **Perubahan:**
  - **`HttpServerDevice` (`/dev/httpd`)** — server HTTP di kernel land. ioctl `LISTEN {port, ownerPid}`, `RESPOND {reqId,status,contentType,body,...}`, `STATUS`. Request dipush ke userland via channel `http_event` (`HTTP_REQUEST`/`LISTENING`/`LISTEN_ERROR`); belum dijawab dalam 30 dtk → auto 404.
  - **`WebSocketDevice` (`/dev/wsd`)** — server WS di kernel land dengan 2 mode: **standalone** (`WSD_LISTEN {port}`) atau **attach ke HTTP server milik owner** (`WSD_ATTACH`) sehingga HTTP+WS bisa satu port. Event channel `ws_event` (`WS_CONNECT`/`WS_MESSAGE`/`WS_CLOSE`/...); perintah `WS_SEND`/`WS_BROADCAST`/`WS_CLOSE`/`STATUS`.
  - SATU device menampung banyak server, dipisah per `ownerPid` → beberapa daemon (mis. DOME & web-gateway) bisa listen di port berbeda sekaligus.
- **Tujuan:** menutup lubang keamanan userland yang memakai `hostRequire("http"/"ws")` (escape hatch berdasarkan nama proses). Userland kini cukup `fs.open` + `fs.ioctl` + `lib.onEvent`.
- **Dokumen:** `wiki/webserver.md`, `wiki/websocket.md`. Contoh pemakaian: `src/mirror/opt/test/webd-demo.ts`.
- **Oleh:** Copilot + kakang

### Sandbox mencabut akses host langsung `http`/`ws`

- **File:** `src/userland/WorkerEntry.ts`, `src/userland/WorkerEntry.js`
- **Perubahan:** Menghapus modul `http` dan `ws` dari privileged `allowedModules` setelah DOME dan web-gateway selesai memakai `lib.web`.
- **Dampak:** Script userland tidak lagi dapat memperoleh modul network host melalui `require("http")`/`require("ws")` hanya karena nama prosesnya mengandung `dome`, `server`, atau `daemon`; akses HTTP/WebSocket wajib lewat device kernel dan `lib.web`.
- **Oleh:** Copilot + kakang

### `MCP23017Device` — konfigurasi hardware dua chip (relay + saklar)

- **File:** `src/kernel/devices/aux-devices/MCP23017Device.ts`
- **Perubahan:**
  - `HARDWARE_CONFIGS` kini dua chip: relay **`mcp-bulb` @0x20** + saklar **`mcp-sw` @0x24** (bus 1) → `/dev/mcp-bulb` & `/dev/mcp-sw` tersedia utk `smartbulb/service`.
  - Default nama device konstruktor digenerikkan: `"mcp-bulb"` → `"MCP23017"` (nama nyata dari `HARDWARE_CONFIGS`/parameter konstruktor).
- **Dampak:** service smartbulb dapat membuka chip relay produksi tanpa registrasi manual tambahan; `disabled: false` tetap sehingga konfigurasi ini auto-init saat boot.
- **Oleh:** kakang

### MCP23017 kembali auto-initialized untuk deployment smartbulb

- **File:** `src/kernel/devices/aux-devices/MCP23017Device.ts`
- **Perubahan:** `disabled` dikembalikan ke `false` agar konfigurasi hardware MCP23017 yang sudah didaftarkan dapat diinisialisasi otomatis saat boot. Permission device tetap `uid=0`, `gid=0`, mode `0660`; service smartbulb produksi dijalankan root atau user group pemilik device.
- **Dampak:** `/dev/mcp-bulb` dan `/dev/mcp-sw` siap dipakai service setelah kernel memuat konfigurasi hardware; client GUI/web tetap memakai IPC dan tidak perlu akses device langsung.
- **Oleh:** kakang

## 2026-09-04

### Auto-reply port probe + pelacakan pemilik port bind (`scanif -p` / `-l`)

- **File:** `src/kernel/devices/SimpleMQTNLDriver.ts`, `src/kernel/Syscalls.ts`
- **Perubahan:**
  - `handleIncomingMessage()`: `PING_REQUEST` (flag 1) ke port service ≠ 65535/65534 **yang sedang di-bind** (ada handler di `onMessageHandlers`) kini dijawab `PING_REPLY` otomatis di level kernel — probe tidak diteruskan ke daemon. Ini yang membuat port scan remote (`scanif -p`) mendeteksi port terbuka, mirip SYN-ACK TCP. Port 65535/65534 tetap: ping & broadcast ping.
  - Parameter `handleIncomingMessage(topic, message)` di-widen `Buffer` → `Buffer | string` (runtime sudah menangani keduanya; memperbaiki error tipe laten pada jalur loopback).
  - Pelacakan pemilik port: map `portProcess: Map<port, namaProses>` + method `bindProcess(port, name)`; syscall `BIND` mencatat `pcb.name`; `unregisterHandler` membersihkannya.
  - `getStats().params.boundPorts` kini `[{ port, proc }]` (sebelumnya hanya angka) → tersedia via `NETSTAT` untuk `scanif -l`.
- **Dampak:** `NETSTAT`/netstat lokal bisa menampilkan port bind per interface beserta nama script/daemon pemilik; auto-responder port-probe hanya aktif untuk port yang benar-benar di-bind.
- **Oleh:** Copilot

### `MCP23017Device` — rapi ulang + konfigurasi chip JayaLaras (`mcp-sw` @0x24), default `disabled`

- **File:** `src/kernel/devices/aux-devices/MCP23017Device.ts`
- **Perubahan:**
  - Reformat konsisten (indent 2-space, komentar register dirapikan).
  - `HARDWARE_CONFIGS` disesuaikan hardware JayaLaras → satu chip: `{ bus: 1, address: 0x24, name: "mcp-sw" }` (menggantikan default `0x20 "mcp23017"`).
  - Nama default device konstruktor: `mcp23017` → `mcp-bulb`.
  - Properti `disabled` default `false` → **`true`** (chip tidak ikut di-load saat boot sampai dikonfigurasi).
- **Dampak:** chip saklar `mcp-sw` siap dipakai `smartbulb/service` & `control --hw`; menambah chip lain cukup edit `HARDWARE_CONFIGS`.
- **Oleh:** kakang + Copilot

---

## 2026-08-28

### Jumlah TTY konsol kini configurable — `sysconfig shell.ttyCount/loginCount`

- **File:** `src/kernel/Kernel.ts`, `src/common/Config.ts`, `src/sysconfig.json`, `src/mirror/bin/init.ts`, `scripts/install.ts`
- **Masalah:** Jumlah konsol virtual & login hardcode (`new TTYManager(16)`, loop `i<=6`, login TTY2-6) → tidak bisa dikecilkan untuk hemat RAM.
- **Perubahan:**
  - `Config.ts` tambah `shell.ttyCount` & `shell.loginCount` (interface).
  - `Kernel.ts`: `new TTYManager(cfg.shell.ttyCount ?? 6)`; loop device `tty1..ttyCount`; inject env `TSIX_TTY_COUNT`/`TSIX_LOGIN_COUNT` ke proses init (diturunkan ke semua userland).
  - `init.ts`: spawn login `TTY2..(1+loginCount)` dari env.
  - `install.ts`: prompt interaktif alokasi TTY + validasi (`loginCount < ttyCount`).
- **Dampak:** `"ttyCount": 2, "loginCount": 1` = hemat RAM ekstrem; daemon remote (tsshd/airtermd/pixelterm) tidak lagi terikat slot ini karena sudah pakai PTY.
- **Oleh:** Copilot · **Laporan/konsep:** kakang

### `openvt` + FLUSH_INPUT (ioctl cmd 5) — isi TTY kosong tanpa input basi

- **File:** `src/mirror/bin/openvt.ts` (baru), `src/kernel/tty/TTY.ts`, `src/kernel/devices/TTYDevice.ts`, `src/kernel/devices/PTYSlaveDevice.ts`
- **Masalah:** TTY kosong (di luar loginCount) tidak bisa diisi tanpa edit kode; dan saat di-spawn, TTY idle menyimpan **input basi** (enter/karakter yang ditekan saat TTY tidak aktif) → proses baru (mis. login) langsung "memakan" enter basi → loop "Invalid username/password".
- **Perubahan:**
  - `TTY.flushInput()` — kosongkan `inputBuffer`/`lineBuffer`/`inputLines`/`cookedEchoState`.
  - ioctl **cmd 5 = FLUSH_INPUT** di `TTYDevice` & `PTYSlaveDevice` (tidak bentrok: 1=clear, 2=switch, 4=winsz, 10=raw, 0x2001/0x2002).
  - `openvt <ttyN> [cmd...]` — cek TTY ada, `ioctl(fd, 5, null)` buang input basi, lalu spawn program (default `/bin/login.js`, ala `getty`).
- **Dampak:** `openvt 4` → TTY4 jadi punya login prompt bersih; `openvt 5 /bin/tsh` → shell langsung. Konsol kosong = "aula siap atraksi" tanpa stale input.
- **Oleh:** Copilot

---

## 2026-08-18

### Error load-path aplikasi tampil di pixelterm & popup desktop (GUI_WINDOW_ERROR)

- **File:** `src/userland/WorkerEntry.ts`
- **Masalah:** Saat app gagal di-transpile/dimuat (mis. `./app.ts` dengan error TS), `console.error` di worker hanya menulis ke **host stderr** — tidak terlihat di pixelterm (yang hanya membaca buffer TTY) maupun di desktop. Pesan akhir `-bash: ...: Application not found (Path: VFS-Only)` juga menyesatkan karena app sebenarnya ketemu, cuma gagal load.
- **Perubahan:**
  - **`emitWorkerError()`:** cetak error load-path (TS Transpile, Direct Execution, identify AppClass, require gagal) ke TTY via `lib.std.print` (merah, format `[Worker N] ...`), fallback ke `console.error` bila print TTY gagal.
  - **Pesan akhir jujur:** `-bash: <app>: Failed to load — <penyebab>` (`transpile failed` / `direct execution failed` / `failed to load module` / `no valid 'main' export found`) menggantikan "Application not found" yang menyesatkan; `Application not found` tetap dipakai bila app benar-benar tidak ada.
  - **`notifyLoadError()`:** kirim `GUI_WINDOW_ERROR` ke parent & Window Manager (Asteracea) via `/opt/asteracea/wm-pid` — pola sama dengan `notifyParentWindowEvent()` di Emerald — sehingga error tampil sebagai popup desktop meski app dijalankan dari file-cruiser/terminal (foreign app). **WAJIB di-await** sebelum `realExit(1)` (fire-and-forget tidak sempat terkirim karena worker langsung mati).
  - **Popup detail:** `loadErrorDetail` membawa pesan esbuild/runtime asli agar popup WM spesifik, bukan sekadar kategori.
- **Dampak:** Error gagal-load kini terlihat di pixelterm (TTY) dan di desktop (popup WM) dari mana pun app dijalankan. Deploy: recompile `WorkerEntry.ts` → `WorkerEntry.js` (kernel memuat file `.js`), lalu restart.
- **Oleh:** Copilot

---

## 2026-08-15

### /dev/ttyN kini world-accessible (0o666) — pixelterm non-root bisa resize TTY

- **File:** `src/kernel/devices/TTYDevice.ts`, `src/mirror/opt/pixelterm/pixelterm.ts`
- **Masalah:** Device `/dev/ttyN` default `mode = 0o600` (root-only, dari `device.mode ?? 0o600` di syscall OPEN) → pixelterm yang dijalankan **non-root** gagal `fs.open("/dev/ttyN", "w+")` untuk TIOCSWINSZ → TTY tidak ke-resize, `getScreenInfo()` app (mis. atto) tetap 80x24 & tanpa SIGWINCH (hanya IPC RESIZE fallback yang tidak konsisten).
- **Perubahan:**
  - **`TTYDevice.ts`:** default `uid=0, gid=0, mode=0o666` — semua user boleh membuka `/dev/ttyN` untuk kontrol terminal (TIOCSWINSZ ioctl 3, clear ioctl 1) dan `less`/`more` yang buka `/dev/tty` dengan "r" (butuh READ). Konsisten dengan model keamanan existing (shell.write/read/send via PID tidak punya ownership check); root tetap bisa chmod/chown per-device.
  - **`pixelterm.ts`:** `applyTtySize()` log warning sekali jika open `/dev/ttyN` ditolak (tidak lagi gagal diam-diam).
- **Dampak:** Resize atto di pixelterm non-root kini sama seperti root. Deploy: restart kernel agar mode device baru aktif.
- **Oleh:** Copilot

---

## 2026-08-12

### Saved UID — login manager (WM) bisa re-elevate ke root utk switch user

- **File:** `src/kernel/Scheduler.ts`, `src/kernel/Syscalls.ts`, `src/mirror/bin/login.ts`
- **Masalah:** Setelah WM login sebagai user non-root, proses drop privilege permanen → kernel menolak `setgroups`/`setgid`/`setuid` untuk non-root, dan `/etc/shadow` (0640 root) tidak lagi terbaca → logout lalu login ulang sebagai root gagal. TSIX belum punya mekanisme **Saved UID** seperti Unix (`seteuid`/`setresuid`).
- **Perubahan:**
  - **`Scheduler.ts`:** tambah `pcb.suid` (Saved UID) di PCB & `createProcess`. Default `suid` = UID proses itu sendiri → app biasa TIDAK bisa escalate; hanya proses yang turun dari root (WM) yang menyimpan `suid=0`.
  - **`Syscalls.ts` SETUID:** proses root bebas setuid & menyimpan `suid` = UID lama (0 utk root); proses non-root hanya boleh **restore** ke `suid`-nya (`setuid(0)` → balik ke root). `SETGID`/`SETGROUPS` tetap root-only (setelah `setuid(0)`, proses jadi root → gid/groups normal).
  - **`login.ts`:** tambah mode `--verify <user> <pass> <resultFile>` — karena `/bin/login.js` SetUID root, ia bisa baca `/etc/shadow` walau dipanggil proses non-root (dipakai WM login). Hasil ditulis ke file (`OK`/`FAIL:...`); kanal file dipilih karena exit code anak tidak andal (WorkerEntry selalu menuntaskan `exit(0)`).
- **Dampak:** WM (Asteracea) bisa logout → login ulang sebagai user lain (termasuk root). Deploy: rebuild kernel + re-sync `login.ts`→`login.js` & `asteracea.ts` ke VFS + restart Asteracea.
- **Oleh:** Copilot · **Laporan/reproduksi:** kakang

---

## 2026-08-10

### Sudo group di-seed default (gaya Ubuntu)

- **File:** `src/kernel/Kernel.ts` (ensureDefaultGroups), `src/mirror/etc/group`
- **Perubahan:** Group `sudo` (GID 27) & `users` (GID 100) ada di seed default. `ensureDefaultGroups()` menjadi safety net: menambah `users`/`sudo` saat boot kalau belum ada.
- **Dampak:** Image fresh langsung punya group `sudo`; cukup `usermod -aG sudo <user>`.
- **Oleh:** Copilot

### Safe mode (`--safe-mode`)

- **File:** `src/kernel/Kernel.ts`
- **Perubahan:** `boot()` mendeteksi `process.argv.includes("--safe-mode")` → `safeMode=true` + log boot "MODE: Safe Mode". `runInit()` mengirim env `TSIX_SAFE_MODE=1` ke proses init (PID 1).
- **Dampak:** Dasar untuk menonaktifkan startup scripts saat troubleshooting (dikonsumsi init, lihat changelog `init.md`).
- **Oleh:** Copilot

---

## 2026-08-03

### PING RTT fix — recvFrom jadi event-driven (bukan polling 100ms)

- **File:** `src/kernel/devices/SocketDevice.ts`, `src/kernel/Syscalls.ts`, `src/mirror/lib/NetworkLib.ts`
- **Masalah:** `ping` menunjukkan RTT ~102ms padahal di bitshark (sniffer) hanya ~5ms. Akar masalah: `SocketDevice.read()` non-blocking (`buffer.shift() || null`), sedangkan `NetworkLib.recvFrom()` polling buta tiap 100ms → balasan yang sudah sampai di buffer ~5ms baru "terlihat" di tick polling berikutnya → RTT terukur ikut +~100ms.
- **Perubahan:**
  - **`SocketDevice`:** tambah `waiters[]` + `waitForData(timeoutMs)` (event-driven). `push()` kini membangunkan reader yang sedang menunggu, bukan menunggu tick polling.
  - **`Syscalls.ts` RECVFROM:** cek non-blocking dulu; kalau buffer kosong → `await socket.waitForData(50)` → begitu paket di-`push`, langsung return.
  - **`NetworkLib.recvFrom`:** ganti `retries = timeoutMs/100` + sleep 100ms dengan loop berbasis `deadline`; penerimaan paket kini event-driven.
- **Dampak:** RTT yang diukur aplikasi (ping, nmap) akurat mengikuti waktu nyata paket tiba. Daemon yang `recv` dalam loop (`tsd`, `otad`, `tpkgd`, `scpd`, `airtermd`) ikut lebih responsif (tidak ada jeda 100ms). Batas timeout keseluruhan tetap dihormati.

### MQTNL local loopback (localhost) — bypass broker untuk traffic lokal

- **File:** `src/kernel/devices/SimpleMQTNLDriver.ts`
- **Perubahan:**
  - Registry statis `SimpleMQTNLDriver.instances` + `findLocal(address)` (cocokkan `localAddress` atau nama device).
  - `send()`: sebelum publish ke broker, kalau alamat tujuan milik node ini (mis. `tsix`, `tsix-node-2`) → paket langsung diserahkan ke `handleIncomingMessage()` driver tujuan (loopback, tanpa round-trip MQTT).
  - Alias reserved **`localhost`** → di-resolve ke `this.localAddress` (interface pengirim) lalu di-loopback — mirip localhost di OS sungguhan. (Catatan: `127.0.0.1` sengaja TIDAK dijadikan alias — `test-dynamic-ota.ts` memakainya sebagai placeholder host remote.)
  - Cek koneksi (`!client.connected`) hanya berlaku untuk paket yang benar-benar keluar ke broker → komunikasi lokal tetap jalan walau broker mati.
  - Broadcast (`*`) tetap lewat broker (tidak di-loopback).
- **Dampak:** Self-ping & komunikasi antar interface lokal (`tsix` ↔ `tsix-node-2`) tidak lagi bergantung pada broker Mosquitto → RTT lokal minimal dan tetap berfungsi offline. Aplikasi userland tidak berubah (tetap `sendTo("<hostname>", ...)`); header paket tetap sama. `tpkg update localhost` kini benar-benar menarget diri sendiri.
- **Oleh:** Copilot

---

## 2026-08-02

### Network Sniffer subsystem (syscall 72/73) — dasar Bitshark

- **File:** `src/common/SyscallCode.ts`, `src/kernel/Syscalls.ts`, `src/kernel/devices/SimpleMQTNLDriver.ts`, `src/mirror/lib/UserLib.ts`
- **Perubahan:**
  - **Syscall baru:**
    - `NET_SNIFFER_REGISTER = 72` — daftarkan proses sebagai sniffer interface (arg: `interfaceName` atau `"*"` = semua).
    - `NET_SNIFFER_UNREGISTER = 73` — hentikan sniffing.
  - **`Syscalls.ts`:**
    - Registri `netSniffers: Map<interfaceName, Set<pid>>` — tahu PID mana yang menerima paket tiap interface; `"*"` untuk semua interface.
    - `forwardSniff(sniff)` — teruskan paket ke semua PID yang terdaftar via `scheduler.sendEvent(pid, "ipc_message", { data: sniff })`.
    - `ensureSnifferWiring()` — wire `onSniff` tiap `SimpleMQTNLDriver` ke `forwardSniff`; `wiredSniffers` mencegah duplikat callback.
    - Handler syscall 72/73; **cleanup otomatis** saat proses mati (PID dilepas dari semua interface).
  - **`SimpleMQTNLDriver.ts`:**
    - `sniffers[]` + `onSniff(cb)` + `emitSniff(sniff)`.
    - Hook di **dua titik strategis**:
      - **TX** (sebelum payload dienkripsi) → data plaintext asli.
      - **RX** (setelah payload didekripsi) → hasil decrypt, langsung terbaca.
  - **`UserLib.ts`:** `netSnifferRegister(iface)` / `netSnifferUnregister(iface)` — API untuk app userland.
- **Dampak:** App (Bitshark) bisa menyadap lalu lintas MQTNL per interface dari userland tanpa akses langsung ke perangkat — model sandbox/ring: semua akses lewat syscall. Karena intercept di dalam driver, payload terlihat plaintext (TX sebelum enkripsi, RX sesudah decrypt) tanpa perlu reverse-engineering enkripsi.
- **Oleh:** Copilot

---

## 2026-07-31

### mysqld — single-instance guard fix (stale pidfile + PID reuse)

- **File:** `src/mirror/etc/mysqld/mysqld.ts`
- **Perubahan:**
  - **Masalah:** `ps` menunjukkan `mysqld EXITED` di boot kedua+. Akar masalah: pidfile `/etc/mysqld/mysqld.pid` persisten di BKFS, dan PID di-reuse antar reboot → guard single-instance melihat dirinya sendiri (`isAlive(11)` = true karena proses baru dapat PID yang sama) → langsung `return` tanpa register sebagai DB service → app DB gagal (`/dev/mysql tidak tersedia`).
  - **Fix guard:** `existing !== selfPid` — pidfile yang berisi PID diri sendiri (reuse) tidak lagi dianggap instance lain.
  - **Fix `stop()`:** Cek `isMysqldAlive()` (PID + nama proses + state != EXITED) — pidfile basi yang menunjuk ke PID yang sudah dipakai proses lain tidak lagi salah-kill saat `mysqld --stop`.
- **Dampak:** mysqld ter-register sebagai DB service di setiap boot. `--stop` aman dari salah membunuh proses yang mewarisi PID lama.
- **Oleh:** Copilot

### crond — auto-daemonize + keep-alive fix

- **File:** `src/mirror/bin/crond.ts`
- **Perubahan:**
  - **Daemonize by default:** `crond` kini auto-daemonize (`shell.daemonize("Cron Daemon")`) kecuali `--foreground`/`-f`. Sebelumnya hanya di-daemonize dengan flag `--detach`, padahal `rc.local` menjalankannya tanpa flag.
  - **Keep-alive fix:** Ganti `await new Promise(() => {})` (promise kosong tidak menahan event loop worker → worker mati) dengan `while(true){ await sleep(5s) }` (timer handle nyata).
  - **Header komentar:** Konversi blok `/* */` → komentar `//` per baris karena contoh cron `*/5` mengandung `*/` yang menutup blok komentar (inilah kenapa header lama tampak "mangling" dengan spasi).
  - **Type fix:** `CronEntry.isReboot?: boolean` (pre-existing error).
- **Dampak:** crond berjalan sebagai background daemon dari rc.local dan tetap hidup meski crontab kosong.
- **Oleh:** Copilot

### CPU usage measurement — diimplementasi lalu di-roll back

- **File:** `src/common/SyscallCode.ts`, `src/kernel/Scheduler.ts`, `src/kernel/Syscalls.ts`, `src/mirror/lib/UserLib.ts`, `src/main.ts`, `src/mirror/bin/taskmgr.ts`, `src/mirror/bin/ps.ts`
- **Perubahan:** Ditambahkan syscall `CPU_REPORT`, sampling CPU per-proses (Scheduler), auto-report worker, kolom CPU% di Task Manager & `ps`. **Di-roll back seluruhnya** karena metrik tidak realistis — TSIX berbasis interpreter (semua worker thread dari satu proses host), jadi `process.cpuUsage()` proses-wide & `eventLoopUtilization()` tidak bisa membedakan beban per-proses secara akurat.
- **Oleh:** Copilot

---

## 2026-07-29

### FSTAB — uid, gid, mode, active support + mount point ownership

- **File:** `src/kernel/Kernel.ts`, `src/kernel/Syscalls.ts`, `src/kernel/MountManager.ts`, `src/mirror/lib/UserLib.ts`, `src/mirror/bin/mount.ts`, `src/vfs/VFS.ts`, `src/vfs/RamFS.ts`, `src/vfs/HostVFS.ts`, `src/vfs/BKFS.ts`
- **Perubahan:**
  - **FSTAB fields baru:** `uid`, `gid`, `mode` (opsional) untuk mengatur kepemilikan dan permission mount point. `active: false` untuk skip entry saat boot.
  - **`MountManager`:** `MountPoint` interface + `uid`/`gid`. `mount()` dan `listMounts()` mendukung parameter baru.
  - **`processFstab()`:** Baca `uid`/`gid`/`mode`/`active` dari fstab. Mount point yang sudah ada (dibuat `ensureDefaultAuth`) di-`chown`/`chmod` ulang. Semua tipe driver (RamFS, HostVFS, BKFS) menerima ownership parameter.
  - **`VirtualFileSystem`:** Constructor terima `rootUid`, `rootGid`, `rootMode` (default `0, 0, 0o755`). **Bug fix:** `mkdir()` sekarang benar-benar pakai parameter `uid`/`gid`/`mode` yang diberikan, bukan hardcoded `0, 0, 493`.
  - **`RamFS`:** Constructor terima `label, uid, gid, mode` → teruskan ke VirtualFileSystem.
  - **`HostVFS`:** Constructor terima `uid, gid, mode`. `stat()` return nilai override jika diset, fallback ke host OS.
  - **`BKFS`:** Constructor terima `uid, gid, mode`. Setelah `initSchema()`, update root node di SQLite jika ownership/permission diset.
  - **`mount` CLI:** Parse `--uid N` dan `--gid N`. Output `mount` (list) tampilkan `uid=`/`gid=` jika ada.
- **Dampak:** Mount point bisa dimiliki user/group selain root. `/tmp` bisa `mode: 1023` (sticky `rwxrwxrwt`) sehingga user biasa bisa nulis. Semua 3 tipe mount (ramfs, host, bkfs) konsisten mendukung custom ownership & permission. Backward compatible — semua field baru opsional.
- **Oleh:** Copilot

### OPEN syscall — truncate overwrites file ownership (bug fix)

- **File:** `src/kernel/Syscalls.ts` — `case SyscallCode.OPEN`
- **Perubahan:** `vfs.touch(relativePath, "")` → `vfs.touch(relativePath, "", pcb.uid, pcb.gid, 420)` pada blok truncate (`flags: "w"`).
- **Dampak:** Sebelumnya file yang dibuat via `OPEN("w")` (termasuk `cp`, redirection `>`, `edit`) selalu jadi `root:root` karena truncate kedua memanggil `touch()` tanpa uid/gid → default ke 0, 0. Sekarang file baru langsung milik user yang membuatnya.
- **Oleh:** Copilot

---

## 2026-07-28

### KILL/SIGNAL syscall — permission & proteksi PID 1

- **File:** `src/kernel/Syscalls.ts` — `case SyscallCode.KILL`, `case SyscallCode.SIGNAL`
- **Perubahan:**
  - **PID 1 (init) dilindungi:** Tidak bisa di-kill atau di-signal oleh siapapun, termasuk root. Hanya bisa dimatikan lewat `SHUTDOWN` syscall yang merupakan prosedur resmi system termination.
  - **Permission check:** Non-root user hanya bisa kill/signal proses miliknya sendiri (cek via UID). Root tetap bisa kill proses siapapun.
  - **Existence check:** Kalau PID target gak ada, return error `kill: No such process` (sebelumnya silent fail).
- **Dampak:** User biasa `kill 1234` proses milik root → error. Root `kill 1` → error, disuruh pakai `shutdown` atau `reboot`. Sesuai standar UNIX security.
- **Oleh:** Copilot

---

## 2026-07-27

### TTY Manager — kapasitas diperluas ke 32

- **File:** `src/kernel/Kernel.ts`
- **Perubahan:** `TTYManager(12)` → `TTYManager(32)`. Iterasi register device TTY dari `i <= 12` jadi `i <= 32`.
- **Dampak:** Tersedia 32 TTY (1-32). TTY 1-6 untuk host console, TTY 7-32 untuk terminal terisolasi (pixelterm, airtermd, dll). Tidak ada perubahan performa signifikan karena TTY dialokasikan secara lazy.
- **Oleh:** andriansah

---

## 2026-07-26

### LS syscall — tambah permission check

- **File:** `src/kernel/Syscalls.ts` — `case SyscallCode.LS`
- **Perubahan:** Sebelumnya `ls` langsung return `vfs.ls()` tanpa ngecek akses. Sekarang `stat()` dulu direktori, lalu cek `Permission.READ` via `PermissionManager`.
- **Dampak:** User non-root gak bisa `ls /root/` lagi. Error: `Permission denied`
- **Oleh:** Copilot

### CHDIR syscall — error message proper

- **File:** `src/kernel/Syscalls.ts` — `case SyscallCode.CHDIR`
- **Perubahan:** Ganti `return false` untuk permission denied jadi `throw new Error(...)` dengan pesan spesifik. Juga ganti `vfs.exists()` redundant dengan cek `node.type`.
- **Dampak:** `cd /root/` bukan root sekarang: `cd: permission denied: /root` (bukan "No such file")
- **Oleh:** Copilot

### Shell `cd` — try-catch biar gak crash

- **File:** `src/mirror/bin/tsh.ts`
- **Perubahan:** Bungkus `shell.chdir()` dengan try-catch.
- **Dampak:** Error permission dari CHDIR syscall gak bikin shell exit/logout.
- **Oleh:** Copilot

### `ls` binary — error message dibedakan

- **File:** `src/mirror/bin/ls.ts`
- **Perubahan:** Catch block sekarang ngecek `e.message` — kalau ada kata "permission" tampilkan `Permission denied`, sisanya `No such file or directory`.
- **Dampak:** User lihat pesan error yang sesuai dengan penyebabnya.
- **Oleh:** Copilot

---
