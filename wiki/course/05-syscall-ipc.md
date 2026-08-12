---
module: 05
title: Syscall & IPC
part: II
partTitle: Boot & Kernel Runtime
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Syscall & IPC

**RFC-TSIX-EDU-002** | Modul kelima kurikulum TSIX. Memahami ABI mini TSIX: bagaimana aplikasi memanggil kernel via syscall, korelasi request-response, dan push event dari kernel ke worker.

> Syscall TSIX adalah **RPC asinkron murni**. Tidak ada urutan yang dijamin — setiap request membawa `requestId` (UUID) dan dijawab dengan `requestId` yang sama. Ini berbeda dari trap sinkron di Linux.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan alur satu syscall lengkap (dari app sampai balik)
- [ ] Menjelaskan peran `requestId` + `responseMap`
- [ ] Membedakan request-response vs push event
- [ ] Menyebutkan beberapa kode syscall penting (1–73)
- [ ] Menjelaskan peran `validateArgs`

---

## Konsep Inti

**TSIX memakai IPC *request-response* asinkron** — bukan trap sinkron ala Linux. Aplikasi dan kernel terpisah *thread* (Worker vs main thread). Satu-satunya jembatan adalah `postMessage` di kedua arah.

| Konsep | Penjelasan |
|---|---|
| **`SyscallRequest`** | Paket app → kernel: `{ requestId, pid, code, args }` |
| **`SyscallResponse`** | Paket kernel → app: `{ requestId, success, data?, error? }` |
| **`requestId`** (UUID) | Korelasi permintaan ↔ jawaban. Dibuat di `UserLib.dispatch`, dipakai lagi kernel saat membalas. |
| **`responseMap`** | Map di sisi app: `requestId` → callback resolve/reject. Balasan dicocokkan lewat kunci ini. |
| **Push event** | Notifikasi kernel → app *tanpa* requestId: `{ type, data }` (signal, ipc_message, gui_request, db_request, resize). |
| **`validateArgs`** | Kontrak argumen di kernel: cek syscall mana yang wajib punya `args`, plus cek tipe spesifik per syscall. |

> [!IMPORTANT]
> Karena RPC asinkron murni, **urutan balasan tidak dijamin**. Dua syscall berurutan (A lalu B) bisa dibalas B lebih dulu. Korelasi selalu lewat `requestId`, bukan urutan.

---

## Alur / Cara Kerja

### Alur 1 syscall lengkap: `PRINT`

Contoh paling sederhana: aplikasi memanggil `std.print("hello")`. Berikut jalur lengkapnya (kode sebagai kebenaran):

```ts
// src/mirror/lib/UserLib.ts — StdLib
public async print(text: string) {
  return await this.dispatch(SyscallCode.PRINT, text);
}
```

**Langkah demi langkah:**

1. `std.print("hello")` memanggil `UserLib.dispatch(PRINT, "hello")` di sisi worker.
2. `dispatch()` membuat `requestId = uuidv4()`, menyimpan callback ke `responseMap`, lalu `parentPort.postMessage({ requestId, pid, code: PRINT, args: "hello" })`.
3. Kernel menerima pesan di `Scheduler.spawnWorker()` → handler `pcb.worker.on("message", ...)`.
4. Handler memanggil `syscallHandler(request)` — di-wire di `Kernel.initializeSubsystems()` lewat `scheduler.setSyscallHandler(...)`.
5. `SyscallDispatcher.handleRequest(req)` → `validateArgs(PRINT, args)` → `dispatch(pid, PRINT, args)`.
6. Case `PRINT` mengambil FD 1 dari `pcb.fdTable`, lalu `entry.device.write("hello")` → output ke layar.
7. Hasil (`0`) kembali ke handler Scheduler; Scheduler membalas `postMessage({ requestId, success: true, data: 0 })`.
8. Di worker, `parentPort.on("message")` menemukan `requestId` di `responseMap`, memanggil callback → Promise `resolve(0)` → `await print` selesai.

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

Korelasi request-response via `requestId` (UUID) + `responseMap` — murni RPC asinkron. Banyak syscall bisa in-flight sekaligus.

### Push event (kernel → worker, tanpa requestId)

Berbeda dari request-response, push event tidak punya `requestId`. Kernel mengirim `{ type, data }` kapan pun dibutuhkan:

```
{ type, data }
```

Tipe yang benar-benar dipakai di kode (`Scheduler.ts`, `Syscalls.ts`, `Kernel.ts`):

| `type` | Pemakaian di kode | Tujuan |
|---|---|---|
| `signal` | `sendEvent(pid, "signal", "SIGINT")` dll. | Sinyal ke proses (SIGINT, SIGTERM, SIGSTOP, SIGCONT, SIGWINCH, SIGSEGV...) |
| `ipc_message` | `SEND_MSG` antar-app; forward paket `NET_SNIFF` | Horizontal IPC / sniffer |
| `gui_request` | Cleanup window & forward ke GUI daemon | GUI daemon (PixelSpace) |
| `db_request` | `forwardDbRequest` → DB service daemon | Transport alternatif database |
| `resize` | `broadcastEvent("resize", { lines, columns })` saat terminal host berubah | Semua proses aktif |

> [!NOTE]
> Di sisi worker, `UserLib.parentPort.on("message")` membedakan tiga hal: (1) balasan syscall — ada `requestId` yang cocok di `responseMap`; (2) event — ada `type` dan `type !== "signal"`; (3) sinyal — `type === "signal"`, dengan default aksi `SIGINT → exit(130)` dan `SIGTERM → exit(143)` bila tidak ada listener.

