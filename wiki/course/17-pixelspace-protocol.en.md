---
module: 17
title: PixelSpace Protocol
part: VII
partTitle: GUI & Desktop
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# PixelSpace Protocol

**RFC-TSIX-EDU-002** | Seventeenth module of the TSIX curriculum. Understand the GUI data contract: the Worker→Kernel→DOME→Browser data flow, GUIRegistry as the window ownership authority, and the security sanctions.

> PixelSpace is the **constitution of TSIX's GUI**. Its contract (`GUITypes.ts`) must not be changed carelessly — every layer above it (DOME, Emerald, Cashew, Asteracea) depends on the shape of this data.

---

## Learning Objectives

- [ ] Explain the UI mounting and event data flow
- [ ] Explain the role of GUIRegistry (auth wid↔pid)
- [ ] Mention the main GUIActions
- [ ] Explain the security sanctions (SIGKILL / SIGSEGV)
- [ ] Explain why the kernel overrides `payload.pid`

---

## Core Concepts

### Data flow

```
Worker (app) → GUI_REQ (61) → Kernel (GUIRegistry auth pid↔wid)
  → DOME daemon (WS broadcast) → Browser (DOM)
Browser → event → DOME → Kernel (SEND_MSG) → Worker (callback)
```

### UI mounting flow

```
Worker App   → GUI_REQ (MOUNT_NODE) → Kernel → gui_request event → DOME → WS → Browser (createElement)
```

### Event flow (click/input)

```
Browser → WS → DOME → SEND_MSG ke pid → Kernel → ipc_message event → Worker → callback → updateProps
```

### GUIAction (GUI operations)

| Action | Purpose |
|---|---|
| `CREATE_WINDOW` / `DESTROY_WINDOW` | Create / destroy a window |
| `MOUNT_NODE` / `UNMOUNT_NODE` | Mount / unmount an element |
| `UPDATE_PROPS` | Change element properties |
| `MINIMIZE_WINDOW` / `RESTORE_WINDOW` | Hide / restore |
| `MAXIMIZE_WINDOW` / `UNMAXIMIZE_WINDOW` | Fullscreen / normal |

### GUIRegistry (kernel)

The **single** authority for window ownership:

- `wid → pid` (primary map) + `pid → Set<wid>` (reverse map, fast lookup on exit)
- Z-index auto-increment (starts at 100)
- `registerDaemon(pid)` — only "gued" may receive forwarded GUI_REQ
- Automatic cleanup when a process dies (`destroyAllForPid`)

### Security

| Violation | Sanction |
|---|---|
| Malformed payload format | `SIGKILL` — process is killed |
| Accessing a window owned by another PID | `SIGSEGV` — segmentation fault |

> [!IMPORTANT] **The kernel always overrides `payload.pid`.** Never trust the `pid` sent by the application — the kernel sets the real identity from the process context.

---

## Source Code

| File | Role |
|---|---|
| `src/common/GUITypes.ts` | Data contract (IDOMNode, IGUIPayload, GUIAction, IBrowserEvent, IGUIEventIPC) |
| `src/kernel/GUIRegistry.ts` | Window authority + auth |
| `src/kernel/Syscalls.ts` | `GUI_REQ` handler + security |
| `src/mirror/root/ps-sample1.ts` | Raw protocol practice |

---

## Snippet (code level)

### GUIRegistry.createWindow

```ts
public createWindow(wid: string, pid: number, title: string = "Untitled"): IWindowEntry {
    if (this.windows.has(wid)) {
        throw new Error(`GUIRegistry: Window '${wid}' already exists.`);
    }
    const entry: IWindowEntry = { wid, pid, title,
        zIndex: this.nextZIndex++, focused: true, createdAt: Date.now() };
    this.windows.set(wid, entry);
    // Update reverse map pid → Set<wid>
    if (!this.pidToWids.has(pid)) this.pidToWids.set(pid, new Set());
    this.pidToWids.get(pid)!.add(wid);
    // Defocus window lain
    return entry;
}
```

---

## Exercise / Practice

1. Read `src/common/GUITypes.ts` — understand the entire "constitution" interface.
2. Read `src/mirror/root/ps-sample1.ts` — practice the raw protocol without a toolkit.
3. Run a GUI app then `ps` — find the gued/DOME PID. Read `wiki/identity_guid_ipc_walkthrough.md` for the identity flow.
4. Modify a window owned by another PID via GUI_REQ — observe SIGSEGV.

---

## References

- `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §1-2, 10
- `wiki/course/00-overview.en.md` §10
- `src/common/GUITypes.ts`, `src/kernel/GUIRegistry.ts`, `src/kernel/Syscalls.ts`

---

*Module 17 — complete. Continue to [Module 18 — DOME Engine](18-dome-engine.en.md).*
