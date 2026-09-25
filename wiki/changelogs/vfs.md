# Changelog VFS / Bootstrap

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-25

### `touch()` mengabaikan `uid`/`gid`/`mode` → berkas baru selalu 0o644

- **File:** `src/vfs/BKFS.ts`, `src/vfs/HostVFS.ts`, `src/vfs/BKFS.test.ts` (B2.28–B2.29)
- **Gejala:** setelah `npm run install`, boot mencetak
  `[INIT] /etc/rc.local dilewati: belum executable` — instalasi "sukses", tapi
  tidak ada satu pun daemon yang jalan. Bonus: `/etc/shadow` jadi 0o644, bukan 0o640.
- **Akar masalah:** `BKFS.touch()` menerima `uid, gid, mode` tapi `resolveForWrite()`
  memanggil `createEmptyFile(path)` **tanpa argumen** — jadi parameter itu hanya
  dekorasi: semua berkas yang dibuat lewat `touch()` selalu 0o644. Pemanggil yang
  sudah benar pun (`install.ts`: `/etc/rc.local` 0o755, `/etc/shadow` 0o640,
  `Kernel.ts`: `shadowPath` 0o640, `bkfs-info.ts --restore`) tidak berpengaruh.
- **Perubahan:** `resolveForWrite(path, uid, gid, mode)` meneruskan ketiganya ke
  `createEmptyFile()` — dihormati hanya saat berkas **BARU**, persis semantik `touch`
  Unix (berkas lama: isi diganti, izin milik pemilik → `chmod` terpisah). `HostVFS.touch()`
  disamakan (mode dipasang setelah `writeFileSync` kalau berkasnya baru).
- **Catatan:** `writeChunk()` tetap membuat berkas baru dengan mode default (0o644) —
  tidak ada pemanggil yang memintanya lain; kalau nanti perlu, `resolveForWrite`
  sudah menerima parameter mode.
- **Dampak:** image hasil install langsung benar (terverifikasi: `/etc/rc.local` 0755,
  `/etc/shadow` 0640, `/bin/sudo.js` 4755). Tidak ada perilaku lama yang berubah:
  berkas yang sudah ada tetap mempertahankan mode-nya.
- **Oleh:** Copilot · **Laporan:** kakang

---

## 2026-09-24

### `vfs:pull` lupa bit eksekusi → semua perintah mati di mode root-host (`/bin/ls.js: Permission denied`)

- **File:** `scripts/lib/binary-mode.ts` (baru), `scripts/vfs-pull.ts`,
  `scripts/rootfs-chmod.ts` (baru), `scripts/install.ts`, `scripts/sync-vfs.ts`,
  `scripts/vfs-bootstrap.ts`, `package.json` (`rootfs:modes`),
  `wiki/Virtual-File-System.md`.
- **Gejala:** dengan `kernel.rootType = "host"` (root `/` = folder host), SEMUA
  perintah eksternal gagal walau sebagai root:
  `root@tsix# ls` → `-tsh: /bin/ls.js: Permission denied` (`$?` = 126).
  `ls.ts`, `cd`, apa pun ikut mati karena shell-nya sendiri tak bisa spawn binary.
- **Akar masalah:** `vfs-pull` menulis berkas apa adanya lewat `fs.writeFileSync`
  → **0644 tanpa bit `x`**. `vfs-bootstrap`/`install`/`sync-vfs` semuanya
  memasang bit eksekusi di VFS (`EXEC_DIRS`, `/sbin` 0o744, SetUID
  login/passwd/sudo), tapi arah BALIK (VFS → host) tidak — jadi begitu host
  dipakai sebagai root, izin di disk-lah yang dibaca kernel dan semuanya 0644.
  Penegakannya di **shell** (`tsh.ts`: `(mode & 0o111) === 0` → tolak, paritas
  Linux), bukan di `PermissionManager` — karena itu UID 0 pun tidak menembusnya.
- **Perubahan:**
    - `scripts/lib/binary-mode.ts` — SATU sumber aturan mode
      (`binaryModeFor`, `applyBinaryMode`, `applyHostBinaryMode`,
      `needsBinaryMode`). Sebelumnya logika itu disalin-tempel di tiga skrip
      (install, sync-vfs, vfs-bootstrap); ketiganya kini mengimpor helper ini.
    - `vfs-pull` memasang mode setelah menulis berkas → tarikan baru langsung
      benar, tidak perlu langkah manual.
    - `scripts/rootfs-chmod.ts` + `npm run rootfs:modes` — memperbaiki folder
      yang sudah telanjur ada (termasuk hasil `git clone`/`cp` tanpa
      `--preserve=mode`); dukung `--dry-run` dan `--root <dir>`.
- **Diuji:** `npm run rootfs:modes` pada `src/rootfs` → **505 dari 507** berkas
  executable diperbaiki (`bin/ls.js` 755, `bin/login.js` 4755, `sbin/*` 744);
  boot `rootType = "host"` tetap bersih sampai prompt login.
