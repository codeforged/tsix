---
module: 10
title: Device Drivers (HAL)
part: III
partTitle: Storage & I/O
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Device Drivers (HAL)

**RFC-TSIX-EDU-002** | Modul kesepuluh kurikulum TSIX. Memahami kontrak `IDevice`, plugin aux-devices, konfigurasi udev-style, dan tabel perangkat `/dev` virtual.

> `/dev` di TSIX adalah **registry device di kernel** (`kernel.devices[xxx]`) — bukan vnode filesystem. Setiap perangkat adalah objek `IDevice` yang bisa dibuka seperti file.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan kontrak `IDevice` (read/write/ioctl + opsional init/open/close/present)
- [ ] Menjelaskan mengapa `/dev` virtual — bukan vnode filesystem
- [ ] Menjelaskan urutan registrasi device saat boot
- [ ] Menjelaskan plugin `aux-devices`: konvensi `export default` + `static autoRegister`
- [ ] Menjelaskan `applyDeviceConfigs()` (udev-style dari `sysconfig.json`)
- [ ] Menjelaskan `present()` untuk hotplug (udev-like)
- [ ] Menjelaskan dual transport `DbLib`: `/dev/mysql` vs daemon `mysqld`
- [ ] Menulis driver sendiri (checklist 10 langkah)

---

## Konsep Inti

### Kontrak IDevice

Semua device adalah objek yang mengimplementasikan `IDevice`. Kernel cukup memanggil tiga method wajib — `read`, `write`, `ioctl` — tanpa tahu isi di dalamnya. Ini abstraksi HAL: satu kontrak untuk semua hardware.

```ts
export interface IDevice {
    name: string;
    read(offset?: number, length?: number): any;
    write(data: any, offset?: number): boolean;
    ioctl(cmd: number, arg: any): any;

    init?(ctx: KContext): void; // Opsional: Untuk nerima 'suntikan' dari Kernel
    open?(): boolean; // Opsional: Lazy open device hardware
    close?(): boolean; // Opsional: Close device hardware (with refcounting)

    /**
     * Opsional: Apakah hardware benar-benar tersedia SEKARANG?
     * Dipakai `ls /dev` untuk menyembunyikan device yang tidak present
     * (udev-like hotplug). Jika tidak diimplementasikan → selalu present.
     */
    present?(): boolean;

    uid?: number;
    gid?: number;
    mode?: number;
    disabled?: boolean;
}
```

`KContext` adalah suntikan utility dari kernel ke driver (diberikan lewat `init`):

```ts
export interface KContext {
    syslog: (message: string) => void;
}
```

| Anggota | Wajib | Makna |
|---|---|---|
| `name` | ✅ | Nama driver; jadi nama path `/dev/<name>` (huruf kecil) |
| `read(offset?, length?)` | ✅ | Baca data dari device |
| `write(data, offset?)` | ✅ | Tulis data; `boolean` sukses/gagal |
| `ioctl(cmd, arg)` | ✅ | Kontrol device (clear, raw mode, refcount, dst.) |
| `init(ctx)` | ⬜ | Dipanggil sekali saat boot; `ctx.syslog()` untuk log |
| `open()` | ⬜ | Lazy open saat device dibuka (mis. SerialDevice) |
| `close()` | ⬜ | Tutup device dengan refcounting |
| `present()` | ⬜ | Hotplug: `ls /dev` menyembunyikan device yang tidak present |
| `uid/gid/mode` | ⬜ | Metadata izin (dipakai cek permission `OPEN`) |
| `disabled` | ⬜ | `true` → dilewati plugin loader saat boot |

### `/dev` Virtual — Bukan Vnode

`/dev` **tidak** menyimpan device node di database VFS. Komentar kode `OPEN` menyebutnya eksplisit: *"we don't want to create device nodes in VFS database"*. Yang ada hanyalah direktori `/dev` (dibuat `bkfs.mkdir("/dev", 0, 0, 493)` saat boot) dan tabel `kernel.devices`.

