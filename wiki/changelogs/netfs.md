# Changelog NetFS

> Format: `YYYY-MM-DD | Perubahan | Oleh`

Dokumentasi lengkap: [`wiki/netfs.md`](../netfs.md).

---

## 2026-09-22

### NetFS — chunk 124 KiB (4 fragmen) + temuan bottleneck RTT & O(n²) di bkfs

- **File:** `src/common/netfs/NetFSProtocol.ts`, `src/mirror/lib/UserLib.ts`, `src/mirror/opt/test/file-operation.ts`, `src/common/netfs/NetFSServer.test.ts`.
- **Gejala (laporan lapangan):** copy file 70 MB ke mount NetFS **jalan tanpa putus** (target: `/mnt/sbak` di SH `jatitsix`), tapi MQTNL traffic monitor menunjukkan TX hanya **~124 KB/s**.
- **Pengukuran:** `netfs info jatitsix:7777` → **RTT 182 ms**. Aritmetika: 31.744 B ÷ 124 KB/s ≈ 0,256 s per chunk ⇒ satu chunk ≈ satu round-trip. Jadi **biaya dominan = round-trip, bukan byte** (broker 2× traversal + hop relay + batas syscall + backend ≈ 182 ms + ~70 ms).
- **Akar masalah:** jalur tulis NetFS sekuensial (offset chunk berikutnya bergantung pada hasil chunk sebelumnya) ⇒ `throughput ≈ chunk / RTT`. Chunk 31 KiB (1 fragmen MQTNL) jadi tidak efisien: jaringan menganggur ~99% waktu.
- **Perubahan:** `NETFS_MAX_CHUNK_BYTES` **31 KB → 124 KB** (4× `packetSize` 32 KiB) dan `NETFS_MAX_REQUEST_BYTES` **64 KB → 256 KB** (2× chunk + overhead). Byte di wire dan jumlah **publish MQTNL tidak berubah** (MQTNL tetap memecah per 32 KB) — yang berkurang hanya jumlah **balasan**, jadi ~4× throughput. `fs.copyWithProgress()` + demo `file-operation` mengikuti plafon 124 KB.
- **Dampak terukur (RTT 182 ms):** 31 KB → ~124 KB/s; 124 KB → **~500 KB/s**; 70 MB ≈ 10 menit → **~2,4 menit**.
- **Temuan tambahan (belum diubah, perlu keputusan):**
    1. **Target export `bkfs` itu O(n²).** BKFS menyimpan isi file di SATU kolom, jadi tiap `writeChunk` append menjalankan `content = IFNULL(content,'') || ?` yang menulis ulang seluruh baris: 70 MB ⇒ ~2.260 chunk × rata-rata 35 MB salinan ≈ **~79 GB** kerja di SH. `host` (HostVFS, `pwrite`) O(1) dan jadi target yang benar untuk export besar. Dicatat di `wiki/netfs.md` §7.1.
    2. **Pipelining belum ada** — 1 chunk in-flight. Kalau RTT besar, ini plafon berikutnya (opsi `writeOpen`/`writeData` + window).
    3. Broker di LAN (kalau kedua node sejaringan) menghapus latensi jaringan tanpa mengubah protokol; `--direct` memangkas hop relay.
- **Test:** 54 test NetFS/VFS/kernel-netfs hijau setelah perubahan konstanta.
- **Oleh:** Copilot · **Laporan:** andriansah

### NetFS v2 — protokol BINER (transport Binfeo), JSON + base64 dibuang

