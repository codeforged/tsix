# Changelog NetFS

> Format: `YYYY-MM-DD | Perubahan | Oleh`

Dokumentasi lengkap: [`wiki/netfs.md`](../netfs.md).

---

## 2026-09-22

### `cp` 70 MB "sukses" tapi 0 byte — `SUBSTR()` pada kolom TEXT ber-NUL

- **File:** `src/vfs/BKFS.ts` (inti perbaikan), `src/vfs/NetFS.ts`,
  `src/common/netfs/NetFSServer.ts`, `src/mirror/bin/cp.ts`, `src/mirror/bin/netfs.ts`
  (subcommand `probe`) — test: `BKFS.test.ts` B2.22b–B2.22d/B2.26–B2.27,
  `NetFS.test.ts` N2.17–N2.19, `NetFSServer.test.ts` N1.14–N1.15
- **Gejala:** `cp /mnt/net/video.mov ./` melaporkan sukses dalam ~580 ms, hasilnya file
  **0 byte**. Setelah pengerasan driver, pesannya jadi:
  `readChunk /video.mov offset 0 mengembalikan KOSONG (minta 126976 byte, ukuran file 70499395)`.
- **Diagnosa berlapis (semua terukur):**
    1. Relay klien (`netfsd --client`) **bukan** penyebab — `netfs probe jatitsix:7777`
       langsung ke SL (tanpa relay) memberi hasil sama.
    2. Jaringan/transport **bukan** penyebab — `info`/`stat`/`getSize` 15–100 ms, dan
       `read` file besar ditolak rapi `ETOOBIG`.
    3. `readChunk` **bukan** rusak — untuk `/readfile-net.ts` (365 B) hasilnya `365 byte ok`.
    4. Baris besar **bukan** masalah SQLite — uji lokal BKFS 60 MB: `readChunk` 4096 byte ✅.
    5. Rantai penuh (driver → SL → `NetFSBackend` → BKFS) direproduksi lokal: tulis 1,75 MB
       lewat driver, dibaca ulang **utuh** ✅.
    ⇒ Dugaan awal "baris korup" **SALAH**: laporan lapangan membuktikannya —
      `cp /mnt/sbak/video.mov /mnt/shared/` **di SH** menghasilkan berkas utuh dan
      videonya normal diputar di VLC. Isi berkas memang ada; yang rusak adalah CARA
      membacanya per potongan.
- **AKAR MASALAH (terukur):** `BKFS.readChunk()` memakai SQL
  `SUBSTR(content, ?, ?)`, sedangkan kolom `content` bertipe **TEXT** — dan SQLite
  memperlakukan TEXT sebagai C-string di fungsi karakter: **berhenti di byte NUL**.
  ```
  INSERT "AB\u0000\u0000\u0000Z"   ->  length() = 2, substr(c,1,6) = "AB"
                                        (SELECT content tetap 6 char — datanya utuh)
  ```
  Berkas biner hampir selalu memuat NUL — bahkan di byte PERTAMA: video MP4/MOV
  diawali `00 00 00 18 ftyp …`. Jadi `SUBSTR(content, 1, 4096)` = `""` untuk SETIAP
  berkas biner, dan offset berapa pun (mis. ekor 70 MB) juga `""` karena sudah di
  luar "panjang C-string". Itu sebabnya:
    - `read()` (baca penuh) **utuh** ✅ — dan berkasnya bisa diputar normal;
    - `readChunk()` selalu **0 byte** ✗ untuk berkas biner, sedangkan berkas teks
      (mis. `readfile-net.ts` 365 B, tanpa NUL) **baik-baik saja** ✅;
    - uji lokal dengan `'x'.repeat(...)` (tanpa NUL) juga lolos — itulah kenapa bug
      ini sempat tersembunyi.
  ⇒ **Semua berkas biner** (video/gambar/font) tidak bisa dibaca chunked — termasuk
    seluruh `cp` dari mount NetFS, yang jalurnya wajib lewat `readChunk`.
- **Perbaikan:** `BKFS.readChunk()` tidak lagi memakai `SUBSTR()`; isi diambil lewat
  `read()` (aman untuk NUL) lalu `slice()` di JS, dengan **cache satu entri** per berkas.
  Efek sampingnya menguntungkan: pembacaan berurutan hanya mengambil isi SEKALI
  (sebelumnya `SUBSTR` men-scan seluruh nilai per potongan — O(n) tiap potongan, jadi
  O(n²) untuk satu berkas utuh). Cache dibuang di setiap operasi tulis
  (`touch`/`append`/`writeChunk`/`unlink`/`rmdir`) dan dibatasi
  `BKFS_CHUNK_CACHE_MAX_BYTES` (192 MB, satu entri).