| Operasi | Penanganan di syscall |
|---|---|
| `ls /dev` | Khusus: enumerasi `Object.keys(kernel.devices)`, filter `present()`, laporkan metadata |
| `open("/dev/xxx")` | `devName = path.replace("/dev/", "")` → `kernel.devices[devName]` → `FDEntry {device, ...}` |
| `stat("/dev/xxx")` | Khusus: ambil metadata device (`uid/gid/mode`) |
| `chmod`/`chown /dev/*` | Root only; langsung set ke objek device |
| `/dev/` tanpa driver | Jatuh ke VFS node (jika ada) dengan cek izin biasa |

Alias yang dikenali `OPEN`:

- `tty` → TTY proses pemanggil (`tty${pcb.ttyId || 1}`).
- `screen`, `console`, `stdout`, `fb0` → TTY aktif pemanggil (fallback `fb0`).
- `keyboard`, `stdin` → `kernel.devices.stdin`.

Cek permission `OPEN` memakai metadata device dengan **default `0o600`** (root only) jika `mode` tidak di-set:

```ts
const devPerm = {
    name: devName,
    uid: device.uid ?? 0,
    gid: device.gid ?? 0,
    mode: device.mode ?? 0o600, // Default: root only (rw-------)
};
```

Device standar I/O (`stdout`/`stdin`/`fb0`/`console`/`screen`/`keyboard`) **bypass** cek ini. Saat dibuka, kernel memanggil `ioctl(10)` (INC_READ_REF) / `ioctl(20)` (INC_WRITE_REF) untuk refcounting, lalu `device.open()` jika tersedia (lazy open). Gagal `open()` → error `Failed to open device /dev/xxx`.

### Tabel perangkat `/dev`

| `/dev/` | Class | Fungsi |
|---|---|---|
| `stdin` | KeyboardDevice | Input keyboard (cooked/raw) |
| `fb0/stdout/stderr` | TTYDevice | Output standar → TTY aktif |
| `tty1..tty32` | TTYDevice | Virtual console |
| `null` | NullDevice | Lubang hitam |
| `smqtnl0/1` | SimpleMQTNLDriver | Network interface MQTNL |
| `randomdevice` | RandomDevice | Angka acak (0–999 per baca) |
| `mcp23017` | MCP23017Device | GPIO I2C (`autoRegister`) |
| `joystick` | JoystickDevice | Gamepad USB HID; `present()` = hotplug |
| `ttyUSB*` | SerialDevice | Auto-detect serial |
| `mysql` *(eksperimental)* | MySQLDevice | Koneksi DB eksternal — `disabled: true` default |
| *(virtual)* | PipeDevice / SocketDevice | Instance runtime, bukan path |

> [!NOTE] `MySQLDevice` punya `disabled: true` di kode sumber — jadi `/dev/mysql` **tidak terdaftar secara default**. Aktifkan hanya saat transport device diperlukan. Lihat catatan dual transport di bawah.

### Registrasi Device saat Boot

`Kernel.boot()` mendaftarkan device dalam urutan tetap:

```ts
// 1. TTYManager(32) → tty1..tty32 (TTYDevice)
// 2. Map device inti:
this.devices = {
    stdin: new KeyboardDevice(),
    fb0: ttysDevs.tty1,    // Alias fb0 ke TTY1
    stdout: ttysDevs.tty1, // Alias stdout ke TTY1
    stderr: ttysDevs.tty1, // Alias stderr ke TTY1
    null: new NullDevice(),
    ...ttysDevs,
};
// 3. Interface jaringan (cfg.network.interfaces) → SimpleMQTNLDriver
// 4. loadAuxDevices()     → plugin dari folder aux-devices
// 5. SerialDeviceManager  → auto-detect ttyUSB*
// 6. applyDeviceConfigs() → udev-style dari sysconfig.json
// 7. init() semua driver  → suntikan KContext (syslog)
// 8. pastikan /dev ada di VFS (mkdir 493)
```

Urutannya penting: `applyDeviceConfigs()` harus jalan **setelah** semua device terdaftar, dan `init()` setelah konfigurasi diterapkan.

### Plugin aux-devices & Konvensi autoRegister

