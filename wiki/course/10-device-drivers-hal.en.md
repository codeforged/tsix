---
module: 10
title: Device Drivers (HAL)
part: III
partTitle: Storage & I/O
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Device Drivers (HAL)

**RFC-TSIX-EDU-002** | Tenth module of the TSIX curriculum. Understand the `IDevice` contract, aux-devices plugins, udev-style configuration, and the virtual `/dev` device table.

> `/dev` in TSIX is the **device registry in the kernel** (`kernel.devices[xxx]`) — not a filesystem vnode. Every device is an `IDevice` object that can be opened like a file.

---

## Learning Objectives

- [ ] Explain the `IDevice` contract (read/write/ioctl + optional init/open/close/present)
- [ ] Explain why `/dev` is virtual — not a filesystem vnode
- [ ] Explain the device registration order at boot
- [ ] Explain the `aux-devices` plugin: `export default` + `static autoRegister` conventions
- [ ] Explain `applyDeviceConfigs()` (udev-style from `sysconfig.json`)
- [ ] Explain `present()` for hotplug (udev-like)
- [ ] Explain the `DbLib` dual transport: `/dev/mysql` vs the `mysqld` daemon
- [ ] Write your own driver (10-step checklist)

---

## Core Concepts

### The IDevice Contract

Every device is an object that implements `IDevice`. The kernel only needs to call the three required methods — `read`, `write`, `ioctl` — without knowing what is inside. This is the HAL abstraction: one contract for all hardware.

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

`KContext` is a utility injection from the kernel into the driver (delivered through `init`):

```ts
export interface KContext {
    syslog: (message: string) => void;
}
```

| Member | Required | Meaning |
|---|---|---|
| `name` | ✅ | Driver name; becomes the path name `/dev/<name>` (lowercase) |
| `read(offset?, length?)` | ✅ | Read data from the device |
| `write(data, offset?)` | ✅ | Write data; `boolean` success/failure |
| `ioctl(cmd, arg)` | ✅ | Control the device (clear, raw mode, refcount, etc.) |
| `init(ctx)` | ⬜ | Called once at boot; `ctx.syslog()` for logging |
| `open()` | ⬜ | Lazy open when the device is opened (e.g. SerialDevice) |
| `close()` | ⬜ | Close the device with refcounting |
| `present()` | ⬜ | Hotplug: `ls /dev` hides devices that are not present |
| `uid/gid/mode` | ⬜ | Permission metadata (used by the `OPEN` permission check) |
| `disabled` | ⬜ | `true` → skipped by the plugin loader at boot |

### `/dev` Virtual — Not a Vnode

`/dev` does **not** store device nodes in the VFS database. The `OPEN` code comment states it explicitly: *"we don't want to create device nodes in VFS database"*. What exists is only the `/dev` directory (created by `bkfs.mkdir("/dev", 0, 0, 493)` at boot) and the `kernel.devices` table.

| Operation | Handling in syscall |
|---|---|
| `ls /dev` | Special: enumerate `Object.keys(kernel.devices)`, filter by `present()`, report metadata |
| `open("/dev/xxx")` | `devName = path.replace("/dev/", "")` → `kernel.devices[devName]` → `FDEntry {device, ...}` |
| `stat("/dev/xxx")` | Special: fetch device metadata (`uid/gid/mode`) |
| `chmod`/`chown /dev/*` | Root only; set directly on the device object |
| `/dev/` without a driver | Falls back to the VFS node (if any) with a normal permission check |

Aliases recognized by `OPEN`:

- `tty` → the calling process's TTY (`tty${pcb.ttyId || 1}`).
- `screen`, `console`, `stdout`, `fb0` → the caller's active TTY (fallback `fb0`).
- `keyboard`, `stdin` → `kernel.devices.stdin`.

The `OPEN` permission check uses device metadata with a **default `0o600`** (root only) when `mode` is not set:

```ts
const devPerm = {
    name: devName,
    uid: device.uid ?? 0,
    gid: device.gid ?? 0,
    mode: device.mode ?? 0o600, // Default: root only (rw-------)
};
```

