# Changelog Twrapper

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-11-21

### Twrapper — builder distro berbasis paket TPKG

- **File utama:** `scripts/twrapper/build.ts`, `scripts/twrapper/imut.json`,
  `scripts/twrapper/rootfs/etc/{profile,rc.local,tpkg/config.json}`,
  `wiki/twrapper.md`
- **Konsep:** komposisi image ditentukan dari **nama paket TPKG**
  (`installedPackages` + `repositoryPackages`), bukan daftar file. Satu file
  hanya boleh dimiliki satu paket; dua paket yang menargetkan path sama dengan
  isi berbeda membuat build gagal.
- **Recipe (schemaVersion 1):** `outputDirectory` wajib di dalam `distro/`;
  nama paket harus ada di `src/mirror/etc/tpkg/packages.json` dan unik lintas
  dua daftar.
- **Repository lokal:** `repositoryPackages` di-_stage_ ke
  `/var/lib/tpkg/repo/<pkg>/...`; katalog image ditulis ulang hanya berisi paket
  repo tersebut, sehingga bisa diuji dengan `tpkg install <pkg>`.
- **Keamanan output:** `.twrapper-state.json` menyimpan sha256 tiap file;
  menolak menimpa file yang diubah manual maupun direktori tak terkelola.
- **npm alias:** `npm run distro:twrapper -- ...` (menggantikan
  `distro:generate`).
- **Hasil uji:** image `distro/imut` ~226 file (~2,2 MB).

### Perbaikan instalasi `base-system` dan integritas byte VFS

- **`SYNC_TO_HOST` (kernel):** `fs.writeFileSync(path, Buffer.from(content,
"latin1"))`. Sebelumnya string latin1 ditulis sebagai UTF-8, sehingga setiap
  byte ≥ 0x80 menggelembung ~2× (file kernel seperti `src/kernel/**` rusak saat
  ditulis balik). Ini kebalikan dari `SYNC_FROM_HOST` yang sudah membaca latin1.
    - Regresi baru **A1.91b**: round-trip host → VFS → host, byte identik
      (BOM + `café` + em dash + `東京`).
- **`SYNC_FROM_HOST`:** regresi **A1.91** memastikan byte host (UTF-8) masuk VFS
  sebagai latin1 apa adanya.
- **`tpkgd`:** fallback `/hostsrc/...` lewat `syncFromHost` + staging, sehingga
  paket `base-system` bisa dilayani tanpa mount `/hostsrc`.
- **`tpkg` (klien):** `backupFiles()` memeriksa `stat` sebelum `readFile`,
  supaya instalasi pertama tidak gagal "File not found".
- **`apply-update`:**
    1. aplikasi diberi akses host module `esbuild` (ditambahkan ke allow-list
       `restrictHostAPI` di `WorkerEntry`, setara `tbuild`);
    2. isi VFS didekode `vfsBytesToUtf8()` sebelum `esbuild`, dan hasil `.js`
       ditulis lewat `utf8ToVfsBytes()` (sidecar VFS & staging host);
    3. direktori staging `/tmp/tpkg-host-sidecar` dibuat sebelum menulis, dan
       hasil `writeFile` diperiksa (gagal tulis = error jelas, bukan "not found").
- **`tsh`:** tidak lagi mengembalikan/mencetak `Script <x> finished.` saat
  menjalankan skrip non-interaktif, menghilangkan derau saat init menjalankan
  `/etc/rc.local`.

### Pembersihan

- **Dihapus:** `scripts/distro-generator.ts`, `scripts/lib/distro-generator.ts`,
  `scripts/lib/distro-generator.test.ts`, serta script `distro:generate` di
  `package.json` (digantikan Twrapper).
- **Dipertahankan:** `scripts/inventory-tsix-files.ts` (+ `scripts/lib/
tsix-file-inventory.ts`) karena dipakai untuk inventaris file TSIX.
- `distro/README.md` diperbarui: alur build kini memakai Twrapper.

### Validasi

- `npx vitest run src/mirror/sbin/tpkg.test.ts src/mirror/lib/TpkgProtocol.test.ts`
  lulus.
- `npx vitest run src/kernel/Syscalls.test.ts -t "SYNC_FROM_HOST"` lulus
  (A1.91, A1.91b, A1.92).
- Type-check bersih pada file yang diubah; `npm run distro:twrapper -- --check`
  jalan.

**Oleh:** Copilot · **Laporan:** kakang
