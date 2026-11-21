/**
 * FSTAB FRESH — templat `/etc/fstab.conf` untuk instalasi baru.
 *
 * Dipisah dari `scripts/install.ts` supaya bisa diuji: formatnya divalidasi
 * `FstabParser.test.ts` (A4.09) — templat harus diurai TANPA PERINGATAN, jadi
 * salah tulis di sini ketahuan sebelum sempat masuk image.
 *
 * Isi sengaja hanya mount ESENSIAL:
 *   /tmp      → ramfs (sticky) — berkas sementara
 *   /var/run  → ramfs — state runtime (marker/PID) WAJIB volatile. Kalau ikut
 *               persisten, marker seperti `/var/run/dome.ready` dari boot
 *               sebelumnya terbaca "sudah siap" → dependen-nya (Asteracea) jalan
 *               sebelum DOME hidup dan gagal. Linux memakai tmpfs untuk `/run`
 *               dengan alasan yang sama.
 *
 * Mount khusus perangkat (`/mnt/shared`, `/mnt/sbak`, netfs) TIDAK dibawa —
 * itu milik node masing-masing dan ditambahkan admin.
 *
 * (c) 2026 TSIX Project
 */
export const FRESH_FSTAB_INI = `# /etc/fstab.conf — dibuat installer (image fresh)
#
# Satu [mount-point] per mount, isinya pasangan \`key = value\`.
#   - mode : oktal eksplisit (\`0o755\`), atau desimal seperti fstab.json lama
#            (509 = 0o775). Nilai telanjang > 0o777 akan diberi peringatan boot.
#   - type : ramfs | host | bkfs | netfs
#   - format .json lama tetap dibaca kalau berkas .conf ini tidak ada.

# /tmp → ramfs (sticky) — berkas sementara
[/tmp]
hostPath = RAM
type     = ramfs
uid      = 0
gid      = 100
mode     = 0o1777
active   = true

# /var/run → ramfs — state runtime (marker/PID) WAJIB volatile: kalau ikut
# persisten, marker seperti /var/run/dome.ready dari boot sebelumnya terbaca
# "sudah siap" sehingga Asteracea jalan sebelum DOME hidup.
[/var/run]
hostPath = RAM
type     = ramfs
uid      = 0
gid      = 0
mode     = 0o755
active   = true
`;
