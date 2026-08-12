# Developer Guide: Building Kernel Devices & Syscalls

Dokumen ini menjelaskan alur "Everything is a File" di TSIX, mulai dari pembuatan driver hingga manajemen hak akses.

> [!IMPORTANT]
> **Golden Rule**: Jangan pernah memodifikasi `Kernel.ts` atau `Syscalls.ts` hanya untuk menambah device baru. Gunakan folder `aux-devices` agar kernel tetap bersih dan stabil.

---

## 1. Implementasi Driver (`IDevice`)

Setiap hardware/layanan virtual harus mengimplementasikan interface `IDevice`.

**Lokasi File**: `src/kernel/devices/aux-devices/NamaDevice.ts`

```typescript
import { IDevice } from "../IDevice";

export default class MyNewDevice implements IDevice {
    // METADATA (Hak Akses)
    public name: string = "mydevice";  // Nama device (akan menjadi /dev/mydevice)
    public uid: number = 0;       // Owner (Default: root)
    public gid: number = 0;       // Group (Default: root)
    public mode: number = 0o600;  // Permissions (Default: rw-------)

    private buffer: string = "";

    public read(offset?: number, length?: number): any {
        return this.buffer;
    }

    public write(data: any): boolean {
        this.buffer = data;
        return true;
    }

    public ioctl(cmd: number, arg: any): any {
        // Digunakan untuk perintah spesifik diluar read/write
        switch (cmd) {
            case 1: // Contoh: RESET_BUFFER
                this.buffer = "";
                return "Buffer Cleared";
            case 2: // Contoh: SET_CONFIG
                const config = arg as { prefix: string };
                this.buffer = config.prefix + this.buffer;
                return true;
            case 3: // Contoh: GET_STATUS
                return { size: this.buffer.length, ready: true };
            default:
                throw new Error("Invalid IOCTL command");
        }
    }
}
```

---

## 2. Menggunakan IOCTL (Input/Output Control)

`ioctl` adalah cara paling fleksibel untuk mengirim dan menerima data kompleks lewat satu pintu.

### Di Sisi App (User-Land)
Anda bisa memanggil fungsi `ioctl` melalui `lib.std.ioctl`:

```typescript
// Contoh: Memanggil perintah 3 (GET_STATUS)
const status = await lib.std.ioctl(fd, 3, null);
console.log(`Size: ${status.size}, Ready: ${status.ready}`);

// Contoh: Mengirim data objek ke driver (SET_CONFIG)
await lib.std.ioctl(fd, 2, { prefix: "[LOG] " });
```

---

## 3. Pendaftaran & Jenis Device

TSIX membagi device menjadi dua kategori utama:

### A. Core Devices (Standard)
Device yang sangat krusial bagi nyawa OS (HAL Utama). Didaftarkan langsung di dalam `Kernel.ts`.
*   `/dev/stdin`, `/dev/stdout`, `/dev/stderr`: Default I/O yang biasanya di-alias ke TTY aktif.
*   `/dev/null`: Black hole untuk pembuangan data.
*   `/dev/fb0`: Framebuffer (layar virtual), biasanya alias ke TTY1.
*   `/dev/tty[1-6]`: Virtual Consoles. TSIX mendukung hingga 6 terminal terisolasi.
*   `/dev/smqtnl*`: Virtual Network Interfaces berbasis MQTT.

### B. Auxiliary Devices (Plugins)
TSIX memiliki sistem **Auxiliary Devices** yang otomatis memuat driver tanpa edit core kernel:
1.  Kernel akan memindai folder `src/kernel/devices/aux-devices/` saat boot.
2.  Nama file akan menjadi nama device (e.g., `RandomDevice.ts` -> `/dev/randomdevice`).
3.  Kernel secara otomatis menangani syscall standar (OPEN, READ, WRITE, STAT, LS) untuk device ini.

---

## 3. Manajemen Hak Akses (Permissions)

TSIX menggunakan model permission POSIX untuk device. Tidak perlu lagi nge-hardcode `if (pcb.uid !== 0)` di dalam syscall.

### Melalui Kode (Default)
Set properti `uid`, `gid`, dan `mode` di dalam class driver Anda (seperti contoh di Bagian 1).

### Melalui CLI (Runtime)
Setelah kernel berjalan, root bisa mengubah kepemilikan dan izin akses menggunakan tool standar:

