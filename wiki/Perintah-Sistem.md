# 🔧 Perintah Sistem

TSIX menyediakan **80+ perintah** yang meniru command-line Linux, semuanya terletak di `/bin/`.

---

## File & Directory Operations

| Perintah | Syntax | Deskripsi |
|----------|--------|-----------|
| `ls` | `ls [-la] [path]` | List isi direktori (support `-a` hidden files, `-l` detail) |
| `cat` | `cat <file>` | Tampilkan isi file |
| `cp` | `cp <src> <dst>` | Copy file |
| `mv` | `mv <src> <dst>` | Pindah/rename file |
| `rm` | `rm [-r] <path>` | Hapus file (atau direktori dengan `-r`) |
| `mkdir` | `mkdir <dir>` | Buat direktori baru |
| `find` | `find <path> [-name pattern]` | Cari file berdasarkan pattern |
| `head` | `head [-n N] <file>` | Tampilkan N baris pertama |
| `tail` | `tail [-n N] <file>` | Tampilkan N baris terakhir |
| `wc` | `wc <file>` | Hitung baris, kata, dan byte |
| `sort` | `sort <file>` | Urutkan baris dalam file |
| `grep` | `grep [-in] <pattern> <file>` | Cari pattern dalam file (support `-n` line numbers) |
| `xxd` | `xxd <file>` | Hex dump isi file |

---

## Navigation & Info

| Perintah | Syntax | Deskripsi |
|----------|--------|-----------|
| `pwd` | `pwd` | Tampilkan working directory saat ini |
| `cd` | `cd <path>` | Pindah direktori (built-in shell) |
| `clear` | `clear` | Bersihkan layar terminal |

---

## Text Viewing & Editing

| Perintah | Syntax | Deskripsi |
|----------|--------|-----------|
| `less` | `less <file>` | Interactive pager (scroll up/down, search) |
| `more` | `more <file>` | Basic pager (scroll forward) |
| `atto` | `atto <file>` | Full-screen text editor (nano-like) |

---

## User & Permission Management

| Perintah | Syntax | Deskripsi |
|----------|--------|-----------|
| `whoami` | `whoami` | Tampilkan username saat ini |
| `id` | `id [user]` | Tampilkan UID, GID, dan groups |
| `users` | `users` | List semua user yang login |
| `groups` | `groups [user]` | Tampilkan keanggotaan group |
| `useradd` | `useradd <username>` | Buat user baru (root only) |
| `usermod` | `usermod <options> <user>` | Modifikasi user account |
| `passwd` | `passwd [user]` | Ubah password |
| `chmod` | `chmod <mode> <path>` | Ubah permission (octal) |
| `chown` | `chown <owner>[:group] <path>` | Ubah owner/group |
| `sudo` | `sudo <command>` | Jalankan command sebagai root |
| `login` | `login` | Login ke system / switch user |

---

## Process Management

| Perintah | Syntax | Deskripsi |
|----------|--------|-----------|
| `ps` | `ps` | List semua proses aktif |
| `kill` | `kill [-9\|-15] <pid>` | Kirim signal ke proses |
| `sleep` | `sleep <seconds>` | Pause selama N detik |
| `uptime` | `uptime` | Waktu sistem sudah berjalan |

---

## System Information

| Perintah | Syntax | Deskripsi |
|----------|--------|-----------|
| `uname` | `uname [-a]` | Info kernel & distro |
| `df` | `df` | Penggunaan disk / VFS usage |
| `lsblk` | `lsblk` | List block devices & mount points |
| `mount` | `mount [-t type] <src> <dst>` | Mount filesystem |
| `umount` | `umount <path>` | Unmount filesystem |
| `history` | `history` | Tampilkan command history |

---

## Networking

| Perintah | Syntax | Deskripsi |
|----------|--------|-----------|
| `ifconfig` | `ifconfig` | Status interface network |
| `ping` | `ping <node>` | Cek konektivitas ke node lain |
| `nmap` | `nmap <node>` | Scan port terbuka |
| `nettop` | `nettop` | Monitor traffic real-time |
| `airterm` | `airterm <node>` | Remote terminal (SSH-like) |
| `scp` | `scp <src> <node>:<dst>` | Secure file copy antar-node |
| `forward` | `forward <options>` | Port forwarding |
| `listen_net` | `listen_net <port>` | Listen incoming packets |
| `ssh-keygen` | `ssh-keygen` | Generate RSA key pair |

---

## Package Management

| Perintah | Syntax | Deskripsi |
|----------|--------|-----------|
| `tpkg` | `tpkg <command> [pkg]` | Package manager utama |
| `tpkg-setup` | `tpkg-setup` | Setup repository |
| `apply-update` | `apply-update` | Apply pending system updates |

---

## System Control

| Perintah | Syntax | Deskripsi |
|----------|--------|-----------|
| `shutdown` | `shutdown [-h\|-r]` | Matikan atau restart sistem |
| `reboot` | `reboot` | Restart sistem |
| `chvt` | `chvt <N>` | Switch ke virtual terminal N |
| `init` | — | Init process (PID 1, internal) |

---

## Development & Build

| Perintah | Syntax | Deskripsi |
|----------|--------|-----------|
| `tbuild` | `tbuild <file>` | Build TypeScript ke JavaScript (via esbuild) |
| `vfs-pull` | `vfs-pull` | Sync VFS → Host filesystem |
| `bkfs` | `bkfs <options>` | Direct BKFS inspection tool |
| `sys-diag` | `sys-diag` | System diagnostics |

---

## IoT & Hardware

| Perintah | Syntax | Deskripsi |
|----------|--------|-----------|
| `esp32-demo` | `esp32-demo` | Demo ESP32 integration |
| `test-uart` | `test-uart` | Test serial/UART komunikasi |
| `test-mcp23017` | `test-mcp23017` | Test MCP23017 I2C GPIO expander |
| `iot-listener` | `iot-listener` | Listen IoT data stream |

---

## IPC & Communication

| Perintah | Syntax | Deskripsi |
|----------|--------|-----------|
| `ipc-send` | `ipc-send <target> <msg>` | Kirim IPC message ke proses lain |
| `ipc-listen` | `ipc-listen` | Listen IPC messages |

---

## Daemon Services

| Daemon | Deskripsi |
|--------|-----------|
| `airtermd` | Remote terminal daemon (server-side `airterm`) |
| `scpd` | SCP daemon (menerima file transfer) |
| `tpkgd` | Package daemon (serve package repository) |
| `tde-server` | TDE (TSIX Desktop Environment) server |

---

## Shell Features

Shell TSIX (`tsh.ts`) mendukung fitur-fitur standar:

| Fitur | Contoh | Deskripsi |
|-------|--------|-----------|
| **Pipe** | `cat file \| grep pattern` | Chain output → input |
| **Redirect** | `ls > output.txt` | Redirect stdout ke file |
| **Append** | `echo text >> log.txt` | Append ke file |
| **Background** | `sleep 10 &` | Jalankan di background |
| **History** | `history` / ↑↓ | Command history |
| **Tab Completion** | `ls /e<TAB>` | Auto-complete path |
| **Environment Vars** | `$HOME`, `$PATH` | Variabel environment |

---

**Halaman selanjutnya:** [📦 Package Manager (TPKG)](Package-Manager-TPKG.md)