- **Temuan sampingan (ikut diperbaiki):** `sync-vfs` memetakan `src/common/**`
  ke **`/common/**`**, padahal canonical-nya `/lib/common/**` (yang dibaca
  `WorkerEntry` untuk `@common/X` dan yang di-seed `vfs-bootstrap`). Jadi
  suntingan `src/common` lewat sync-vfs mendarat di path mati. Kini
  `/lib/common/**`; jalur `src/mirror` tidak berubah.
- **Mode host = alat sinkronisasi NO-OP:** saat `kernel.rootType = "host"` (atau
  env `TSIX_ROOTFS=host`), **`sync-vfs`, `vfs-pull`, dan `vfs-bootstrap`** berhenti
  di awal — pesan singkat + **exit 0** (agar hook otomatis seperti run-on-save
  tidak dianggap gagal). Root memang folder host itu sendiri, jadi tidak ada yang
  perlu disinkronkan; menulis ke `system.db` cuma menghasilkan "sukses palsu".
  Logika ini dipusatkan di `scripts/lib/root-mode.ts` (`activeRootType`,
  `activeHostRoot`, `skipIfHostRoot`) yang memakai helper KERNEL yang sama
  (`resolveRootType`, `resolveHostRootDir`), sehingga env
  `TSIX_ROOTFS`/`TSIX_ROOTFS_PATH` juga dihormati `rootfs:modes` dan tidak ada
  alat yang bisa berbeda pendapat dengan kernel. `vfs-pull` sekaligus membuang
  resolver path-nya sendiri (dulu hardcode `../src/root`, lalu duplikat logika)
  dan memakai `resolveHostRootDir` — plus memasang bit eksekusi hasil tarikan.
  Diuji: mode host → ketiganya exit 0 tanpa menyentuh DB; `TSIX_ROOTFS=bkfs`
  dengan `TSIX_ROOTFS_PATH=/tmp/pull-test` → 703 berkas tertarik, `bin/ls.js`
  0o755 & `bin/login.js` 0o4755; `vfs-bootstrap` jalan seperti biasa.- **Positioning ditulis eksplisit:** mode `host` bukan pengganti BKFS. BKFS tetap
  root yang dimaksud desainnya (transaksi `batch()`, WAL + checkpoint, isolasi
  ruang nama berkas, backup = 1 berkas image). Mode `host` ada untuk menunjukkan
  kernel bisa diganti backend apa pun (secara teori termasuk NetFS di `/`) dan
  untuk iterasi kilat. Saat mode host aktif, boot log menandainya sebagai
  **eksperimen** (+ `logger.warn`), dan `Config.ts` / `RootFilesystem.ts` /
  `wiki/Virtual-File-System.md` memuat perbandingan jaminannya.- **Oleh:** Copilot

---

## 2026-09-23

### Ikon launcher kacau (`ðº` bukan `📺`): konsumen teks di dalam TSIX harus decode

- **File:** `src/mirror/opt/asteracea/asteracea.ts` (loader menu), `src/mirror/bin/atto.ts`
- **Masalah:** berkasnya sendiri SEHAT — `/opt/asteracea/menu/retroterm.menu` berisi
  byte `f0 9f 93 ba` (`icon=📺`) dan VFS byte-identical dengan sumber. Yang salah: loader
  menu memperlakukan isi berkas sebagai teks tanpa decode, jadi 4 byte UTF-8 sampai ke
  browser sebagai 4 karakter latin1 (`ðº`) dan ikon launcher tampak kacau.
- **Perubahan:** loader `.menu` memakai `vfsBytesToUtf8()`; editor `atto` decode saat
  buka **dan** encode (`utf8ToVfsBytes()`) saat simpan — jalur simpan yang tidak
  di-encode akan MEMOTONG karakter > U+00FF (menyimpan hasil edit = kehilangan emoji,
  data loss).
- **Dampak:** ikon/label app dari `.menu` tampil benar (`📺`, `🔊`, …). `cat`/`head`/`tail`
  sengaja dibiarkan byte-transparan supaya `cat a > b` tetap byte-exact (biner aman).
  Aturan konsumen didokumentasikan di `wiki/Virtual-File-System.md`.
- **Oleh:** Copilot

### VFS menyimpan BYTE: glyph UI kacau (latin1 memotong karakter > U+00FF)
- **File:** `src/common/VfsText.ts` (baru), `scripts/lib/text-file.ts`,
  `scripts/lib/text-file.test.ts` (`T1.06`–`T1.07`), `scripts/{vfs-bootstrap,install,sync-vfs,sync-tde}.ts`,
  `src/kernel/{Kernel,Syscalls}.ts`, `src/userland/WorkerEntry.ts`,
  `src/mirror/opt/dome/dome.ts`
