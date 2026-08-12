---
module: 05
title: Syscalls & IPC
part: II
partTitle: Boot & Kernel Runtime
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Syscalls & IPC

**RFC-TSIX-EDU-002** | Fifth module of the TSIX curriculum. Understand the TSIX mini ABI: how applications call the kernel via syscall, request-response correlation, and push events from the kernel to the worker.

> TSIX syscalls are **purely asynchronous RPC**. No order is guaranteed — every request carries a `requestId` (UUID) and is answered with the same `requestId`. This differs from synchronous traps in Linux.

---

## Learning Objectives

- [ ] Explain the complete flow of one syscall (from app to return)
- [ ] Explain the role of `requestId` + `responseMap`
- [ ] Distinguish request-response vs push events
- [ ] Name several important syscall codes (1–73)
- [ ] Explain the role of `validateArgs`

---

## Core Concepts

**TSIX uses asynchronous *request-response* IPC** — not synchronous traps like Linux. The application and the kernel run in separate *threads* (Worker vs main thread). The only bridge is `postMessage` in both directions.

| Concept | Explanation |
|---|---|
| **`SyscallRequest`** | Packet app → kernel: `{ requestId, pid, code, args }` |
| **`SyscallResponse`** | Packet kernel → app: `{ requestId, success, data?, error? }` |
| **`requestId`** (UUID) | Correlates request ↔ response. Created in `UserLib.dispatch`, reused by the kernel when replying. |
| **`responseMap`** | Map on the app side: `requestId` → callback resolve/reject. Replies are matched through this key. |
| **Push event** | Kernel → app notification *without* requestId: `{ type, data }` (signal, ipc_message, gui_request, db_request, resize). |
| **`validateArgs`** | Argument contract in the kernel: checks which syscalls must have `args`, plus type checks per syscall. |

> [!IMPORTANT]
> Because RPC is purely asynchronous, **reply order is not guaranteed**. Two consecutive syscalls (A then B) can be answered with B first. Correlation always goes through `requestId`, never through order.

---

## Flow / How It Works

### Full syscall flow: `PRINT`

Simplest example: the app calls `std.print("hello")`. Here is the complete path (code is truth):

```ts
// src/mirror/lib/UserLib.ts — StdLib
public async print(text: string) {
  return await this.dispatch(SyscallCode.PRINT, text);
}
```

**Step by step:**

1. `std.print("hello")` calls `UserLib.dispatch(PRINT, "hello")` on the worker side.
2. `dispatch()` creates `requestId = uuidv4()`, stores the callback in `responseMap`, then `parentPort.postMessage({ requestId, pid, code: PRINT, args: "hello" })`.
3. The kernel receives the message in `Scheduler.spawnWorker()` → handler `pcb.worker.on("message", ...)`.
4. The handler calls `syscallHandler(request)` — wired in `Kernel.initializeSubsystems()` via `scheduler.setSyscallHandler(...)`.
5. `SyscallDispatcher.handleRequest(req)` → `validateArgs(PRINT, args)` → `dispatch(pid, PRINT, args)`.
6. The `PRINT` case takes FD 1 from `pcb.fdTable`, then `entry.device.write("hello")` → output to screen.
7. The result (`0`) returns to the Scheduler handler; the Scheduler replies `postMessage({ requestId, success: true, data: 0 })`.
8. In the worker, `parentPort.on("message")` finds `requestId` in `responseMap`, calls the callback → Promise `resolve(0)` → `await print` finishes.

