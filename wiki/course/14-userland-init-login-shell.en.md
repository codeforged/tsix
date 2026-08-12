---
module: 14
title: Userland: init / login / shell / apps
part: V
partTitle: Human Interaction
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Userland: init / login / shell / apps

**RFC-TSIX-EDU-002** | Fourteenth module of the TSIX curriculum. Understand the application layer: PID 1 (init), login, shell, and the two styles of writing TSIX applications.

> All userland runs in a Worker Thread (Ring 4) — including PID 1. There is no inittab: the init logic is **hardcoded** in `init.ts`.

---

## Learning Objectives

- [ ] Explain the role of init (PID 1) without inittab
- [ ] Explain the login flow: passwd+shadow(bcrypt) → setgroups→setgid→setuid
- [ ] Explain the two application styles: `IProgram` vs `Program()` wrapper
- [ ] Explain the "error = window" concept (`std.error`)
- [ ] Explain the role of `monitorProcess` (respawn login)

---

## Core Concepts

### Init (PID 1)

There is no `/etc/inittab` — all init decisions are hardcoded in `src/mirror/bin/init.ts` (class `Init`). Execution order:

1. **Enforce setuid** — `chmod("/bin/passwd.js", 2541)` and `chmod("/bin/sudo.js", 2541)`. The value `2541` (decimal) equals `0o4755` (setuid root + rwxr-xr-x). The target is `.js`, not `.ts`, because the runtime executes the `.js` sidecar.
2. **RSA identity** — check `/etc/keys/rsa/id_rsa.pub`. If it is missing, `SecurityAgent.generateKeyPair()` creates a new key (RSA 2048-bit) and saves it to `/etc/keys/rsa/`. If it exists, the key is verified. The SHA256 fingerprint is taken via `shell.getFingerprint()`, and the identity color bar (`SecurityAgent.generateVisualIdentity`) is sent to the TTY via `std.ioctl(1, 33, colorBar)` — ioctl 33 = `SET_VISUAL_IDENTITY`.
3. **Exec `rc.local`** — run `/etc/rc.local.js` then `waitpid`. Exit code `0` = successful startup; anything else is logged as a warning.
4. **Spawn login TTY2–6** — `for (let i = 2; i <= 6; i++) spawnLogin(i)`. Each login process is *monitored* by `monitorProcess` (respawn + 1s delay anti-crash-loop).
5. **Spawn login TTY1** (foreground) — done after the banner and fingerprint.
6. **Loop forever** — `while (true) { await new Promise(r => setTimeout(r, 10000)); }`. Init must not exit; if PID 1 dies, the kernel calls `process.exit(exitCode)` (keepAlive, `1` = reboot).

### Login

`src/mirror/bin/login.ts` — one login process per TTY, spawned by init. Core flow:

1. Read `/etc/passwd` → find the user entry → take `uid` (field 3), `gid` (field 4), `home` (field 6), `shell` (field 7).
2. Read `/etc/shadow` → take the bcrypt hash (field 2) → `bcrypt.compareSync(password, hash)`.
3. Read `/etc/group` → collect *supplementary groups* (groups that contain the username, besides the primary gid).
4. `setgroups` → `setgid` → `setuid` — **mandatory POSIX order**. The GID must be changed before the UID; after the UID becomes non-root, the process loses the privilege to change the GID.
5. Set env `USER`/`HOME`, `chdir(home)`, then `exec` the shell — the shell is taken from `/etc/passwd` field 7 (usually `tsh`).

### WM Login (Asteracea) — GUI mode

TTY login (`login.ts`) is re-spawned as a fresh root process per TTY, so it can always read `/etc/shadow` & `setuid`. In contrast, **the WM (Asteracea) is a SINGLE process that is both login manager and desktop session**:

- The WM starts as root (spawned by init), then after the first login it **permanently drops privileges** to the logged-in user.
- On logout → login again (e.g. as root), the WM is already non-root → **two problems**:
  1. It can no longer read `/etc/shadow` (0640 root) → password verification fails.
  2. The kernel rejects `setgroups`/`setgid`/`setuid` for non-root → cannot switch users.