- **Masalah:** berkas teks dibaca `utf8` (string berisi karakter asli) lalu disimpan
  `Buffer.from(s,"latin1")` — dan encode latin1 **memotong** setiap karakter > U+00FF
  ke byte rendahnya: `✕` U+2715 → `0x15`, `─` U+2500 → `0x00`, `→` U+2192 → `0x92`.
  Akibatnya 243 berkas (`emerald.ts`, `asteracea.ts`, `tableLib.ts`, `file-cruiser.ts`,
  …) kehilangan glyph-nya di VFS: **tombol minimize/maximize/close dan border tabel
  jadi kacau**, begitu juga emoji.
- **Perubahan:** aturan eksplisit “isi VFS = byte berkas” (bukan karakter):
  `readTextFile()` mengembalikan byte apa adanya (BOM dibuang di level byte),
  `utf8ToVfsBytes()`/`vfsBytesToUtf8()` (`src/common/VfsText.ts`) untuk konversi di
  batas teks, dan semua jalur host→VFS memakainya — termasuk hasil transpile esbuild
  (dulu dikirim sebagai teks → terpotong). Titik konversi dipasang di
  `Kernel.rebuildVFSCache()`, `Syscalls` EXEC, `WorkerEntry` (modul relatif), dan
  `dome.ts` (aset disajikan `latin1` = byte apa adanya, bukan `utf8`).
- **Dampak:** VFS sekarang byte-identical dengan berkas sumber — terverifikasi pada
  `emerald.ts`, `tableLib.ts`, `asteracea.ts`, `file-cruiser.ts`, `dome-client-core.js`
  (termasuk UTF-8 asli `—` `→` emoji) dan aset biner (MP3 `FF FB`, JPEG `FF D8`).
  Sidecar hasil transpile juga benar: `/lib/emerald.js` berisi `// ── TRAVE…` dengan
  byte UTF-8 asli. Tes: `T1.06` (glyph) & `T1.07` (batas teks vs byte biner).
- **Oleh:** Copilot

### BOM UTF-8 → byte `0xFF` di VFS: seluruh skrip DOME mati di browser

- **File:** `scripts/lib/text-file.ts` (baru), `scripts/lib/text-file.test.ts` (baru),
  `scripts/vfs-bootstrap.ts`, `scripts/install.ts`, `scripts/sync-vfs.ts`,
  `scripts/sync-tde.ts`, 9 berkas sumber di `src/mirror/opt/{dome,file-cruiser}`
- **Masalah:** 9 berkas sumber punya BOM UTF-8. Dibaca `utf8` → `U+FEFF`, lalu
  di-encode latin1 → `U+FEFF & 0xFF` = **byte `0xFF`** di VFS. Berkas JS yang diawali
  byte sampah ditolak browser, jadi **seluruh** engine mati:
  `Uncaught ReferenceError: ÿ is not defined` di `dome-client-*.js` (dan modul lain
  gagal berantai karena `window.TSIX` tidak pernah terbentuk).
- **Perubahan:** `readTextFile()` (buang BOM UTF-8) + `readBinaryFile()` (latin1
  byte-untuk-byte, `0xFF` aset biner TIDAK disentuh) + `peekBom()`; semua jalur
  host→VFS memakainya; sinkronisasi mencetak `BOM UTF-8 dibuang: <path>` dan
  memperingatkan BOM UTF-16; BOM di 9 berkas sumber dibuang; tes `T1.01`–`T1.05`.
- **Dampak:** Berkas di VFS yang diawali `0xFF` turun 13 → 4, dan 4 sisanya sah
  (JPEG `FF D8`, MP3 `FF FB`, BOM UTF-16LE `ocean.b64`). Terverifikasi:
  `/opt/dome/dome-client-core.js` sekarang mulai `/*`, `dome-client.html` mulai
  `<!doctype html>`. Sisa temuan: `ocean.b64` sendiri ber-UTF-16LE (aset lama yang
  perlu dikonversi ke UTF-8).
- **Oleh:** Copilot

### Invarian “content ATAU blok” ditegakkan + pembersihan otomatis (bug nyata di syslog)

- **File:** `src/vfs/BKFS.ts`, `src/vfs/BKFS.test.ts` (`B4.01`–`B4.06`),
  `scripts/sync-tde.ts`
- **Masalah:** Aturan penyimpanan “isi file ada di `content` ATAU di `blocks`” hanya
  diingat pemanggil (`clearBlocks()` manual di setiap jalur). Di database asli
  ditemukan `/var/log/syslog` dengan `content` 17 KB **dan** blok sisa 2,6 MB
  (`seq` 0, 1, 19 — bolong). Isi tidak salah, tapi 260 KB jadi sampah tak terlihat,
  `readChunk()` menjawab berbeda dari `read()` untuk file yang sama, dan
  `scripts/sync-tde.ts` masih menulis `content` lewat SQL mentah (melewati aturan).
