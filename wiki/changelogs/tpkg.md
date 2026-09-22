# Changelog TPKG

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-22

### Paket engine sejati: `system-update` meng-update kernel + seluruh sistem

- **File:** `scripts/gen-tpkg-manifest.ts` (baru), `src/mirror/etc/tpkg/packages.json`,
  `src/mirror/sbin/TpkgProtocol.ts`, `src/mirror/sbin/tpkgd.ts`, `src/mirror/sbin/tpkg.ts`,
  `src/mirror/sbin/apply-update.ts`, `src/mirror/etc/fstab.json`
- **Alasan:** audit menunjukkan `system-update` **tidak meng-upgrade apa pun**:
    - isinya hanya 17 item, padahal sistem punya ~128 file (+ 37 file kernel);
    - **kernel tidak ada di VFS sama sekali**, jadi tidak mungkin dikirim lewat paket;
    - alur staging `/tmp/system-updates/**` → `apply-update` menghitung path host dari
      `process.cwd()` sehingga menulis ke `<repo>/bin/...` (bukan `src/mirror/bin/...`),
      dan cabang "VFS ROOT MIRRORING"-nya menunjuk `src/root/` yang sudah tidak ada.
- **Perubahan:**
    - **`hostDst` (field item baru).** File yang hidup di host (kernel, `src/common/*`,
      `WorkerEntry.ts`) ditulis ke VFS **dan** disalin ke host lewat `syncToHost`.
      Divvalidasi di server & klien (`isSafeHostDst`) dan **ikut ditandatangani**
      (masuk `bundleDigest`) supaya tujuan host tidak bisa dibelokkan.
    - **Alur staging dihapus.** `system-update` menulis langsung ke path VFS aslinya
      (`/bin/init.ts`, `/lib/common/*`, `/sbin/*`), bukan `/tmp/system-updates/`.
    - **`apply-update.ts` ditulis ulang** menjadi hook pasca-install yang benar-benar
      diperlukan: membangun ulang sidecar `.js` di `/bin`, `/sbin`, `/usr/bin`
      (PATH & EXEC memprioritaskan `.js`, dan `bootEntry` = `init.js` — tanpa ini update
      seolah tidak terjadi), sidecar host `WorkerEntry.js`, plus penegakan mode
      eksekusi & SetUID.
    - **Generator manifest** (`npm run tpkg:manifest`): 176 item (VFS 138 + host 38),
      ±1,9 MB; versi paket diambil dari `src/kernel/Kernel.ts`. Menulis-ulang hanya
      paket `system-update`, paket lain dipertahankan.
    - **Mount read-only `/hostsrc` → `src`** (fstab, mode `0o700` root-only) supaya
      `tpkgd` bisa membaca file host (kernel) di sisi server.
    - **Data per-node tidak pernah dikirim**: `/etc/passwd|shadow|group`,
      `trusted_repos`, `/etc/tpkg/keys/**`, `/etc/tsd/**`, `fstab.json`, `crontab`, dan
      config aplikasi. Mengirim `/etc/shadow` ke node lain = akun server menggantikan
      akun node itu.
    - **Mode disamakan dengan `vfs-bootstrap`**: `/sbin` → `0o744`, SetUID
      `login`/`passwd`/`sudo` → `0o4755`, dan file **data** di direktori eksekusi
      (mis. kunci OTA) tidak ikut di-chmod `0o755`.
- **Gerbang root (permintaan operator):** karena paket engine menyentuh host FS,
  `update`/`install`/`download`/`rollback` **wajib root**, `tpkgd` juga. Ditambah
  konfirmasi eksplisit berisi daftar file host sebelum menulis (default **tidak**).
  Kernel sudah menolak `SYNC_TO_HOST` dari non-root — jadi ini pertahanan berlapis.
- **Bug yang ditemukan test baru:**
    - item ber-`hostDst` tidak mem-backup sisi VFS-nya → kegagalan di tengah jalan
      meninggalkan VFS sudah versi baru (P2.14);
    - satu kegagalan pemulihan host membuat sisi VFS ikut terlewat karena berada di
      `try` yang sama → kini try/catch terpisah per sisi (P2.14).
    - `nettools` menunjuk `/usr/bin/scp.ts` yang tidak ada (file aslinya `/bin/scp.ts`,
      dan `/bin/scp.ts` tidak dikirim paket mana pun).
- **Test:** `TpkgProtocol.test.ts` 13 test (hostDst di digest, `isSafeHostDst`,
  aturan mode), `tpkg.test.ts` 18 test e2e (tulis host, konfirmasi ditolak, gagal
  sync → rollback VFS, rollback host, hostDst berbahaya ditolak, tolak non-root di
  `tpkg` & `tpkgd`).
