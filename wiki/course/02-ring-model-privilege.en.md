---
module: 02
title: Ring Model & Privilege Boundaries
part: I
partTitle: Foundations
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Ring Model & Privilege Boundaries

**RFC-TSIX-EDU-002** | The second module of the TSIX curriculum. Understand the "Ring" concept as a privilege boundary, and where the *actual* security boundary sits in TSIX.

> Important: **A Ring in TSIX is a concept (documentation), not a hardware isolation mechanism.** TSIX runs on top of V8, not on bare metal. The real boundaries live in two layers: the **WorkerEntry sandbox** and the **PermissionManager (kernel)**.

---

## Learning Objectives

- [ ] Explain the contents of each Ring 0–4 and its main files
- [ ] Distinguish a Ring as a concept vs. a real isolation mechanism
- [ ] Explain the two real privilege boundary layers: the WorkerEntry sandbox & the PermissionManager
- [ ] Explain what the setuid bit is and an example of its use
- [ ] Know the weakness of privilege based on app name

---

## Core Concepts

### Ring Map

| Ring | Contents | Main files |
|------|----------|------------|
| **0** | Host: Linux + Node/V8 | — (reserved) |
| **1** | Kernel core: Scheduler, Syscall, Permission | `src/kernel/*`, `src/common/*` |
| **2** | Drivers & FS: HAL devices, VFS backends, MountManager | `src/kernel/devices/*`, `src/vfs/*` |
| **3** | Library framework: UserLib, Application | `src/mirror/lib/*` |
| **4** | Apps: `/bin/*`, `init`, `tsh`, daemon | `src/mirror/bin/*` |

![Ring 1 & 2 — kernel internals (dispatcher, scheduler, FS/Net/HAL stacks)](/wiki/diagram/Arsitektur-Sistem-2.png)
*Source: [`wiki/diagram/Arsitektur-Sistem-2.mmd`](/wiki/diagram/Arsitektur-Sistem-2.mmd)*

A Ring is a **map of responsibility** — not isolation enforced by V8. Two files from different rings may call each other; what keeps the system secure are the rules below.

### Comparison with Linux

| Feature | Linux Equivalent | TSIX Ring |
|---|---|---|
| Core OS Logic | Ring 0 (Kernel Mode) | **Ring 1** |
| Drivers & FS | Ring 0 (Kernel Mode) | **Ring 2** |
| Standard Library | Ring 3 (glibc) | **Ring 3** |
| User Apps | Ring 3 (User Mode) | **Ring 4** |

> [!NOTE] **Ring 0 is the host domain.** Because TSIX is not bare metal, "Ring 0" means Linux/Windows + V8. TSIX starts numbering from Ring 1.

---

## The Two Real Privilege Boundary Layers

### Layer 1 — WorkerEntry Sandbox (worker side)

`src/userland/WorkerEntry.ts` is the **bootloader** of every worker. It locks the door before the app runs:

- An app may only `require` the `@tsix/*` / `@common/*` frameworks — everything else is blocked.
- `process.exit` / `process.kill` are sabotaged (thrown).
- **Privileged** apps (name contains `server`, `daemon`, `dome`, `tbuild`, `vfs`) get an **allow-list** of host modules: `http`, `ws`, `path`, `fs`, `url`, `esbuild`, `crypto`, `os`, `bcryptjs`.

### Layer 2 — PermissionManager (kernel side)

`src/kernel/PermissionManager.ts` is the "security guard" in the kernel. It performs layered rwx checks:

```
check(pid, path, mode):
  root (uid 0) → bypass
  owner        → check owner bit
  group        → check group bit
  others       → check others bit
```

The **SetUID bit** (`0o4000`) is supported: a process runs with the file's ownership. Example: `/bin/login` has mode `0o4755` — whoever runs login, the process runs as root (to perform setuid/setgid to the target user).

---

## Source Code

| File | Role |
|---|---|
| `src/userland/WorkerEntry.ts` | Worker-side sandbox (restrictHostAPI) |
| `src/kernel/PermissionManager.ts` | rwx checks + setuid |
| `src/kernel/Syscalls.ts` | Call the permission check before an action |
| `src/mirror/bin/login.ts` | Example of setuid usage (`0o4755`) |

---

## Snippet (code level)

```ts
// src/kernel/PermissionManager.ts — core of the permission check (condensed)
check(pid: number, path: string, mode: number): boolean {
  const { uid, gid } = this.scheduler.getProcess(pid);
  const stat = this.getStat(path);
  if (uid === 0) return true;            // root bypass
  if (uid === stat.uid) return !!(stat.mode & mode);        // owner
  if (gid === stat.gid) return !!(stat.mode & (mode >> 3)); // group
  return !!(stat.mode & (mode >> 6));                       // others
}
```

> [!WARNING] **Known weakness.** Privileged status is based on **app name substring** — a fragile heuristic. Anyone who names their app `my-daemon` automatically becomes privileged. Ideally this should be replaced with *capability-based*.

---

## Exercises / Practice

1. Read `src/userland/WorkerEntry.ts` — find the allow-list of host modules.
2. Read `src/kernel/PermissionManager.ts` — test the rwx check logic with several uid/gid/mode combinations.
3. Run a non-privileged app that tries to `require("fs")` — observe the error that appears.

---

## References

- `wiki/ARCHITECTURE_RINGS.md` — official ring definitions
- `wiki/Keamanan-dan-Sandboxing.md` — sandbox details
- `wiki/course/00-overview.md` §2

---

*Module 02 — done. Continue to [Module 03 — Boot Sequence](03-boot-sequence.en.md).*