- Solution (see Snippet):
  1. **Verify via a SetUID-root helper** — `login.js --verify <user> <pass> <file>` (login.js is already SetUID root) → result is written to a temp file (`OK`/`FAIL:...`) and read back by the WM. A file channel is used because the child's *exit code* is unreliable (WorkerEntry always finishes with `exit(0)`).
  2. **Saved UID (kernel)** — `pcb.suid`. When the WM drops from root, the kernel keeps `suid=0`; on re-login the WM may `setuid(0)` to **restore** root, then drop to the target user. This is the Unix Saved UID mechanism (`seteuid`/`setresuid`).
  3. **Credential order in the WM** — if the WM is not root yet → `setuid(0)` first (restore), then `setgroups` → `setgid` → `setuid(target user)` (POSIX order for dropping).

> [!NOTE] **Saved UID safety** — `suid` defaults to the process's own UID in `createProcess`, so **regular apps do NOT inherit saved root** and cannot escalate. Only a process that dropped from root (i.e. the WM) keeps the "ticket back to root".

### Shell (tsh)

`src/mirror/bin/tsh.ts` — interactive shell, written in the `IProgram` style (`export class main implements IProgram`). Main features:

- Prompt `user@hostname:cwd#/$` customizable via the `PROMPT_FORMAT` env (`&username`, `&hostname`, `&cwd`, `&usertype`).
- Line editor: raw mode, history (up/down arrows), Tab completion, Ctrl+U, Home/End.
- Before running a command, the shell switches to cooked mode so foreground commands can receive SIGINT.
- `tsh <username>` — delegates to `/bin/login.js` (login is SetUID root, so it can authenticate & switch users).
- Resize (SIGWINCH / `RESIZE` event) updates the `LINES`/`COLUMNS` env without overwriting the foreground application's screen.

### Two application styles

There are two styles for writing TSIX applications:

**1. Class `IProgram` (mostly legacy)** — export class `main` that implements `IProgram`, with the method `execute(lib, args)`. All APIs are accessed through the `lib` parameter:

```ts
export class main implements IProgram {
    async execute(lib: OSContext, args: string[]) {
        // ...
    }
}
```

Examples: `ls`, `cat`, `ps`, `kill`, `tsh`.

**2. `Program()` wrapper + proxy singletons (new)** — import the `std`, `fs`, `shell`, `net`, `db` singletons from `@tsix/Application`, then wrap the main function with `Program(fn)`:

```ts
import { Program, std, fs, shell, net } from "@tsix/Application";

export default Program(async (args) => {
    // ...
});
```

Examples: `esp-send`, `dome`, `iot-dashboard`.

> [!NOTE] **How `Program()` works** — `Program(fn)` returns an anonymous class that `implements IProgram`. The `execute` method stores the `OSContext` into `global._tsixOsc`, calls `fn(args)`, and if `fn` throws an error, calls `std.error(error.stack, appName)` then re-throws. The `std`/`fs`/`shell`/`net`/`db` singletons are `Proxy` objects that forward access to `_tsixLib` on the current thread. `os.pid` and `os.rand` are also available.

**Comparison of the two styles:**

| Aspect | Class `IProgram` (legacy) | `Program()` wrapper (new) |
|---|---|---|
| Shape | Class `main` + method `execute()` | Anonymous function wrapped in `Program(fn)` |
| Signature | `execute(lib: OSContext, args: string[])` | `fn(args: string[])` |
| API access | Through the `lib` parameter (`lib.std`, `lib.fs`, ...) | Import proxy singletons (`std`, `fs`, `shell`, `net`, `db`) |
| Arguments | Second parameter | Single function parameter |
| Error handling | Manual (own try/catch) | Automatic → `std.error()` then re-throw |
| Implementation | `implements IProgram` directly | `Program()` returns a class `implements IProgram` |
| Examples | `ls`, `cat`, `ps`, `kill`, `tsh` | `esp-send`, `dome`, `iot-dashboard` |

### Error = "Window"

`std.error()` does 4 things:

1. Write to `/var/log/syslog`.
2. Find `fileHint` from the stack trace (skipping `UserLib`, `Application`, `emerald`).
3. Broadcast to the parent via IPC — message `{ type: "GUI_WINDOW_ERROR", wid, pid, file, error, context, timestamp }`.
4. Print to the TTY in red `[ERROR]`.

So when an application crashes, **an error window appears on the desktop** — not just text in the terminal.

## Flow / How It Works

### Boot: Kernel → init (PID 1)

```
Kernel (main.ts) — kernel.runInit()
  resolve /bin/init.js
  createProcess("init", fds:[tty1×3])   → PID 1
  setForegroundProcess(1, 1)

[init.ts — Worker Thread, Ring 4]
  1. Enforce setuid
       chmod /bin/passwd.js  2541   (0o4755)
       chmod /bin/sudo.js    2541
  2. RSA identity
       cek /etc/keys/rsa/id_rsa.pub
         ada       → verify + fingerprint
         tidak ada → generateKeyPair() → simpan id_rsa + id_rsa.pub
       fingerprint + color bar → ioctl(1, 33, colorBar)  (SET_VISUAL_IDENTITY)
  3. Exec /etc/rc.local.js + waitpid
  4. for (i = 2; i <= 6; i++) spawnLogin(i)
       exec /bin/login.js (ttyId=i)
       monitorProcess → respawn saat login mati (delay 1s anti-crash-loop)
  5. Banner ASCII + fingerprint color bar
  6. spawnLogin(1)   ← foreground TTY1
  7. while (true) { sleep 10s }   ← init tidak boleh exit
```

### Login: TTY → shell

```
login.ts (satu proses per TTY)
  1. username = args[0] || readLine("Username: ")
  2. password = readPassword("Password:🔑")   ← masked, raw mode
  3. /etc/passwd → uid(3), gid(4), home(6), shell(7)
  4. /etc/shadow → hash bcrypt (field 2)
  5. bcrypt.compareSync(password, hash)
       gagal → "Login: Invalid username or password" → ulangi dari langkah 1
  6. MOTD: /etc/motd + frasa acak /etc/motd.json
  7. /etc/group → supplementary gids (grup yang memuat username)
  8. setgroups(gids) → setgid(gid) → setuid(uid)   ← urutan POSIX
  9. setenv USER / HOME → chdir(home)
  10. exec(shell dari /etc/passwd) → waitpid → break (satu sesi)
```

### WM Login: GUI → desktop

```
asteracea.ts (single process = login manager + desktop)
  1. WM starts as root (spawned by init)
  2. Show GUI login screen
  3. Verify: spawn /bin/login.js --verify <user> <pass> <file>  ← SetUID root
       read result file: "OK" / "FAIL:..."
  4. /etc/passwd → uid(3), gid(4), home(6)   ← world-readable, read directly
  5. /etc/group → supplementary gids
  6. If the WM is not root yet (already logged in non-root) → setuid(0)  ← restore via Saved UID
  7. setgroups(gids) → setgid(gid) → setuid(uid)   ← POSIX order (drop)
  8. setenv USER / HOME → chdir(home)
  9. Show desktop — the WM BECOMES that user (taskbar, launcher, wallpaper)
  10. Logout → back to step 2 (WM stays alive; identity is reset via Saved UID)
```

## Source Code

| File | Role |
|---|---|
| `src/mirror/bin/init.ts` | PID 1 — hardcoded init (setuid, RSA, rc.local, spawn login) |
| `src/mirror/bin/login.ts` | passwd+shadow (bcrypt) authentication → setgroups/setgid/setuid → exec shell |
| `src/mirror/bin/tsh.ts` | Interactive shell (`IProgram` style) |
| `src/mirror/opt/asteracea/asteracea.ts` | WM + GUI login manager — verify via `login.js --verify`, re-elevate via Saved UID |
| `src/mirror/lib/UserLib.ts` | Framework: `std`, `fs`, `shell`, `net`, `db` (sub-library) |
| `src/mirror/lib/Application.ts` | `Program()` wrapper + proxy singleton |
| `src/mirror/lib/IProgram.ts` | `IProgram` & `OSContext` interfaces |