Folder `src/kernel/devices/aux-devices/` di-scan `loadAuxDevices()` saat boot. Dua konvensi:

1. **`export default` wajib** — loader membaca `module.default || module`. Tanpa default export, class tidak dikenali.
2. **`static autoRegister(kernel)` opsional** — untuk konfigurasi hardware platform-specific (mis. MCP23017 + bus I2C). Dipanggil setelah instance terdaftar.

### applyDeviceConfigs (udev-style)

Blok `devices` di `sysconfig.json` → aturan "udev": set `mode`/`uid`/`gid` per nama device — persis aturan udev Linux.

```json
{
  "devices": {
    "randomdevice": {
      "mode": 438
    }
  }
}
```

`438` (decimal) = `0o666` (`rw-rw-rw-`), diterapkan ke `/dev/randomdevice`. Lihat snippet `applyDeviceConfigs()`.

---

## Alur / Cara Kerja

### Alur akses device (read/write)

```
App (Ring 4)                     Kernel (Ring 1-2)                 Driver
    │ fs.open("/dev/tty1","r")       │                               │
    ├── syscall OPEN ───────────────►│ /dev/ → kernel.devices        │
    │                                │   • cek izin (uid/gid/mode)   │
    │                                │   • ioctl(10) INC_READ_REF    │
    │                                │   • open() lazy (jika ada)    │
    │  ← fd (FDEntry {device}) ──────┤                               │
    │ fs.read(fd)                    │                               │
    ├── syscall READ ───────────────►├── device.read() ─────────────►│
    │  ← data ───────────────────────┤◄── hasil ─────────────────────│
    │ fs.ioctl(fd, cmd)              │                               │
    ├── syscall IOCTL ──────────────►├── device.ioctl(cmd, arg) ────►│
```

### Alur registrasi saat boot

1. `TTYManager(32)` membuat 32 konsol → `TTYDevice` tty1..32.
2. Map inti `this.devices`: `stdin`/`fb0`/`stdout`/`stderr`/`null` + tty1..32.
3. Interface jaringan dari `cfg.network.interfaces` → `SimpleMQTNLDriver`.
4. `loadAuxDevices()`: scan `aux-devices/` → `export default` → register → `autoRegister`.
5. `SerialDeviceManager` mendeteksi `ttyUSB*`.
6. `applyDeviceConfigs()`: terapkan `mode`/`uid`/`gid` dari `sysconfig.json`.
7. Loop `init()` semua driver → suntik `KContext.syslog`.
8. Direktori `/dev` dijamin ada di VFS.

### Alur `ls /dev` (hotplug udev-like)

```
ls /dev
  → syscall LS dengan path /dev
  → enumerasi kernel.devices
  → filter: device dengan present() hanya tampil jika present() true
  → laporan {name, type:"DEVICE", size:0, uid, gid, mode}
```

Contoh: `JoystickDevice.present()` mengembalikan `this.connected` — saat gamepad dicabut, `/dev/joystick` hilang dari `ls /dev`; saat dicolok lagi, muncul kembali.

---

## Catatan Khusus: `MySQLDevice` & `DbLib` (Dual Transport)

> [!IMPORTANT] **`/dev/mysql` bukan driver hardware.**
> `MySQLDevice` adalah **transport pertama** untuk integrasi database eksternal lewat model device — contoh perluasan HAL ke arah yang tidak biasa.
>
> **`DbLib` sudah terimplementasi** (sub-library UserLib, pola `lib.fs`/`lib.net`) dengan **dual transport pluggable**:
> - **Device** (`/dev/mysql`): syscall `DB_*` (67–69) → kernel → device → `mysql2`
> - **Service daemon** (`mysqld`): syscall `DB_*` → kernel → daemon Ring 4 → `mysql2`
>
> Kernel me-route **secara dinamis**: jika `mysqld` terdaftar (syscall `DB_SERVICE_REGISTER`=70) → ke daemon; jika tidak → ke device (fallback). Daemon membalas via `DB_SERVICE_REPLY`=71. Aplikasi hanya melihat `db.connect()/query()/disconnect()` — medium tak terlihat. Sandbox aman karena `mysql2` hanya disentuh kernel atau daemon privileged.

