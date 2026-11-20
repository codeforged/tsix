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
npm run distro:inventory
npm run distro:generate -- --check
npm run distro:generate
```

Generator menyalin file terpilih dengan struktur path yang sama, menulis
`manifest.json` dan README instalasi, serta menolak symlink atau perubahan manual
pada file hasil generate. Paket menyertakan `scripts/install.ts`, helper yang
dibutuhkannya, dan metadata npm. Di paket hasil generate, perintah `install`
diubah menjadi `tsix:install` agar `npm install` tidak tanpa sengaja membuat
image sistem. Jalankan `npm install`, lalu `npm run tsix:install`; pada instalasi
baru installer meminta password root dan tidak membawa hash password dari repo.