- **Perubahan:** `writeInline()` menjadi satu-satunya jalur penulis `content` (selalu
  membuang blok lebih dulu); `writeToBlocks()` selalu men-NULL-kan `content`;
  `readChunk()`/`storageKind()` memilih sumber dari `content` (bukan jumlah blok);
  `append()` hanya memakai jalur inline bila tidak ada blok; `repairStorage()`
  (idempoten, dipanggil otomatis setiap DB dibuka) + `storageHealth()`;
  `sync-tde.ts` membuang blok sebelum menulis `content`.
- **Dampak:** Bentuk penyimpanan campuran tidak bisa lagi terbentuk dari jalur mana pun,
  dan yang sudah ada dibersihkan sendiri saat database dibuka (dicatat sebagai
  peringatan di log). Terverifikasi: 3 blok basi di `system.db` hilang, isi file utuh.
- **Oleh:** Copilot

### `bkfs:info` — alat diagnostik penyimpanan (dan `--repair` / `--migrate-legacy`)

- **File:** `scripts/bkfs-info.ts` (npm: `bkfs:info`)
- **Masalah:** Hasil kerja storage (tabel blok, WAL, BLOB) tidak bisa dilihat: `ls -l`
  tidak membedakan inline vs ber-blok, `df` hanya total, dan `quick_check` hanya
  memeriksa integritas halaman — bentuk penyimpanan tidak konsisten tetap “ok”.
- **Perubahan:** Alat baru dengan laporan ukuran (+ peringatan `-wal` tertinggal),
  pragma, integritas, sebaran inline/blok, baris warisan TEXT, file terbesar beserta
  bentuk penyimpanannya, dan seksi “Kesehatan penyimpanan” (blok yatim/basi, file
  bolong, `size` ≠ isi). Opsi: `--top`, `--check`, `--json`, `--repair`,
  `--migrate-legacy`, `--checkpoint`, `--compact`. Read-only secara default.
- **Dampak:** Perubahan storage jadi **terverifikasi secara visual**, dan masalah yang
  sebelumnya tidak terlihat muncul sebagai angka. Langsung menemukan 147 baris warisan
  TEXT berisi biner (`level*.png` 180 KB, `laser-beam.mp3` 192 KB) yang membengkak ≈2×
  dan tidak bisa diukur dengan `length()` SQLite.
- **Oleh:** Copilot

---

## 2026-09-22

### Kernel menutup storage saat shutdown (dulu `system.db-wal` tertinggal)

- **File:** `src/main.ts`, `src/kernel/Kernel.ts`, `src/kernel/MountManager.ts`,
  `src/vfs/BKFS.ts`, test: `B3.14`, `A4.20`–`A4.21`
- **Gejala (dilaporkan operator):** setelah TSIX di-shutdown, masih ada
  `system.db-shm` dan `system.db-wal` (749 KB) — begitu pula `systembak.db-wal`.
- **Akar masalah:** `close()`/`checkpoint()` sudah ada di BKFS, tapi hanya dipakai
  skrip host (`install.ts`, `vfs-bootstrap.ts`). Kernel yang sedang berjalan **tidak
  pernah** menutup storage: tidak ada `MountManager.closeAll()`, dan `main.ts`
  memanggil `process.exit()` langsung dari keep-alive/SIGINT.
- **Kenapa berbahaya (bukan sekadar file sisa):** dalam mode WAL, transaksi terakhir
  yang belum ter-checkpoint **hanya** ada di `-wal`. Menyalin `system.db` sendirian
  sebagai backup / mengirimkannya ke node lain berarti **kehilangan transaksi
  terakhir**. Bonus: setiap boot berikutnya harus recovery dari WAL.
- **Perubahan:**
  - `MountManager.closeAll()` — menutup root + semua mount, urutan dibalik (mount
    terdalam dulu), tiap driver sekali saja, dan satu driver yang gagal **tidak**
    menghentikan yang lain.
  - `Kernel.closeFilesystems()` — idempotent, tidak pernah melempar, memakai
    `console` (bukan `bootLog`/`syslog`) karena setelah `closeAll()` database sudah
    tertutup sehingga tulis ke VFS akan gagal.
  - `main.ts` — memanggil `closeFilesystems()` di jalur keep-alive (reboot/halt) dan
    SIGINT, plus jaring pengaman `process.on("exit")` supaya jalur keluar yang belum
    terpikirkan pun tetap menutup storage.
  - `BKFS.close()` kini idempotent (bisa dipanggil eksplisit **dan** dari exit hook)
    dan mencatat path DB yang ditutup; `checkpoint()` melaporkan kalau tertahan
    koneksi lain (`wal_checkpoint` → `busy = 1`) alih-alih mengklaim sukses.
- **Verifikasi:** `B3.14` (setelah `close()` berkali-kali, `-wal`/`-shm` hilang dan
  isi tetap ada saat dibuka lagi), `A4.20` (root + semua mount ditutup sekali),
  `A4.21` (driver tanpa `close()` dilewati; satu yang melempar tetap melanjutkan).
