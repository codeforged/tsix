---
module: 06
title: Permissions & Security
part: II
partTitle: Boot & Kernel Runtime
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Permissions & Security

**RFC-TSIX-EDU-002** | The sixth module of the TSIX curriculum. Understand the rwx permission model, the setuid bit, root bypass, and known weaknesses in the TSIX permission system.

> PermissionManager is the kernel's "security guard". Every file access goes through layered checks: root bypass → owner → group → others. Plus the setuid bit for privileged binaries like `login` and `sudo`.

---

## Learning Objectives

- [ ] Explain the permission check order (root → owner → group → others)
- [ ] Explain the permission bits `r=4, w=2, x=1`
- [ ] Read the permission matrix and example modes (`600`, `644`, `755`, `4755`) with their decimal values
- [ ] Explain the setuid bit (`0o4000` = 2048) and its handling during `EXEC`
- [ ] Explain why `parseMode("4755")` is 2541 (decimal)
- [ ] Explain the `CHMOD` rule (owner or root) vs `CHOWN` (root only)
- [ ] Explain the app-name-based privilege weakness and its mitigation

---

## Core Concepts

### Layered rwx checks

```
check(pcb, node, requested):
  1. root (uid 0)        → true (God Mode)
  2. owner (uid == node.uid) → bit owner   ((mode >> 6) & 0x7)
  3. group (gid match)        → bit group   ((mode >> 3) & 0x7)
  4. others                   → bit others  (mode & 0x7)
```

![PermissionManager check flow (root → owner → group → others)](/wiki/diagram/Keamanan-dan-Sandboxing-3.png)
*Source: [`wiki/diagram/Keamanan-dan-Sandboxing-3.mmd`](/wiki/diagram/Keamanan-dan-Sandboxing-3.mmd)*

### rwx permission matrix

One mode = **3 octal digits**, one for each class: owner, group, and others. `check()` shifts the bits according to the class:

| Class | Calculation in `check()` | Bits | Example `644` (decimal 420) |
|---|---|---|---|
| **owner** (user) | `(mode >> 6) & 0x7` | r=4, w=2, x=1 | digit `6` → `rw-` |
| **group** | `(mode >> 3) & 0x7` | r=4, w=2, x=1 | digit `4` → `r--` |
| **others** | `mode & 0x7` | r=4, w=2, x=1 | digit `4` → `r--` |

### Encode permission

| Bit | Value | Meaning |
|---|---|---|
| r (read) | 4 | Read content |
| w (write) | 2 | Write / modify |
| x (execute) | 1 | Execute |

Bit combination per octal digit (used in the mode table below):

| Digit | Binary | rwx | Meaning |
|---|---|---|---|
| `0` | 000 | `---` | no access |
| `1` | 001 | `--x` | execute |
| `2` | 010 | `-w-` | write |
| `3` | 011 | `-wx` | write + execute |
| `4` | 100 | `r--` | read |
| `5` | 101 | `r-x` | read + execute |
| `6` | 110 | `rw-` | read + write |
| `7` | 111 | `rwx` | read + write + execute |

### Common modes & decimal values

Modes are stored as **decimal in SQLite** (not an octal string). `parseMode("4755")` = `parseInt("4755", 8)` = **2541** (decimal) — this is the value `init.ts` uses when it calls `chmod("/bin/passwd.js", 2541)`.

| Mode | Octal | Decimal | owner | group | others | Example usage |
|---|---|---|---|---|---|---|
| `600` | `0o600` | 384 | `rw-` | `---` | `---` | private files: `/etc/shadow`, SSH keys |
| `644` | `0o644` | 420 | `rw-` | `r--` | `r--` | plain text files (default mode of `touch` in the `OPEN` syscall) |
| `755` | `0o755` | 493 | `rwx` | `r-x` | `r-x` | directories & binaries (default mode of `mkdir`) |
| `4755` | `0o4755` | 2541 | `rws` | `r-x` | `r-x` | setuid binaries: `/bin/passwd.js`, `/bin/sudo.js` |

> The `s` in the owner position means the **setuid bit is active** (`0o4000` = 2048), not a regular `x`.
> The decimal values are confirmed by test `A5.10` (`644` → 420, `755` → 493) and `A5.13` (`4755 & 0o4000`).

### The SetUID bit (`0o4000`)

SetUID = execute as the **file owner**, not the caller. Example:

- `/bin/passwd.js` → `chmod 2541` (0o4755): a normal user runs passwd, and the process runs as root so it can modify `/etc/shadow`.
- `/bin/sudo.js` → same.

**Handling during `EXEC`** (in `Syscalls.ts`): the `0o4000` bit = **2048** (decimal). When executing a binary, the kernel checks `node.mode & 2048`. If active, `targetUid = node.uid` and `targetGid = node.gid`; the new process is born with the file owner's uid/gid, while `ruid` (real UID) stays with the caller. See the snippet below.