### Kode syscall DB

| Kode | Nama | Fungsi |
|---|---|---|
| 67 | `DB_CONNECT` | Buka koneksi (`{host, user, password, database}`) |
| 68 | `DB_QUERY` | Eksekusi SQL (SELECT → rows; INSERT/UPDATE/DELETE → ResultSetHeader) |
| 69 | `DB_DISCONNECT` | Tutup koneksi |
| 70 | `DB_SERVICE_REGISTER` | Daemon `mysqld` mendaftar sebagai transport service |
| 71 | `DB_SERVICE_REPLY` | Daemon mengirim hasil `{requestId, result}` ke kernel |

### Alur routing dinamis

```
App (Ring 4)   lib.db.query(sql)             ← DbLib (@tsix/DbLib)
  ▼
UserLib.dispatch(DB_QUERY = 68)
  ▼
Kernel (Syscalls.ts)
  │  if (this.dbServicePid !== null)
  ├── YA   → forwardDbRequest(pid, "query", sql)
  │            → sendEvent(mysqld, "db_request") → daemon → mysql2
  │            → DB_SERVICE_REPLY=71 (requestId, result) → resolve pending
  └── TIDAK → /dev/mysql (MySQLDevice) → device.query(sql, pid) → mysql2
  ▼
resolve → App (rows)
```

Logika routing persis sama di setiap case `DB_CONNECT`/`DB_QUERY`/`DB_DISCONNECT`: cek `dbServicePid` dulu, baru fallback ke device. Saat daemon keluar, `Syscalls.ts` mereset `dbServicePid = null` sehingga route otomatis kembali ke device.

### Detail implementasi

- **`MySQLDevice`** (`aux-devices/MySQLDevice.ts`) punya `disabled: true` — **tidak terdaftar secara default**.
- **Multi-instance**: koneksi disimpan per-PID (`Map<pid, Connection>`); tiap app punya koneksi sendiri, dua app bisa akses server/database berbeda paralel. Jalur raw ioctl tanpa pid memakai slot anonim (`ANON_PID = 0`): `ioctl(0x2001)` connect / `ioctl(0x2002)` disconnect.
- **`release(pid)`**: dipanggil kernel saat proses mati → koneksi ditutup paksa (anti-bocor).
- **Daemon `mysqld`** (`src/mirror/etc/mysqld/mysqld.ts`): Ring 4 privileged — allow-list modul host mencakup `mysql2` dan `mysql2/promise`.
- **App tidak pernah menyentuh `mysql2`** — hanya `lib.db.*` atau `import { db } from "@tsix/Application"`.

---

## Snippet (level kode)

Semua snippet di bawah **salinan persis dari source** (kode adalah kebenaran).

### Kontrak IDevice — `src/kernel/devices/IDevice.ts`

```ts
export interface IDevice {
    name: string;
    read(offset?: number, length?: number): any;
    write(data: any, offset?: number): boolean;
    ioctl(cmd: number, arg: any): any;

    init?(ctx: KContext): void; // Opsional: Untuk nerima 'suntikan' dari Kernel
    open?(): boolean; // Opsional: Lazy open device hardware
    close?(): boolean; // Opsional: Close device hardware (with refcounting)

    /**
     * Opsional: Apakah hardware benar-benar tersedia SEKARANG?
     * Dipakai `ls /dev` untuk menyembunyikan device yang tidak present
     * (udev-like hotplug). Jika tidak diimplementasikan → selalu present.
     */
    present?(): boolean;

    uid?: number;
    gid?: number;
    mode?: number;
    disabled?: boolean;
}
```

### Driver nyata kecil — `NullDevice` (`/dev/null`)

```ts
// src/kernel/devices/NullDevice.ts
import { IDevice } from "./IDevice";

/**
 * NULL DEVICE (/dev/null)
 * 
 * Lubang hitam kernel. 
 * Apapun yang ditulis ke sini akan dibuang.
 * Apapun yang dibaca dari sini akan langsung EOF (null/empty).
 */
export class NullDevice implements IDevice {
    name = "NullDevice";

    read() {
        return "";
    }

    write(_data: any): boolean {
        return true;
    }

    ioctl(_cmd: number, _arg: any): any {
        return true;
    }
}
```

