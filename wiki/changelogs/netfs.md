# Changelog NetFS

> Format: `YYYY-MM-DD | Perubahan | Oleh`

Dokumentasi lengkap: [`wiki/netfs.md`](../netfs.md).

---

## 2026-09-17

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