```mermaid
sequenceDiagram
    participant App as Aplikasi (Worker)
    participant Lib as UserLib (dispatch)
    participant Sch as Scheduler (worker.on message)
    participant Disp as SyscallDispatcher
    participant Dev as Device (fdTable[1])

    App->>Lib: std.print("hello")
    Lib->>Lib: requestId = uuidv4(); responseMap.set(requestId, cb)
    Lib->>Sch: postMessage({ requestId, pid, code: PRINT, args })
    Sch->>Disp: await syscallHandler(request)
    Disp->>Disp: validateArgs(PRINT, args)
    Disp->>Dev: dispatch(pid, PRINT, args) → fdTable[1].device.write()
    Dev-->>Disp: return 0
    Disp-->>Sch: return 0
    Sch-->>Lib: postMessage({ requestId, success: true, data: 0 })
    Lib->>Lib: cocokkan requestId di responseMap → resolve(0)
    Lib-->>App: await print selesai
```

Request-response correlation via `requestId` (UUID) + `responseMap` — purely asynchronous RPC. Many syscalls can be in-flight at once.

### Push events (kernel → worker, without requestId)

Unlike request-response, push events have no `requestId`. The kernel sends `{ type, data }` whenever needed:

```
{ type, data }
```

Types actually used in the code (`Scheduler.ts`, `Syscalls.ts`, `Kernel.ts`):

| `type` | Usage in code | Purpose |
|---|---|---|
| `signal` | `sendEvent(pid, "signal", "SIGINT")` etc. | Signals to processes (SIGINT, SIGTERM, SIGSTOP, SIGCONT, SIGWINCH, SIGSEGV...) |
| `ipc_message` | `SEND_MSG` between apps; forward `NET_SNIFF` packets | Horizontal IPC / sniffer |
| `gui_request` | Window cleanup & forward to GUI daemon | GUI daemon (PixelSpace) |
| `db_request` | `forwardDbRequest` → DB service daemon | Alternative database transport |
| `resize` | `broadcastEvent("resize", { lines, columns })` when host terminal changes | All active processes |

> [!NOTE]
> On the worker side, `UserLib.parentPort.on("message")` distinguishes three things: (1) syscall reply — has a `requestId` matching in `responseMap`; (2) event — has `type` and `type !== "signal"`; (3) signal — `type === "signal"`, with default action `SIGINT → exit(130)` and `SIGTERM → exit(143)` when there is no listener.

---

## Main Syscall List (mini ABI)

| Kode | Nama | Kode | Nama |
|---|---|---|---|
| 1 | `PRINT` | 29 | `PIPE` |
| 2 | `MKDIR` | 30–34 | `SOCKET/BIND/SENDTO/RECVFROM/NETSTAT` |
| 3 | `LS` | 35 | `UPTIME` |
| 4 | `EXIT` | 36 | `DETACH` |
| 5–8 | `OPEN/READ/WRITE/CLOSE` | 37 | `UNAME` |
| 9 | `SCREEN_INFO` | 38 | `SETGROUPS` |
| 10–12 | `PS/KILL/EXEC` | 40–41 | `GET_SYSPATH/GET_USAGE` |
| 13–14 | `CHDIR/GETCWD` | 50 | `SHUTDOWN` |
| 15–16 | `CHMOD/CHOWN` | 53–55 | `SYNC_TO_HOST/REEXEC/SYNC_FROM_HOST` |
| 17–19 | `WHOAMI/GETENV/SETENV` | 56–58 | `MOUNT/UMOUNT/GET_MOUNTS` |
| 20–23 | `STAT/UNLINK/RMDIR/IOCTL` | 60 | `SET_IDENTITY` |
| 24–28 | `SEND_MSG/WAITPID/SIGNAL/SETUID/SETGID` | 61–66 | `GUI_REQ/GET_PPID/READ_CHUNK/WRITE_CHUNK/GET_SIZE/REPARENT` |
| — | — | 67–71 | `DB_CONNECT/DB_QUERY/DB_DISCONNECT/DB_SERVICE_REGISTER/DB_SERVICE_REPLY` |
| — | — | 72–73 | `NET_SNIFFER_REGISTER/NET_SNIFFER_UNREGISTER` |

> `SyscallCode` is an enum in `src/common/SyscallCode.ts` — the ABI contract. Do not change existing numbers (breaking change).

