---
module: 03
title: Boot Sequence
part: II
partTitle: Boot & Kernel Runtime
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Boot Sequence

**RFC-TSIX-EDU-002** | Third module of the TSIX curriculum. Traces the boot sequence from `main.ts` → `kernel.boot()` → PID 1 (`init`) → login, up to the 100ms keep-alive on the host.

> TSIX boot mimics a UNIX/Linux boot: from host bootstrap → kernel subsystem init → init (PID 1) → rc.local → getty/login per TTY. What decides whether the system is "alive or dead" is the **100ms keep-alive** in `main.ts`.

---

## Learning Objectives

- [ ] Explain the role of `main.ts` and the 100ms keep-alive
- [ ] List the order of `initializeSubsystems()` in the kernel
- [ ] Explain the content and role of `init` (PID 1)
- [ ] Explain the order of daemons in `rc.local`
- [ ] Explain what exit code 1 means when PID 1 dies (reboot)

---

## Flow / How It Works

TSIX boot follows the classic UNIX/Linux pattern: host bootstrap → kernel subsystem init → `init` (PID 1) in a Worker → `rc.local` → getty/login per TTY → host keep-alive. The diagram below summarizes the entire sequence, from the first second the host starts until the system is "alive".

```mermaid
sequenceDiagram
    participant H as Host (Node.js)
    participant M as main.ts
    participant K as Kernel.ts
    participant V as VFS (BKFS/SQLite)
    participant W as Worker Thread (Ring 4)
    participant I as init (PID 1)
    participant R as rc.local
    participant L as login (TTY1-6)

    H->>M: node src/main.ts
    M->>M: Config.load() → sysconfig.json
    M->>K: new Kernel() (Logger, PermissionManager, MountManager, GUIRegistry)
    M->>K: await kernel.boot()

    activate K
    K->>K: initializeSubsystems()
    K->>V: mount BKFS "/" (system.db)
    K->>K: processFstab() → /tmp (RamFS), /mnt/shared, /mnt/sbak
    K->>K: new Scheduler() + new PermissionManager() + new PortManager()
    K->>K: new SyscallDispatcher() → scheduler.setSyscallHandler(...)
    K->>K: rebuildVFSCache() → pre-compile /lib (DME)
    K->>K: TTYManager(32) + /dev devices (stdin, fb0, stdout, stderr, null, tty1-32)
    K->>K: network interfaces (SimpleMQTNLDriver) + loadAuxDevices() + SerialDeviceManager
    K->>K: applyDeviceConfigs() (udev) + pastikan /dev di VFS
    K->>K: load RSA identity → fingerprint visual
    K->>K: ensureDefaultAuth() + ensureDefaultGroups()
    K-->>M: boot() selesai

    M->>K: kernel.runInit()
    K->>V: resolve /bin/init.js (cfg.scheduler.bootEntry)
    K->>W: createProcess("init", fds:[tty1×3]) → PID 1
    K->>K: setForegroundProcess(1, 1)
    deactivate K

    activate W
    activate I
    I->>I: enforce setuid (/bin/passwd.js, /bin/sudo.js)
    I->>I: RSA identity: generate/verify keypair + fingerprint
    I->>R: exec /etc/rc.local.js + waitpid
    activate R
    R->>R: airtermd → tpkgd → scpd → otad → iot-listener
    R->>R: tunggu /var/run/dome.ready → dome → asteracea
    R->>R: crond → mysqld
    R-->>I: exit 0
    deactivate R

    I->>L: spawnLogin TTY2-6 (monitorProcess → respawn)
    I->>L: spawnLogin TTY1 (foreground)
    I->>I: while(true) { wait 10s }  ← PID 1 tak pernah exit
    deactivate I
    deactivate W

    M->>M: keepAlive: setInterval(100ms)
    M->>M: scheduler.getProcess(1) → EXITED?
    M-->>M: exitCode === 1 → reboot | else → power off
```

> [!NOTE] This mermaid version is more complete than `wiki/boot_sequence.md` and follows the current code (`Kernel.ts`, `init.ts`, `rc.local.ts`).

### Concise flow (ASCII)

