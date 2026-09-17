# Changelog NetFS

> Format: `YYYY-MM-DD | Perubahan | Oleh`

Dokumentasi lengkap: [`wiki/netfs.md`](../netfs.md).

---

## 2026-09-17

### NetFS — payload Buffer diterima (fix "terganggu saat tssh jalan") + protocol di-pin eksplisit

- **File:** `src/common/netfs/NetFSProtocol.ts` (`parseNetFSPayload()` baru), `src/common/netfs/NetFSServer.ts`, `src/vfs/NetFS.ts`, `src/mirror/sbin/netfsd.ts`, `src/mirror/lib/NetFSClient.ts`, `src/kernel/netfs/MQTNLNetFSChannel.ts`.
- **Gejala:** mount NetFS jalan normal, lalu jalur NetFS "terganggu" (operasi menggantung / timeout) begitu ada trafik biner lain di node yang sama — mis. `tssh` ke node lain. Yang terganggu justru jalur ke node yang sama sekali tidak terlibat.
- **Dua sebab (diperbaiki keduanya):**
  1. **Kernel:** port channel NetFS tidak di-pin protocolnya, sehingga mewarisi framing dari trafik biner node (gema paket sendiri masuk ke `protocolRegistry`). Diperbaiki di driver + `MQTNLNetFSChannel.open()` (lihat `wiki/changelogs/kernel.md`).
  2. **Userland:** semua titik masuk NetFS memakai pola `typeof raw === "string" ? JSON.parse(raw) : raw`. Kalau driver memilih framing biner untuk port itu (Binfeo/Binary), payload tiba sebagai **Buffer** — pola di atas menganggapnya "sudah diparse", `req.id`/`res.id` jadi `undefined`, lalu:
     - di `netfsd` (relay): request **dibuang diam-diam** → mount hang sampai timeout, tanpa error di log;
     - di SL/driver kernel: jawaban `EBADOP "op tidak dikenal: undefined"` walau request-nya valid.
- **Perubahan:**
  - Helper baru **`parseNetFSPayload()`** di `@common/netfs/NetFSProtocol` — menerima string JSON, **Buffer** (utf8), artefak IPC `{type:"Buffer",data:[]}`, atau objek yang sudah diparse. Dipakai di **semua** titik masuk: `NetFSServer.handle()`, `NetFS.onMessage()` (driver kernel), `NetFSClient`, dan `netfsd`.
  - Pagar ukuran request (`NETFS_MAX_REQUEST_CHARS`) kini dihitung dari panjang payload mentah, apa pun framingnya (string/Buffer).
  - `netfsd` menyebut **`protocol: "JSON"` eksplisit** di ketiga socket (SL + relay `local` + relay `upstream`) — kontrak wire jadi terbaca dari daemon-nya, tidak bergantung pada default node.
  - `MQTNLNetFSChannel` mem-pin port channel ke JSON (open) dan melepasnya (close).
- **Catatan penting:** `NetSocket` sudah meng-pin protocol saat `open()`, jadi socket daemon sebenarnya aman — yang rapuh adalah (a) port channel kernel yang tidak di-pin, dan (b) parser yang mengasumsikan payload selalu string. Keduanya kini dijaga.
- **Test:** `NetFSProtocol.test.ts` (N6 — decoder: string/Buffer/IPC/garbage), `NetFSServer.test.ts` N1.03b/N1.03c (payload Buffer diproses, payload rusak → `EBADREQ` jelas), `SimpleMQTNLDriver.protocol.test.ts` (N7), `MQTNLNetFSChannel.test.ts` N4.06/N4.08.
- **Oleh:** Copilot · **Laporan:** andriansah

### NetFS — filesystem antar-node lewat MQTNL (driver + SL + daemon klien)

- **File (baru):**
  - `src/common/netfs/NetFSProtocol.ts` — wire protocol NetFS v1: daftar op, amplop request/response, codec konten base64, parser spec alamat (`tsix_2:7777`), mapping error → kode POSIX-style. Sengaja **tanpa dependency** karena dipakai kernel *dan* userland.
  - `src/common/netfs/NetFSServer.ts` — inti **SL** (Server Listener): eksekusi op ke backend, prefix export, pagar `--ro`, filter client (`--allow`), normalisasi `..`, pagar ukuran/chunk.
  - `src/vfs/NetFS.ts` — **driver VFS (kernel)**: implementasi `IVFS` dengan korelasi `id`, timeout, cache opsional, penanda **stale**, pemulihan otomatis.
  - `src/kernel/netfs/MQTNLNetFSChannel.ts` — transport sisi kernel: alokasi port MQTNL + `registerHandler` + `send()` + pelepasan port/session key saat umount.
  - `src/mirror/sbin/netfsd.ts` — **userland, NetSocket**: `--export <path>` (SL di storage host) dan `--client --to <addr>` (jembatan klien).
  - `src/mirror/lib/NetFSBackend.ts` — adapter `IVFS` → `lib.fs` (syscall) untuk `netfsd --export`.
  - `src/mirror/lib/NetFSClient.ts` + `src/mirror/bin/netfs.ts` — alat diagnosa tanpa mount: `netfs info | ls | cat | status`.
  - `src/common/MaybePromise.ts` — tipe `MaybePromise<T>`.
