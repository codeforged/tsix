# 📖 Panduan Developer

Panduan lengkap untuk membuat aplikasi dan device driver baru di TSIX.

---

## Bagian A: Membuat Aplikasi User-Land

### Struktur Dasar

Setiap aplikasi TSIX adalah TypeScript module yang mengekspor class `main` dengan method `execute`:

```typescript
// Lokasi: src/__root/bin/myapp.ts
import { UserLib } from "../lib/UserLib";

export class main {
    async execute(lib: UserLib, args: string[]) {
        await lib.std.print("Hello from TSIX!\n");
        
        if (args.length > 0) {
            await lib.std.print(`Arguments: ${args.join(", ")}\n`);
        }
        
        return 0; // Exit code (0 = success)
    }
}
```

### Workflow Pengembangan

```mermaid
flowchart LR
    Write["1. Tulis .ts di src/__root/bin/"] --> Save["2. Simpan file"]
    Save --> Boot["3. Boot/Reboot TSIX"]
    Boot --> Sync["4. Kernel auto-sync ke VFS"]
    Sync --> Run["5. Ketik nama command di shell"]
```

1. **Buat file** `.ts` di `src/__root/bin/`
2. **Simpan** — di dev mode, kernel auto-sync saat boot
3. **Jalankan** di shell TSIX (tanpa ekstensi):
   ```bash
   root@antigonon:/# myapp arg1 arg2
   ```

---

## API Reference (`UserLib`)

### `lib.std` — Standard I/O

| Method | Signature | Deskripsi |
|--------|-----------|-----------|
| `print` | `print(text: string): Promise<void>` | Output ke terminal (stdout) |
| `read` | `read(): Promise<string>` | Baca input dari stdin |
| `ioctl` | `ioctl(fd: number, cmd: number, arg: any): Promise<any>` | Kontrol device |

### `lib.fs` — Filesystem

| Method | Signature | Deskripsi |
|--------|-----------|-----------|
| `open` | `open(path: string, flags: string): Promise<number>` | Buka file → FD |
| `read` | `read(fd: number): Promise<string>` | Baca dari FD |
| `write` | `write(fd: number, data: string): Promise<boolean>` | Tulis ke FD |
| `close` | `close(fd: number): Promise<void>` | Tutup FD |
| `ls` | `ls(path: string): Promise<DirEntry[]>` | List direktori |
| `stat` | `stat(path: string): Promise<FileStat>` | Metadata file |
| `mkdir` | `mkdir(path: string): Promise<boolean>` | Buat direktori |
| `unlink` | `unlink(path: string): Promise<boolean>` | Hapus file |
| `chmod` | `chmod(path: string, mode: number): Promise<boolean>` | Ubah permission |

### `lib.shell` — Process Management

| Method | Signature | Deskripsi |
|--------|-----------|-----------|
| `exec` | `exec(path: string, args: string[], env?: object, options?: object): Promise<number>` | Jalankan program → PID |
| `exit` | `exit(code: number): Promise<void>` | Keluar dari proses |
| `waitpid` | `waitpid(pid: number): Promise<ExitInfo>` | Tunggu proses selesai |
| `whoami` | `whoami(): Promise<UserInfo>` | Info user (UID, GID, username) |
| `uname` | `uname(): Promise<SystemInfo>` | Info sistem |
| `onSignal` | `onSignal(signal: string, callback: Function): void` | Register signal handler |

### `lib.net` — Networking

| Method | Signature | Deskripsi |
|--------|-----------|-----------|
| `ping` | `ping(target: string): Promise<PingResult>` | Ping node |
| `connect` | `connect(target: string, port: number): Promise<Connection>` | Buka koneksi |

---

## Contoh Aplikasi

### File Reader

```typescript
export class main {
    async execute(lib: UserLib, args: string[]) {
        if (args.length === 0) {
            await lib.std.print("Usage: readfile <path>\n");
            return 1;
        }
        
        const fd = await lib.fs.open(args[0], "r");
        if (fd < 0) {
            await lib.std.print(`Error: Cannot open ${args[0]}\n`);
            return 1;
        }
        
        const content = await lib.fs.read(fd);
        await lib.std.print(content);
        await lib.fs.close(fd);
        return 0;
    }
}
```

### Pipe-Compatible App

```typescript
export class main {
    async execute(lib: UserLib, args: string[]) {
        // Baca dari stdin (mungkin dari pipe)
        const input = await lib.std.read();
        const processed = input.toUpperCase();
        
        // Output ke stdout (bisa di-pipe lagi)
        await lib.std.print(processed);
        return 0;
    }
}
```

**Penggunaan:**
```bash
cat myfile.txt | myapp | grep "PENTING"
```

### Signal Handler (Graceful Shutdown)