```bash
# Memberikan akses ke grup 'users' (GID 100)
sudo chown :users /dev/randomdevice

# Memberikan izin baca/tulis ke grup (rw-rw----)
sudo chmod 660 /dev/randomdevice
```

Sistem `PermissionManager` (Satpam) akan otomatis memvalidasi setiap proses yang mencoba membuka device tersebut berdasarkan identitasnya.

---

## 4. Akses dari User-Land

### Menggunakan Raw Syscall (C Mode)
Aplikasi bisa langsung memanggil `lib.fs.open()`:

```typescript
const fd = await lib.fs.open("/dev/randomdevice", "r");
const data = await lib.fs.read(fd);
await lib.fs.close(fd);
```

### Membuat Library API (Recommended)
Agar developer aplikasi tidak perlu pusing dengan FD (file descriptor) atau nomor perintah `ioctl`, buatlah class wrapper di `src/root/lib/`. 

Contoh: `src/root/lib/MyServiceLib.ts`
```typescript
import { FsLib, StdLib } from "./UserLib";

export class MyServiceLib {
    constructor(private fs: FsLib, private std: StdLib) {}

    /**
     * Mengambil status device secara elegan
     */
    public async getStatus() {
        const fd = await this.fs.open("/dev/mydevice", "r");
        if (fd < 0) throw new Error("Device not found");
        
        // Membungkus IOCTL perintah 3 (GET_STATUS)
        const status = await this.std.ioctl(fd, 3, null);
        await this.fs.close(fd);
        return status;
    }

    /**
     * Reset device tanpa perlu tahu detail internal
     */
    public async reset() {
        const fd = await this.fs.open("/dev/mydevice", "w");
        if (fd < 0) return false;
        
        await this.std.ioctl(fd, 1, null); // RESET_BUFFER
        await this.fs.close(fd);
        return true;
    }
}
```

---

## 5. Contoh Penggunaan di Aplikasi
Aplikasi sekarang bisa memanggil device tersebut lewat "bahasa manusia".

**Lokasi**: `src/root/bin/myapp.ts`

```typescript
import { MyServiceLib } from "../lib/MyServiceLib";

export class main {
    async execute(lib: UserLib, args: string[]) {
        // Inisialisasi Library
        const myService = new MyServiceLib(lib.fs, lib.std);
        
        // Panggil fungsi API yang bersih
        await myService.reset();
        const status = await myService.getStatus();
        
        await lib.std.print(`Device Ready: ${status.ready}\n`);
    }
}
```

---

## 6. Virtual Consoles & TTY Devices

TSIX mensimulasikan terminal Linux dengan sistem **TTY (Teletype)**. Ini adalah device yang paling kompleks karena menangani dua mode: **Cooked** (default, dengan buffer & echo) dan **Raw** (langsung untuk TUI).

### Terminal Isolation
Setiap TTY (`/dev/tty1` sampai `/dev/tty6`) benar-benar terisolasi. 
*   Aplikasi di TTY1 tidak akan melihat input dari TTY2.
*   Output aplikasi dipaksa masuk ke TTY tempat proses tersebut dijalankan.

### I/O Redirection (The `EXEC` Magic)
Saat Anda menjalankan aplikasi melalui `EXEC` syscall, Kernel secara otomatis melakukan routing:
1.  Jika `ttyId` ditentukan (1-6), maka FD 0, 1, dan 2 (`stdin`, `stdout`, `stderr`) akan diarahkan ke device `/dev/ttyX` tersebut.
2.  Inilah alasan mengapa aplikasi `login` bisa muncul di banyak layar tanpa tabrakan teks.

### IOCTL Spesifik TTY
Developer aplikasi TUI (seperti Editor Teks) sering butuh info layar. Gunakan ioctl standar:
```typescript
// Mengambil ukuran terminal (TIOCGWINSZ)
const size = await lib.std.ioctl(fd, 0x5413, null); 
// Output: { rows: 24, cols: 80 }
```

---

## 7. Ringkasan Alur Kerja
1.  Buat file di `aux-devices/`.
2.  Tentukan default `mode` (misal `0o660` jika ingin bisa diakses grup).
3.  Akses langsung dari `/dev/` tanpa edit core kernel.

---

## 8. Model Keamanan & Sandboxing (The Jail)

Anda mungkin bertanya: *"Kalau saya buat script di dalam TSIX, apa dia bisa hapus file di Windows/Linux asli saya?"*