- **Guard yang ditambahkan (supaya kelas ini tidak pernah senyap lagi):**
    - `NetFS.readChunked()`: potongan kosong/pendek/total ≠ ukuran = **ERROR**, pesannya
      menyebut kemungkinan berkas korup + saran `netfs probe` & salin ulang. Dulu
      `return null`/`""` → `cp` menulis 0 byte dan melaporkan SUKSES.
    - SL (`read`): kalau `size > 0` tapi isi kosong → `EIO "...baris korup..."`,
      bukan mengirim `""`.
    - `BKFS.writeChunk()`: **sparse write ditolak** (`offset > ekor`). Dulu jalur ini
      "berhasil" dengan `content=potongan` tapi `size=offset+len` — kolom `size`
      berbohong. Offset melewati ekor hampir selalu berarti pemanggil salah hitung
      (mis. `getSize` basi), jadi gagal jelas lebih baik daripada state setengah jadi.
    - `cp`: membandingkan panjang hasil `read` dengan metadata sebelum menulis —
      korupsi senyap dari lapisan mana pun jadi pesan jelas.
    - Alat diagnosa baru: `netfs probe <addr> <path>` (info/stat/getSize/read/readChunk
      head+tail, tanpa mencetak isi berkas).
- **Verifikasi:** 81 test NetFS/VFS hijau (termasuk regresi N2.19, N1.15, N1.14,
  B2.22b–B2.22d, B2.26–B2.27); `npm test` = 8 kegagalan pra-ada (tidak ada regresi).
  Reproduksi lokal e2e (driver → SL → NetFSBackend → BKFS) dengan konten biner
  ber-NUL seperti `.mov` (`00 00 00 18 ftyp …`): `readChunk(0,4096)` = 4096 byte ✅ dan
  tulis-baca penuh **utuh** ✅.
- **HASIL LAPANGAN (verifikasi user, 2026-09-22):** `cp /mnt/net/video.mov ./` di `tsix`
  **berhasil** — **102 s** untuk 70.499.395 byte (**≈ 690 KB/s**), berkas utuh dan lancar
  diputar di VLC. Arah balik `cp video.mov /mnt/shared/` (host fs) cuma **1,95 s**.
  Bandingkan arah TULIS ke export **bkfs** yang dulu 12 menit 44 s (≈ 92 KB/s): plafon
  berikutnya ada di jalur TULIS (`writeChunk` bkfs O(n²) — tiap potongan menulis ulang
  seluruh kolom `content`), bukan di jalur baca. Untuk salinan besar, export direktori
  `host` (`pwrite` O(1)) tetap rekomendasi; `fs.copyWithProgress()` untuk hemat RAM klien.
- **Catatan link (laporan user, 2026-09-22):** dengan **kabel LAN** 70 MB ≈ **1,7 menit**
  (≈ 690 KB/s — sama dengan angka baca di atas), sedangkan lewat **WiFi** salinan ke
  export bkfs dulu **12 menit**. Bacaan: keduanya bukan apel-ke-apel — jalur **baca**
  dihitung per round-trip (`throughput ≈ chunk / RTT`), jadi link cepat langsung terasa;
  jalur **tulis ke bkfs** biayanya didominasi backend (terukur ~80% waktu di sana, lihat
  entri 124 KiB di bawah), jadi kabel saja tidak banyak menolong. Untuk membandingkan
  link secara jujur, ukur RTT-nya: `netfs info <peer>` (dulu 182 ms lewat WiFi) dan lihat
  `ms` per op di `netfs probe`.
- **Tabel lapangan lengkap (70 MB = `video.mov`, semua terukur):**

  | Jalur | Link | Waktu | ≈ throughput |
  |---|---|---|---|
  | **baca** dari mount (export bkfs SH) | LAN | **102 s** | **690 KB/s** |
  | **tulis** ke export bkfs | LAN | **8 m 6 s** (486.229 ms) | 145 KB/s |
  | **tulis** ke export bkfs | WiFi | 12 m 44 s (763.938 ms) | 92 KB/s |
  | tulis ke direktori `host` (di SH) | — | 1,95 s | — |

  ⇒ Kabel LAN menolong **~1,6×** di jalur tulis (92 → 145 KB/s) tapi tidak menghapus
    plafonnya: sisanya tetap backend. Tulis ke bkfs **≈ 4,8× lebih lambat** daripada baca
    dari bkfs, karena tiap `writeChunk` menulis ulang seluruh kolom `content`.
    Konsekuensi praktis: untuk berkas besar, **export direktori `host`** dulu
    (`pwrite` O(1)) — atau ubah penyimpanan bkfs agar ramah append (bukan satu kolom).
