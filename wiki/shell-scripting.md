# Shell Scripting di TSIX (`tsh`)

`tsh` adalah shell bergaya **Bourne** untuk TSIX. Panduan ini disusun langsung dari
implementasinya — `src/mirror/bin/tsh.ts` (eksekutor) dan
`src/mirror/lib/ShellScript.ts` (parser) — jadi isinya **apa yang benar-benar
didukung**, bukan "seperti bash".

> Prinsipnya: subset Unix yang bisa dipertanggungjawabkan. Kalau sesuatu tidak ada di
> sini, artinya memang belum diimplementasikan — bukan bug yang menunggu dilaporkan.

Semua contoh di panduan ini **ASCII saja**. Ini disengaja; alasannya di
[bagian 12](#12-aturan-encoding-emotikon-dan-berkas-biner).

---

## 1. Menjalankan skrip

| Cara | Perilaku |
| --- | --- |
| `./skrip.sh` | Dijalankan di shell yang **sama** (seperti `source`): `cd`, `export`, dan variabel di dalamnya **terasa** di shell Anda |
| `tsh skrip.sh [args]` | Non-interaktif: skrip jalan lalu shell keluar. Inilah bentuk yang dipakai `rc.local`, cron, dan background |
| `tsh skrip.sh &` | Dijalankan sebagai **subshell terpisah** di background — `cd`/`export` di dalamnya tidak bocor ke shell Anda |
| `/path/skrip.sh` (ber-shebang) | Kernel membaca shebang lalu menjalankannya dengan interpreter yang ditunjuk (`/bin/tsh`, `/bin/sh`, `bash`, atau `/usr/bin/env tsh`) |

Skrip **wajib punya bit eksekusi** (sama seperti Linux):

```sh
root@tsix# chmod +x /root/backup.sh
root@tsix# ./backup.sh /mnt/sbak
```

Tanpa bit `x`: `Permission denied (butuh bit x: chmod +x /root/backup.sh)` dan `$?` = **126**.
Perintah yang tidak ditemukan → `$?` = **127**.

---

## 2. Kerangka skrip

```sh
#!/bin/tsh
# Komentar dimulai dengan '#' di AWAL baris, atau setelah spasi.
# Baris shebang (baris pertama) diabaikan saat dieksekusi.

echo "Halo dari TSIX"
```

- **Shebang** hanya bermakna di baris pertama. `#!/bin/tsh`, `#!/bin/sh`,
  `#!/usr/bin/env tsh`, dan `bash` semuanya diterima.
- **Akhiran `.sh`** membuat berkas dianggap skrip walau tanpa shebang.
- **Komentar**: `#` dihitung komentar hanya kalau berada di awal baris atau didahului
  spasi. Jadi `echo "a # b"` tetap utuh dan `$#` tidak terpotong.
- **Akhir baris CRLF** (berkas dari Windows) tetap ditangani.

### Sambung baris (`\`)

```sh
netfsd --export /mnt/sbak/ \
       --label databank \
       --port 7777
```

`\` di akhir baris membuang backslash **dan** newline, sehingga potongan-potongan itu
menjadi SATU perintah. Biasakan menulis **spasi sebelum** `\`. Prompt lanjutan bisa
diubah lewat env `PROMPT2`. Batasnya 128 sambungan.

---

## 3. Argumen dan variabel

```sh
echo "Skrip      : $0"
echo "Argumen ke-1: $1"
echo "Jumlah arg : $#"
echo "Semua arg  : $@"
```

| Bentuk | Arti |
| --- | --- |
| `$0` | Path skrip |
| `$1` … `$9`, `$10` | Argumen posisional |
| `$#` | Jumlah argumen |
| `$@`, `$*` | Semua argumen (di `for`, ini **dipecah per argumen**) |
| `$?` | Exit code perintah terakhir |
| `${VAR}` / `$VAR` | Variabel environment |

Variabel di TSIX adalah **environment process** (`export`-style), jadi otomatis diwarisi
perintah yang di-spawn:

```sh
export BACKUP_DIR=/mnt/sbak/daily     # eksplisit
COUNTER=0                             # tanpa 'export' juga tersimpan
COUNTER=$(expr $COUNTER + 1)
LANG=C sort /etc/hosts                # VAR=nilai di depan perintah (bentuk prefix)
```

`/etc/profile` (system-wide) dan `~/.tsixrc` (per-user) di-source saat shell start.
Keduanya hanya mengenali baris `export NAME=VALUE` dan `echo ...`.

---

## 4. Ekspansi kata

| Bentuk | Hasil |
| --- | --- |
| `'teks apa pun'` | Literal total — `$`, `\`, dan `"` bukan apa-apa |
| `"teks $VAR"` | Variabel & `$(...)` di-expand, spasi tetap satu kata |
| `\$VAR` | Literal `$VAR` |
| `\\$VAR` | `\` diikuti **nilai** `$VAR` |
| `$(perintah)` | Substitusi perintah (lihat [gotcha 10.1](#101-substitusi-perintah--hanya-menangkap-output-builtin)) |
| `~`, `~/dir` | Direktori home |
| `*` | Wildcard (di-glob ke daftar berkas) |
| `{1..5}`, `{a..e}` | Range — **hanya** di dalam `for ... in` (lihat bagian 6) |

Ekspansi dilakukan **satu pass**, jadi kutip dan escape dievaluasi bersamaan:

```sh
SECRET='$HOME rahasia'
echo "$SECRET"      # -> $HOME rahasia   (tidak ada variabel yang di-expand)
echo "nilai: \$HOME"   # -> nilai: $HOME
echo "nilai: \\$HOME"  # -> nilai: \/root
```

---

## 5. Kondisi: `if` / `elif` / `else`

```sh
if [ "$1" = "admin" ]; then
    echo "[IF] mode admin"
elif [ "$1" = "guest" ]; then
    echo "[ELIF] mode guest"
else
    echo "[ELSE] mode standar"
fi
```

Format `if [ ... ]; then` dan `if [ ... ]` + `then` di baris berikutnya keduanya jalan.
`[ ... ]` dan `test ...` setara.

### Operator yang didukung

| Jenis | Operator | Catatan |
| --- | --- | --- |
| String | `=`, `==`, `!=` | Bandingkan dengan operand di kutip: `[ "$X" = "y" ]` |
| Bilangan | `-gt`, `-lt`, `-ge`, `-le`, `-eq`, `-ne` | Kedua operand **harus** angka; kalau tidak, hasilnya `false` |
| Berkas | `-e`, `-f`, `-d`, `-r`, `-w`, `-x` | `-f` = file, `-d` = direktori, `-r/-w/-x` = permission |
| String kosong | `-z` (kosong), `-n` (tidak kosong) | |
| Non-kosong | `[ "$X" ]` | Benar bila `$X` tidak kosong |

Kondisi bisa juga berupa **perintah apa pun** — dinilai dari `$?`:

```sh
if ping 10.0.0.1 1; then
    echo "node hidup"
fi
```

> Perhatikan sintaks `ping`: jumlah paket adalah argumen **posisional**
> (`ping <host> [count]`), bukan `-c` seperti iputils di Linux. Karena itu biasakan
> memeriksa `--help` tiap utilitas: TSIX mengikuti gaya Unix, tapi tidak selalu sama
> flag-nya.

Kondisi majemuk pakai `&&`/`||` dengan short-circuit:

```sh
if [ -d /mnt/sbak ] && [ -w /mnt/sbak ]; then
    echo "siap dipakai"
fi
```

> **Tidak ada** `[[ ... ]]`, `!`, `=~`, dan `-a`/`-o`. Untuk negasi, tukar bloknya:
> `if [ ... ]; then :; else echo "tidak cocok"; fi`.

---

## 6. Perulangan

### `for ... in`

```sh
for SERVICE in web-server database cache-redis; do
    echo " -> starting $SERVICE"
done

for ARG in $@; do              # tiap argumen skrip
    echo "arg: $ARG"
done

for F in /bin/*.js; do         # wildcard (di-glob lebih dulu)
    echo "bin: $F"
done

for N in {1..5}; do            # range angka: 1 2 3 4 5
    echo "iterasi $N"
done

for CH in {a..e}; do           # range huruf
    echo "$CH"
done
```

### `while`

```sh
COUNTER=3
while [ $COUNTER -gt 0 ]; do
    echo "countdown: $COUNTER"
    COUNTER=$(expr $COUNTER - 1)
done
```

`while true; do ... done` juga jalan (kondisi diperiksa dari `$?` perintah `true`).

> **Tidak ada** `until`, `break`, dan `continue`. Cara mengakali: pakai variabel
> penanda + `if` di dalam loop, atau pecah loop menjadi dua tahap di skrip terpisah.

---

## 7. `case ... esac`

```sh
case "$1" in
    start)
        echo "menyalakan"
        ;;
    stop|restart|reload)
        echo "kontrol service: $1"
        ;;
    *.log)
        echo "ini berkas log"
        ;;
    *)
        echo "pemakaian: $0 {start|stop|*.log}"
        ;;
esac
```

Pola mendukung `*`, `?`, dan `[...]`, serta alternatif dengan `|`. Percabangan boleh
ditulis rata (`pat) perintah ;;`) maupun multi-baris.

---

## 8. Pipeline, redirection, dan background

```sh
cat /var/log/syslog | grep ERROR | tail -n 20
echo "Baris 1"  > /tmp/out.txt      # timpa
echo "Baris 2" >> /tmp/out.txt      # tambahkan
/sbin/crond.js &                    # background
```

> `tail` memakai `-n <jumlah>` (bukan `tail -20`). `-f` (follow) dan `-s <detik>` juga
> tersedia; periksa `tail --help` untuk daftar lengkapnya.

| Fitur | Status |
| --- | --- |
| `\|` (pipeline) | Didukung — pipe nyata di kernel, proses berjalan paralel |
| `>` dan `>>` | Didukung |
| `&` (background, di akhir perintah) | Didukung |
| `<`, `2>`, `&>`, `2>&1` | **Tidak ada** — hanya stdout yang bisa diarahkan |
| `\|&` | **Tidak ada** |

Catatan `&`: skrip yang dijalankan background di-spawn sebagai **subshell** (`tsh skrip.sh &`),
jadi `cd`/`export` di dalamnya tidak mempengaruhi shell pemanggil.

---

## 9. Builtin shell

Builtin berjalan **di dalam** proses shell (tanpa spawn worker baru) — ini yang membuat
skrip dengan puluhan `echo` tetap ringan.

| Builtin | Keterangan |
| --- | --- |
| `echo [-n] teks` | `echo ""` mencetak satu baris kosong, `-n` tanpa newline |
| `cd <dir>` | Ganti direktori (tanpa argumen → `/`) |
| `pwd` | Cetak direktori kerja |
| `export NAME=VALUE` | Set variabel environment |
| `read [-p prompt] [VAR]` | Baca satu baris dari input (default `REPLY`; beberapa nama = dipecah per kata) |
| `waitfile <path> [ms]` | Tunggu berkas muncul (default 10000 ms) — pengganti polling manual |
| `expr <n> <op> <n>` | `+`, `-`, `*`, `/`, `%` (bilangan bulat) |
| `true`, `false`, `:` | Penanda exit code |
| `history [--clear]` | Riwayat perintah (tanpa duplikat) |
| `help`, `version` | Bantuan dan versi shell |
| `exit` | Keluar — di dalam skrip, sisa baris tidak dijalankan |

Modifier `*perintah` mengukur waktu eksekusi:

```sh
*ping 10.0.0.1 3
# ...output...
# Time execution: 3012ms.
```

---

## 10. Jebakan yang perlu diketahui

### 10.1 Substitusi perintah — hanya menangkap output **builtin**

```sh
COUNT=$(expr $COUNT + 1)     # BENAR (expr = builtin)
VER=$(version)               # BENAR (builtin)
FILES=$(cat /tmp/list.txt)   # KOSONG! cat adalah binary eksternal
```

Binary eksternal mencetak **langsung ke TTY**, jadi hasilnya tidak bisa ditangkap. Yang
bisa ditangkap: builtin shell dan `expr` di dalam `$(...)`. Untuk data dari proses lain,
tulis dulu ke berkas lalu olah dengan perintah berikutnya (atau kirim lewat IPC).

### 10.2 Peringatan perintah lama di dalam skrip

Kalau sebuah perintah di dalam skrip berjalan lebih dari 15 detik, shell mencetak
peringatan ke layar:

```
tsh: '/bin/login.js' masih berjalan setelah 15s - kalau ini daemon, pastikan ia
     men-daemonize sendiri atau jalankan dengan '&'; kalau perintah interaktif
     (mis. /bin/login.js), jangan dipakai di dalam skrip.
```

Ini menutup jebakan paling mahal saat boot: satu perintah interaktif membuat skrip
menggantung, dan **semua baris sesudahnya tidak pernah dijalankan** tanpa pesan apa pun.
Ambang diatur lewat env `TSH_WAIT_HINT_MS` (0 = matikan); lihat juga builtin `waitfile`.

### 10.3 Batas dan exit code

| Kejadian | Hasil |
| --- | --- |
| Skrip bersarang terlalu dalam | maksimum 16 level |
| Sambung baris berlebihan | maksimum 128 |
| Bit `x` tidak ada | pesan `Permission denied`, `$?` = 126 |
| Perintah tidak ditemukan | `command not found`, `$?` = 127 |
| `exit` di dalam skrip | menghentikan sisa baris skrip |

### 10.4 Yang tidak ada (dan penggantinya)

| Tidak ada | Pengganti |
| --- | --- |
| Fungsi (`nama() { }`) | Pisahkan ke skrip lain, panggil `./skrip.sh` |
| Backtick `` `cmd` `` | Pakai `$(cmd)` |
| `[[ ... ]]`, `!`, `=~` | `[ ... ]` + tukar blok `then`/`else` |
| `until`, `break`, `continue` | Variabel penanda + `if` |
| `set -e` | Rantai `cmd \|\| exit 1` atau `cmd && cmd` |
| `[[ ... ]]` array / `local` | Variabel environment biasa |
| `<`, `2>`, `&>` | Hanya stdout (`>`, `>>`) |
| `$!`, `$$`, `$RANDOM` | Tidak ada; ambil PID dari output `exec`/`&` |

---

## 11. Contoh lengkap

Skrip asli di repo yang bisa dijadikan acuan:

| Berkas | Isi |
| --- | --- |
| `scripts/test/fixtures/sample-script.sh` | Semua fitur utama: argumen, if/elif, for, while, case, read, pipe, redirection, wildcard |
| `src/mirror/var/tsd/packages/checker.sh` | Contoh paling sederhana (shebang `#!/usr/bin/env sh`) |
| `/etc/rc.local` | Skrip boot (`#!/bin/tsh`) — dijalankan `init` setiap boot |

Pola yang sering dipakai:

```sh
#!/bin/tsh
# Menyalakan daemon, lalu menunggu kesiapannya.

# Mount tetap (persisten) berasal dari /etc/fstab.conf — satu-satunya sumber
# kebenaran mount, jadi skrip cukup MEMERIKSA, bukan me-mount ulang.
if [ -d /mnt/sbak ]; then
    echo "[OK]   /mnt/sbak siap"
else
    echo "[FAIL] /mnt/sbak tidak ter-mount (lihat /etc/fstab.conf)"
    exit 1
fi

/opt/dome/dome.js &
waitfile /var/run/dome.ready 10000

echo "[OK]   dome siap"
exit 0
```

### Menguji skrip tanpa boot TSIX

```sh
node -r esbuild-register -r tsconfig-paths/register \
  scripts/test/tsh-script-harness.ts scripts/test/fixtures/sample-script.sh admin 123
```

Harness ini menyediakan std/fs/shell tiruan, tetapi **fd-nya nyata** — jadi `>` dan `>>`
benar-benar menulis berkas. Cara paling cepat untuk menguji perubahan skrip.

---

## 12. Aturan encoding, emotikon, dan berkas biner

Tulis skrip dan pesan log dalam **ASCII**. Ini bukan soal selera:

- Isi VFS disimpan sebagai **byte** (1 char = 1 byte). Karakter di luar ASCII melewati
  lebih banyak lapisan konversi, dan setiap lapisan adalah kesempatan untuk salah —
  sudah terbukti menghasilkan beberapa bug senyap (glyph terpotong, BOM menjadi byte
  `0xFF`, mojibake di konsumen teks).
- Konsol berbeda-beda memperlakukan non-ASCII secara berbeda (Windows cp1252 vs UTF-8),
  jadi log dengan emoji menghasilkan keluaran yang tidak bisa diprediksi atau di-parse.
- Gunakan penanda ASCII yang konsisten: `[OK]`, `[FAIL]`, `[WARN]`, `[SKIP]`, `->`.

```sh
# BENAR
echo "[OK]   dome siap"

# HINDARI
echo "[OK] dome siap"     # emoji/box-drawing di skrip: rapuh di lintas platform
```

Bila skrip memang harus menangani berkas non-ASCII (mis. membaca `.menu` aplikasi yang
berisi ikon), ingat bahwa **isi berkas adalah byte** dan harus didekode eksplisit di
dalam program TSIX — lihat bagian "Isi VFS = BYTE" di
[Virtual-File-System.md](Virtual-File-System.md).

Catatan `cat`: `cat` sengaja **byte-transparan**, sehingga `cat berkas > salinan` selalu
menyalin byte dengan tepat (berkas biner pun aman). Konsekuensinya, menampilkan berkas
non-ASCII di TTY apa adanya akan terlihat sebagai byte mentah.

---

## 13. Tips interaktif

| Fitur | Cara pakai |
| --- | --- |
| Completion perintah & berkas | `TAB` (dua kali untuk daftar, panah/TAB untuk memilih) |
| Riwayat | Panah atas/bawah; duplikat dibuang otomatis |
| Hapus seluruh baris | `Ctrl+U` |
| Batalkan perintah | `Ctrl+C` |
| Perintah multi-baris | Akhiri baris dengan `\` lalu Enter |
| Waktu eksekusi | Awali perintah dengan `*` |
| Format prompt | Env `PROMPT_FORMAT` (`&username`, `&hostname`, `&cwd`, `&usertype`) |
| Prompt lanjutan | Env `PROMPT2` |

---

## Lihat juga

- [fhs.md](fhs.md) — tata letak direktori dan isi `/bin`, `/sbin`, `/usr/bin`
- [Virtual-File-System.md](Virtual-File-System.md) — aturan "isi VFS = byte" dan cara membaca berkas teks
- [Kernel-dan-Scheduler.md](Kernel-dan-Scheduler.md) — PID, signal, dan `waitpid`
- [Panduan-Developer.md](Panduan-Developer.md) — alur kerja pengembangan & uji
- `src/mirror/lib/ShellScript.ts` — parser murni (unit test: `ShellScript.test.ts`)