The standard I/O devices (`stdout`/`stdin`/`fb0`/`console`/`screen`/`keyboard`) **bypass** this check. When opened, the kernel calls `ioctl(10)` (INC_READ_REF) / `ioctl(20)` (INC_WRITE_REF) for refcounting, then `device.open()` if available (lazy open). A failed `open()` → error `Failed to open device /dev/xxx`.

### The `/dev` Device Table

| `/dev/` | Class | Function |
|---|---|---|
| `stdin` | KeyboardDevice | Keyboard input (cooked/raw) |
| `fb0/stdout/stderr` | TTYDevice | Standard output → active TTY |
| `tty1..tty32` | TTYDevice | Virtual consoles |
| `null` | NullDevice | Black hole |
| `smqtnl0/1` | SimpleMQTNLDriver | MQTNL network interface |
| `randomdevice` | RandomDevice | Random numbers (0–999 per read) |
| `mcp23017` | MCP23017Device | I2C GPIO (`autoRegister`) |
| `joystick` | JoystickDevice | USB HID gamepad; `present()` = hotplug |
| `ttyUSB*` | SerialDevice | Auto-detect serial |
| `mysql` *(experimental)* | MySQLDevice | External DB connection — `disabled: true` by default |
| *(virtual)* | PipeDevice / SocketDevice | Runtime instances, not paths |

> [!NOTE] `MySQLDevice` has `disabled: true` in the source code — so `/dev/mysql` is **not registered by default**. Enable it only when a device transport is needed. See the dual transport note below.

### Device Registration at Boot

`Kernel.boot()` registers devices in a fixed order:

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

The order matters: `applyDeviceConfigs()` must run **after** all devices are registered, and `init()` after the configuration is applied.

### aux-devices Plugins & the autoRegister Convention

The `src/kernel/devices/aux-devices/` folder is scanned by `loadAuxDevices()` at boot. Two conventions:

1. **`export default` is required** — the loader reads `module.default || module`. Without a default export, the class is not recognized.
2. **`static autoRegister(kernel)` is optional** — for platform-specific hardware configuration (e.g. MCP23017 + I2C bus). Called after the instance is registered.

### applyDeviceConfigs (udev-style)

The `devices` block in `sysconfig.json` → "udev" rules: set `mode`/`uid`/`gid` per device name — exactly like Linux udev rules.

```json
{
  "devices": {
    "randomdevice": {
      "mode": 438
    }
  }
}
```

`438` (decimal) = `0o666` (`rw-rw-rw-`), applied to `/dev/randomdevice`. See the `applyDeviceConfigs()` snippet.

---

## Flow / How It Works

### Device access flow (read/write)

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

### Boot registration flow

1. `TTYManager(32)` creates 32 consoles → `TTYDevice` tty1..32.
2. The core map `this.devices`: `stdin`/`fb0`/`stdout`/`stderr`/`null` + tty1..32.
3. Network interfaces from `cfg.network.interfaces` → `SimpleMQTNLDriver`.
4. `loadAuxDevices()`: scan `aux-devices/` → `export default` → register → `autoRegister`.
5. `SerialDeviceManager` detects `ttyUSB*`.
6. `applyDeviceConfigs()`: apply `mode`/`uid`/`gid` from `sysconfig.json`.
7. Loop `init()` over all drivers → inject `KContext.syslog`.
8. The `/dev` directory is guaranteed to exist in VFS.

### The `ls /dev` flow (udev-like hotplug)

```
ls /dev
  → syscall LS dengan path /dev
  → enumerasi kernel.devices
  → filter: device dengan present() hanya tampil jika present() true
  → laporan {name, type:"DEVICE", size:0, uid, gid, mode}
```

Example: `JoystickDevice.present()` returns `this.connected` — when the gamepad is unplugged, `/dev/joystick` disappears from `ls /dev`; when plugged back in, it reappears.

---

## Special Note: `MySQLDevice` & `DbLib` (Dual Transport)

