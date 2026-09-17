#!/bin/tsh
# Fixture smoke test: membuktikan builtin `waitfile` timeout dengan pesan jelas
# DAN skrip tetap lanjut ke baris berikutnya (tanpa `set -e`).
waitfile /tmp/tidak-pernah-ada 300
version