- **File (diubah):** `src/vfs/IVFS.ts`, `src/kernel/Syscalls.ts` (mount type `netfs` + `await` di semua call-site IVFS), `src/kernel/Kernel.ts` (`fstab` tipe `netfs`, `runInit()` async), `src/main.ts`, `src/kernel/MountManager.ts` (`stale` di `listMounts`), `src/kernel/devices/IDevice.ts` + `FileSystemDevice.ts`, `src/mirror/lib/UserLib.ts` (`fs.mount` menerima opsi tambahan), `mount.ts` (`--netfs` + `--via/--direct/--key/--timeout/--cache/--iface`), `lsblk.ts` (`rw,stale`), `df.ts` (`NET`/`STALE`), `scripts/install.ts` (lewati `*.test.ts`).
- **Perubahan:** filesystem node TSIX lain bisa di-mount sebagai mount point biasa — `mount /mnt/net tsix_2:7777 --netfs`. Transport **MQTNL**, jadi **tanpa IP publik / sewa VPS**: cukup di broker yang sama. Driver VFS tetap di kernel; SL dan daemon klien di **userland memakai NetSocket**. Dua jalur transport: lewat daemon klien (kernel → `localhost:7778`, MQTNL loopback) atau `--direct` (kernel → SL langsung).
- **Kontrak yang berubah:** semua method `IVFS` → `MaybePromise<T>`, dan `IDevice.write()` → `MaybePromise<boolean>`. Pemakai di kernel kini `await`; driver lokal tidak berubah sama sekali. `Kernel.runInit()` jadi `async`.
- **Keamanan:** hak akses remote = uid proses `netfsd` di SH (**efek root-squash**), `--ro` dipaksa di SH, filter `--allow`, enkripsi per-port (`--key` 64 hex → ChaCha20-Poly1305/AES-GCM), klien tak bisa keluar dari root export.
- **Perilaku gagal:** timeout → error `ETIMEDOUT` + mount **stale** (soft mount, bukan hang), pulih sendiri saat peer hidup; `umount` melepas port MQTNL + session key. Boot tidak digagalkan bila peer di fstab mati.
- **Test:** 45 test baru (`NetFSServer.test.ts`, `NetFS.test.ts`, `MQTNLNetFSChannel.test.ts`, `NetFSBackend.test.ts`) — tanpa broker MQTT (transport diganti loopback/spy). Regresi nol: 8 kegagalan test lain sudah ada sebelum perubahan ini.
- **Deploy:** file userland baru harus masuk VFS dulu → jalankan `npm run install`.
- **Dampak:** TSIX kini bisa berbagi storage antar-node tanpa infrastruktur jaringan publik; pola mount konsisten dengan `host`/`bkfs`/`ramfs`.
- **Oleh:** Copilot

### Relay daemon klien: id request ditulis ulang (aman multi-mount)

- **File:** `src/mirror/sbin/netfsd.ts`
- **Masalah:** setiap driver `NetFS` memulai hitungan `id` dari 1. Kalau **dua mount** berbagi satu daemon klien, `id` mereka bentrok dan balasan dari SH bisa salah rute ke mount yang lain.
- **Perubahan:** relay memakai `id` sendiri (naik monoton) untuk tiap request yang diteruskan ke SH, lalu **memulihkan `id` asli** milik kernel saat membalas.
- **Dampak:** satu `netfsd --client` aman melayani beberapa mount sekaligus.
- **Oleh:** Copilot

### `netfsd` gagal dimuat — bug loader worker (import relatif modul bersarang)

- **File:** `src/userland/WorkerEntry.ts`, `src/userland/WorkerEntry.js`, `scripts/test/worker-dme-smoke.mjs` (baru)
- **Gejala:** `netfsd` → `Direct Execution Error: Cannot find module './NetFSProtocol'` (require stack: `@common_netfs/NetFSServer.js`).
- **Akar masalah:** loader DME di `WorkerEntry` hanya menerjemahkan import relatif untuk modul **top-level** (nama file buatan `@common_x.js`); untuk modul **bersarang** (`@common/netfs/NetFSServer` → file `@common_netfs/NetFSServer.js`) `./NetFSProtocol` dibiarkan mentah → `require()` gagal. NetFS adalah modul bersarang pertama di repo yang punya import relatif, jadi bug laten ini baru muncul sekarang.
- **Perbaikan:** resolusi relatif dilakukan di ruang module-id (`moduleIdByFile` + `resolveRelativeModuleId()`), dan peta didaftarkan **sebelum** `_compile()` karena `require` anak terjadi di dalam `_compile`. Detail lengkap + verifikasi: `wiki/changelogs/kernel.md` (2026-09-17).
- **Catatan:** ini bug framework, bukan NetFS. `netfsd`/`netfs` sendiri tidak diubah — setelah loader diperbaiki keduanya jalan (diverifikasi dengan harness `scripts/test/worker-dme-smoke.mjs`).
- **Oleh:** Copilot