```typescript
export class main {
    async execute(lib: UserLib, args: string[]) {
        const fd = await lib.fs.open("/tmp/data.lock", "w");
        
        // Register Ctrl+C handler
        lib.shell.onSignal("SIGINT", async () => {
            await lib.std.print("\n[CLEANUP] Closing file...\n");
            await lib.fs.close(fd);
            await lib.fs.unlink("/tmp/data.lock");
            await lib.shell.exit(130);
        });
        
        await lib.std.print("Running... Press Ctrl+C to stop.\n");
        
        while (true) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}
```

---

## Bagian B: Membuat Device Driver

### Anatomi Device

Setiap device harus mengimplementasikan interface `IDevice`:

```typescript
// Lokasi: src/kernel/devices/aux-devices/MyDevice.ts
import { IDevice } from "../IDevice";

export default class MyDevice implements IDevice {
    // Metadata & Permission
    public name: string = "mydevice";   // → /dev/mydevice
    public uid: number = 0;             // Owner: root
    public gid: number = 0;             // Group: root
    public mode: number = 0o600;        // rw------- 

    private buffer: string = "";

    public read(offset?: number, length?: number): any {
        return this.buffer;
    }

    public write(data: any): boolean {
        this.buffer = data;
        return true;
    }

    public ioctl(cmd: number, arg: any): any {
        switch (cmd) {
            case 1:  // RESET
                this.buffer = "";
                return "Buffer cleared";
            case 2:  // SET_CONFIG
                const config = arg as { prefix: string };
                this.buffer = config.prefix + this.buffer;
                return true;
            case 3:  // GET_STATUS
                return { size: this.buffer.length, ready: true };
            default:
                throw new Error("Invalid IOCTL command");
        }
    }
}
```

### Pendaftaran Otomatis

> [!IMPORTANT]
> **Jangan** edit `Kernel.ts` atau `Syscalls.ts` untuk menambah device baru! Cukup taruh file di `aux-devices/` dan kernel akan otomatis memuatnya saat boot.

```
src/kernel/devices/aux-devices/
├── MyDevice.ts       → /dev/mydevice
├── SensorDevice.ts   → /dev/sensordevice
└── LEDDevice.ts      → /dev/leddevice
```

### Jenis Device

| Kategori | Lokasi | Contoh |
|----------|--------|--------|
| **Core Devices** | Langsung di `Kernel.ts` | stdin, stdout, tty1-6, smqtnl0 |
| **Auxiliary Devices** | `aux-devices/` folder | randomdevice, custom sensors |

---

## Membuat Library Wrapper

Agar developer aplikasi tidak perlu berurusan dengan FD/ioctl, buat wrapper library:

```typescript
// Lokasi: src/__root/lib/MyServiceLib.ts
import { FsLib, StdLib } from "./UserLib";

export class MyServiceLib {
    constructor(private fs: FsLib, private std: StdLib) {}

    public async getStatus() {
        const fd = await this.fs.open("/dev/mydevice", "r");
        if (fd < 0) throw new Error("Device not found");
        
        const status = await this.std.ioctl(fd, 3, null); // GET_STATUS
        await this.fs.close(fd);
        return status;
    }

    public async reset() {
        const fd = await this.fs.open("/dev/mydevice", "w");
        if (fd < 0) return false;
        
        await this.std.ioctl(fd, 1, null); // RESET
        await this.fs.close(fd);
        return true;
    }
}
```

**Penggunaan di aplikasi:**
```typescript
import { MyServiceLib } from "../lib/MyServiceLib";

export class main {
    async execute(lib: UserLib, args: string[]) {
        const svc = new MyServiceLib(lib.fs, lib.std);
        
        await svc.reset();
        const status = await svc.getStatus();
        await lib.std.print(`Device ready: ${status.ready}\n`);
    }
}
```

---

## Aturan Sandbox

| ❌ Dilarang | ✅ Gunakan Ini |
|-------------|---------------|
| `import fs from 'fs'` | `lib.fs.open()`, `lib.fs.read()` |
| `require('http')` | `lib.net.connect()` |
| `process.env.HOME` | `lib.shell.getenv("HOME")` |
| `process.exit()` | `lib.shell.exit()` |
| `console.log()` (untuk output) | `lib.std.print()` |

> [!TIP]
> Gunakan `console.log()` hanya untuk debug di host console (saat `enableConsole: true` di sysconfig). Untuk output ke terminal TSIX, selalu pakai `lib.std.print()`.

---

## Debugging

| Method | Target | Kapan Dipakai |
|--------|--------|---------------|
| `lib.std.print()` | Terminal TSIX | Output normal & debug saat runtime |
| `console.log()` | Host terminal | Debug saat development (perlu `enableConsole: true`) |
| `sys-diag` | Terminal TSIX | System diagnostics tool |

---

**Halaman selanjutnya:** [🚀 Memulai (Getting Started)](Memulai.md)