- **Deploy:** perbaikan intinya di `BKFS.ts` (KERNEL) → **kedua node** harus restart
  kernel (`npm start` untuk jalur cepat) + `npm run vfs:bootstrap`; SH juga restart
  `netfsd`. Tidak ada berkas yang perlu disalin ulang — data lama tetap valid.
- **Oleh:** Copilot · **Laporan:** andriansah

## 2026-09-22

### `cp` dari NetFS → VFS: `stat` timeout 5 s + kernel SH OOM (jalur metadata & pagar balasan)

- **File:** `src/vfs/BKFS.ts`, `src/vfs/NetFS.ts`, `src/common/netfs/NetFSProtocol.ts`,
  `src/common/netfs/NetFSServer.ts` (+ test: `BKFS.test.ts` B2.26–B2.27,
  `NetFSServer.test.ts` N1.14, `NetFS.test.ts` N2.17–N2.18)
- **Gejala (dua laporan berurutan):**
    ```
    root@tsix# cp /mnt/net/video.mov ./
    cp: error copying '/mnt/net/video.mov': NetFS[/mnt/net → localhost:8888]: timeout 5000ms pada stat /video.mov
    root@tsix# df
    tsix://jatit...    STALE   -   0   0   /mnt/net
    ```
    lalu di SH (`jatitsix`), kernel mati:
    ```
    Mark-Compact 100.5 (105.7) -> 29.6 (36.2) MB ...
    Mark-Compact 823.8 (830.4) -> 823.8 (827.1) MB ... allocation failure
    FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
    ```
- **Catatan penting (laporan lapangan):** arah **tulis** sudah aman — copy 70 MB ke mount
  NetFS jalan karena driver sudah memecah otomatis (`writeContent()`). Yang belum dipecah
  adalah arah **baca**.
- **Akar 1 — `BKFS.stat()` memakai `SELECT *`** sehingga ikut menarik kolom `content`:
  untuk file 70 MB itu berarti mematerialisasi seluruh isi + string JS ~2× ukuran byte
  **hanya untuk membaca `size`/`mode`**. Diukur pada file 60 MB (plafon heap 256 MB):
  perilaku lama menambah **+60 MB heap per panggilan** (126 → 185 → 245 MB) dan `FATAL
  ERROR` di iterasi ke-3; setelah fix **datar 0 MB**. Itu persis pola OOM di SH: beberapa
  `stat`/`OPEN` beruntun (klien retry) menghabiskan heap.
  `BKFS.getUsage()` punya penyakit sama — `SUM(length(content))` membaca isi SETIAP file,
  jadi `df` lambat/timeout → mount ditandai `STALE`.
- **Akar 2 — `read` tak dibatasi & tak dipecah:** satu op `read` = satu balasan berisi
  SELURUH file. 70 MB dalam satu frame tidak mungkin selesai dalam timeout 5 s, dan
  memaksanya membuat SL (satu event loop) mematerialisasi isi + MQTNL memecahnya jadi
  ribuan paket — RAM node SH habis.
- **Perubahan:**
    1. `BKFS.stat()` memilih kolom metadata saja (`VNODE_META_COLUMNS` — `content`
       sengaja tidak ikut) dan `getUsage()` menghitung dari kolom `size` yang dipelihara
       `touch`/`append`/`writeChunk` (sekaligus kini konsisten dengan `ls -l`).
    2. Konstanta baru `NETFS_MAX_RESPONSE_BYTES` (256 KiB, sama dengan pagar request) +
       pagar di SL: `read` memeriksa `getSize` **dulu** → `ETOOBIG` sebelum konten dibaca.
    3. Driver `NetFS.read()` menangkap `ETOOBIG` lalu membaca per `readChunk` (cermin
       `writeContent()`); file kecil tetap **1 round-trip** — jalur cepat tidak dikorbankan.
- **Verifikasi:** 84 test NetFS/VFS/kernel-netfs hijau (N1.14 membuktikan pagar balasan,
  N2.17 fallback chunk, N2.18 tetap 1 frame untuk file kecil, B2.26/B2.27 metadata tanpa
  konten). `npm test` = **1148 passed**, 8 kegagalan **pra-ada** (tidak ada regresi).
- **Deploy:** `BKFS.ts` + `NetFS.ts` + `NetFSProtocol.ts` ada di **kernel** → restart
  kernel di **kedua** node. `NetFSServer.ts`/`NetFSBackend.ts` ada di **userland** →
  `npm run vfs:bootstrap` **dan restart `netfsd` di SH** (pagar balasan ditegakkan di SL).
