#!/bin/tsh
# Contoh skrip shell TSIX — dipakai oleh smoke test loader & uji fitur skrip.
# Baris komentar seperti ini harus DIABAIKAN oleh tsh.

# Argumen skrip: $0 = path skrip, $1.. = argumen, $# = jumlah argumen.
export GREETING=$1
export ALL_ARGS=$@
export ARG_COUNT=$#

# Sambung baris (`\`) juga berlaku DI DALAM skrip:
version \
  --dummy-arg

# echo true