- **Oleh:** Copilot

---

## 2026-09-22

### Hidupkan kembali `tpkg`/`tpkgd` + port fitur dari `tsd`/`tsdd`

- **File:** `src/mirror/sbin/tpkg.ts`, `src/mirror/sbin/tpkgd.ts`,
  `src/mirror/sbin/TpkgProtocol.ts` (baru), `src/mirror/sbin/tpkg-setup.ts`,
  `src/mirror/etc/tpkg/packages.json`
- **Alasan:** `tpkg`/`tpkgd` sudah "setengah mati" (CLI tanpa implementasi penuh,
  daemon tanpa opsi) sementara `tsd`/`tsdd` punya beberapa fitur yang lebih matang.
  Diputuskan **standardisasi di tpkg** dan memindahkan fitur berguna dari tsd,
  bukan memelihara dua package manager.
- **Perubahan:**
    - **CLI lengkap:** `update`, `list`, `install`, `download`, `info`, `verify`,
      `rollback`, `metrics`, `--set-repo`. Sebelumnya tidak ada `download`,
      `verify`, `rollback`, maupun `metrics`.
    - **`--port` / `--repo` / `--max-bundle` / `--help` pada `tpkgd`.** Port tidak
      lagi di-hardcode `80` di 4 tempat: alamat `host[:port]` di-parse
      (`parseHostPort`) dan benar-benar dikirim ke jaringan. Port tidak valid
      ditolak **sebelum** bind.
    - **Backup & rollback (`tpkg.ts`).** Sebelum menimpa file, isi lama disimpan ke
      `/var/lib/tpkg/backup/<pkg>/<timestamp>/` + `index.json`. Gagal backup =
      instalasi dibatalkan. `tpkg rollback` memulihkan backup terbaru lalu menjalankan
      `undoScript`. Backup lama dipangkas otomatis.
    - **`tpkg download` tidak lagi ikut menginstall.** Dulu `download` memanggil jalur
      install (post-install ikut jalan — efek samping tak terduga). Kini murni
      mengambil + memverifikasi ke `/var/cache/tpkg/bundles/`.
    - **Verifikasi 2 lapis.** Signature RSA atas digest bundle (path+size+sha256,
      bukan konten penuh) **plus** pemeriksaan ukuran & SHA-256 per file sebelum file
      ditulis. Hash dihitung atas byte **latin1** — `Buffer.from(content)` polos
      (utf8) akan merusak file biner; ada test regresi khusus untuk ini.
    - **Batas ukuran bundle.** `--max-bundle` (default 4 MB) menolak paket raksasa
      dengan pesan jelas, menggantikan `maxBundleSize: 500MB` milik tsd yang berujung
      OOM.
    - **Session TTL + rate limit.** Session 10 menit dengan sweep saat idle (dulu
      `stagedDir` di tsd menumpuk tanpa pembersihan); 120 permintaan/menit per
      pengirim → `RATE_LIMITED`.
    - **Field manifest baru:** `permissions`, `isExecutable`, `undoScript`, plus saran
      "did you mean" (Levenshtein) untuk nama paket yang salah.
- **Perbaikan bug yang ikut ketemu:**
    - `parseHostPort(" node : 8090 ")` melempar error karena spasi di akhir alamat.
    - `compareVersions("2.0.0-rc1", "2.0.0")` mengembalikan `1` (salah) — prerelease
      tidak dibersihkan.
    - File executable di luar `/bin/` ditulis `0o644` → post-install `hello-world`
      gagal error **126**. Kini `isExecutable`/`permissions` dihormati dan
      `permissions` menang atas `isExecutable`.
- **Test:** `src/mirror/sbin/TpkgProtocol.test.ts` (unit, 9 test) dan
  `src/mirror/sbin/tpkg.test.ts` (end-to-end dengan filesystem & jaringan palsu,
  11 test) — semuanya baru.
- **Config test:** `vitest.config.mts` (baru) — alias `@common`/`@userland`/`@tsix`/
  `@bin` agar modul userland bisa di-test, `.ts` didahulukan dari sidecar `.js`
  hasil transpile, dan `testTimeout` 20 detik karena handshake nyata memakai
  generate RSA 2048-bit (sumber flaky di suite lain).
- **Dokumentasi:** `wiki/Package-Manager-TPKG.md` ditulis ulang — perintah, format
  manifest, alur instalasi berlapis, backup/rollback, opsi daemon, troubleshooting.
- **Oleh:** Copilot