- **Oleh:** Copilot

---

## 2026-09-22

### BKFS: tabel blok + WAL + BLOB — akar O(n²) yang membuat NetFS lambat

- **File:** `src/vfs/BKFS.ts`, `src/vfs/BKFS.test.ts` (B3.01–B3.13),
  `scripts/install.ts`, `scripts/vfs-bootstrap.ts`, `scripts/vfs-pull.ts`,
  `scripts/sync-tde.ts`, `wiki/Virtual-File-System.md`
- **Alasan:** copy 70 MB lewat NetFS butuh **12m44s**. Analisis menunjukkan akarnya
  bukan jaringan, tapi penyimpanan: seluruh isi file ada di SATU baris, jadi setiap
  potongan `writeChunk()` menulis ulang seluruh baris.
- **Terukur (8 MB dalam 66 potongan @124 KiB, chunk NetFS):**

  | Varian | Waktu |
  |---|---|
  | `content TEXT` + journal `DELETE` + `content \|\| ?` (lama) | 6.370 ms |
  | `journal_mode=WAL`, masih `content \|\| ?` | 6.822 ms (**0,9× — WAL saja tidak menolong**) |
  | **WAL + tabel blok** | **583 ms (10,9×)** |

  Ukuran file DB juga turun 16,1 MB → 7,2 MB. Baris kedua yang penting: penyebabnya
  **bukan fsync**, tapi SQLite membangun ulang string seukuran file tiap potongan
  (CPU + memori) — jadi perbaikannya harus struktural.
- **Perubahan:**
  - **Tabel `blocks(vnode_id, seq, data BLOB)`** (`WITHOUT ROWID`, FK `ON DELETE
    CASCADE`). Isi ≤ `BKFS_INLINE_MAX_BYTES` (64 KiB) tetap di kolom `content`;
    di atasnya dipecah 128 KiB/blok. Append & tulis acak kini **O(ukuran potongan)**,
    bukan O(ukuran file). Pemindahan inline → blok terjadi sekali per file, termasuk
    untuk baris lama yang isinya masih satu baris besar.
  - **`PRAGMA journal_mode=WAL` + `synchronous=NORMAL`** (opsional `FULL`) +
    `busy_timeout` + `cache_size` + `mmap_size`. Kalau WAL tidak bisa dipakai
    (filesystem tidak mendukung), BKFS **memperingatkan** — tidak diam-diam lambat.
  - **`PRAGMA foreign_keys=ON`** dinyalakan SETELAH migrasi dedup (database lama yang
    kotor justru yang paling butuh migrasi, dan FK aktif akan menggagalkannya).
  - **`batch(fn)`** — satu transaksi atomik. Bootstrap/install kini membungkus seluruh
    penyalinan image di dalamnya: mati di tengah = **tidak ada** image setengah jadi,
    plus ribuan `fsync` menjadi satu.
  - **`content` disimpan sebagai BLOB** (`Buffer.from(text, "latin1")`), bukan TEXT.
    Ini menghapus dua bug sekaligus: `substr()` SQLite yang berhenti di byte NUL
    (penyebab `cp` menghasilkan file 0 byte) dan inflasi ~2× untuk byte ≥ 0x80.
    `readChunk()` kini memotong di sisi SQL untuk BLOB — kernel tidak lagi menahan
    seluruh file di heap. Baris TEXT warisan tetap terbaca (SQLite menyimpan tipe
    per-nilai), jadi **tidak ada migrasi yang bisa gagal di tengah**.
  - **`close()` / `checkpoint()`** — dulu BKFS tidak pernah ditutup, sehingga WAL bisa
    tertinggal dan `system.db` tidak lengkap kalau disalin. `install.ts` yang dulu
    menembus private `db?.close?.()` kini memakai `close()` yang benar.
  - **`checkIntegrity()`, `compact()`, `storageKind()`, `countBlocks()`** untuk
    operasional/diagnostik.
  - Cache prepared statement per-koneksi (sebelumnya setiap panggilan `prepare()`
    dari awal).
- **Perbaikan konsumen SQL mentah** (kalau ini terlewat, `vfs-pull` akan menulis file
  besar sebagai file **kosong**, karena isinya ada di `blocks`):
  - `scripts/vfs-pull.ts`: memakai `readVnodeContent()` (export dari BKFS), query tidak
    lagi `SELECT *`, dan menulis dengan **latin1** — sebelumnya `writeFileSync(path,
    "string")` memakai utf8 sehingga aset biner ≥ 0x80 rusak saat ditarik ke host
    (padahal `install.ts` membacanya latin1 — sekarang round-trip byte-per-byte).
    `HOST_ROOT` juga diperbaiki: dulu hardcode `src/root` yang sudah tidak ada;
    sekarang dibaca dari `sysconfig.json` dengan patokan yang sama seperti kernel.
  - `scripts/sync-tde.ts`: menulis lewat `encodeContent()` dan ikut memperbarui `size`
    (kolom `size` adalah sumber kebenaran panjang file).