- **File:** `src/common/netfs/NetFSProtocol.ts` (codec baru), `src/common/netfs/NetFSServer.ts`, `src/vfs/NetFS.ts`, `src/kernel/netfs/MQTNLNetFSChannel.ts`, `src/mirror/sbin/netfsd.ts`, `src/mirror/lib/NetFSClient.ts`, `src/mirror/lib/UserLib.ts`, `src/mirror/opt/test/file-operation.ts`, + seluruh test NetFS.
- **Alasan:** v1 mengirim konten sebagai base64 di dalam JSON, jadi ada dua pemborosan bertumpuk: (1) base64 → **+33%**, (2) saat `--key`, `securePacketOut()` mengubah hasil enkripsi jadi **hex** → **×2** lagi. Satu chunk 32 KB menjadi ~87,6 KB di wire (3 fragmen MQTNL), plus CPU base64/hex dan `JSON.parse`/`stringify` — yang di relay `netfsd --client` dikerjakan **dua kali** per request (parse lalu serialize ulang).
- **Perubahan:**
    - **Frame biner v2** (`NETFS_VERSION = 2`): header 8 byte (`magic 0x4E`, versi, tipe frame, kode op / flag, lalu `id` uint32 **di offset tetap 4**), diikuti nilai bertag (`null`/`false`/`true`/`num` i64 BE/`str` UTF-8/`blob` byte mentah/`arr`/`obj`).
    - **Konten = byte mentah** lewat `blob()`/`blobData()` — tanpa base64, tanpa JSON. `read`/`readChunk` mengembalikan blob; `touch`/`append`/`writeChunk` menerima blob.
    - **Transport dipin ke Binfeo** (`NETFS_WIRE_PROTOCOL`) di empat titik: socket SL, relay `local`, relay `upstream`, dan port channel kernel (`ioctl 0x1002`). Konstanta baru itu mencegah typo nama protocol.
    - **Relay jauh lebih murah:** `netfsd --client` hanya membaca header (`readNetFSFrameHeader`) lalu menambal `id` (`patchNetFSFrameId`) — payload besar tidak lagi di-parse dan di-serialize ulang.
    - **Batas ukuran dalam byte:** `NETFS_MAX_REQUEST_BYTES` = 64 KB (dulu 96 KB _karakter_), `NETFS_MAX_CHUNK_BYTES` = **31 KB** (dulu 32 KB) supaya satu potongan + IV/tag (28 B) pas **satu** fragmen MQTNL 32 KB. `NETFS_MAX_REQUEST_CHARS` & `NETFS_MAX_INLINE_BYTES` dihapus (pemecahan otomatis di driver tetap jalan, ambangnya kini 31 KB). → **Disuperseded hari yang sama:** 31 KB/64 KB dinaikkan jadi **124 KB/256 KB** begitu ketahuan bottleneck-nya round-trip (lihat entry paling atas).
    - **Diagnosa salah-versi:** `toNetFSBuffer()` menormalkan semua bentuk payload (Buffer kernel / Uint8Array lewat IPC / string saat Binfeo tanpa key / artefak `{type:"Buffer",data:[]}`), dan `netfsWireHint()` memberi pesan jelas kalau peer masih mengirim JSON v1 — supaya beda versi tidak terlihat seperti "mount hang".
    - `fs.copyWithProgress()` (userland) ikut memakai plafon 31 KB.
- **Tanpa backward compat (disengaja):** NetFS baru beberapa hari, jadi v1 tidak didukung lagi; peer lama dijawab `EBADREQ` + petunjuk Binfeo. Entry "`cp` file besar gagal `ETOOBIG`" di bawah berlaku untuk v1 — angka `NETFS_MAX_INLINE_BYTES`/96 KB di sana sudah digantikan angka di atas.
- **Dampak (1 MiB konten, `--key` aktif):** ~96 publish MQTNL → ~33 (tiap chunk 31 KB = 1 fragmen), byte di wire ~2,6× lebih sedikit, dan tidak ada lagi base64/hex/JSON di jalur data.
- **Test:** `NetFSProtocol.test.ts` N6.01–N6.10 (round-trip frame, blob byte 0..255 tanpa pembengkakan, header + tambal `id`, normalisasi payload, frame rusak/versi lama, penjaga kedalaman), `NetFSServer.test.ts` N1.03b/N1.03c/N1.04/N1.07/N1.08/N1.13 + N3.04, `NetFS.test.ts` N2.14–N2.16, `MQTNLNetFSChannel.test.ts` N4.02/N4.03/N4.06/N4.08 (pin Binfeo). 62 test NetFS hijau; `npm test` = 1086 passed dengan 9 kegagalan **pra-ada** (tidak ada regresi baru).
- **Deploy:** driver + channel ada di **kernel** (aktif setelah restart). `netfsd.ts`, `NetFSClient.ts`, `UserLib.ts`, dan `src/common/netfs/*` ada di **userland** → jalankan `npm run install` (atau `npm run vfs:bootstrap`) supaya VFS ikut diperbarui. **Kedua node wajib di-update** — beda versi = `EBADREQ`.
- **Oleh:** Copilot · **Laporan:** andriansah