**Jawabannya: TIDAK BISA.** TSIX menerapkan sistem sandboxing berlapis:

1.  **VFS Confinement**: Semua syscall (`open`, `read`, `ls`, etc) dipaksa hanya melihat dunia di dalam `BKFS` (database SQLite). Kernel tidak menyediakan jalur ke modul Node.js `fs` asli untuk aplikasi User-Land.
2.  **Worker Isolation**: Setiap aplikasi berjalan di `Worker Thread` terpisah.
3.  **API Masking**: Sebelum aplikasi Anda berjalan, `WorkerEntry.ts` akan melakukan "operasi penyisiran":
    *   `require` diblokir (Anda tidak bisa `require('fs')` atau modul host lainnya).
    *   `process.env` dikosongkan (Anda tidak bisa melihat environment variable asli laptop Om).
    *   `process.exit` dan fungsi sensitif lainnya dideaktivasi.
4.  **Hardware Guard**: Akses ke `/dev/` dikawal ketat oleh `PermissionManager`. Tanpa hak akses `rw` yang sesuai, aplikasi akan terkena "Hadang Satpam" (Permission Denied).

**TSIX - Everything is a File, and everyone has their place.**

---

## 9. Troubleshooting & Kernel Traps

Pengembangan device atau daemon di area kernel rentan terhadap kesalahan silang lapisan (cross-layer traps), terutama yang berhubungan dengan Inter-Process Communication (IPC) antara Kernel dan User-Land. Berikut adalah daftar jebakan umum (seperti yang ditemukan pada implementasi _High-Speed Binary OTA_):

### 1. IPC Buffer Degradation (Siluman Biner)
Jalur komunikasi IPC di Node.js (antara Kernel dan Worker process daemon seperti `otad.ts`) akan "menelanjangi" protoype objek `Buffer` asli.
*   **Gejala:** Objek `Buffer` murni di driver berubah wujud menjadi format JSON string/object `{"type": "Buffer", "data": [0x52, ...]}` saat tiba di aplikasi User-Land. Properti semacam `.length` akan menghasilkan `undefined`.
*   **Solusi:** Terapkan rutinitas "Restorasi IPC Biner" (_Super Binary Distillery_) menggunakan kode:
    ```typescript
    if (payload && payload.type === "Buffer" && Array.isArray(payload.data)) {
        payload = Buffer.from(payload.data);
    }
    ```

### 2. Jebakan JSON Cleaner vs "String-Byte"
String yang ditransfer lewat IPC dapat mengacaukan skema enkripsi standar UTF-8 bawaan (khususnya untuk byte heksadesimal `>= 0x80` seperti `128` atau `32768`).
*   **Insiden Mengerikan:** Jika Anda mengirim 9-byte biner yang dienkoding sebagai string `"\x52\x00\x10\x00..."` ke daemon, lalu daemon menderita sindrom _JSON Parser Paranoia_ (yaitu menggunakan filter penghapus _null-byte_ seperti `.replace(/[\x00-\x1F\x7F]/g, '')`), semua nilai binernya akan musnah seketika (kecuali byte ASCII yang tercetak di layar)!
*   **Solusi Emas:** Jangan mencampuradukkan raw byte (offset, array, dsb) dalam bentuk untaian teks biasa yang berpotensi melintasi alat-bantu string Regex. Selalu terapkan **Fast-Path ASCII Protocol**, (contoh: buat string berarsitektur `"R 32768 4096"` alih-alih `[0x52, 0, 0x80...]`). ASCII murni tidak akan pernah dirusak oleh filter regex dasar maupun UTF-8.

### 3. Fragmentation Hazard (Terpotong di Jalan)
Library UDP/MQTT membatasi _Payload Maximum Transfer Unit_ (MTU) secara keras pada node mikrokontroler. 
*   **Gejala:** Mengirimkan paket berukuran gajah dari daemon (misal: membalas `4101` byte saat MTU MQTT/PubSubClient bernilai `4096`) akan memaksa Driver Kernel (seperti `SimpleMQTNLDriver.ts`) memangkas dan melemparnya dalam 2 fragmen (`4096` dan `5`). Jika target receiver (seperti ESP) tidak dibekali rakit-ulang paket logika reassembly, program perangkat keras akan bengong atau error (*out-of-sync*).
*   **Solusi:** Sinkronkan `chunk_length` tepat di bawah `BUFFER_SIZE` klien (misal 2048 atau 4096 byte).