- **Sisa (belum dikerjakan):** `cp` masih pola baca-semua → tulis-semua (puncak ~70 MB di
  klien). Untuk file besar, `fs.copyWithProgress()` (124 KiB per potongan) sudah tersedia
  dan aman dari sisi RAM; `writeChunk` di export **bkfs** tetap O(n²) seperti dicatat di
  entri di bawah — export direktori `host` tetap rekomendasi untuk file besar.
- **Oleh:** Copilot · **Laporan:** andriansah

## 2026-09-22

### NetFS — chunk 124 KiB (4 fragmen) + temuan bottleneck RTT & O(n²) di bkfs

- **File:** `src/common/netfs/NetFSProtocol.ts`, `src/mirror/lib/UserLib.ts`, `src/mirror/opt/test/file-operation.ts`, `src/common/netfs/NetFSServer.test.ts`.
- **Gejala (laporan lapangan):** copy file 70 MB ke mount NetFS **jalan tanpa putus** (target: `/mnt/sbak` di SH `jatitsix`), tapi MQTNL traffic monitor menunjukkan TX hanya **~124 KB/s**.
- **Pengukuran:** `netfs info jatitsix:7777` → **RTT 182 ms**. Aritmetika: 31.744 B ÷ 124 KB/s ≈ 0,256 s per chunk ⇒ satu chunk ≈ satu round-trip. Jadi **biaya dominan = round-trip, bukan byte** (broker 2× traversal + hop relay + batas syscall + backend ≈ 182 ms + ~70 ms).
- **Akar masalah:** jalur tulis NetFS sekuensial (offset chunk berikutnya bergantung pada hasil chunk sebelumnya) ⇒ `throughput ≈ chunk / RTT`. Chunk 31 KiB (1 fragmen MQTNL) jadi tidak efisien: jaringan menganggur ~99% waktu.
- **Perubahan:** `NETFS_MAX_CHUNK_BYTES` **31 KB → 124 KB** (4× `packetSize` 32 KiB) dan `NETFS_MAX_REQUEST_BYTES` **64 KB → 256 KB** (2× chunk + overhead). Byte di wire dan jumlah **publish MQTNL tidak berubah** (MQTNL tetap memecah per 32 KB) — yang berkurang hanya jumlah **balasan**, jadi ~4× throughput. `fs.copyWithProgress()` + demo `file-operation` mengikuti plafon 124 KB.
- **Dampak terukur (RTT 182 ms):** 31 KB → ~124 KB/s; 124 KB → **~500 KB/s**; 70 MB ≈ 10 menit → **~2,4 menit**.
- **HASIL LAPANGAN (verifikasi user, 2026-09-22):** copy 70 MB (`/mnt/shared/video.mov` → `/mnt/net/`, export `/mnt/sbak` = **bkfs** di SH `jatitsix`) turun dari **~40 menit → 12 menit 44 detik** (`cp` melaporkan `Time execution: 763938ms`; ~92 KB/s rata-rata) — **~3,1×**. Ini juga mengonfirmasi model: total kerja backend `Σ k·c ≈ N²/(2c)`, jadi **chunk 4× lebih besar juga memotong 4× kerja rewrite bkfs**, bukan cuma jumlah round-trip (prediksi 10 menit vs nyata 12,7 menit — sisa selisih dari baca 70 MB ke memori + variance broker).
- **Plafon berikutnya (terukur dari sisa waktu):** dengan 124 KB, ~565 chunk dalam 764 s = **1,35 s/chunk**, padahal 1 round-trip cuma ~0,25 s ⇒ **~80% waktu habis di backend bkfs**, bukan jaringan. Pindahkan export ke direktori `host` (mis. `/mnt/shared/netdata`) → backend jadi `pwrite` O(1) → perkiraan **~2,4–3 menit** (~490 KB/s). Pipelining (`writeOpen`/`writeData`) menyusul untuk menghapus plafon RTT.
- **Temuan tambahan (belum diubah, perlu keputusan):**
    1. **Target export `bkfs` itu O(n²).** BKFS menyimpan isi file di SATU kolom, jadi tiap `writeChunk` append menjalankan `content = IFNULL(content,'') || ?` yang menulis ulang seluruh baris: pada 31 KB ⇒ ~2.260 chunk × rata-rata 35 MB salinan ≈ **~77 GB** kerja di SH (pada 124 KB ⇒ ~19 GB). `host` (HostVFS, `pwrite`) O(1) dan jadi target yang benar untuk export besar. Dicatat di `wiki/netfs.md` §7.1.
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
