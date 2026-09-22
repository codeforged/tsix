# Changelog TPKG

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-22

### Fix loader lanjutan: `..` tidak boleh menembus root VFS (regresi `/common/...`)

- **File:** `src/userland/VfsModuleResolver.ts` (+ sidecar `.js` di-rebuild),
  `src/userland/VfsModuleResolver.test.ts`, `scripts/test/worker-dme-smoke.mjs`
- **Gejala saat dicoba di sistem hidup:**
    ```
    root@tsix# tpkgd
    [Worker 46] Local module scan failed: File not found: /common/SyscallCode.ts
    ```
    (muncul juga di `tpkg`; app tetap jalan, tapi seluruh pemindaian import relatif batal diam-diam)
- **Akar masalah:** `resolveVfsRelative()` memakai `"/lib/UserLib".split("/")` apa
  adanya, sehingga segmen KOSONG dari `/` di depan ikut dihitung sebagai direktori.
  Akibatnya `..` masih bisa "pop" walau pemanggil sudah di root, dan hasilnya
  menempel ke root:
    ```
    ("/lib/UserLib", "../../common/SyscallCode")  →  "/common/SyscallCode"   ❌
    ```
    `common` di VFS hidup di `/lib/common`, jadi `/common/SyscallCode.ts` **tidak
    ada** — dan `fs.readFile` untuk file hilang **MELEMPAR** `File not found`
    (syscall `OPEN` menolak flag `r`), bukan mengembalikan `null`. Karena lemparan
    itu terjadi di tengah loop, `collectRelativeModules()` gagal total
    (`programModules = {}`) — bukan cuma satu modul yang hilang.
- **Kenapa kena tepat di `tpkg`/`tpkgd`:** keduanya `import "../lib/UserLib"`, jadi
  pemindaian masuk ke `/lib/UserLib` → isinya `import "../../common/SyscallCode"`
  (layout host: `src/mirror/lib` → `src/common`) → kena bug di atas.
- **Perubahan:**
    - `resolveVfsRelative()`: segmen kosong dibuang (`filter(s => s !== "")`), dan
      `..` yang menembus root → `null` (bukan dipangkas ke root). Modul framework
      tetap aman karena hook `Module._load` memetakan request apa pun yang memuat
      `/common/` → `@common/*` dan `/lib/` → `@tsix/*`, keduanya dilayani `vfsCache`.
    - `collectRelativeModules()`: pembaca VFS yang **melempar** kini ditoleransi
      (`readMaybe()`), karena kandidat selalu diuji berurutan (`.ts` → `.js` →
      `index.*`) dan satu kandidat yang tidak ada dulu membatalkan seluruh scan.
      Error transpile SENGAJA tetap tidak ditelan — kalau `.ts`-nya rusak, pesannya
      harus tetap muncul.
- **Verifikasi:** 11 unit test hijau, termasuk regresi baru **R1.10** (root tidak
  bisa ditembus) dan **R1.11** (pembaca yang melempar tidak membatalkan scan).
  Diuji langsung dengan pembaca ala kernel terhadap tree `src/mirror`:
  `/sbin/tpkgd` → `{DbLib, IProgram, NetworkLib, UserLib}`; `/usr/local/bin/tsd`
  → `+ TsdTypes`; `File not found` tidak lagi muncul.
- **Harness smoke diperbaiki (kenapa bug ini lolos):** `worker-dme-smoke.mjs` dulu
  membalas `-1` untuk `OPEN` file hilang (padahal kernel MELEMPAR) dan VFS palsunya
  kosong, jadi jalur pemindaian ini tidak pernah benar-benar teruji. Sekarang: VFS
  palsu diisi seluruh `src/mirror`, `OPEN` file hilang melempar seperti kernel,
  error syscall dikirim sebagai `success:false` (bukan diam-diam "sukses"), dan
  `Local module scan failed` dihitung GAGAL. Dengan harness itu error di atas
  tereproduksi persis sebelum fix, dan hilang sesudahnya.
- **Deploy:** cukup rebuild sidecar host `src/userland/VfsModuleResolver.js`
  (sudah dikerjakan). **Tidak perlu** `vfs:bootstrap` (tidak ada file `src/mirror/*`
  yang berubah) dan **tidak perlu restart kernel** — worker baru membaca sidecar
  baru saat spawn.
- **Oleh:** Copilot

---

## 2026-09-22

### Fix loader: import RELATIF (`./x`, `../y`) di userland sekarang jalan

- **File:** `src/userland/WorkerEntry.ts`, `src/userland/VfsModuleResolver.ts` (baru),
  `scripts/vfs-bootstrap.ts`, `src/mirror/lib/TpkgProtocol.ts` (pindah dari `sbin/`)
- **Gejala saat dicoba di sistem hidup:**
    ```
    root@mactsix# tpkgd
    [Worker 35] Direct Execution Error: Cannot find module './TpkgProtocol'
    Require stack:
    - /sbin/tpkgd.js
    ```
- **Akar masalah:** program userland dijalankan lewat "Direct Memory Execution" —
  Kernel mengirim isi file sebagai `appContent`, lalu WorkerEntry men-`_compile()`-nya.
  Hook `Module._load` hanya melayani module-id framework (`@tsix/*` → `/lib/*.ts`,
  `@common/*` → `/lib/common/*.ts`) dan `../lib/...`. Import **sesama direktori**
  jatuh ke Node biasa, yang mencarinya di HOST filesystem — padahal file itu ada di
  VFS (BKFS). Jadi dulu satu-satunya jalan adalah memindahkan file ke `/lib`.
- **Kenapa tidak bisa dibetulkan di hook:** `Module._load` SINKRON, sedangkan baca
  VFS lewat syscall ASINKRON — hook tidak mungkin membaca file sendiri.
- **Solusinya:** modul relatif dikumpulkan LEBIH DULU di `main()` (yang async):
  telusuri import relatif secara statis dari isi program, resolve ke path VFS,
  baca via `fs.readFile`, transitif (kedalaman bebas, siklus aman, ada pagar 64
  modul), lalu simpan sebagai peta `id → kode ter-transpile`. Hook `require` tinggal
  melihat peta itu — tanpa I/O. File `.js` dipakai apa adanya, `.ts` ditranspile.
- **Struktur:** logika murni dipisah ke `src/userland/VfsModuleResolver.ts`
  (tanpa efek samping, jadi bisa di-unit-test); `WorkerEntry.ts` hanya menyambungkannya
  ke loader. Sidecar host `VfsModuleResolver.js` ikut di-generate & disinkronkan
  (`scripts/vfs-bootstrap.ts` + `/sbin/apply-update.ts`).
- **Verifikasi:** 9 unit test (`VfsModuleResolver.test.ts`) + uji worker sungguhan
  (WorkerEntry.js dijalankan dengan `workerData` tiruan): `./TpkgProtocol`,
  `./Sub/Extra`, `../TpkgProtocol` dari modul bersarang, dan `./helper` (`.js`)
  semuanya dibaca dari VFS; error `Cannot find module` hilang.
- **Ikutan:** `TpkgProtocol.ts` **dipindah** `sbin/` → `lib/` tetap dipertahankan
  karena memang library bersama (masuk cache pre-compile `/lib`, tidak perlu baca VFS
  per exec) dan di-import sebagai `@tsix/TpkgProtocol`.
- **Oleh:** Copilot

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