**Some key codes (number → name → purpose):**

| Number | Name | Purpose |
|---|---|---|
| 1 | `PRINT` | Prints text to the screen (via FD 1) |
| 14 | `GETCWD` | Gets the process working directory |
| 24 | `SEND_MSG` | Horizontal IPC (app-to-app) |
| 25 | `WAITPID` | Waits for a process to finish by PID |
| 26 | `SIGNAL` | Sends a signal to a process |
| 61 | `GUI_REQ` | PixelSpace Display Protocol (RFC-TSIX-002) |
| 67 | `DB_CONNECT` | Opens an external database connection |

---

## Source Code

| File | Contents | Relevance |
|---|---|---|
| `src/common/SyscallCode.ts` | ABI enum 1–73 | Syscall numbers |
| `src/common/IPCTypes.ts` | Packet shapes `SyscallRequest`, `SyscallResponse`, `IPCEvent` | Packet contract |
| `src/kernel/Syscalls.ts` | `SyscallDispatcher`: `handleRequest`, `validateArgs`, `dispatch` | Dispatcher |
| `src/kernel/Scheduler.ts` | `spawnWorker` + `worker.on("message")` (reply) + `sendEvent` | Bridge & reply |
| `src/kernel/Kernel.ts` | Wiring `setSyscallHandler(...)` | Wiring |
| `src/mirror/lib/UserLib.ts` | `dispatch()`, `responseMap`, `parentPort.on("message")`, `onEvent` | Worker side |

---

## Snippets (code level)

> All snippets below are copied from the source. "Code is truth."

### 1. UserLib dispatch (worker side) — `src/mirror/lib/UserLib.ts`

```ts
  private async dispatch(code: SyscallCode, args: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = uuidv4();
      const request: SyscallRequest = { requestId, pid: this.pid, code, args };

      this.responseMap.set(requestId, (response: SyscallResponse) => {
        if (response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response.error || "Syscall Failed"));
        }
      });

      if (parentPort) {
        parentPort.postMessage(request);
      } else {
        reject(new Error("No parentPort found! Are you running in a Worker?"));
      }
    });
  }
```

> `responseMap` has type `Map<string, (res: SyscallResponse) => void>` — its values are **callbacks**, not `{ resolve, reject }` objects. The Promise is resolved/rejected inside the callback when the reply arrives.

### 2. Receiver side (worker) — `parentPort.on("message")`

```ts
parentPort.on("message", (msg: any) => {
  // 1. Balasan Syscall
  if (msg.requestId && this.responseMap.has(msg.requestId)) {
    const resolve = this.responseMap.get(msg.requestId)!;
    resolve(msg as SyscallResponse);
    this.responseMap.delete(msg.requestId);
  }
  // 2. Event (Push Notification) — selain signal
  else if (
    msg.type &&
    msg.type !== "signal" &&
    this.eventListeners.has(msg.type)
  ) {
    const callbacks = this.eventListeners.get(msg.type)!;
    callbacks.forEach((cb) => cb(msg.data));
  }
  // 3. Signal (SIGINT/SIGTERM) dengan default action
  else if (msg.type === "signal") {
    const sig = msg.data;
    // ... default: exit(130) untuk SIGINT, exit(143) untuk SIGTERM
  }
});
```

### 3. Kernel handleRequest — `src/kernel/Syscalls.ts`

```ts
public async handleRequest(req: SyscallRequest): Promise<any> {
    const silentCodes = [
      SyscallCode.READ,
      SyscallCode.PS,
      SyscallCode.GETCWD,
      SyscallCode.WHOAMI,
    ];
    if (!silentCodes.includes(req.code)) {
      this.logger.debug(
        `[IPC] PID ${req.pid} Request: ${SyscallCode[req.code]} (${req.requestId})`,
      );
    }

    try {
      this.validateArgs(req.code, req.args);
      return await this.dispatch(req.pid, req.code, req.args);
    } catch (e: any) {
      this.logger.error(
        `Syscall Error [${SyscallCode[req.code]}]: ${e.message}`,
      );
      throw e;
    }
  }
```