> [!IMPORTANT] **`/dev/mysql` is not a hardware driver.**
> `MySQLDevice` is the **first transport** for external database integration through the device model — an example of extending HAL in an unusual direction.
>
> **`DbLib` is already implemented** (a UserLib sub-library, the `lib.fs`/`lib.net` pattern) with **pluggable dual transport**:
> - **Device** (`/dev/mysql`): syscall `DB_*` (67–69) → kernel → device → `mysql2`
> - **Service daemon** (`mysqld`): syscall `DB_*` → kernel → Ring 4 daemon → `mysql2`
>
> The kernel routes **dynamically**: if `mysqld` is registered (syscall `DB_SERVICE_REGISTER`=70) → to the daemon; if not → to the device (fallback). The daemon replies via `DB_SERVICE_REPLY`=71. Applications only see `db.connect()/query()/disconnect()` — the medium is invisible. The sandbox is safe because only the kernel or a privileged daemon touches `mysql2`.

### DB syscall codes

| Code | Name | Function |
|---|---|---|
| 67 | `DB_CONNECT` | Open a connection (`{host, user, password, database}`) |
| 68 | `DB_QUERY` | Execute SQL (SELECT → rows; INSERT/UPDATE/DELETE → ResultSetHeader) |
| 69 | `DB_DISCONNECT` | Close the connection |
| 70 | `DB_SERVICE_REGISTER` | The `mysqld` daemon registers as a service transport |
| 71 | `DB_SERVICE_REPLY` | The daemon sends the result `{requestId, result}` to the kernel |

### Dynamic routing flow

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

The routing logic is identical in every `DB_CONNECT`/`DB_QUERY`/`DB_DISCONNECT` case: check `dbServicePid` first, then fall back to the device. When the daemon exits, `Syscalls.ts` resets `dbServicePid = null` so the route automatically returns to the device.

### Implementation details

- **`MySQLDevice`** (`aux-devices/MySQLDevice.ts`) has `disabled: true` — **not registered by default**.
- **Multi-instance**: connections are stored per-PID (`Map<pid, Connection>`); each app has its own connection, and two apps can access different servers/databases in parallel. The raw ioctl path without a pid uses an anonymous slot (`ANON_PID = 0`): `ioctl(0x2001)` connect / `ioctl(0x2002)` disconnect.
- **`release(pid)`**: called by the kernel when a process dies → the connection is closed forcibly (anti-leak).
- **The `mysqld` daemon** (`src/mirror/etc/mysqld/mysqld.ts`): privileged Ring 4 — the host module allow-list includes `mysql2` and `mysql2/promise`.
- **Apps never touch `mysql2`** — only `lib.db.*` or `import { db } from "@tsix/Application"`.

---

## Snippet (code level)

All snippets below are **exact copies from the source** (code is the truth).

### The IDevice contract — `src/kernel/devices/IDevice.ts`

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

### A small real driver — `NullDevice` (`/dev/null`)

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

> Note: `IDevice.ts` also contains a concise `NullDevice` (name `"Null"`, `ioctl` → `-1`) as a learning example. The `/dev/null` driver used at boot is the `NullDevice.ts` above.

### Driver with init + default export — `RandomDevice` (`/dev/randomdevice`)

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

> Note the `const DeviceClass = module.default || module;` line — this is why `export default` is **required** so the class can be instantiated.

### The autoRegister convention — `MCP23017Device`

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

### `OPEN` routing for `/dev/*` — `src/kernel/Syscalls.ts` (core excerpt)

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

## Guide: Writing Your Own Driver

> [!TIP] This answers the "Next steps" in the Module 10 ToC: *a tutorial for writing your own driver*.
> The smallest examples already exist: `NullDevice` and `RandomDevice`.

### File locations

| Driver type | Location | How to register |
|---|---|---|
| Core device (stdin, fb0, tty, null) | `src/kernel/devices/*.ts` | Directly in `Kernel.boot()` (the `this.devices` map) |
| Hardware / experimental | `src/kernel/devices/aux-devices/<Name>Device.ts` | Auto via `loadAuxDevices()` + `export default` |
| Network interface | — | Via `cfg.network.interfaces` in `sysconfig.json` |

### The 10-step checklist