```
main.ts
  Config.load()                    → baca sysconfig.json
  new Kernel()                     → Logger, PermissionManager, MountManager, GUIRegistry
  kernel.boot()
    initializeSubsystems()
      mount BKFS("/")              → SQLite system.db (root filesystem)
      processFstab()               → /tmp (RamFS), /mnt/shared (HostVFS), /mnt/sbak (BKFS)
      new Scheduler()
      new PermissionManager()
      new PortManager()
      new SyscallDispatcher()      → scheduler.setSyscallHandler(...)
      rebuildVFSCache()            → pre-compile /lib ke memori (DME)
    new TTYManager(32) + TTYDevice tty1..32
    devices{}                      → stdin, fb0, stdout, stderr, null
    init network interfaces        → SimpleMQTNLDriver per config
    loadAuxDevices()               → plugin driver (random, mysql, mcp23017)
    SerialDeviceManager            → auto-detect ttyUSB*
    applyDeviceConfigs()           → "udev": mode/uid/gid dari sysconfig
    pastikan /dev ada di VFS
    load RSA identity              → fingerprint visual di TTY
    ensureDefaultAuth()            → seed /etc/passwd + /etc/shadow (root)
    ensureDefaultGroups()          → seed users (100) + sudo (27)
    wire keyboard + TTY callbacks  → Ctrl+C → SIGINT fg; Alt+F1-6 → switch
  kernel.runInit()
    resolve /bin/init.js
    createProcess("init", fds:[tty1×3])   → PID 1
    setForegroundProcess(1, 1)
  [init.ts di Worker]
    enforce setuid (passwd, sudo)
    generate/verify RSA identity
    exec /etc/rc.local.js + waitpid
    spawn login TTY2..6 (monitorProcess → respawn)
    spawn login TTY1 (foreground) → loop forever
  keepAlive (100ms di main.ts)
    jika PID 1 EXITED → process.exit(exitCode)  (1 = reboot)
```

### `initializeSubsystems()` order (from `Kernel.ts`)

```ts
this.bootLogStart("VFS: Mounting root filesystem (BKFS/SQLite)");
this.bkfs = new BKFS(cfg.kernel.database);
this.mountManager.mount("/", this.bkfs, "bkfs", cfg.kernel.database, false);
this.bootLogEnd(true);

await this.processFstab();                    // /tmp (RamFS), /mnt/* (HostVFS/BKFS)

this.scheduler = new Scheduler();             // Core: Process Scheduler
this.satpam = new PermissionManager();        // Security: Permission Manager
this.portManager = new PortManager();         // Network: Port Manager
this.syscall = new SyscallDispatcher(
  this.bkfs, this.mountManager, this.scheduler, this, this.satpam,
);
this.scheduler.setSyscallHandler(async (req) => {
  return await this.syscall!.handleRequest(req);
});
this.rebuildVFSCache();                       // VFS: pre-compile /lib (DME)
this.scheduler.setVFSCacheProvider(() => this.vfsCache);
```

### rc.local order (daemons, from `rc.local.ts`)

1. **SetUID** `/bin/login.js` → `0o4755`, chown root:root.
2. `airtermd` (`/sbin/airtermd.js`) — remote access.
3. `tpkgd` (`/sbin/tpkgd.js`) — package server (TPKG).
4. `scpd` (`/sbin/scpd.js`) — SCP file transfer.
5. `otad` (`/sbin/otad.js`) — ESP firmware OTA.
6. `iot-listener` (`/sbin/iot-listener.js`) — MQTNL sensor.
7. Clean old marker `/var/run/dome.ready`, then **wait for DOME ready** (polling 200ms, timeout 10s).
8. `dome` (`/opt/dome/dome.js`) — display server (PixelSpace).
9. `asteracea` (`/opt/asteracea/asteracea.js`) — window manager (after DOME is ready).
10. `crond` (`/sbin/crond.js`) — cron scheduler.
11. `mysqld` (`/opt/mysqld/mysqld.js`) — database service.

> [!WARNING] **Documentation vs code.** The `rc.local.ts` source contains the 11 steps above. However, the compiled `rc.local.js` file (the one actually executed) only contains 3 daemons: `airtermd`, `tpkgd`, `scpd`. **Code is truth** — at runtime, only the first 3 daemons actually run from `rc.local`.

---

## Source Code

| File | Role |
|---|---|
| `src/main.ts` | Host entry point + keep-alive |
| `src/kernel/Kernel.ts` | `boot()` + `initializeSubsystems()` + `runInit()` |
| `src/mirror/bin/init.ts` | PID 1: setuid, identity, rc.local, spawn login |
| `src/mirror/etc/rc.local.ts` | Startup daemon list |
| `src/common/Config.ts` | Reads `sysconfig.json` |

