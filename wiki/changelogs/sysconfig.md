# Changelog Sysconfig (konfigurasi node)

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-24

### `sysconfig.json` → `sysconfig.conf`: konfigurasi node jadi KEY-VALUE (gaya `/etc/fstab.conf`)

- **File:** `src/common/IniParser.ts` (baru), `src/common/SysConfigIni.ts` (baru),
  `src/common/Config.ts`, `src/common/IniParser.test.ts` (baru, D9.01–D9.16),
  `scripts/install.ts`, `scripts/lib/db-path.ts`, `scripts/lib/root-mode.ts`,
  `scripts/rootfs-chmod.ts`, `scripts/vfs-pull.ts`, `.gitignore`,
  `vitest.config.mts`, `README.md`, `CONTRIBUTING.md`, `wiki/*`.
- **Alasan:** konfigurasi node sebaiknya bisa dibaca/diedit seperti `/etc/fstab.conf`
  — satu baris satu setelan, bisa dikomentari per baris (`#`/`;`), dan tidak perlu
  hati-hati soal koma (JSON: satu koma salah = seluruh berkas tidak bisa dibaca).
  Ini juga menyatukan aturan nilai dengan fstab & `ConfigParser` userland.
- **Bentuk berkas** (contoh ringkas):

  ```ini
  [kernel]
  database     = system.db
  rootType     = bkfs          # bkfs | host (lihat wiki/Virtual-File-System.md)
  rootHostPath = ../mirror
  verbose      = true

  [network]
  defaultDevice = smqtnl0
  interfaces    = smqtnl0, smqtnl1

  [iface.smqtnl0]
  broker      = mqtt://192.168.1.204
  address     = tsix
  defaultPort = 1883

  [device.tft]
  mode = 0o666
  uid  = 0
  gid  = 0
  ```

- **Aturan nilai** (`IniParser.ts`, disamakan dengan `FstabParser` + `/lib/ConfigParser`):
  `"teks"` = string, `a, b` = array (koma di luar kutip), `true/false|yes/no|on/off`
  = boolean, angka hanya kalau bolak-baliknya utuh (`0755` tetap string, `0o755` → 493),
  `#`/`;` = komentar (baris penuh atau ekor, tidak memotong nilai berkutip).
  `[iface.<deviceName>]` = satu interface MQTNL, urutannya dari `[network] interfaces`;
  `[device.<nama>]` = aturan udev-style (`applyDeviceConfigs`).
- **Migrasi otomatis (sekali-jalan):** kalau `sysconfig.conf` belum ada tapi
  `sysconfig.json` masih ada, isinya diformat ulang ke `.conf` lalu **dibaca ulang
  sebagai validasi**, dan berkas `.json`-nya dibiarkan (berhenti dipakai) — pola yang
  sama dengan migrasi `/etc/fstab.json` → `/etc/fstab.conf` di `Kernel.processFstab()`.
  Berlaku di `Config.load()` (kernel) dan `install.ts`.
- **Dampak ke samping (duplikasi dibuang):**
    - `getDefaultDbPath()` (`scripts/lib/db-path.ts`), `lib/root-mode.ts`,
      `rootfs-chmod.ts`, dan `vfs-pull.ts` dulu masing-masing mem-parse
      `sysconfig.json` sendiri; semuanya kini lewat `Config.tryGet()` (satu parser,
      satu aturan, migrasi ikut).
    - Default konfigurasi jadi SATU sumber: `createDefaultSysConfig()`
      (`src/common/SysConfigIni.ts`) dipakai installer **dan** parser (key yang tidak
      ada di berkas). `install.ts` hanya menimpa versi kernel + jawaban interaktif.
    - `Config.tryGet()` ditambahkan (null alih-alih throw) untuk skrip diagnostik.
    - Key/section tak dikenal atau nilai salah tipe hanya **diperingatkan**, tidak
      menggagalkan boot — satu baris salah tidak boleh mematikan node.
- **Perbaikan sampingan:** `vitest.config.mts` mengecualikan `src/rootfs/**`.
  Tanpa itu `npm test` menjalankan salinan sidecar `.test.js` di dalam dump rootfs
  (vitest tidak membaca `.gitignore`) → puluhan file "gagal" yang bukan test repo ini.
- **Diuji:** 12 test baru (D9.01–D9.16: aturan nilai, array, komentar, iface/device,
  peringatan, round-trip formatter → parser). Boot terverifikasi dengan `rootType = bkfs`
  (`Mounting root filesystem (BKFS/SQLite (system.db))`) dan `rootType = host`
  (`HostVFS (src/rootfs)`) — keduanya sampai prompt login. `tsc --noEmit` bersih.
- **Sisa (belum dikerjakan):** halaman kursus `wiki/course/*` masih menyebut
  `sysconfig.json`, dan `docs/TSIX-Course-*.html` (generated) ikut menyebutnya —
  perlu regenerate setelah halaman wiki-nya diperbarui.
- **Oleh:** Copilot
