# WebSocket Device — `/dev/wsd` (WebSocketDevice)

Server **WebSocket** di **kernel land**, dibuka dari userland sebagai device
(`fs.open` + `fs.ioctl` + `onEvent`). Menutup pola `hostRequire("ws")` dan
menjadi pasangan `/dev/httpd` untuk transport HTTP+WS yang aman.

Kode: `src/kernel/devices/aux-devices/WebSocketDevice.ts`
Device: `/dev/wsd` · Event channel: `ws_event`
Pasangan HTTP: lihat `wiki/webserver.md` (`/dev/httpd`).

---

## 1. Dua mode listen

WS bisa dipakai **sendiri** atau **nempel di HTTP server**:

| Mode | ioctl | Kapan dipakai |
| --- | --- | --- |
| **Standalone** | `WSD_LISTEN { port, ownerPid }` | App yang hanya butuh WS di port sendiri |
| **Attach ke HTTP** | `WSD_ATTACH { ownerPid }` | App yang mau HTTP **dan** WS di **satu port** (upgrade) — kebutuhan `web-gateway`/`dome` |

Attach mencari `http.Server` milik `ownerPid` yang sama dari `HttpServerDevice`
(`kernel.devices["httpd"].getHttpServer(ownerPid)`); bila belum ada → error.

## 2. ioctl

| Kode | Nilai | Argumen |
| --- | --- | --- |
| `WSD_LISTEN` | `0x5201` | `{ port, ownerPid }` |
| `WSD_ATTACH` | `0x5202` | `{ ownerPid }` |
| `WSD_SEND` | `0x5203` | `{ ownerPid, clientId, data }` |
| `WSD_BROADCAST` | `0x5204` | `{ ownerPid, data }` |
| `WSD_CLOSE` | `0x5205` | `{ ownerPid, clientId }` |
| `WSD_STATUS` | `0x5206` | `{ ownerPid }` → `{ listening, port, clients }` |

`data` berupa string (teks frame). Objek JSON dibuat string dulu di userland
atau via `lib.web` (otomatis `JSON.stringify`).

## 3. Event push (channel `ws_event`)

| Type | Isi |
| --- | --- |
| `WS_CONNECT` | `{ clientId }` |
| `WS_MESSAGE` | `{ clientId, data, binary }` |
| `WS_CLOSE` | `{ clientId }` |
| `LISTENING` | `{ port }` / `{ attached, ownerPid }` |
| `LISTEN_ERROR` | `{ message }` |

`clientId` dibuat kernel (uuid pendek) dan **wajib dipakai** untuk
`WSD_SEND`/`WSD_CLOSE`.

## 4. Pemakaian dari userland

### 4a. Cara mentah (ioctl)
```ts
const fd = await fs.open("/dev/wsd", "r+");
lib.onEvent("ws_event", async (p) => {
  if (p.type === "WS_CONNECT") {
    await fs.ioctl(fd, 0x5203, { ownerPid: lib.getPid(), clientId: p.clientId,
      data: JSON.stringify({ type: "welcome" }) });
  } else if (p.type === "WS_MESSAGE") {
    await fs.ioctl(fd, 0x5204, { ownerPid: lib.getPid(),
      data: JSON.stringify({ echo: p.data }) });   // broadcast
  }
});
await fs.ioctl(fd, 0x5202, { ownerPid: lib.getPid() }); // attach ke httpd
```

### 4b. Cara nyaman — `lib.web`
```ts
const srv = lib.web;
srv.on("connection", async (c) => {
  await srv.send(c.clientId, { type: "welcome", clientId: c.clientId });
});
srv.on("message", async (m) => {
  await srv.send(m.clientId, { type: "echo", back: m.data });
  // atau await srv.broadcast({ ... });
});
await srv.start(8080, "both");  // HTTP + WS satu port
```

## 5. Catatan / roadmap

- **Broadcast** = ke semua client (tanpa exclude). Kalau nanti perlu
  "kirim ke client tertentu selain pengirim", tambah `excludeClientId`.
- **Frame biner output** belum eksplisit (input sudah ditandai `binary`).
  DOME sekarang teks/JSON → belum perlu.
- **Traffic/byte accounting per-app** (kebutuhan monitor DOME) bisa ditambah
  ke driver nanti (`WSD_STATUS` + tag `srcPid` di `WSD_BROADCAST`).

## Referensi

- `src/kernel/devices/aux-devices/WebSocketDevice.ts`
- `wiki/webserver.md` (pasangan HTTP)
- `wiki/changelogs/kernel.md`
- Contoh: `src/mirror/opt/test/webd-demo.ts`
