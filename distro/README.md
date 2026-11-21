# Inventaris distro TSIX

Jalankan `npm run distro:inventory` untuk membangun ulang `tsix-files.json`.
File tersebut berisi path relatif, kategori, target, tag domain, dan bukti
klasifikasi. Recognizer memeriksa metadata source serta import TypeScript/JavaScript;
ia tidak menyalin isi source ke inventaris.

Arti status klasifikasi:

- `auto`: dikenali oleh aturan deterministik.
- `needs-review`: ambigu atau belum dikenal; jangan masukkan ke paket sebelum
  ditinjau.
- `reviewed`: keputusan manusia yang tercatat dalam
  `file-classification-overrides.json`.

Untuk menyetujui klasifikasi, tambahkan path dari `reviewQueue` sebagai key di
`file-classification-overrides.json`. Setiap override wajib berisi kategori dan
alasan:

```json
{
    "schemaVersion": 1,
    "overrides": {
        "src/mirror/opt/test/hello-world.ts": {
            "category": "application",
            "reason": "Contoh tutorial yang memang didistribusikan."
        }
    }
}
```

`tags` dan `targets` dapat ditambahkan bila perlu. Path override yang sudah tidak
ada akan menyebabkan proses inventaris gagal agar keputusan lama tidak diam-diam
terabaikan. Klasifikasi `sensitive` tidak dapat diturunkan oleh override.
Direktori hasil generate `distro/<nama-distro>/` tidak ikut dipindai kembali;
metadata lokal PlatformIO `.piopm` dan file resource fork macOS `._*` juga
dikecualikan.

## TSIX IoT Edition

Scope dan aturan pemilihan sumber didefinisikan di
`distro/manifests/iot-edition.json`; daftar path konkret untuk draft saat ini
ada di `distro/iot-edition/manifest.json`. Distro ini memilih tag `iot` dan
`tde`; `desktop-dependent` hanya menandai aplikasi yang memakai library desktop,
bukan komponen TDE, sehingga tidak otomatis memasukkan semua aplikasi GUI.

File `needs-review`, konten ber-tag `example`, serta isi `/opt/test` tidak
dimasukkan. Manifest masih berstatus draft: menu Asteracea dapat merujuk
aplikasi opsional di luar scope, dan `platformio.ini` memiliki port upload khusus
perangkat pengembang. Path yang dicantumkan secara eksplisit dapat melewati
pengecualian kategori biasa (misalnya file `LICENSE`), tetapi tidak dapat melewati
proteksi file sensitif, konfigurasi node-local, file review, atau contoh. Tinjau
catatan rilis di manifest sebelum membangun image.

Untuk membangun paket dari aturan terbaru:

```sh
npm run distro:inventory          # (opsional) perbarui inventaris
npm run tpkg:manifest             # pastikan katalog paket mutakhir
npm run distro:twrapper -- --check
npm run distro:twrapper
```

> Generator lama `distro:generate` (`scripts/distro-generator.ts`) sudah dihapus.
> Komposisi distro kini dideklarasikan lewat recipe Twrapper
> (`scripts/twrapper/*.json`) dan diambil dari paket TPKG, bukan daftar file.
> Dokumentasi lengkap: `wiki/twrapper.md`.

Twrapper menyalin berkas installer (`scripts/install.ts`, helper yang
dibutuhkannya, dan metadata npm), menolak symlink atau perubahan manual pada file
hasil build, serta menulis README instalasi. Di paket hasil build, perintah
`install` diubah menjadi `tsix:install` agar `npm install` tidak tanpa sengaja
membuat image sistem. Jalankan `npm install`, lalu `npm run tsix:install`; pada
instalasi baru installer meminta password root dan tidak membawa hash password
dari repo.

## Twrapper: TSIX Imut

Twrapper membangun image dari nama paket TPKG, bukan dari aturan kategori, tag,
dan path file. Resep lab ada di `scripts/twrapper/imut.json`:
`installedPackages` menentukan isi awal image, sedangkan `repositoryPackages`
hanya ditempatkan di repository lokal untuk diuji lewat `tpkg install`.

```sh
node -r esbuild-register scripts/twrapper/build.ts --check
node -r esbuild-register scripts/twrapper/build.ts
```

Hasilnya ada di `distro/imut/`. Profile, `rc.local`, dan konfigurasi repo TPKG
dibuat khusus untuk lab: hanya `tpkgd` yang dijalankan saat boot, repository
default-nya `localhost:8080`, dan paket uji belum terpasang ke image awal.
Twrapper memakai katalog paket di `src/mirror/etc/tpkg/packages.json`; alur ini
independen dari file-based generator IoT Edition.