---

## Snippet (code level)

All snippets below are copied from the source — *code is the truth*.

### Init — enforce setuid

```ts
// Runtime mengeksekusi sidecar .js (bukan source .ts),
// jadi chmod harus di .js. Nilai 2541 = 0o4755 (setuid root).
await lib.fs.chmod("/bin/passwd.js", 2541);
await lib.std.print(`${ok} [INIT] SetUID bit applied to: /bin/passwd.js\n`);
await lib.fs.chmod("/bin/sudo.js", 2541);
await lib.std.print(`${ok} [INIT] SetUID bit applied to: /bin/sudo.js\n`);
```

> `ok` is the green `[  OK  ]` prefix defined at the start of `execute()` in `init.ts`.

### Init — spawnLogin (TTY2-6)

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

// Start login on all TTYs (TTY2-6)
for (let i = 2; i <= 6; i++) {
    await spawnLogin(i);
}
```

### Init — monitorProcess (respawn anti-crash-loop)

```ts
private async monitorProcess(
    lib: UserLib, ttyId: number, pid: number,
    respawn: (tty: number) => Promise<void>,
) {
    const exitCode = await lib.shell.waitpid(pid);
    await lib.std.print(
        `Init: Process on TTY${ttyId} (PID ${pid}) exited with code ${exitCode}. Respawning...\n`,
    );
    // Delay sedikit biar nggak spam kalau crash loop
    await new Promise(r => setTimeout(r, 1000));
    await respawn(ttyId);
}
```

### Login — bcrypt verification

```ts
// 1. Cari user di /etc/passwd → uid, gid, home, shell
const parts = userEntry.split(":");
const uid = parseInt(parts[2]);
const gid = parseInt(parts[3]);
const home = parts[5];
const userShell = parts[6];   // shell dari /etc/passwd field 7

// 2. Ambil hash dari /etc/shadow → bcrypt.compareSync
const hash = shadowEntry.split(":")[1];
const match = bcrypt.compareSync(password, hash);
if (!match) {
    await lib.std.print("Login: Invalid username or password\n");
    continue;   // kembali ke loop → prompt ulang
}
```

### Login — setgroups → setgid → setuid (POSIX order)

```ts
// 3.5. Resolve Supplementary Groups dari /etc/group
const supplementaryGids: number[] = [gid]; // dimulai dari primary gid
try {
    const groupContent = await lib.fs.readFile("/etc/group") || "";
    const groupLines = groupContent.split("\n")
        .map(l => l.trim()).filter(l => l.length > 0);
    for (const gLine of groupLines) {
        const gParts = gLine.split(":");
        const groupGid = parseInt(gParts[2]);
        const groupUsers = gParts[3] ? gParts[3].split(",") : [];
        if (groupUsers.includes(username.trim()) && groupGid !== gid) {
            supplementaryGids.push(groupGid);
        }
    }
} catch (e) {
    // Ignore group errors
}

// Set Identity — GID harus SEBELUM UID.
// Setelah UID menjadi non-root, proses kehilangan privilege untuk mengubah GID.
await lib.shell.setgroups(supplementaryGids);
await lib.shell.setgid(gid);
await lib.shell.setuid(uid);

// Set Env + exec shell
await lib.shell.setenv("USER", username.trim());
await lib.shell.setenv("HOME", home);
await lib.shell.chdir(home);
const result = await lib.shell.exec(userShell);   // shell dari /etc/passwd
if (result && result.pid) {
    await lib.shell.waitpid(result.pid);
}
```

### WM Login — verify via login.js --verify (file channel)

```ts
// asteracea.ts — verify password via a SetUID-root helper.
// A non-root WM cannot read /etc/shadow (0640 root) → delegate to login.js.
const verifyOut = `/tmp/verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
let authOk = false;
const vp = await shell.exec("/bin/login.js", ["--verify", u, password, verifyOut]);
if (vp && vp.pid) {
    await shell.waitpid(vp.pid);                     // wait until done
    const res = (await fs.readFile(verifyOut)) || "";
    authOk = String(res).trim() === "OK";            // "OK" / "FAIL:..."
}
await fs.unlink(verifyOut);                          // cleanup temp file
```