> Note: the runtime executes the `.js` sidecar, so SetUID must be set on `/bin/*.js`, not the source `.ts` files. This is what `init.ts` does: `lib.fs.chmod("/bin/passwd.js", 2541)` and `lib.fs.chmod("/bin/sudo.js", 2541)`. `rc.local.ts` also sets `chmod("/bin/login.js", 0o4755)`.

The POSIX order during login: `setgroups → setgid → setuid` (this order is required so the group is correct). Visible in `login.ts`: `setgroups(supplementaryGids) → setgid(gid) → setuid(uid)`.

---

## Snippet (code level)

### PermissionManager.check()

```ts
public check(pcb: PCB, node: any, requested: Permission): boolean {
    if (pcb.uid === 0) return true;            // 1. root bypass

    const mode = node.mode;                    // decimal di SQLite

    if (pcb.uid === node.uid) {                // 2. owner
        const userMode = (mode >> 6) & 0x7;
        if ((userMode & requested) === requested) return true;
    }

    if (pcb.gid === node.gid || (pcb.groups && pcb.groups.includes(node.gid))) {
        const groupMode = (mode >> 3) & 0x7;   // 3. group
        if ((groupMode & requested) === requested) return true;
    }

    const otherMode = mode & 0x7;              // 4. others
    if ((otherMode & requested) === requested) return true;

    return false;
}

public static parseMode(octal: string | number): number {
    return parseInt(octal.toString(), 8);      // "4755" → 2541
}
```

### EXEC — permission enforcement & setuid (Syscalls.ts)

```ts
// 1. Cek x bit dulu — tanpa izin eksekusi, langsung ditolak
if (!this.satpam.check(pcb, node, Permission.EXECUTE)) {
  throw new Error(`Permission Denied: Cannot execute ${absoluteExecPath}`);
}

let targetUid = pcb.uid;
let targetGid = pcb.gid;
let targetOwner = pcb.owner;

// 2. SETUID BIT SUPPORT (0o4000 = 2048)
if (node && node.mode & 2048) {
  targetUid = node.uid;        // eksekusi sebagai pemilik file
  targetGid = node.gid;
  if (targetUid === 0) targetOwner = "root";
  this.logger.info(
    `SetUID Execution detected for ${absoluteExecPath}: Running as UID ${targetUid}`,
  );
}

// 3. Proses baru lahir dengan uid/gid target; ruid (real UID) dipertahankan
const newPcb = this.scheduler.createProcess(binaryName, {
  // ...
  uid: targetUid,
  gid: targetGid,
  ruid: pcb.ruid, // Preserve Real UID
  owner: targetOwner,
  // ...
});
```

> This path is the security key for `/bin/login.js`, `/bin/passwd.js`, and `/bin/sudo.js`: a normal user cannot setuid directly, but executing a setuid-root binary makes the process run as `uid 0`.

### OPEN — read vs write (Syscalls.ts)

```ts
const requiredPerm =
  flags.includes("w") || flags.includes("+")
    ? Permission.WRITE
    : Permission.READ;

const node = vfs.stat(relativePath);

if (node) {
  // File sudah ada → cek izin file itu sendiri
  if (!this.satpam.check(pcb, node, requiredPerm)) {
    throw new Error(
      `Permission Denied: Cannot open ${absoluteOpenPath} for ${Permission[requiredPerm]}`,
    );
  }
} else if (requiredPerm === Permission.WRITE) {
  // File belum ada → cek WRITE ke direktori parent, lalu buat mode 420 (644)
  // ...
  vfs.touch(relativePath, "", pcb.uid, pcb.gid, 420); // 644 equivalent
}
```

### CHMOD — change mode (Syscalls.ts)

```ts
case SyscallCode.CHMOD: {
  const { path: argPath, mode } = args as { path: string; mode: number };
  const absolutePath = PathResolver.resolve(pcb.cwd, argPath);

  if (absolutePath.startsWith("/dev/")) {
    if (!this.isRoot(pcb)) return false;   // chmod /dev/* → root only
    const devName = absolutePath.replace("/dev/", "");
    const device = this.kernel.devices[devName];
    if (!device) return false;
    device.mode = mode;
    return true;
  }

  const { vfs, relativePath } = this.mountManager.resolve(absolutePath);
  const node = vfs.stat(relativePath);
  if (!node) return false;
  if (pcb.uid !== 0 && pcb.uid !== node.uid) return false; // root ATAU owner
  return vfs.chmod(relativePath, mode);
}
```

> `CHMOD` rule: a regular file may be changed by **its owner or root**. Verified by test `A5.11`.

