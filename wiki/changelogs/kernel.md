# Changelog Kernel TSIX

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-12

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

### `scheduler.workerReapGraceMs` (opsional, belum diaktifkan)

- **File:** `src/sysconfig.json`, `src/common/Config.ts`
- **Perubahan:** Opsi grace period (ms) untuk force-terminate worker yang PCB-nya sudah `EXITED` tapi thread-nya masih hidup. Saat ini baru disiapkan konfigurasinya; reaper periodiknya belum diimplementasikan.
- **Oleh:** Copilot

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
