# 🚀 Memulai (Getting Started)

Panduan langkah demi langkah untuk menginstall, mengkonfigurasi, dan menjalankan TSIX.

---

## Prerequisites

| Software | Versi Minimum | Keterangan |
|----------|---------------|------------|
| **Node.js** | v18.x+ | Runtime engine |
| **NPM** | v8.x+ | Package manager |
| **Git** | Any | Untuk clone repository |

---

## Instalasi

### 1. Clone Repository

```bash
git clone https://github.com/andriansah/tsix.git
cd tsix
```

### 2. Install Dependencies

```bash
npm install
```

Dependencies utama yang akan terinstall:

| Package | Fungsi |
|---------|--------|
| `esbuild` + `esbuild-register` | Fast TypeScript transpilation (sub-100ms) |
| `better-sqlite3` | SQLite engine untuk BKFS |
| `mqtt` | MQTT client untuk MQTNL networking |
| `serialport` | Serial/UART communication (IoT) |
| `ws` | WebSocket support |
| `bcryptjs` | Password hashing |
| `uuid` | Unique ID generation |
| `i2c-bus` | I2C hardware communication |

### 3. Jalankan TSIX

**Linux/Mac:**
```bash
chmod +x bootstrap.sh
./bootstrap.sh
```

**Windows:**
```batch
bootstrap.bat
```

**Atau langsung via Node.js:**
```bash
npm start
```

---

## First Boot

Saat pertama kali dijalankan, TSIX akan:

```
--- POWER ON ---
[Kernel] Booting TSIX-Dinawari v0.0.1-alpha...
[Kernel] DEV MODE detected (src/__root/ exists)
[Kernel] Syncing host filesystem to VFS...
[Kernel] Loading auxiliary devices...
[Kernel] Initializing MQTNL network...
[Kernel] Spawning PID 1: init
[Init] Running /etc/rc.local...
[Init] Spawning login on TTY1...

Antigonon leptopus (TSIX-Dinawari)
login:
```

### Login Default

| Username | Password | UID |
|----------|----------|-----|
| `root` | `root` | 0 |

```
login: root
Password: root

Welcome to Antigonon leptopus!

root@antigonon:/# _
```

---

## Konfigurasi (`sysconfig.json`)

File konfigurasi utama di `src/sysconfig.json`:

### Kernel

```json
{
    "kernel": {
        "version": "0.0.1-alpha",
        "database": "system.db",
        "verbose": true,
        "distroName": "Antigonon leptopus",
        "engineName": "TSIX-Dinawari"
    }
}
```

### Logger

```json
{
    "logger": {
        "defaultLevel": "INFO",
        "logFile": "jsix.log",
        "enableConsole": false
    }
}
```

| Level | Deskripsi |
|-------|-----------|
| `DEBUG` | Semua log (verbose) |
| `INFO` | Informasi umum |
| `WARN` | Peringatan |
| `ERROR` | Error saja |

### Shell

```json
{
    "shell": {
        "defaultUser": "root",
        "defaultHostname": "antigonon",
        "promptFormat": "&username@&hostname:&cwd&usertype ",
        "defaultRows": 24,
        "defaultColumns": 80,
        "historyPath": "/.sh_history"
    }
}
```

### Network

```json
{
    "network": {
        "interfaces": [
            {
                "broker": "mqtt://192.168.0.109",
                "deviceName": "smqtnl0",
                "address": "antigonon",
                "defaultPort": 1883
            }
        ],
        "defaultDevice": "smqtnl0"
    }
}
```

> [!TIP]
> Ganti `broker` ke MQTT broker Anda sendiri, misalnya `mqtt://test.mosquitto.org` untuk testing via internet.

---

## Mode Operasi

### Development Mode

**Aktif** saat `src/__root/` ada.

- Edit kode di `src/__root/bin/` menggunakan VS Code
- Kernel auto-sync perubahan ke VFS saat boot
- Ideal untuk pengembangan aplikasi baru

### Production Mode

**Aktif** saat `src/__root/` tidak ada (rename ke `src/.root/`).

- Sistem berjalan murni dari `system.db`
- Tidak ada sync dari host filesystem
- Mimic perangkat IoT sesungguhnya

```bash
# Switch ke production mode
mv src/__root src/.__root

# Switch kembali ke dev mode
mv src/.__root src/__root
```

---

## Quick Commands

Setelah login, coba beberapa perintah:

```bash
# System info
uname -a

# List files
ls -la /

# Lihat proses
ps

# Buat file
echo "Hello" > /tmp/test.txt
cat /tmp/test.txt

# Lihat perintah yang tersedia
ls /bin

# Buka text editor
atto /tmp/note.txt

# Cek disk usage
df

# Lihat uptime
uptime

# Switch terminal
chvt 2

# Shutdown
shutdown -h
# atau
reboot
```

---

## Struktur File Penting

| File/Folder | Deskripsi |
|-------------|-----------|
| `src/main.ts` | Entry point — jangan dimodifikasi |
| `src/sysconfig.json` | Konfigurasi sistem |
| `src/__root/bin/` | Buat aplikasi baru disini |
| `src/__root/lib/` | Buat library disini |
| `src/__root/etc/` | Konfigurasi VFS (passwd, shadow, motd) |
| `system.db` | Database VFS — sumber kebenaran |
| `bootstrap.sh` | Script boot dengan reboot handling |
| `docs/` | Dokumentasi proyek |

---

## Troubleshooting

### Error: "env: 'node': No such file or directory"

Node.js tidak terinstall atau tidak ada di `$PATH`:
```bash
# Cek instalasi Node.js
node --version

# Install via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 18
```

### Error: "Cannot find module 'better-sqlite3'"

Jalankan install dependencies:
```bash
npm install
```

Jika masih error (native compilation):
```bash
npm rebuild better-sqlite3
```

### Sistem tidak responsif setelah boot

Cek log file:
```bash
cat jsix.log | tail -50
```

### Reset VFS ke default

Hapus database dan reboot:
```bash
rm system.db
./bootstrap.sh
```

> [!WARNING]
> Menghapus `system.db` akan menghilangkan semua data di VFS (termasuk file user, konfigurasi, dan package yang terinstall).

---

## Langkah Selanjutnya

- 📖 Baca [Panduan Developer](Panduan-Developer.md) untuk membuat aplikasi pertama Anda
- 🏗️ Pelajari [Arsitektur Sistem](Arsitektur-Sistem.md) untuk memahami internal TSIX
- 🌐 Explore [Networking MQTNL](Networking-MQTNL.md) untuk remote access & IoT

---

*TSIX — Everything is a File, and everyone has their place.*
