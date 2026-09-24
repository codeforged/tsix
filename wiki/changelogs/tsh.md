# Changelog TSH (Shell TSIX)

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-24

### Panduan shell scripting: `wiki/shell-scripting.md`

- **File:** `wiki/shell-scripting.md` (baru), `wiki/Home.md` (tautan navigasi)
- **Masalah:** aturan shell (`tsh`) hanya hidup di dalam kode + satu fixture uji, jadi
  pemakaian sehari-hari bergantung pada coba-coba — dan batasan seperti “`$(...)` hanya
  menangkap output builtin” atau “tidak ada `break`/`function`/`set -e`” baru ketahuan
  setelah skrip gagal di tengah boot.
- **Perubahan:** panduan lengkap yang disusun dari implementasi (`bin/tsh.ts`,
  `lib/ShellScript.ts`): cara menjalankan skrip, argumen & variabel, ekspansi, kondisi,
  perulangan, `case`, pipeline/redirection, daftar builtin, tabel “tidak ada + pengganti”,
  jebakan (`$(...)`, wait-hint 15s, batas sarang 16), contoh nyata dari repo, cara menguji
  tanpa boot (`tsh-script-harness.ts`), serta aturan penulisan (ASCII, bukan emoji).
- **Dampak:** setiap contoh sudah diverifikasi terhadap utilitas asli — termasuk koreksi
  sintaks yang mudah salah: `ping <host> <count>` (posisional, bukan `-c`), `tail -n <n>`
  (bukan `tail -20`), dan mount yang berasal dari `/etc/fstab.conf`.
- **Oleh:** Copilot

---

## 2026-09-18

### Builtin `read` dan Struktur Kontrol `case`

- **File:** `src/mirror/bin/tsh.ts`, `scripts/test/fixtures/sample-script.sh`
- **Perubahan 1 — Builtin `read`:** Mengimplementasikan perintah `read [-p prompt] [var...]` untuk membaca input dari stdin (mendukung *cooked mode* native via `this.std.readLine()`). Perbaikan ini menyelesaikan masalah pencetakan prompt ganda di skrip shell yang sebelumnya terjadi karena pemanggilan fungsi `this.readLine()` milik shell interaktif.
- **Perubahan 2 — Struktur Kontrol `case`:** Mengimplementasikan blok `case $VAR in ... esac`. Mendukung pola wildcard (`*`, `?`), penutup ganda (`;;`), penutup implisit tanpa `;;` (saat menjumpai baris pola `pattern)` baru), dan eksekusi perintah per-branch yang sesuai.
- **Dampak:** Skrip menu / interaktif bergaya Linux (seperti cek kuota / isi pulsa di `sample-script.sh`) sekarang berjalan dengan baik secara native di TSIX.
- **Oleh:** Copilot

---

## 2026-09-17

### Mesin skrip: kutip/escape, `for`, `$(...)`, `&&`/`||`, `VAR=nilai`

- **File:** `src/mirror/bin/tsh.ts`, `src/mirror/lib/ShellScript.ts`, `src/mirror/lib/ShellScript.test.ts` (10 test baru `S1.40`–`S1.55`), `scripts/test/tsh-script-harness.ts` (baru), `scripts/test/fixtures/sample-script.sh` (baru).
- **Gejala yang dilaporkan:** menjalankan `sample.sh admin 123` menghasilkan `Nama Skrip (\./sample.sh)`, blok FOR LOOP kosong, dan header `5. PENGUJIAN PIPELINE (|) & REDIRECTION (>)` terpotong jadi `5. PENGUJIAN PIPELINE (`.

**Akar masalah (semuanya soal tanda kutip yang tidak dihormati):**