---

## Daftar Syscall Utama (ABI mini)

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

> `SyscallCode` adalah enum di `src/common/SyscallCode.ts` — kontrak ABI. Jangan mengubah nomor yang sudah ada (breaking change).

**Beberapa kode kunci (nomor → nama → tujuan):**

| Nomor | Nama | Tujuan |
|---|---|---|
| 1 | `PRINT` | Mencetak teks ke layar (via FD 1) |
| 14 | `GETCWD` | Mendapatkan direktori kerja proses |
| 24 | `SEND_MSG` | Horizontal IPC (app-to-app) |
| 25 | `WAITPID` | Menunggu proses selesai berdasarkan PID |
| 26 | `SIGNAL` | Mengirim sinyal ke proses |
| 61 | `GUI_REQ` | PixelSpace Display Protocol (RFC-TSIX-002) |
| 67 | `DB_CONNECT` | Membuka koneksi database eksternal |

---

## Kode Sumber

| File | Isi | Relevan |
|---|---|---|
| `src/common/SyscallCode.ts` | Enum ABI 1–73 | Nomor syscall |
| `src/common/IPCTypes.ts` | Bentuk paket `SyscallRequest`, `SyscallResponse`, `IPCEvent` | Kontrak paket |
| `src/kernel/Syscalls.ts` | `SyscallDispatcher`: `handleRequest`, `validateArgs`, `dispatch` | Dispatcher |
| `src/kernel/Scheduler.ts` | `spawnWorker` + `worker.on("message")` (balasan) + `sendEvent` | Jembatan & reply |
| `src/kernel/Kernel.ts` | Wiring `setSyscallHandler(...)` | Wiring |
| `src/mirror/lib/UserLib.ts` | `dispatch()`, `responseMap`, `parentPort.on("message")`, `onEvent` | Sisi worker |

---

## Snippet (level kode)

> Semua snippet di bawah ini disalin dari sumber. "Kode adalah kebenaran."

### 1. UserLib dispatch (sisi worker) — `src/mirror/lib/UserLib.ts`

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

> `responseMap` bertipe `Map<string, (res: SyscallResponse) => void>` — nilainya **callback**, bukan objek `{ resolve, reject }`. Promise di-resolve/reject di dalam callback saat balasan tiba.

### 2. Sisi penerima (worker) — `parentPort.on("message")`

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

> ⚠️ **Koreksi penting**: `handleRequest` **tidak membalas sendiri**. Ia hanya memvalidasi, mengeksekusi, lalu mengembalikan hasil (atau melempar error). Balasan `postMessage` dikirim oleh **Scheduler** di handler `worker.on("message")` (lihat snippet 4).

### 4. Balasan dikirim oleh Scheduler — `src/kernel/Scheduler.ts` (`spawnWorker`)

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

### 5. Contoh handler syscall nyata — `src/kernel/Syscalls.ts`

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

> `PRINT` tidak menulis langsung ke layar — ia menulis lewat **FD 1** (`stdout`) di `fdTable`. Ini wujud "everything is a file": output hanyalah device yang terpasang di fdTable. `GETCWD` sebaliknya, cukup mengembalikan `pcb.cwd` (state proses di PCB).

### 6. Push event — `sendEvent` di `src/kernel/Scheduler.ts`

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

Contoh pemakaian (forward paket sniffer di `Syscalls.ts`):

```ts
this.scheduler.sendEvent(pid, "ipc_message", { data: sniff });
```

---

## Latihan / Praktik

1. Baca `src/common/SyscallCode.ts` — catat semua nomor syscall (1–73). Perhatikan celah nomor (39, 42–49, 51–52, 59) yang sengaja direservasi.
2. Baca `src/common/IPCTypes.ts` — kenali bentuk `SyscallRequest`, `SyscallResponse`, `IPCEvent`.
3. Tambahkan *log* di `handleRequest` untuk syscall `PRINT` — lalu jalankan `echo hello` di shell. Amati alurnya (requestId yang sama di request & response).
4. Jelaskan mengapa `requestId` diperlukan — apa yang terjadi tanpa korelasi?
5. Kirim dua syscall sekaligus (mis. `READ` file besar + `PRINT`) dan amati urutan balasannya — buktikan urutan tidak dijamin.
6. Dari sisi worker, cek isi `responseMap` segera setelah `dispatch()` dipanggil (sebelum balasan tiba) — buktikan nilainya berupa callback.

---

## Referensi

- `src/common/SyscallCode.ts` — enum ABI (kebenaran nomor syscall)
- `src/common/IPCTypes.ts` — bentuk paket IPC
- `src/kernel/Syscalls.ts` — `handleRequest`, `validateArgs`, `dispatch`
- `src/kernel/Scheduler.ts` — `worker.on("message")` (balasan) + `sendEvent` (push)
- `src/kernel/Kernel.ts` — wiring `setSyscallHandler`
- `src/mirror/lib/UserLib.ts` — `dispatch()`, `responseMap`, `onEvent`
- `wiki/identity_guid_ipc_walkthrough.md` — walkthrough IPC & identitas
- `wiki/course/00-overview.md` §4.2

---

*Modul 05 — selesai. Lanjut ke [Modul 06 — Permission & Security](06-permission-security.md).*