```ts
// login.ts — helper side (runs as SetUID root, so it can read shadow)
if (args[0] === "--verify") {
    const vUser = (args[1] || "").trim();
    const vPass = args[2] || "";
    const vOut  = args[3] || "/tmp/verify-result.txt";
    let ok = false, errMsg = "";
    try {
        const shadow = (await lib.fs.readFile("/etc/shadow")) || "";
        const entry = shadow.split("\n").map(l => l.trim()).filter(l => l)
            .find(l => l.split(":")[0] === vUser);
        const hash = entry ? entry.split(":")[1] : "";
        ok = !!hash && bcrypt.compareSync(vPass, hash);
        if (!hash) errMsg = "account not found or no password";
    } catch (e) { errMsg = e.message || "verify error"; }
    await lib.fs.writeFile(vOut, ok ? "OK" : "FAIL:" + errMsg);
    return;   // done — WorkerEntry finishes the process
}
```

### Saved UID (kernel) — setuid may restore to suid

```ts
// Syscalls.ts — SETUID with Saved UID (mirrors Unix setuid/seteuid)
if (this.isRoot(pcb)) {
    pcb.suid = pcb.uid;   // root may change UID freely; keep the way back (0 for root)
    pcb.uid = newUid;
    pcb.ruid = newUid;
} else if (newUid === pcb.suid) {
    pcb.uid = newUid;     // non-root may only RESTORE to its Saved UID (e.g. back to root)
    pcb.ruid = newUid;
} else {
    throw new Error("Permission Denied: Only root or root group members can change UID");
}

// Scheduler.ts — createProcess: suid defaults to the process's own UID
suid: options.suid ?? options.uid ?? 0,   // regular apps CANNOT escalate
```

### App — `IProgram` style (legacy)

```ts
// greet.ts — gaya klasik: class main implements IProgram
import { IProgram, OSContext } from "@tsix/IProgram";

export class main implements IProgram {
    async execute(lib: OSContext, args: string[]): Promise<string | void> {
        const name = args[0] || "dunia";
        await lib.std.print(`Halo, ${name}!\n`);
        await lib.std.print(`CWD: ${await lib.shell.getcwd()}\n`);
    }
}
```

### App — `Program()` wrapper style (new)

```ts
// halo.ts — gaya baru: Program() wrapper + proxy singleton
import { Program, std, os } from "@tsix/Application";

export default Program(async (args) => {
    const name = args[0] || "dunia";
    await std.print(`Halo, ${name}!\n`);
    await std.print(`PID: ${os.pid}\n`);
    return "Selesai.";
});
```

---

## Exercises / Practice

1. Log in as `root`, then run `ps` — identify the login process per TTY (`/bin/login.js`).
2. From the root shell, run `tsh tamu` — observe the login delegation (setuid root) and the new shell with a different user.
3. Read `src/mirror/bin/login.ts` — trace the `setgroups`/`setgid`/`setuid` order and explain why this order is mandatory.
4. Read `src/mirror/bin/init.ts` — find `monitorProcess`; kill the login process on a TTY (`kill <pid>` from root) then observe init respawning it within about 1 second.
5. Write an app in the `IProgram` style and an app in the `Program()` style — compare their structures (see Snippet).
6. Create an app that calls `std.error()` — observe the error window appearing on the desktop (`GUI_WINDOW_ERROR` message).

---

## References

- `wiki/Memulai.md`, `wiki/Perintah-Sistem.md`, `wiki/Panduan-Developer.md`
- `wiki/course/00-overview.en.md` §9 (Userland: init, shell, applications)
- `src/mirror/bin/init.ts`, `src/mirror/bin/login.ts`, `src/mirror/bin/tsh.ts`
- `src/mirror/lib/UserLib.ts`, `src/mirror/lib/Application.ts`, `src/mirror/lib/IProgram.ts`

---

*Module 14 — done. Part V complete. Continue to [Module 15 — Networking MQTNL](15-networking-mqtnl.en.md).*