---

## Snippet (code level)

### Keep-alive in `main.ts` (the host must not die)

```ts
const keepAlive = setInterval(() => {
    const scheduler = kernel.getScheduler();
    const p1 = scheduler?.getProcess(1);
    if (!p1 || p1.state === "EXITED") {
        clearInterval(keepAlive);
        if (process.stdin.isTTY) {
            (process.stdin as any).setRawMode(false);
        }

        const exitCode = (kernel as any).wantedExitCode ?? (process.exitCode ?? 0);
        if (exitCode === 1) {
            console.log("\n[Kernel] System is rebooting...");
        } else {
            console.log("\n[Kernel] System halted. Powering off...");
        }
        process.exit(exitCode);
    }
}, 100); // 100ms biar satset responnya
```

Key point: **as long as PID 1 is alive, the host does not stop.** When PID 1 exits with **code 1** → reboot; otherwise → power off. Before exiting, the terminal raw mode is restored so the host terminal is not left "broken".

### Boot log: `bootLogStart()` + `bootLogEnd()`

`Kernel.ts` prints boot progress with a `[      ]` bracket that updates in place (`\r` + ANSI `\x1b[K`). Usage pattern:

```ts
this.bootLogStart("VFS: Mounting root filesystem (BKFS/SQLite)");
this.bkfs = new BKFS(cfg.kernel.database);
this.mountManager.mount("/", this.bkfs, "bkfs", cfg.kernel.database, false);
this.bootLogEnd(true);                     // → [  OK  ] VFS: Mounting root...
```

`bootLogEnd(false, "pesan")` → `[ FAIL ]`. Both are no-ops if `cfg.kernel.verbose` is false.

### runInit: spawning PID 1

```ts
const initPath = "/bin/" + cfg.scheduler.bootEntry;   // bootEntry = "init.js"
const res = this.mountManager.resolve(initPath);
const raw = res.vfs.read(res.relativePath);           // kontrak IVFS, bukan stat()

const initPcb = this.scheduler?.createProcess("init", {
    fds: [tty1, tty1, tty1],
    appName: "init",
    appContent: initContent,
    env: {
        PATH: cfg.scheduler.defaultPath,
        HOME: "/root",
        HOSTNAME: cfg.shell.defaultHostname,
        PROMPT_FORMAT: cfg.shell.promptFormat,
        LINES: (process.stdout.rows || cfg.shell.defaultRows).toString(),
        COLUMNS: (process.stdout.columns || cfg.shell.defaultColumns).toString(),
    },
    cwd: cfg.scheduler.defaultCwd,
    ttyId: 1,
});
if (initPcb) this.scheduler?.setForegroundProcess(initPcb.pid, 1);
```

### init: enforce setuid

```ts
// Runtime mengeksekusi sidecar .js (bukan source .ts), jadi chmod harus di .js
await lib.fs.chmod("/bin/passwd.js", 2541);   // 2541 = 0o4755 (setuid root)
await lib.std.print(`${ok} [INIT] SetUID bit applied to: /bin/passwd.js\n`);
await lib.fs.chmod("/bin/sudo.js", 2541);
await lib.std.print(`${ok} [INIT] SetUID bit applied to: /bin/sudo.js\n`);
await lib.std.print(`${ok} [INIT] System binary permissions enforced.\n`);
```

> [!NOTE] `2541` decimal = `0o4755` octal (setuid + rwxr-xr-x). This SetUID lets `passwd` and `sudo` elevate privileges to root even when run by a regular user.

### init: exec rc.local + waitpid

```ts
const result = await lib.shell.exec("/etc/rc.local.js", [], undefined, undefined, undefined);
if (result) {
    const exitCode = await lib.shell.waitpid(result.pid);
    if (exitCode === 0) {
        await lib.std.print(`${ok} [INIT] Startup scripts completed successfully.\n`);
    } else {
        await lib.std.print(`Init: Warning - rc.local exited with code ${exitCode}\n`);
    }
}
```

### init: spawnLogin + monitorProcess (respawn to avoid crash-loop)

