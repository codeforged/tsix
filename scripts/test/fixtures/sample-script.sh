#!/bin/tsh
# ==============================================================================
# SAMPLE TEST SCRIPT UNTUK TSH (TSIX SHELL)
# ==============================================================================
# Menguji: Shebang, Komentar, Parameter ($0, $1, $#, $@), Variables, If/Elif/Else,
# For Loop, While Loop, Case Statement, Read Builtin, Piping, Redirection, Wildcards, dan Builtin Commands.
#
# Jalankan tanpa boot TSIX:
#   node -r esbuild-register -r tsconfig-paths/register \
#     scripts/test/tsh-script-harness.ts scripts/test/fixtures/sample-script.sh admin 123
# ==============================================================================

echo "=========================================="
echo " 1. PENGUJIAN PARAMETER & ARGUMEN SKRIP"
echo "=========================================="
echo "Nama Skrip (\$0) : $0"
echo "Jumlah Argumen (\$#): $#"
echo "Argumen 1 (\$1)   : $1"
echo "Argumen 2 (\$2)   : $2"
echo "Semua Arg (\$@)   : $@"
echo ""

echo "=========================================="
echo " 2. PENGUJIAN KONDISIONAL (IF / ELIF / ELSE)"
echo "=========================================="
if [ "$1" = "admin" ]; then
    echo "[IF] User diset sebagai admin!"
elif [ "$1" = "guest" ]; then
    echo "[ELIF] User diset sebagai guest."
else
    echo "[ELSE] User diset sebagai mode umum / standar."
fi
echo ""

echo "=========================================="
echo " 3. PENGUJIAN PERULANGAN FOR LOOP"
echo "=========================================="
echo "Iterasi daftar item statis & variabel:"
for SERVICE in web-server database cache-redis; do
    echo " -> Starting service: $SERVICE..."
done
echo ""

echo "=========================================="
echo " 4. PENGUJIAN PERULANGAN WHILE LOOP"
echo "=========================================="
COUNTER=3
echo "Hitung mundur (While):"
while [ $COUNTER -gt 0 ]; do
    echo " Countdown: $COUNTER"
    COUNTER=$(expr $COUNTER - 1)
done
echo " Boom! Selesai loop."
echo ""

echo "=========================================="
echo " 5. PENGUJIAN PIPELINE (|) & REDIRECTION (>)"
echo "=========================================="
echo "Menulis output log ke file temp..."
echo "Baris 1: TSIX OS" > /tmp/test_output.txt
echo "Baris 2: Tsh Shell" >> /tmp/test_output.txt
echo "Baris 3: ShellScript Engine" >> /tmp/test_output.txt

echo "Membaca file yang ditulis:"
cat /tmp/test_output.txt
echo ""

echo "=========================================="
echo " 6. PENGUJIAN BUILTIN & WILDCARD (*)"
echo "=========================================="
echo "Lokasi direktori saat ini:"
cd /
echo "Cek isi direktori root dengan wildcard /b*:"
echo /b*
cd ~

echo ""
echo "=========================================="
echo " 7. PENGUJIAN READ & CASE STATEMENT"
echo "=========================================="
# `read` membaca satu baris input dari user dan menyimpan ke variabel.
# Di mode non-interaktif (test harness), input langsung EOF → variabel kosong.
read -p "Masukkan pilihan (1/2/3): " PILIHAN

case $PILIHAN in
    1)
        echo " -> Opsi 1: Cek Kuota";;
    2)
        echo " -> Opsi 2: Isi Pulsa";;
    3)
        echo " -> Opsi 3: Keluar";;
    *)
        echo " -> Opsi tidak valid";;
esac

echo ""
echo "=========================================="
echo " SEMUA PENGUJIAN SELESAI DENGAN SUKSES!"
echo "=========================================="