### NetFS — `cp` file besar gagal `ETOOBIG` (konten besar kini dipecah otomatis di driver)

- **File:** `src/vfs/NetFS.ts`, `src/common/netfs/NetFSProtocol.ts`, `src/mirror/lib/UserLib.ts`, `src/mirror/opt/test/file-operation.ts`.
- **Gejala:** menyalin file dari filesystem lokal ke mount NetFS (`cp big.bin /mnt/net/`) gagal untuk file besar dengan `ETOOBIG` — pesan `"request N char melebihi batas 98304"`. File kecil baik-baik saja.
- **Akar masalah:** `cp` membaca isi penuh lalu menulisnya lewat satu syscall `WRITE` → `vfs.append()` → op NetFS `append` dengan **seluruh konten** dalam satu request. Konten membengkak 4/3x setelah base64, dan SL menolak request > 96 KiB (`NETFS_MAX_REQUEST_CHARS`). Jadi ambang praktisnya hanya ~72 KiB — bukan 500 KiB seperti yang diasumsikan dokumentasi. Protokol memang menyediakan `writeChunk` (32 KiB), tapi tidak ada yang memanggilnya untuk jalur tulis "biasa".
- **Perubahan:**
    - **Pemecahan otomatis di driver klien** (`NetFS.writeContent()`): `touch()`/`append()` dengan konten ≤ `NETFS_MAX_INLINE_BYTES` dikirim inline (tetap 1 round-trip); di atasnya dipecah jadi `writeChunk` per `NETFS_MAX_CHUNK_BYTES` (32 KiB). Dilakukan di **driver**, bukan di pemanggil, supaya `cp`, `writeFile()`, dan redirect shell file besar tetap jalan tanpa tahu batas wire.
    - `touch()` besar = _ganti isi_: file lama di-`unlink` dulu (karena `writeChunk` menimpa, tidak memotong ekor), lalu uid/gid/mode dipasang kembali lewat `chown`/`chmod`.
    - `append()` besar = sambung di ekor: `getSize()` dulu (toleran kalau file belum ada → offset 0).
    - Konstanta baru `NETFS_MAX_INLINE_BYTES` (48 KiB) di `NetFSProtocol.ts` — batas konten inline yang menyisakan ~32 KiB dari pagar 96 KiB untuk amplop JSON + path.
    - `fs.copyWithProgress()` kini memakai default **32 KiB** (dulu 64 KiB) dan **men-clamp** `chunkSize` ke plafon itu, karena `readChunk`/`writeChunk` di atas 32 KiB ditolak `ETOOBIG` oleh SL NetFS.
- **Dampak:** file besar bisa disalin ke/dari mount NetFS dengan `cp` biasa; jumlah round-trip naik (1 per 32 KiB) tapi setiap paket tetap di bawah batas fragmentasi MQTNL.
- **Test:** `NetFS.test.ts` N2.14 (append besar → terpecah, `maxSent ≤ NETFS_MAX_REQUEST_CHARS`) & N2.15 (touch besar lalu diganti konten lebih pendek → tidak menyisakan ekor); `NetFSServer.test.ts` N1.13 (request inline > 96 KiB ditolak `ETOOBIG`, chunk 32 KiB diterima). 216 test NetFS/VFS hijau; tidak ada regresi baru (9 kegagalan `npm test` semuanya sudah ada sebelum perubahan).
- **Deploy:** perubahan `NetFS.ts` ada di **kernel** (aktif setelah restart). `UserLib.ts`/`file-operation.ts` ada di userland → jalankan `npm run install` (atau `npm run vfs:bootstrap`) agar terbawa ke VFS.
- **Oleh:** Copilot · **Laporan:** andriansah

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
    - `src/common/netfs/NetFSProtocol.ts` — wire protocol NetFS v1: daftar op, amplop request/response, codec konten base64, parser spec alamat (`tsix_2:7777`), mapping error → kode POSIX-style. Sengaja **tanpa dependency** karena dipakai kernel _dan_ userland.
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