> Catatan: `IDevice.ts` juga memuat `NullDevice` ringkas (nama `"Null"`, `ioctl` → `-1`) sebagai contoh belajar. Driver `/dev/null` yang dipakai boot adalah `NullDevice.ts` di atas.

### Driver dengan init + default export — `RandomDevice` (`/dev/randomdevice`)

```ts
// src/kernel/devices/aux-devices/RandomDevice.ts
import { IDevice, KContext } from "../IDevice";

/**
 * RANDOM DEVICE (/dev/random)
 * 
 * Menghasilkan angka acak sebagai string.
 * Implementasi sederhana untuk demonstrasi plugin system.
 */
export class RandomDevice implements IDevice {
    name = "RandomDevice";
    private kctx: KContext | null = null;

    init(ctx: KContext) {
        this.kctx = ctx;
        this.kctx.syslog("Driver initialized and ready.");
    }

    read() {
        // Balikin angka acak 0-999 sebagai string
        const val = Math.floor(Math.random() * 1000);
        if (this.kctx) {
            this.kctx.syslog(`Random number generated: ${val}`);
        }
        return val.toString() + "\n";
    }

    write(_data: any): boolean {
        // Menulis ke random device biasanya diabaikan atau buat seeding
        if (this.kctx) {
            this.kctx.syslog("Write attempt to RandomDevice ignored.");
        }
        return true;
    }

    ioctl(_cmd: number, _arg: any): any {
        return true;
    }
}

// Plugin Export: Harus export default class yang implement IDevice
export default RandomDevice;
```

### loadAuxDevices() — plugin loader (`src/kernel/Kernel.ts`)

```ts
private loadAuxDevices() {
    if (!this.devices) return;

    const auxPath = path.resolve(__dirname, "devices/aux-devices");
    if (!fs.existsSync(auxPath)) {
        this.logger.debug(`Auxiliary devices directory not found: ${auxPath}`);
        return;
    }

    const files = fs.readdirSync(auxPath);
    files.forEach((file) => {
        if (file.endsWith(".ts") || file.endsWith(".js")) {
            try {
                const fullPath = path.join(auxPath, file);
                const module = require(fullPath);
                const DeviceClass = module.default || module;

                if (typeof DeviceClass === "function") {
                    // 1. Try auto-loading as device instance (original behavior)
                    const instance = new DeviceClass() as IDevice;

                    // Check if device is explicitly disabled
                    if (instance.disabled === true) {
                        this.logger.debug(
                            `[Dynamic HAL] Kernel Plugin ${file} is disabled, skipping.`,
                        );
                        return;
                    }

                    const devName = (
                        instance.name || file.replace(".ts", "").replace(".js", "")
                    ).toLowerCase();
                    this.devices![devName] = instance;
                    this.logger.info(
                        `[Dynamic HAL] Kernel Plugin Loaded: /dev/${devName}`,
                    );

                    // 2. Check for static autoRegister method (new convention)
                    if (typeof (DeviceClass as any).autoRegister === "function") {
                        try {
                            (DeviceClass as any).autoRegister(this);
                            this.logger.debug(
                                `[Dynamic HAL] Auto-register called for ${file}`,
                            );
                        } catch (e: any) {
                            this.logger.debug(
                                `[Dynamic HAL] Auto-register skipped for ${file}: ${e.message}`,
                            );
                        }
                    }
                }
            } catch (e: any) {
                this.logger.error(`Failed to load aux device ${file}: ${e.message}`);
            }
        }
    });
}
```

> Perhatikan `const DeviceClass = module.default || module;` — ini alasan `export default` **wajib** agar class ter-instantiate.

### Konvensi autoRegister — `MCP23017Device`

