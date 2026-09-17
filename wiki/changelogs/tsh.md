# Changelog TSH (Shell TSIX)

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-17

### `tsh` bisa menjalankan skrip `.sh` (butuh bit `x`)

- **File:** `src/mirror/bin/tsh.ts`, `src/mirror/lib/ShellScript.ts` (baru), `src/mirror/lib/ShellScript.test.ts` (baru), `scripts/test/fixtures/smoke-script.sh` (baru), `scripts/test/worker-dme-smoke.mjs` (diperluas).
- **Perubahan:** skrip shell kini bisa dijalankan dua cara — `./start-netfs.sh [args]` (interaktif) dan `tsh start-netfs.sh [args]` (non-interaktif). Deteksi skrip: ber-akhiran `.sh` **atau** punya shebang (`#!/bin/tsh`, `#!/bin/sh`); file `.ts`/`.js` tetap jalur aplikasi seperti sebelumnya.
- **Bit eksekusi ditegakkan:** skrip tanpa bit `x` ditolak `-tsh: <path>: Permission denied (butuh bit x: chmod +x <path>)` dengan `$?`/`ERROR_LEVEL` = **126** — sama seperti Linux. Pemeriksaan ditaruh di `runScriptCommand()` supaya jalur non-interaktif (`tsh skrip.sh`) tidak bisa menembusnya (sempat lolos saat implementasi pertama, ketahuan lewat harness dengan `SMOKE_FILE_MODE=644`).
- **Eksekusi di shell yang sama (seperti `source`):** `cd`, `export`, dan variabel benar-benar terasa efeknya setelah skrip selesai. `exit` di dalam skrip menghentikan sisa barisnya.
- **Argumen & parsing:** `$0` (path skrip), `$1..$9`, `$@`/`$*`, `$#` tersedia di dalam skrip; komentar `#` hanya bila di awal kata dan di luar tanda kutip (jadi `echo "a # b"` utuh dan `$#` tidak terpotong); sambung baris `\` **juga** berlaku di dalam file skrip; baris shebang dilewati.
- **Skrip di background** (`./skrip.sh &`) di-spawn sebagai subshell `tsh <skrip>` (proses terpisah, environment sendiri) supaya shell tetap responsif. Pagar kedalaman skrip bersarang: maksimum 16.
- **Interpreter divalidasi:** hanya `tsh`/`sh`/`bash` (termasuk `#!/usr/bin/env tsh`) yang diterima; selain itu ditolak dengan pesan jelas (exit 126) alih-alih gagal aneh di tengah jalan.
- **Alasan util dipisah:** parsing (komentar/sambung baris/shebang) ditaruh di `@tsix/ShellScript` yang murni tanpa dependency, sehingga bisa ditest langsung — 13 test (`S1.01`–`S1.33`) menutup kasus komentar di dalam kutip, `$#`, backslash genap/ganjil, shebang, dan gabungan baris.
- **Verifikasi end-to-end (headless, tanpa boot TSIX):** harness `scripts/test/worker-dme-smoke.mjs` kini menyajikan mini-VFS (`SMOKE_FILES`) + syscall STAT/OPEN/READ/CLOSE/GETENV/SETENV/CHDIR, sehingga `tsh skrip.sh` sungguhan bisa dijalankan di worker. Hasil: `export GREETING=$1` → `GREETING=halo`, `ALL_ARGS=$@` → `halo dunia`, `ARG_COUNT=$#` → `2`, dan baris `version \` + `--dummy-arg` tergabung menjadi satu perintah. Mode 644 → ditolak 126.
- **Dampak:** perintah panjang (mis. `netfsd --export ... --key ...`) cukup disimpan sekali di file `start-*.sh` lalu dipanggil singkat. Deploy: file baru (`/lib/ShellScript.ts`, `/bin/tsh.ts` yang berubah) → `npm run install`, lalu restart shell.
- **Oleh:** Copilot

### Sambung baris `\` di console `tsh`

- **File:** `src/mirror/bin/tsh.ts` (`readLogicalLine()`), `src/mirror/lib/ShellScript.ts` (`splitTrailingContinuation()`).
- **Perubahan:** menulis `\` lalu Enter menyambung perintah ke baris berikutnya dengan prompt lanjutan `> ` (bisa diubah lewat env `PROMPT2`), persis kebiasaan shell Unix:

  ```
  root@tsix# netfsd --export /mnt/sbak/ \
  > --label databank --port 7777 \
  > --key c50f67b7...
  ```

- **Detail semantik:** `\` tunggal di akhir baris dibuang bersama newline-nya (karena itu spasi sebelum `\` berfungsi sebagai pemisah argumen); `\\` (jumlah genap) berarti backslash literal dan **tidak** menyambung; Ctrl+C atau Enter kosong membatalkan seluruh perintah logis; pagar 128 baris sambungan. Histori mencatat perintah logis lengkap (satu entri, bukan per-potongan).
- **Dampak:** perintah panjang dengan banyak `--flag` bisa ditulis rapi tanpa harus mengandalkan scroll horizontal; `help` kini menjelaskan skrip + sambung baris.
- **Oleh:** Copilot

### Builtin `waitfile` + peringatan perintah skrip yang menggantung

- **File:** `src/mirror/bin/tsh.ts`
- **Perubahan 1 — `waitfile <path> [timeout_ms]`:** menunggu sebuah file muncul (polling 200 ms, default timeout 10 s), exit 0 kalau muncul dan exit 1 dengan pesan jelas kalau tidak. Ini pengganti polling manual di skrip boot: `waitfile /var/run/dome.ready 10000` sebelum Asteracea start (sebelumnya hanya ada di `rc.local.ts` legacy sebagai loop `while`).
- **Perubahan 2 — peringatan 15 detik:** kalau sebuah perintah **di dalam skrip** masih berjalan setelah 15 s, tsh mencetak pesan sekali: bisa jadi daemon yang belum selesai atau perintah interaktif yang tidak boleh ada di skrip. Sebelumnya skrip bisa menggantung tanpa petunjuk apa pun — tepatnya yang terjadi saat `/bin/login.js` ikut masuk `/etc/rc.local` dan membuat semua daemon sesudahnya tidak pernah start. Ambang diatur lewat `TSH_WAIT_HINT_MS` (`0` = mati); peringatan hanya aktif di skrip, bukan console interaktif.
- **Verifikasi:** harness DME (fixture `smoke-waitfile.sh`) — timeout → `-tsh: waitfile: /tmp/... tidak muncul dalam 300ms`, `ERROR_LEVEL=1`, dan skrip **tetap lanjut** ke baris berikutnya (tanpa `set -e`); jalur sukses (file ada) → `ERROR_LEVEL=0` tanpa output.
- **Oleh:** Copilot

### Batasan yang diketahui (belum ada di `tsh`)

- Belum ada struktur kontrol (`if`, `for`, `while`), fungsi, `$()`/backtick, dan `set -e` — skrip saat ini adalah **daftar perintah** (dengan `;`, `|`, `>`, `&`, wildcard, variabel, dan argumen posisional). Jadi `.sh` gaya Linux kompleks belum bisa dijalankan apa adanya.
- Skrip di background memakai proses `tsh` baru → perubahan environment di dalamnya tidak kembali ke shell induk.
- `sourceProfile()` (`/etc/profile`, `~/.tsixrc`) masih memakai parser terbatas (hanya `export`/`echo`) dan **belum** dialihkan ke mesin skrip baru — sengaja tidak diubah agar perilaku login tidak berisiko; kandidat penyatuan berikutnya.
