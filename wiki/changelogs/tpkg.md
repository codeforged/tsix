# Changelog TPKG

> Format: `YYYY-MM-DD | Perubahan | Oleh`

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