```ts
// src/kernel/devices/aux-devices/MCP23017Device.ts (bagian)

// Platform-specific hardware configuration
const HARDWARE_CONFIGS = [
    { bus: 2, address: 0x20, name: "mcp23017" }  // Orange Pi 3B default
];

export class MCP23017Device implements IDevice {
    name: string;
    uid: number = 0;
    gid: number = 0;
    mode: number = 0o660;
    disabled: boolean = false;

    static autoRegister(kernel: any): void {
        for (const config of HARDWARE_CONFIGS) {
            try {
                const device = new MCP23017Device(config.bus, config.address, config.name);
                kernel.devices[config.name] = device;
            } catch (e: any) {
                // Silently skip if hardware not present or i2c-bus not available
            }
        }
    }
    // ... (pinMode/digitalWrite/digitalRead)
}

export default MCP23017Device;
```

### applyDeviceConfigs() — udev-style (`src/kernel/Kernel.ts`)

```ts
private applyDeviceConfigs() {
    const cfg = Config.get();
    if (!cfg.devices) return;

    for (const devName in cfg.devices) {
        const device = this.devices[devName];
        if (device) {
            const devCfg = cfg.devices[devName];
            if (devCfg.mode !== undefined) device.mode = devCfg.mode;
            if (devCfg.uid !== undefined) device.uid = devCfg.uid;
            if (devCfg.gid !== undefined) device.gid = devCfg.gid;
            this.logger.info(
                `[udev] Configuration applied to / dev / ${devName}: mode = ${device.mode?.toString(8)}, uid = ${device.uid}, gid = ${device.gid}`,
            );
        }
    }
}
```

### Routing OPEN `/dev/*` — `src/kernel/Syscalls.ts` (bagian inti)

```ts
if (absoluteOpenPath.startsWith("/dev/")) {
    const devName = absoluteOpenPath.replace("/dev/", "");
    let device: IDevice | null = null;
    if (this.kernel.devices && this.kernel.devices[devName]) {
        device = this.kernel.devices[devName];
    }
    // ... (alias: tty / screen,console,stdout,fb0 / keyboard,stdin — diringkas)
    if (device) {
        const devPerm = {
            name: devName,
            uid: device.uid ?? 0,
            gid: device.gid ?? 0,
            mode: device.mode ?? 0o600, // Default: root only (rw-------)
        };
        if (!this.satpam.check(pcb, devPerm, requiredPerm)) {
            throw new Error(
                `Permission Denied: You cannot access device /dev/${devName}`,
            );
        }
        const f = flags || "r";
        if (f.includes("r") && device.ioctl) await device.ioctl(10, null); // INC_READ_REF
        if ((f.includes("w") || f.includes("a")) && device.ioctl)
            await device.ioctl(20, null); // INC_WRITE_REF
        if (device.open) {
            const opened = device.open();
            if (!opened) {
                throw new Error(`Failed to open device /dev/${devName}`);
            }
        }
        const fd = pcb.fdTable.length;
        pcb.fdTable.push({ device, context: absoluteOpenPath, flags });
        return fd;
    }
}
```

---

## Panduan: Menulis Driver Sendiri

> [!TIP] Ini menjawab "Langkah berikutnya" di ToC Modul 10: *tutorial menulis driver sendiri*.
> Contoh terkecil sudah ada: `NullDevice` dan `RandomDevice`.

### Lokasi file

| Jenis driver | Lokasi | Cara daftar |
|---|---|---|
| Core device (stdin, fb0, tty, null) | `src/kernel/devices/*.ts` | Langsung di `Kernel.boot()` (map `this.devices`) |
| Hardware / eksperimental | `src/kernel/devices/aux-devices/<Nama>Device.ts` | Auto via `loadAuxDevices()` + `export default` |
| Interface jaringan | — | Via `cfg.network.interfaces` di `sysconfig.json` |

### Checklist 10 langkah