- **Test:** B3.01–B3.13 — WAL aktif & integrity ok, `close()` lalu buka ulang tetap
  utuh, `batch()` atomik (error di tengah membatalkan semua), byte 0..255 utuh &
  tersimpan BLOB, baris TEXT warisan tetap benar (termasuk NUL), file besar memakai
  blok, append lintas blok, `readChunk` offset tak sejajar/lintas blok, tulis acak di
  blok, touch besar→kecil membuang blok, unlink membuang blok, invariant
  `size` == panjang isi.
- **Oleh:** Copilot

---

## 2026-09-22

### BKFS: `stat`/`getUsage` tidak lagi membaca konten file (penyebab timeout NetFS & OOM kernel SH)

- **File:** `src/vfs/BKFS.ts`, `src/vfs/BKFS.test.ts` (B2.26–B2.27)
- **Gejala:** `cp` file 70 MB dari mount NetFS gagal `timeout 5000ms pada stat /video.mov`
  (klien), `df` menandai mount `STALE`, dan kernel di node SH mati
  `FATAL ERROR: Reached heap limit` — Mark-Compact melompat 100.5 MB → 823.8 MB.
  Detail lengkap + analisis: `wiki/changelogs/netfs.md` (2026-09-22).
- **Akar masalah:** `stat()` memakai `SELECT *` sehingga ikut membaca kolom `content`.
  Untuk file 70 MB itu mematerialisasi seluruh isi + string JS ~2× ukuran byte **hanya
  untuk membaca `size`/`mode`**. Diukur pada file 60 MB dengan plafon heap 256 MB:
  perilaku lama **+60 MB heap per panggilan** → `FATAL ERROR` di iterasi ke-3. Kontrak
  `IVFS` sendiri sudah tegas: `stat` = metadata, `read` = konten (lihat komentar di
  `Syscalls.EXEC` yang sengaja TIDAK memakai `node.content`).
  `getUsage()` memakai `SUM(length(content))` — artinya membaca isi SETIAP file demi `df`.
- **Perubahan:** `stat()` memilih kolom metadata saja (`VNODE_META_COLUMNS`), `getUsage()`
  menghitung dari kolom `size` yang sudah dipelihara `touch`/`append`/`writeChunk`.
- **Efek samping yang diperbaiki sekaligus:** `df` kini konsisten dengan `ls -l` (dulu bisa
  berbeda pada karakter non-BMP, karena SQLite `length()` menghitung code point sedangkan
  kolom `size` code unit UTF-16), dan `stat` tak lagi mengembalikan properti `content`.
- **Verifikasi:** test B2.26 (`stat` tanpa `content`, metadata tetap lengkap) & B2.27
  (`getUsage` tetap benar walau `content` dikosongkan lewat koneksi kedua) + pengukuran
  heap A/B datar setelah fix. Seluruh suite: 1148 passed, 8 kegagalan pra-ada.
- **Deploy:** `BKFS.ts` ada di **kernel** → restart kernel (`npm start`).
- **Oleh:** Copilot · **Laporan:** andriansah

---

## 2026-09-17

### Kontrak `IVFS` jadi `MaybePromise` — backend filesystem jaringan (NetFS)

- **File:** `src/vfs/IVFS.ts`, `src/vfs/NetFS.ts` (baru), `src/common/MaybePromise.ts` (baru), `src/kernel/Syscalls.ts`, `src/kernel/Kernel.ts`, `src/kernel/devices/IDevice.ts`, `src/kernel/devices/FileSystemDevice.ts`
- **Perubahan:** semua method `IVFS` (dan `IDevice.write()`) bertipe `MaybePromise<T>`, sehingga satu kontrak yang sama bisa dipenuhi backend sinkron (VFS/BKFS/HostVFS/RamFS) **dan** backend yang butuh I/O jaringan (NetFS). Pemakai di kernel kini `await` hasilnya — driver lama tidak perlu diubah karena `await` pada nilai biasa mengembalikan nilai itu apa adanya. `Kernel.runInit()` ikut jadi `async`.
- **Alasan:** filesystem antar-node (`mount /mnt/net tsix_2:7777 --netfs`, lihat `wiki/changelogs/netfs.md`) tidak bisa menjawab sinkron; tanpa perubahan kontrak, opsi satu-satunya adalah memblokir kernel.
- **Dampak:** satu tipe mount baru (`netfs`) di `MountManager`/`fstab`/`mount`/`lsblk`/`df`. Efek samping yang perlu diketahui: setiap call-site IVFS di kernel wajib `await` (kalau lupa, hasilnya jadi Promise dan pemakaian berikutnya salah tipe).
- **Oleh:** Copilot

---

## 2026-09-12

### Peluang terbuka: resolve `.ts` `/lib` dari sidecar `.js` (belum dikerjakan)