```ts
const spawnLogin = async (ttyId: number) => {
    try {
        if (ttyId > 1)
            await lib.std.print(`${ok} Initializing session on TTY${ttyId}...\n`);
        const result = await lib.shell.exec("/bin/login.js", [], undefined, undefined, ttyId);
        if (result && result.pid) {
            terminals.set(ttyId, result.pid);
            await lib.std.log(`Login service spawned on TTY${ttyId} (PID ${result.pid})`, "init");
            // Kita nungguin di background (thread terpisah di Worker)
            this.monitorProcess(lib, ttyId, result.pid, spawnLogin);
        }
    } catch (e: any) {
        await lib.std.print(`Init: Error spawning login on TTY${ttyId}: ${e.message}\n`);
    }
};
for (let i = 2; i <= 6; i++) await spawnLogin(i);   // TTY2-6 di background
await spawnLogin(1);                                 // TTY1 foreground
```

`monitorProcess` waits on `waitpid`; if login dies, it waits 1 second then `respawn`s — preventing crash-loop spam:

```ts
private async monitorProcess(
    lib: UserLib, ttyId: number, pid: number, respawn: (tty: number) => Promise<void>,
) {
    const exitCode = await lib.shell.waitpid(pid);
    await lib.std.print(
        `Init: Process on TTY${ttyId} (PID ${pid}) exited with code ${exitCode}. Respawning...\n`,
    );
    await new Promise(r => setTimeout(r, 1000)); // delay anti crash-loop
    await respawn(ttyId);
}
```

### init: eternal loop (PID 1 must never exit)

```ts
// Init process must never exit
while (true) {
    await new Promise(r => setTimeout(r, 10000));
}
```

### rc.local: waiting for DOME ready (marker, not a fixed sleep)

```ts
const DOME_READY_MARKER = "/var/run/dome.ready";
const DOME_WAIT_MS = 10000;
const DOME_POLL_MS = 200;
let domeReady = false;
const waitStart = Date.now();
while (Date.now() - waitStart < DOME_WAIT_MS) {
    try {
        if (await lib.fs.stat(DOME_READY_MARKER)) { domeReady = true; break; }
    } catch (_) { /* marker belum ada */ }
    await new Promise(r => setTimeout(r, DOME_POLL_MS));
}
```

Asteracea is only started after the marker appears — otherwise, `CREATE_WINDOW` is rejected by the kernel ("GUI_REQ: DOME engine is not running") and the screen stays blank.

### ensureDefaultAuth / ensureDefaultGroups (identity seeding)

At the end of `boot()`, the kernel ensures the identity files exist before userland runs:

```ts
// ensureDefaultAuth() — seed bila belum ada
const rootPasswd = "root:x:0:0:root:/root:/bin/tsh.ts\n";        // /etc/passwd
const rootShadow = "root:$2b$10$...KupG:19750:0:99999:7:::\n";   // /etc/shadow (bcrypt "root")

// ensureDefaultGroups() — group wajib
missing.push("users:x:100:");   // GID 100
missing.push("sudo:x:27:");     // GID 27 (gaya Ubuntu)
```

---

## Exercises / Practice

1. Run `npm start` — note the boot log order (`[  OK  ]` / `[ FAIL ]`) and compare it with the mermaid diagram above.
2. Kill the `init` process from inside the system (`kill 1` as root) — what happens to the host? (100ms keep-alive → exit code → reboot/halt).
3. Read `src/mirror/bin/init.ts` — where are `enforce setuid` and RSA identity called? How many login TTYs are spawned?
4. Read `src/mirror/etc/rc.local.ts` — match the 11 daemon steps above with the code. Compare with `rc.local.js` (only 3 daemons) — why are they different?
5. Read `src/kernel/Kernel.ts` — find the order of `initializeSubsystems()` and `rebuildVFSCache()`; explain the role of DME (Direct Memory Execution).

---

## References

- `wiki/boot_sequence.md` — mermaid sequence diagram
- `wiki/course/00-overview.en.md` §3 — Boot Sequence
- `src/main.ts` — host entry point + keep-alive
- `src/kernel/Kernel.ts` — boot, initializeSubsystems, runInit, ensureDefaultAuth
- `src/mirror/bin/init.ts` — PID 1 (setuid, identity, rc.local, spawn login)
- `src/mirror/etc/rc.local.ts` — startup daemons
- `src/common/Config.ts` — reads `sysconfig.json`

---

*Module 03 — done. Continue to [Module 04 — Processes & Scheduler](04-processes-scheduler.en.md).*