1. **`>` di dalam tanda kutip dianggap redirection.** Deteksi lama memakai `trimmedInput.includes(">")`, jadi `echo " -> Starting service: $SERVICE..."` diperlakukan sebagai `echo " -` **>** `Starting service: ...` — output FOR LOOP ditulis ke file bernama sisanya, bukan ke layar. Itu sebabnya loop terlihat "tidak jalan" padahal loopnya benar.
2. **`|` di dalam tanda kutip dianggap pipeline.** `echo " 5. PENGUJIAN PIPELINE (|) & REDIRECTION (>)"` dipecah jadi pipeline palsu.
3. **`;` di dalam tanda kutip dianggap pemisah perintah.**
4. **Escape tidak dikenal.** `echo "Nama Skrip (\$0)"` menghasilkan `\` + nilai `$0`, bukan literal `$0` — karena ekspansi lama memakai regex `\$VAR` tanpa tahu arti `\$`.
5. **`$(...)` berisi spasi pecah saat tokenisasi.** `export COUNTER=$(expr $COUNTER - 1)` menjadi kata `COUNTER=$(expr`, `$COUNTER`, `-`, `1)` → `COUNTER` berisi `$(expr` dan loop WHILE hanya jalan sekali (substitusi dulu ditangani di level baris lewat regex non-greedy, yang juga tidak tahan `;`/kutip/nesting).
6. **`VAR=nilai` tanpa `export`** dicari sebagai binary → `-tsh: i=0: command not found`.

**Perbaikan (satu jalur tokenisasi yang sadar kutip):**

- Util baru di `@tsix/ShellScript` (murni, ada test): `splitRawWords()` (kata mentah, kutip & escape dipertahankan), `splitTopLevel()` / `findTopLevelOperator()` / `findTopLevelOperators()` (operator HANYA di luar tanda kutip). Semuanya melewati `$( ... )` sebagai satu potongan, jadi `$(a; b)` dan `$(cat > f)` tidak memecah perintah luar.
- `tsh`: `expandWord()` menggantikan `expandVariables()` — ekspansi **satu pass** untuk kutip, escape, `$VAR`/`${VAR}`, dan `$(...)` (boleh bersarang, `expr` tetap cepat-track). Satu pass itu wajib: `\$VAR` → literal `$VAR`, sedangkan `\\$VAR` → `\` + nilai VAR. `'...'` benar-benar literal (`'$0'` tidak di-expand), `"..."` mengekspansi variabel, dan `"*"`/`'~'` tidak di-glob.
- Redirection & background (`&`) dicari dengan pemindai kutip; target `>` ikut di-expand (`> /tmp/out-$A.txt`, `~`).
- `for VAR in ...`: item di-expand per kata (kutip dihormati), wildcard di-glob (`for f in /b*`), dan `$@`/`$*` dipecah jadi satu item per argumen skrip.
- `if`/`while`/`while`: tiap operand kondisi di-expand sendiri (bukan satu string lalu dipecah ulang), jadi `[ "$1" = "" ]` benar-benar membandingkan string kosong. Tambahan operator: `-z`, `-n`, `-e`, `-f`, `-d`, `-r`, `-w`, `-x`, `[ "$X" ]`, dan kondisi majemuk `[ ... ] && [ ... ]` / `||` (short-circuit, rekursif).
- Baru: rantai `&&`/`||` di luar `if` (`make && echo ok || echo gagal`) dengan prioritas benar (`a | b && c` = `(a|b) && c`) dan `$?` yang tidak berubah saat segmen di-skip; penugasan `VAR=nilai` dan bentuk prefix `VAR=nilai perintah`.
- `help` kini menyebut kontrol yang didukung; `expandVariables()` + `processCommandSubstitutions()` yang lama dihapus.

**Verifikasi:** harness baru `scripts/test/tsh-script-harness.ts` menjalankan mesin skrip tanpa boot TSIX (mocked std/fs/shell, fd nyata supaya `>`/`>>` benar-benar menulis file):

```
node -r esbuild-register -r tsconfig-paths/register \
  scripts/test/tsh-script-harness.ts scripts/test/fixtures/sample-script.sh admin 123
```

Hasil `sample-script.sh` sekarang: `Nama Skrip ($0) : ...`, `Jumlah Argumen ($#): 2`, 3 baris `-> Starting service: ...`, countdown 3-2-1, isi `/tmp/test_output.txt` terbaca `cat`, dan `/b*` → `/bin /boot`. Unit test `ShellScript.test.ts` 23/23 hijau; smoke DME (`worker-dme-smoke.mjs`) tetap `GREETING=halo`, `ALL_ARGS=halo dunia`, `ARG_COUNT=2`.

- **Dampak:** skrip `.sh` gaya Linux (sample dari user) kini jalan apa adanya. Deploy: `/bin/tsh.ts` + `/lib/ShellScript.ts` → `npm run install`, restart shell.
- **Oleh:** Copilot

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

> **Diperbarui 2026-09-18 (entri teratas):** `if/elif/else`, `for`, `while`, `case`, `$(...)`, `&&`/`||`, dan `VAR=nilai` **sudah ada**. Yang masih belum: backtick (`` `cmd` ``), fungsi, `set -e`, dan `local`.

- Belum ada struktur fungsi, `$()`/backtick, dan `set -e` — skrip saat ini adalah **daftar perintah** (dengan `;`, `|`, `>`, `&`, wildcard, variabel, dan argumen posisional). Jadi `.sh` gaya Linux kompleks belum bisa dijalankan apa adanya.
- Skrip di background memakai proses `tsh` baru → perubahan environment di dalamnya tidak kembali ke shell induk.
- `sourceProfile()` (`/etc/profile`, `~/.tsixrc`) masih memakai parser terbatas (hanya `export`/`echo`) dan **belum** dialihkan ke mesin skrip baru — sengaja tidak diubah agar perilaku login tidak berisiko; kandidat penyatuan berikutnya.
