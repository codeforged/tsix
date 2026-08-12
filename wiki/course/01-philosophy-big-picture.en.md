---
module: 01
title: Philosophy & Big Picture
part: I
partTitle: Foundations
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Philosophy & Big Picture

**RFC-TSIX-EDU-002** | The first module of the TSIX curriculum. Builds a mental map: what TSIX is, why it was designed this way, and the four core principles that form the foundation of the entire system.

> Before writing code, understand the **philosophy** first. TSIX is not just an "OS emulator" — it is an **OS abstraction built on top of the existing Node.js runtime**. This module explains *why* it was designed this way, and the four principles that are consistent across all subsystems.

---

## Learning Objectives

- [ ] Explain what TSIX is and how it differs from a VM/emulator
- [ ] Name the four core principles of the TSIX architecture
- [ ] Explain why the kernel, drivers, and FS are combined into a single thread
- [ ] Recognize the Ring 0–4 layers and their contents in broad outline
- [ ] Explain why the kernel never executes applications

---

## Core Concepts

### What is TSIX?

TSIX is a **simulated operating system based on Node.js + TypeScript**. It is not a VM that emulates a CPU. It builds an **OS abstraction on top of the existing Node.js runtime** — using `Worker Thread` as the process boundary, `postMessage` as IPC, and `SQLite` as the filesystem.

```
┌──────────────────────────────────────────────────────────────────┐
│ HOST — Linux + Node.js + V8                                      │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ MAIN THREAD = KERNEL (Ring 1-2)                            │  │
│  │  • Boot subsistem • Syscall dispatcher • Scheduler         │  │
│  │  • VFS (SQLite) • HAL devices • GUI registry               │  │
│  └───────────────────────────────┬────────────────────────────┘  │
│                                  │ new Worker() + postMessage    │
│  ┌───────────────────────────────┼────────────────────────────┐  │
│  │ WORKER THREAD #1 (Ring 4)     │  WORKER THREAD #N (Ring 4) │  │
│  │  /bin/init.js  (PID 1)        │  /bin/ls.js, /bin/dome.ts, │  │
│  │  /bin/login, /bin/tsh         │  aplikasi user...          │  │
│  └───────────────────────────────┴────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

With this approach, TSIX adopts **UNIX architecture concepts** — process isolation, UID/GID permissions, POSIX filesystem, signal handling, device abstraction (HAL), syscall communication — expressed in TypeScript on top of Node.js.

### Why not a microkernel?

One of the most fundamental architectural decisions: **the kernel, drivers, and filesystem are combined into a single main thread**, not split into separate threads like a pure microkernel (Minix, QNX, seL4).

| Reason | Explanation |
|---|---|
| **IPC overhead** | A pure microkernel = 3–4x `postMessage` per operation (App → Kernel → FS → Kernel → App). A single thread = 1x (App → Kernel). Each `postMessage` performs a structured clone (serialize → deserialize). |
| **Worker limitation** | Node.js Worker Threads **cannot use shared memory**. Each transfer = new allocation + data copy. The larger the data, the larger the overhead. |
| **Embedded target** | TSIX is for IoT with limited CPU and small RAM. Each additional Worker = ~4–8MB heap. |
| **Isolation already exists** | Applications (Ring 4) are already in a separate worker → 90% of the isolation benefit at 10% of the cost. |

**The result:** the most frequent crashes are user applications — and they are already isolated. Kernel + drivers + FS rarely crash, and even if they do, the system dies (but that is rare).

---

## Four Core Principles

### 1. "Syscall = the only door"

Worker threads **never touch resources directly**. Even `print` goes through a syscall. This keeps the ring boundary truly meaningful — there are no shortcuts.

```
App → UserLib.dispatch(code, args) → postMessage → Kernel → dispatch → kembali
```

### 2. "Everything is a File"

Files and devices are both `IDevice`; `read/write` is polymorphic.

- Opening a regular file → `FileSystemDevice`
- Opening `/dev/tty1` → `TTYDevice`
- Opening `/dev/smqtnl0` → `SimpleMQTNLDriver`

Even pipes and sockets are devices. One contract, many implementations.

### 3. "Direct Memory Execution" (DME)

The framework (`/lib`) is pre-compiled into memory at boot, sent to workers via `workerData`, and executed **without a filesystem hit**. `@tsix/*` feels instant — there is no recompilation per process.

### 4. "Unix fidelity first, pragmatic later"

TSIX mirrors Unix/Linux behavior and architecture as closely as practical — syscall semantics, UID/GID permissions, credentials (saved UID), file formats (`/etc/shadow`, `passwd`), filesystem hierarchy — as the design **north star**. Not because it "must match exactly", but because **observable** behavior must be consistent: non-root cannot read `/etc/shadow`, a non-root process cannot `setuid` arbitrarily, and so on.

Deviating from Unix is **allowed**, but only when the Node.js/V8 runtime truly cannot model it — never as a "it's easier this way" shortcut. Every deviation **must be documented** (a changelog entry and/or a code comment) with a clear technical reason, so it is not mistaken for a bug.

> [!NOTE] **Semantics > Mechanisms** — there is no need to emulate bare-metal (hardware interrupts, MMU, etc.). What matters is that behavior observed from userland matches Unix. Example: `setuid` is simulated with a saved UID (`pcb.suid`) in the kernel, not with a CPU register — but the effect is the same.

---

## Source Code

| File | Role |
|---|---|
| `src/main.ts` | Host entry point + keep-alive |
| `src/kernel/Kernel.ts` | Boot orchestrator for all subsystems |
| `src/kernel/Syscalls.ts` | Syscall dispatcher |
| `src/kernel/Scheduler.ts` | Process management |
| `src/userland/WorkerEntry.ts` | Worker bootloader + sandbox |
| `src/common/IPCTypes.ts` | IPC contract |

---

## Exercises / Practice

1. Read `src/main.ts` — find where the 100ms keep-alive is. What happens if PID 1 exits with code 1?
2. Read `src/kernel/Kernel.ts` — list the order of `initializeSubsystems()`. Compare it with the boot diagram in Module 03.
3. Run TSIX (`npm start` / per `README.md`) and observe the boot log.

---

## References

- `wiki/Arsitektur-Sistem.md` — layer diagram and microkernel analysis
- `wiki/course/00-overview.en.md` §1 — global mental map
- `src/main.ts`, `src/kernel/Kernel.ts`

---

*Module 01 — complete. Continue to [Module 02 — Ring Model & Privilege Boundaries](02-ring-model-privilege.en.md).*