### CHOWN — change owner/group (Syscalls.ts)

```ts
case SyscallCode.CHOWN: {
  const {
    path: argPath,
    uid: targetUid,
    gid: targetGid,
  } = args as { path: string; uid: number; gid: number };
  const absolutePath = PathResolver.resolve(pcb.cwd, argPath);

  if (absolutePath.startsWith("/dev/")) {
    if (!this.isRoot(pcb)) return false;   // chown /dev/* → root only
    // ...
  }

  if (!this.isRoot(pcb)) return false;     // chown file → ROOT SAJA
  const { vfs, relativePath } = this.mountManager.resolve(absolutePath);
  return vfs.chown(relativePath, targetUid, targetGid);
}
```

> `CHOWN` rule: **only root** may change a file's owner (test `A5.15`). Unlike `CHMOD`, which the owner may also do.

---

## Known Weaknesses

> [!WARNING] **App-name-based privilege (fragile).**
> In `WorkerEntry.ts`, `restrictHostAPI(appName)` marks an app as "privileged" if the **substring** of its name (after `toLowerCase()`) contains one of:
>
> ```ts
> const isPrivileged = appName.toLowerCase().includes("server") ||
>     appName.toLowerCase().includes("daemon") ||
>     appName.toLowerCase().includes("dome") ||
>     appName.toLowerCase().includes("tbuild") ||
>     appName.toLowerCase().includes("vfs") ||
>     appName.toLowerCase().includes("mysqld");
> ```
>
> A privileged app gets an **allow-list of host modules**:
>
> ```ts
> const allowedModules = ["http", "ws", "path", "fs", "url", "esbuild", "crypto", "os", "bcryptjs", "mysql2", "mysql2/promise"];
> ```

**Exploitation scenario (example):**

1. An attacker uploads an app named `evil-daemon` (the name contains `daemon`).
2. When executed, `isPrivileged = true` → `global.require = privilegedRequire`.
3. The app can now `require("fs")`, `require("crypto")`, `require("http")`, etc. — **direct host** Node.js modules, not TSIX syscalls.
4. With `fs`, the attacker can read files outside the TSIX VFS sandbox (e.g., the host Linux `/etc/shadow`) → **sandbox escape**.

> [!IMPORTANT] **Mitigation.**
> - **Long-term (architectural):** replace the substring heuristic with **capability-based** checks — an explicit list of `appName → capabilities` pairs (or a per-app manifest).
> - **Now (defense-in-depth):** even if an app is "privileged" inside the sandbox, the kernel still has `PermissionManager` + `validateArgs` + root-only `SETUID`. The app name only opens the host module door — **not** full kernel access; every syscall is still checked per-invocation on the kernel side.

---

## Exercises / Practice

1. Run `ls -l /bin/passwd.js` — observe the setuid bit (`s`) in the owner mode (mode `rwsr-xr-x`).
2. Run `stat /bin/passwd.js` — check the decimal mode value (should be `2541` = `0o4755`).
3. Run `chmod 755 /bin/passwd.js` then `ls -l` again — the `s` bit disappears; `init` will set it again (`init.ts`).
4. As a non-root user, try to read `/etc/shadow` — observe the permission error.
5. As a non-root user, run `chown root /tmp/foo` — observe the error (only root may chown); then `chmod 600 /tmp/foo` — must succeed because the owner may chmod.
6. Read `src/kernel/PermissionManager.ts` and `src/kernel/Syscalls.ts` — find all call sites of `satpam.check()`.
7. Read `src/userland/WorkerEntry.ts` → the `restrictHostAPI` function — test: run an app named `evil-daemon` that calls `require("fs")`, and compare it with a normal app named `hitung`.

---

## References

- `wiki/Keamanan-dan-Sandboxing.md` — complete security model
- `wiki/course/00-overview.en.md` §4.3 (ring model & privilege boundaries)
- `src/kernel/PermissionManager.ts` — implementation of `check()` & `parseMode()`
- `src/kernel/PermissionManager.test.ts` — tests A5.1–A5.30 (rwx, chmod, chown, umask, setuid, sudo)
- `src/kernel/Syscalls.ts` — OPEN/EXEC/CHMOD/CHOWN permission enforcement + setuid in EXEC
- `src/userland/WorkerEntry.ts` — the `restrictHostAPI` sandbox (name-based privilege)
- `src/mirror/bin/init.ts`, `src/mirror/bin/rc.local.ts` — setuid bit setup
- `src/mirror/bin/login.ts`, `src/mirror/bin/sudo.ts` — the setgroups/setgid/setuid flow

---

*Module 06 — complete. Continue to [Module 07 — Mount & Path Resolution](07-mount-path-resolution.en.md).*