1. **Buat file**: `src/kernel/devices/aux-devices/EchoDevice.ts`.
2. **Import kontrak**: `import { IDevice, KContext } from "../IDevice";`
3. **Tulis class**: `export class EchoDevice implements IDevice { name = "echo"; ... }` — `name` menentukan path `/dev/echo` (huruf kecil).
4. **Implement wajib**: `read()`, `write()`, `ioctl()`. Kernel cukup memanggil ketiganya.
5. **Opsional lifecycle**: `init(ctx)` untuk syslog, `open()`/`close()` untuk lazy open, `present()` untuk hotplug.
6. **Opsional metadata**: `uid/gid/mode` (default permission `0o600`), `disabled` untuk mematikan saat boot.
7. **`export default EchoDevice;`** — WAJIB. Tanpa ini `loadAuxDevices()` tidak mengenali plugin (`module.default || module`).
8. **Opsional `static autoRegister(kernel)`** — untuk konfigurasi hardware platform-specific (bus, address, name).
9. **Atur izin udev-style**: `sysconfig.json` → `"devices": { "echo": { "mode": 438 } }`.
10. **Test**: boot → `ls /dev/echo` → tulis/baca dari shell → cek syslog `[Dynamic HAL] Kernel Plugin Loaded: /dev/echo`. Tambah unit test di `src/kernel/devices/aux-devices/C10-AuxDevices.test.ts` (pola C10.08–C10.12).

> [!IMPORTANT] Konvensi default export: loader memakai `const DeviceClass = module.default || module;` lalu `if (typeof DeviceClass === "function")`. Class driver **harus** di-`export default` agar ter-instantiate. `MCP23017Device` memenuhi keduanya: `export default` + `static autoRegister`.

---

## Latihan / Praktik

1. Baca `wiki/DEVELOPER_GUIDE_DEVICES.md` — panduan menulis driver.
2. Baca `src/kernel/devices/aux-devices/RandomDevice.ts` — pola device minimal (`export default` + `init`).
3. Baca `src/kernel/devices/aux-devices/MCP23017Device.ts` — pelajari `autoRegister` + `disabled`.
4. Baca `src/kernel/devices/aux-devices/joystick.ts` — pelajari `present()` (hotplug udev-like).
5. Jalankan `ls /dev` setelah boot — perhatikan `/dev/randomdevice` dan metadata-nya.
6. Ubah `mode` di `sysconfig.json` (blok `devices.randomdevice`) → boot ulang → amati hasil `ls /dev`.
7. (Tantangan) Tulis driver `/dev/echo`: `read()` mengembalikan teks yang ditulis terakhir, `write()` menyimpannya. Ikuti checklist 10 langkah di atas, lalu uji dari shell.

---

## Referensi

- `wiki/DEVELOPER_GUIDE_DEVICES.md` — panduan menulis driver
- `wiki/mcp23017-registration.md` — contoh registrasi plugin
- `wiki/course/00-overview.md` §5.2 — device model (HAL) + catatan DbLib
- `src/kernel/devices/IDevice.ts` — kontrak `IDevice` + `KContext`
- `src/kernel/devices/NullDevice.ts`, `src/kernel/devices/aux-devices/RandomDevice.ts`, `src/kernel/devices/aux-devices/joystick.ts` — contoh driver
- `src/kernel/devices/aux-devices/MCP23017Device.ts`, `src/kernel/devices/aux-devices/MySQLDevice.ts` — autoRegister & transport DB
- `src/kernel/Kernel.ts` — boot, `loadAuxDevices()`, `applyDeviceConfigs()`
- `src/kernel/Syscalls.ts` — routing `OPEN`/`LS`/`STAT`/`CHMOD`/`CHOWN` untuk `/dev`, DB_* 67–71
- `src/common/SyscallCode.ts` — kode syscall `DB_*`
- `src/mirror/lib/DbLib.ts` — API `db.connect/query/disconnect`
- `src/mirror/etc/mysqld/mysqld.ts` — service daemon (transport alternatif)
- `src/kernel/devices/aux-devices/C10-AuxDevices.test.ts` — test driver (C10.08–C10.12)
- `src/sysconfig.json` — blok `devices` (udev-style)

---

*Modul 10 — selesai. Bagian III tuntas. Lanjut ke [Modul 11 — Worker Thread & Sandbox](11-worker-thread-sandbox.md).*
