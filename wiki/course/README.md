# TSIX Documentation

Official, structured documentation for TSIX — an educational OS-like runtime
built on Node.js/TypeScript. This is the recommended entry point for learning
how TSIX works and how to build on top of it.

> Note: TSIX is an educational/experimental project. These docs describe how
> the system currently behaves; they may lag behind the code. When the wiki
> and the code disagree, the code wins (see [format.md](format.md)).

## How to read

- Start with [Module 00 — Overview & Mental Map](00-overview.md).
- Modules can be read in order or jumped into by topic.
- Each module follows a consistent structure: objectives -> concepts -> snippet
  -> practice (see [format.md](format.md)).
- The detailed roadmap with code references lives in [toc.md](toc.md).

## Course Modules

Status: **Complete** = full module, **Partial** = exists but can be deepened,
**Draft** = planned / not yet written.

### Part I — Foundations

| # | Module | Status |
|---|--------|--------|
| 00 | [Overview & Mental Map](00-overview.md) | Complete |
| 01 | [Philosophy & Big Picture](01-philosophy-big-picture.md) | Complete |
| 02 | [Ring Model & Privilege Boundaries](02-ring-model-privilege.md) | Complete |

### Part II — Boot & Kernel Runtime

| # | Module | Status |
|---|--------|--------|
| 03 | [Boot Sequence](03-boot-sequence.md) | Complete |
| 04 | [Processes & Scheduler](04-processes-scheduler.md) | Complete |
| 05 | [Syscalls & IPC](05-syscall-ipc.md) | Complete |
| 06 | [Permissions & Security](06-permission-security.md) | Complete |
| 07 | [Mount & Path Resolution](07-mount-path-resolution.md) | Complete |

### Part III — Storage & I/O

| # | Module | Status |
|---|--------|--------|
| 08 | [VFS](08-vfs.md) | Complete |
| 09 | [FD Table & File Syscalls](09-fd-table-file-syscalls.md) | Complete |
| 10 | [Device Drivers (HAL)](10-device-drivers-hal.md) | Complete |

### Part IV — Process Isolation

| # | Module | Status |
|---|--------|--------|
| 11 | [Worker Thread & Sandbox](11-worker-thread-sandbox.md) | Complete |
| 12 | [Module Resolution & Direct Memory Execution](12-module-resolution-dme.md) | Complete |

### Part V — Human Interaction

| # | Module | Status |
|---|--------|--------|
| 13 | [TTY & Virtual Console](13-tty-virtual-console.md) | Complete |
| 14 | [Userland: init / login / shell / apps](14-userland-init-login-shell.md) | Complete |

### Part VI — Networking

| # | Module | Status |
|---|--------|--------|
| 15 | [Networking MQTNL](15-networking-mqtnl.md) | Complete |
| 16 | [Wire Protocol MQTNL](16-wire-protocol-mqtnl.md) | Complete |

### Part VII — GUI & Desktop

| # | Module | Status |
|---|--------|--------|
| 17 | [PixelSpace Protocol](17-pixelspace-protocol.md) | Complete |
| 18 | [DOME Engine (Display Server)](18-dome-engine.md) | Complete |
| 19 | [Emerald Widget Toolkit](19-emerald-widget-toolkit.md) | Complete |
| 20 | [Cashew Component Framework](20-cashew-component-framework.md) | Complete |
| 21 | [Asteracea & TDE (Window Manager)](21-asteracea-tde.md) | Complete |
| 22 | [State Replay & Persistence](22-state-replay-persistence.md) | Complete |

### Part VIII — Development

| # | Module | Status |
|---|--------|--------|
| 23 | [Development Workflow](23-development-workflow.md) | Complete |
| 24 | [Best Practices & Writing Apps](24-best-practices.md) | Complete |
## Languages

Each module has an Indonesian version (`NN-*.md`) and an English translation
(`NN-*.en.md`). Open the docs in the course server with `?lang=en` to view
the English versions (it falls back to the Indonesian file when a translation
does not exist yet). The roadmap also has an English version (`toc.en.md`).
## Reference

- [format.md](format.md) — document format & style conventions.
- [toc.md](toc.md) — detailed roadmap with code references per module.
- `course-server.ts` — local browser renderer for these docs.