- **File:** `src/kernel/Kernel.ts` (`rebuildVFSCache`), `scripts/vfs-bootstrap.ts`
- **Alasan:** `rebuildVFSCache()` masih men-transpile 16 file `/lib/*.ts` saat boot — **96 ms CPU di main thread** (memblokir boot). Padahal sidecar `.js` untuk semuanya sudah tersedia dan segar (nol basi, diverifikasi `modified_at`).
- **Kenapa belum dikerjakan:** menyentuh jalur eksekusi framework, dan **wajib** memakai guard `modified_at` — bila sidecar lebih tua dari `.ts`, harus pakai hasil transpile (kalau tidak, perubahan sumber tidak akan terpakai). Perlu uji boot penuh sebelum diaktifkan.
- **Bonus terkait:** `scripts/vfs-bootstrap.ts` masih menulis sidecar dengan `sourcemap: "inline"` (1.25 MB) sementara `rebuildVFSCache` sudah `sourcemap: false` (0.33 MB). Menyeragamkan ke `false` akan mengecilkan DB + mempercepat baca.
- **Oleh:** Copilot

### CATATAN — akun runtime (`useradd`) hilang dari `/etc/passwd`; `vfs:bootstrap` BUKAN penyebabnya

> ⚠️ Koreksi: dugaan awal (saat kerja optimasi memori) bahwa `vfs:bootstrap` menimpa
> `/etc/passwd` **terbukti SALAH** setelah diuji. Bagian ini ditulis ulang berdasarkan
> hasil verifikasi.

- **Fakta terverifikasi (diuji langsung):** `scripts/vfs-bootstrap.ts` **melewati** file tanpa ekstensi — `syncDir()` punya `if (!isTarget) continue;`, dan `isTarget` hanya mencocokkan `.ts/.js/.json/.html/.css/.menu/.mp3/.wav/.jpg/.jpeg/.png/.gif/.bmp/.svg/.webp/.ico`. Uji A/B: `passwd`, `group`, `shadow`, `motd`, `profile` di DB **identik** sebelum & sesudah `npm run vfs:bootstrap`.
- **Yang MEMANG menimpa:** `scripts/install.ts` — daftar `CRITICAL_ETC` (`passwd`, `group`, `shadow`, dll) sengaja di-`touch` dari `src/mirror/etc/*`. Ini **didesain** untuk fresh install, jadi bukan bug; tapi efek sampingnya perlu diketahui (fresh install mereset akun ke isi sumber).
- **Isi sumber:** `src/mirror/etc/passwd` & `shadow` hanya berisi `root` (di git, sejak awal).
- **Observasi:** pada `system.db` kerja, `passwd` hanya berisi `root`, sementara `shadow` & `group` masih memuat entri `joe`/`joes` buatan **runtime** (`useradd`). Jadi akun `joe` bukan berasal dari git — ia state runtime di DB. Pemicu tepat hilangnya entri di `passwd` **belum teridentifikasi**; yang pasti bukan `vfs:bootstrap` dan bukan seed kernel (seed hanya jalan bila file belum ada).
- **Praktis:** akun yang dibuat runtime dapat hilang dari `/etc/passwd` karena operasi yang menulis ulang file itu dari sumber. Bila perlu, buat ulang dengan `useradd`, atau `usermod -s` untuk memperbaiki field shell. `system.db` bersifat lokal (tidak ikut ter-commit).
- **Oleh:** Copilot · **Laporan:** kakang

### Shell default pindah ke sidecar `.js` — path `.ts` melewati preferensi `.js`
- **File:** `src/mirror/etc/passwd`, `src/kernel/Kernel.ts` (seed), `src/mirror/bin/useradd.ts`, `scripts/lib/user-account.ts`
- **Masalah:** `/etc/passwd` menunjuk `/bin/tsh.ts` (path `.ts` eksplisit). Di `Syscalls.EXEC`, blok preferensi ekstensi `.js`→`.ts` hanya berjalan `if (!node)`; karena `.ts`-nya **ada**, sidecar `.js` tidak pernah dicoba. Akibatnya setiap shell dipaksa memakai preload transpiler (**+14.4 MB RSS/worker**).
- **Perubahan:** shell default → `/bin/tsh.js` di keempat titik (file sumber, seed kernel, `useradd`, dan helper installer). Sidecar `tsh.js` sudah tersedia (mode 755), lebih baru dari `.ts`-nya, dan lolos `node --check`.
- **Dampak:** Worker shell turun dari ~30.6 MB → ~16.2 MB.
- **Deploy:** nilai `/etc/passwd` di DB yang sudah ada harus disesuaikan manual (mis. `usermod -s /bin/tsh.js root`) — `vfs:bootstrap` tidak menyentuhnya.
- **Oleh:** Copilot

### Semua titik spawn `.ts` dipindah ke sidecar `.js`