1. **Create the file**: `src/kernel/devices/aux-devices/EchoDevice.ts`.
2. **Import the contract**: `import { IDevice, KContext } from "../IDevice";`
3. **Write the class**: `export class EchoDevice implements IDevice { name = "echo"; ... }` — `name` determines the path `/dev/echo` (lowercase).
4. **Implement the required methods**: `read()`, `write()`, `ioctl()`. The kernel only calls these three.
5. **Optional lifecycle**: `init(ctx)` for syslog, `open()`/`close()` for lazy open, `present()` for hotplug.
6. **Optional metadata**: `uid/gid/mode` (default permission `0o600`), `disabled` to turn it off at boot.
7. **`export default EchoDevice;`** — REQUIRED. Without it `loadAuxDevices()` does not recognize the plugin (`module.default || module`).
8. **Optional `static autoRegister(kernel)`** — for platform-specific hardware configuration (bus, address, name).
9. **Set udev-style permissions**: `sysconfig.json` → `"devices": { "echo": { "mode": 438 } }`.
10. **Test**: boot → `ls /dev/echo` → read/write from the shell → check the syslog for `[Dynamic HAL] Kernel Plugin Loaded: /dev/echo`. Add a unit test in `src/kernel/devices/aux-devices/C10-AuxDevices.test.ts` (the C10.08–C10.12 pattern).

> [!IMPORTANT] Default export convention: the loader uses `const DeviceClass = module.default || module;` then `if (typeof DeviceClass === "function")`. The driver class **must** be `export default` so it can be instantiated. `MCP23017Device` satisfies both: `export default` + `static autoRegister`.

---

## Exercises / Practice

1. Read `wiki/DEVELOPER_GUIDE_DEVICES.md` — the driver-writing guide.
2. Read `src/kernel/devices/aux-devices/RandomDevice.ts` — the minimal device pattern (`export default` + `init`).
3. Read `src/kernel/devices/aux-devices/MCP23017Device.ts` — study `autoRegister` + `disabled`.
4. Read `src/kernel/devices/aux-devices/joystick.ts` — study `present()` (udev-like hotplug).
5. Run `ls /dev` after boot — notice `/dev/randomdevice` and its metadata.
6. Change `mode` in `sysconfig.json` (the `devices.randomdevice` block) → reboot → observe the `ls /dev` results.
7. (Challenge) Write the `/dev/echo` driver: `read()` returns the last text written, `write()` stores it. Follow the 10-step checklist above, then test it from the shell.

---

## References

- `wiki/DEVELOPER_GUIDE_DEVICES.md` — driver-writing guide
- `wiki/mcp23017-registration.md` — plugin registration example
- `wiki/course/00-overview.en.md` §5.2 — device model (HAL) + DbLib notes
- `src/kernel/devices/IDevice.ts` — the `IDevice` + `KContext` contract
- `src/kernel/devices/NullDevice.ts`, `src/kernel/devices/aux-devices/RandomDevice.ts`, `src/kernel/devices/aux-devices/joystick.ts` — driver examples
- `src/kernel/devices/aux-devices/MCP23017Device.ts`, `src/kernel/devices/aux-devices/MySQLDevice.ts` — autoRegister & DB transport
- `src/kernel/Kernel.ts` — boot, `loadAuxDevices()`, `applyDeviceConfigs()`
- `src/kernel/Syscalls.ts` — `OPEN`/`LS`/`STAT`/`CHMOD`/`CHOWN` routing for `/dev`, DB_* 67–71
- `src/common/SyscallCode.ts` — `DB_*` syscall codes
- `src/mirror/lib/DbLib.ts` — the `db.connect/query/disconnect` API
- `src/mirror/etc/mysqld/mysqld.ts` — service daemon (alternative transport)
- `src/kernel/devices/aux-devices/C10-AuxDevices.test.ts` — driver tests (C10.08–C10.12)
- `src/sysconfig.json` — the `devices` block (udev-style)

---

*Module 10 — complete. Part III done. Continue to [Module 11 — Worker Thread & Sandbox](11-worker-thread-sandbox.en.md).*
