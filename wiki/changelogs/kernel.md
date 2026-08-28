# Changelog Kernel TSIX

> Format: `YYYY-MM-DD | Perubahan | Oleh`

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