- **File:** `src/mirror/opt/pixelterm/pixelterm.ts`, `src/mirror/opt/tssh/tsshd.ts`, `src/mirror/sbin/airtermd.ts`, `src/mirror/bin/userdel.ts`, `src/mirror/bin/sudo.ts`, `src/mirror/bin/which.ts`, `src/mirror/bin/tsh.ts`, `src/mirror/opt/taskmgr/taskmgr.ts`
- **Masalah:** Pola yang sama berulang di banyak tempat — path `.ts` ditulis eksplisit, atau resolver hanya mencoba `cmd` lalu `cmd.ts` tanpa `cmd.js`.
- **Perubahan:**
  - `tsshd.ts` & `airtermd.ts`: exec `/bin/login.js` (sebelumnya `/bin/login.ts`).
  - `userdel.ts`: exec `/bin/rm.js` (sebelumnya `/bin/rm.ts`).
  - `sudo.ts`: urutan ekstensi `["", ".ts"]` → `["", ".js", ".ts"]` — sebelumnya **setiap perintah via `sudo`** selalu memakai worker `.ts`.
  - `which.ts`: tambah `.js` pada jalur path-langsung (sebelumnya hanya `cmd` + `cmd.ts`).
  - `tsh.ts` (`resolveBinary()`): jalur `cmd.includes("/")` kini mencoba sidecar `.js` sebelum `.ts`.
  - `taskmgr.ts`: filter shell memakai `/^tsh\.(ts|js)$/` agar tetap benar saat shell berganti nama.
- **Dampak:** Hemat ~14.4 MB per proses yang terlibat; tidak ada perubahan perilaku.
- **Deploy:** `npm run vfs:bootstrap` (wajib — runtime mengeksekusi sidecar `.js`).
- **Oleh:** Copilot

---

## 2026-08-28

### PENTING — perubahan `src/common/*` & `src/mirror/lib/*` JUGA wajib `vfs:bootstrap`
- **File:** `src/userland/WorkerEntry.ts` (perilaku), `src/kernel/Kernel.ts` (`rebuildVFSCache`)
- **Masalah:** Setelah menambah enum syscall baru (`PTY_ALLOC`/`PTY_FREE`) di `src/common/SyscallCode.ts`, pixelterm error `Unknown Syscall: undefined`. Akar: worker memuat `@common/*` & `@tsix/*` dari **VFS Memory Cache** (`/lib/common/SyscallCode.ts`, `/lib/UserLib.ts`) yang di-build dari `system.db` saat boot — database belum di-sync → konstanta enum baru = `undefined`.
- **Perubahan (pola kerja):** Edit `src/common/*` + `src/mirror/*` → **WAJIB `npm run vfs:bootstrap`**. File `src/kernel/*` (host-side) langsung berlaku saat `npm start` tanpa sync.
- **Deteksi mismatch:** query `vnodes` untuk `SyscallCode.ts` — cek `content.includes("PTY_ALLOC")`; atau gejala runtime `Unknown Syscall: undefined`.
- **Oleh:** Copilot · **Laporan:** kakang

---

## 2026-08-05

### vfs-bootstrap: sync binary assets (.mp3 / .wav)
- **File:** `scripts/vfs-bootstrap.ts`
- **Masalah:** Bootstrap hanya menyinkronkan `.ts/.js/.json/.html/.css/.menu` — file audio (`mp3`/`wav`) tidak ikut, jadi harus dimasukkan manual ke system.db.
- **Perubahan:** Tambah `.mp3` & `.wav` ke daftar target. Binary dibaca sebagai Buffer lalu disimpan sebagai **latin1 string** (1 byte = 1 char) — kompatibel dengan `Buffer.from(raw, "latin1")` di sisi app (mis. ResourceBank encode base64).
- **Dampak:** File audio di `src/mirror/` kini persist lewat `npm run vfs:bootstrap` (contoh: `footstep.wav` sample DDC 5).
- **Oleh:** Copilot

## 2026-08-04

### `create-bkfs.ts` — pembuat database VFS kosong
- **File:** `scripts/create-bkfs.ts` (npm: `bkfs:create`)
- **Perubahan:** Script untuk membuat `system.db` kosong (schema BKFS). Opsi: `--path <file>` (default `system.db`), `--seed-dirs` (membuat `/bin /dev /etc /home /lib /mnt /opt /root(700) /tmp(1777) /usr /var`), `--force` (backup file existing ke `.bak-<ts>`).
- **Dampak:** Inisialisasi database VFS baru tanpa bootstrap penuh.
- **Oleh:** Copilot

### `vfs-bootstrap.ts` menerima argumen dbPath
- **File:** `scripts/vfs-bootstrap.ts`
- **Perubahan:** Terima path database sebagai argumen positional: `npm run vfs:bootstrap -- data/test.db` (default `system.db`).
- **Dampak:** Bisa bootstrap ke database selain default (pengujian / instalasi perangkat baru).
- **Oleh:** Copilot