> ⚠️ **Important correction**: `handleRequest` **does not reply by itself**. It only validates, executes, then returns the result (or throws an error). The `postMessage` reply is sent by the **Scheduler** in the `worker.on("message")` handler (see snippet 4).

### 4. Reply sent by Scheduler — `src/kernel/Scheduler.ts` (`spawnWorker`)

```ts
pcb.worker.on("message", async (request: SyscallRequest) => {
    if (this.syscallHandler) {
        try {
            const result = await this.syscallHandler(request);
            if (pcb.worker) {
                pcb.worker.postMessage({
                    requestId: request.requestId,
                    success: true,
                    data: result
                });
            }
        } catch (error: any) {
            if (pcb.worker) {
                pcb.worker.postMessage({
                    requestId: request.requestId,
                    success: false,
                    error: error.message
                });
            }
        }
    }
});
```

### 5. Real syscall handler example — `src/kernel/Syscalls.ts`

```ts
      case SyscallCode.PRINT: {
        const entry = pcb.fdTable[1];
        if (!entry) return -1;
        entry.device.write(args as string);
        return 0;
      }

      case SyscallCode.GETCWD:
        return pcb.cwd;
```

> `PRINT` does not write directly to the screen — it writes through **FD 1** (`stdout`) in `fdTable`. This embodies "everything is a file": output is just a device attached to fdTable. `GETCWD`, on the other hand, simply returns `pcb.cwd` (process state in the PCB).

### 6. Push events — `sendEvent` in `src/kernel/Scheduler.ts`

```ts
public sendEvent(pid: number, type: string, data: any): boolean {
    const pcb = this.getProcess(pid);
    if (pcb && pcb.worker && pcb.state !== ProcessState.EXITED) {
        pcb.worker.postMessage({ type, data });
        return true;
    }
    return false;
}
```

Example usage (forwarding sniffer packets in `Syscalls.ts`):

```ts
this.scheduler.sendEvent(pid, "ipc_message", { data: sniff });
```

---

## Exercises / Practice

1. Read `src/common/SyscallCode.ts` — note all syscall numbers (1–73). Pay attention to the number gaps (39, 42–49, 51–52, 59) intentionally reserved.
2. Read `src/common/IPCTypes.ts` — recognize the shapes of `SyscallRequest`, `SyscallResponse`, `IPCEvent`.
3. Add a *log* in `handleRequest` for the `PRINT` syscall — then run `echo hello` in the shell. Observe the flow (same requestId in request & response).
4. Explain why `requestId` is needed — what happens without correlation?
5. Send two syscalls at once (e.g. `READ` large file + `PRINT`) and observe the reply order — prove that order is not guaranteed.
6. From the worker side, check the contents of `responseMap` right after `dispatch()` is called (before the reply arrives) — prove the values are callbacks.

---

## References

- `src/common/SyscallCode.ts` — ABI enum (source of truth for syscall numbers)
- `src/common/IPCTypes.ts` — IPC packet shapes
- `src/kernel/Syscalls.ts` — `handleRequest`, `validateArgs`, `dispatch`
- `src/kernel/Scheduler.ts` — `worker.on("message")` (reply) + `sendEvent` (push)
- `src/kernel/Kernel.ts` — wiring `setSyscallHandler`
- `src/mirror/lib/UserLib.ts` — `dispatch()`, `responseMap`, `onEvent`
- `wiki/identity_guid_ipc_walkthrough.md` — IPC & identity walkthrough
- `wiki/course/00-overview.en.md` §4.2

---

*Module 05 — complete. Continue to [Module 06 — Permission & Security](06-permission-security.en.md).*
