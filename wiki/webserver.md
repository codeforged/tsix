# WebServer Device — `/dev/httpd` (HttpServerDevice)

Server **HTTP** yang hidup di **kernel land**, dibuka dari userland sebagai
device biasa (`fs.open` + `fs.ioctl` + `onEvent`). Ini pengganti resmi untuk
pola lama `hostRequire("http")` yang dipakai DOME / web-gateway — menutup
lubang keamanan "userland pegang socket host di luar kendali kernel".

Kode: `src/kernel/devices/aux-devices/HttpServerDevice.ts`
Device: `/dev/httpd` · Event channel: `http_event`
Pasangan WebSocket: lihat `wiki/websocket.md` (`/dev/wsd`).

---

## 1. Kenapa perlu device ini

Sebelumnya DOME & web-gateway menangkap `require` asli lalu memakai
`http`/`ws` langsung dari userland (`hostRequire`). Akses itu diberikan hanya
berdasarkan **nama proses** (mengandung `server`/`daemon`/`dome`) — mudah
dispoof, dan memberi script userland akses network host mentah di luar kendali
kernel.

Prinsip yang benar (dan sekarang diterapkan): **userland tidak boleh menyentuh
network host langsung; semua lewat kernel.** `HttpServerDevice` (HTTP) &
`WebSocketDevice` (WS) adalah transport-nya.

```text
Browser
   │  HTTP
   ▼
/dev/httpd  (HttpServerDevice, kernel land — satu-satunya yg pegang http.Server)
   │  push event "http_event" (HTTP_REQUEST)   ──▶ userland (lib.onEvent)
   ◀── ioctl HTTPD_RESPOND {reqId,status,ct,body} (userland balas)
```

## 2. Registrasi & izin

- Auto-register via `static autoRegister(kernel)` saat boot → `/dev/httpd`.
- `uid=0`, `gid=0`, `mode=0o666` (semantik server diatur ioctl, bukan file mode).

## 3. ioctl (dipakai userland)

| Kode | Nilai | Argumen |
| --- | --- | --- |
| `HTTPD_LISTEN` | `0x5101` | `{ port, ownerPid }` |
| `HTTPD_RESPOND` | `0x5102` | `{ ownerPid, reqId, status, contentType, body, encoding?, extraHeaders? }` |
| `HTTPD_STATUS` | `0x5103` | `{ ownerPid }` → `{ listening, port, pendingHttp }` |

- SATU device menampung banyak server, dipisah per `ownerPid` → beberapa
  daemon bisa listen di port berbeda sekaligus.
- Request HTTP yang tidak dijawab owner dalam 30 detik → auto `404` (anti
  bocor koneksi/memori).

## 4. Event push (channel `http_event`)

| Type | Isi |
| --- | --- |
| `HTTP_REQUEST` | `{ reqId, method, url, headers }` |
| `LISTENING` | `{ port }` |
| `LISTEN_ERROR` | `{ message }` |

## 5. Pemakaian dari userland

### 5a. Cara mentah (ioctl)
```ts
const fd = await fs.open("/dev/httpd", "r+");
lib.onEvent("http_event", async (p) => {
  if (p.type === "HTTP_REQUEST") {
    await fs.ioctl(fd, 0x5102, { ownerPid: lib.getPid(), reqId: p.reqId,
      status: 200, contentType: "text/plain; charset=utf-8", body: "hi" });
  }
});
await fs.ioctl(fd, 0x5101, { ownerPid: lib.getPid(), port: 8080 });
```

### 5b. Cara nyaman — `lib.web`
```ts
const srv = lib.web;                    // WebLib (lihat changelogs/userlib.md)
srv.on("request", async (req) => {
  await srv.respond(req.reqId, 200, "text/plain; charset=utf-8", "hi");
});
await srv.start(8080, "http");          // HTTP saja
// atau srv.start(8080, "both")         // HTTP + WS satu port (attach /dev/wsd)
```

## 6. Batasan / roadmap

- **Body request (POST) belum dibaca** — event `HTTP_REQUEST` baru membawa
  `method/url/headers` (tanpa body). Cukup untuk GET/statis sekarang; tambah
  pembacaan body saat ada kebutuhan REST `POST`.
- Belum ada HTTPS/TLS (bisa ditambahkan di driver tanpa mengubah userland).
- Static file & logika tetap di userland (driver hanya request/response
  primitif) — lihat `web-gateway.ts` sebagai konsumen pertama.

## Referensi

- `src/kernel/devices/aux-devices/HttpServerDevice.ts`
- `wiki/websocket.md` (pasangan WS)
- `wiki/changelogs/kernel.md`
- Contoh: `src/mirror/opt/test/webd-demo.ts`
