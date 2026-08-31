# NetSocket in a Nutshell

> **NetSocket** adalah komponen high-level untuk networking MQTNL di TSIX (ala Cashew).
> Membungkus `NetworkLib` (syscall-level) jadi API yang bersih: `instantiate → open()
> → events (onData/onError/onClose) → close()`. Tanpa magic number, tanpa urus fd
> manual, auto-release port + normalisasi security agent saat close.

```
NetworkLib (syscall: socket/bind/sendto/recv/ioctl)
   └── NetSocket (high-level: open/onData/upgradeSecurity/sendTo/reply/close)
```

---

## 1. Konsep inti

| Konsep | Penjelasan |
|---|---|
| **Port lokal TETAP** | NetSocket selalu bind ke port tertentu (bukan ephemeral). Ini penting karena MQTNL mengenkripsi **per srcPort** — session key di-`upgradeSecurity()` dipasang ke port itu. |
| **Plain dulu, upgrade belakangan** | `open()` membuat socket plain. Enkripsi (ChaCha20-Poly1305) diaktifkan **eksplisit** via `upgradeSecurity()`. Bisa mulai plain → handshake → switch secure. |
| **Event-driven vs manual** | Bisa terima data via `onData` (loop internal) ATAU loop `recv()` manual. Keduanya eksklusif. |
| **Auto-cleanup** | Ctrl+C → `close()` otomatis (release port + normalisasi security agent). |

---

## 2. Aturan PENTING yang sering bikin bingung

### ⚠️ `onData` harus di-set SEBELUM `open()`

Recv-loop event-driven hanya start kalau `onData` sudah terpasang **saat `open()` dipanggil**:

```ts
// ❌ SALAH — loop tidak pernah start → tidak menerima apa pun
const sock = new NetSocket({ port: 2501, key: KEY_HEX });
await sock.open();
sock.onData = (pkt) => { ... };  // telat

// ✅ BENAR — onData dipasang dulu, open() men-start loop
const sock = new NetSocket({ port: 2501, key: KEY_HEX });
sock.onData = (pkt) => { ... };  // sebelum open
await sock.open();
```

> Ini sumber error "TX tidak menerima pong" — si TX set `onData` setelah `open()`,
> jadi recv-loop tidak pernah jalan. **Ingat: onData dulu, baru open.**

### ⚠️ `onData` dan `recv()` manual itu eksklusif

- Kalau `onData` diisi → pakai mode event-driven. `recv()` akan melempar error.
- Kalau tidak diisi → pakai loop `while (sock.isOpen) { await sock.recv(); }`.

---

## 3. Lifecycle

```
new NetSocket({ port, key })   → konfigurasi (belum buka apa-apa)
      │
      ▼
set onData / onError            → (WAJIB sebelum open kalau mau event-driven)
      │
      ▼
open()                          → socket + bind (PLAIN) + start recv-loop (kalau onData ada)
      │
      ▼
upgradeSecurity()               → switch ke ChaCha20-Poly1305 (pakai key)
      │
      ▼
sendTo / reply                  → kirim data
recv (manual) / onData (event)  → terima data
      │
      ▼
close()                         → release port + normalisasi security agent
```

---

## 4. Contoh 1 — Paling sederhana: ping-pong plain (event-driven)

**RX** (`netsocket-rx`):
```ts
import { Program, std, NetSocket } from "@tsix/Application";

export const main = Program(async (args: string[]) => {
  const sock = new NetSocket({ port: 2500 });

  // onData SEBELUM open()
  sock.onData = (pkt) => {
    std.println(`[RX] ${pkt.src}:${pkt.port} -> ${pkt.data}`);
    sock.reply(pkt, "pong");            // balas balik ke pengirim
  };
  sock.onError = (err) => std.println(`[RX] error: ${err.message}`);

  await sock.open();
  await sock.waitClosed();              // jaga hidup sampai ditutup (Ctrl+C)
});
```

**TX** (`netsocket-tx`):
```ts
import { Program, std, NetSocket } from "@tsix/Application";

export const main = Program(async (args: string[]) => {
  const sock = new NetSocket({ port: 2501 });

  // onData SEBELUM open() — biar TX bisa menerima pong balik
  sock.onData = (pkt) => std.println(`[TX] ← ${pkt.src}:${pkt.port} -> ${pkt.data}`);

  await sock.open();
  await sock.sendTo("localhost", 2500, "halo!");
  await sock.waitClosed();
  await sock.close();
});
```

> `localhost` di-resolve ke alamat node sendiri. Kalau RX di node lain, ganti dengan
> alamat node RX (mis. `mactsix` / nama node).

---

## 5. Contoh 2 — Dua pola menerima data

### Pola A: event-driven (disarankan)
```ts
sock.onData = (pkt) => { ... };   // dipanggil loop internal
sock.onError = (err) => { ... };
await sock.open();
await sock.waitClosed();
```

### Pola B: manual loop (gaya lama)
```ts
await sock.open();                // jangan set onData!
while (sock.isOpen) {
  try {
    const pkt = await sock.recv();
    if (pkt) { ... }
  } catch (_e) {
    break;                        // socket ditutup saat menunggu
  }
}
```

---

## 6. Contoh 3 — Mode terenkripsi (ChaCha20-Poly1305)

Kedua sisi harus pakai **key yang sama** dan sama-sama `upgradeSecurity()`:

```ts
const KEY_HEX = "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

const sock = new NetSocket({ port: 2500, key: KEY_HEX });
sock.onData = (pkt) => { ... };

await sock.open();
await sock.upgradeSecurity();     // switch ke ChaCha20-Poly1305
// sekarang semua kirim/terima otomatis terenkripsi dengan key tsb
await sock.waitClosed();
```

> Port harus TETAP (bukan 0) — kalau ephemeral, key terpasang ke port yang salah
> dan receiver secured gagal decrypt.

---

## 7. Contoh 4 — RSA handshake untuk berbagi secret key ChaCha20

Pola ini dipakai di **TeleChat** dan **tpkgd**: RSA (asimetris) dipakai **sekali** untuk
mengirim session key ChaCha20 (simetris) dengan aman. Setelah itu semua data memakai
ChaCha20 (lebih cepat).

> **Irit data dengan opcode, bukan string.** Jenis paket ditandai **opcode numerik 1 byte**
> di awal payload (`onData` tidak membawa field `flag`, jadi opcode ditaruh di payload).

```
Opcode (1 byte, di awal payload):
  0x01 = REQUEST_KEY   (client → server, minta public key)
  0x02 = PUBKEY        (server → client, diikuti public key PEM)
  0x03 = SECRETKEY     (client → server, diikuti session key ter-enkripsi RSA)
```

```
Opcode (1 byte, di awal payload):
  0x01 = REQUEST_KEY   (client → server, minta public key)
  0x02 = PUBKEY        (server → client, diikuti public key PEM)
  0x03 = SECRETKEY     (client → server, diikuti session key ter-enkripsi RSA)
```

```
Client                                   Server
  │  generateKeyPair() (RSA)              │
  │  open() (plain)                       │
  │  ── [0x01] ────────────────────────▶  │
  │                                       │  generateKeyPair() (RSA)
  │  ◀── [0x02][publicKey] ─────────────  │
  │  generateSessionKey() (32 byte)       │
  │  encryptWithPublicKey(serverPub, sk)  │
  │  ── [0x03][encSessionKey] ──────────▶ │  decryptWithPrivateKey(priv, enc) → sessionKey
  │                                       │  upgradeSecurity(sessionKey)
  │  upgradeSecurity(sessionKey)          │
  │  ◀═══ data terenkripsi ChaCha20 ═══▶  │
```

### Client side
```ts
import { SecurityAgent, NetSocket } from "@tsix/Application";

// Opcode handshake (1 byte)
const OP = { REQ_KEY: 0x01, PUBKEY: 0x02, SECRET_KEY: 0x03 };

const sock = new NetSocket({ port: 2501 });
sock.onData = (pkt) => {
  const buf = Buffer.isBuffer(pkt.data) ? pkt.data : Buffer.from(String(pkt.data), "utf8");
  const op = buf[0];                      // byte pertama = opcode
  const body = buf.subarray(1);           // sisanya = data

  if (op === OP.PUBKEY) {
    // 1) Server kirim public key
    const serverPub = body.toString("utf8");
    const sessionKey = SecurityAgent.generateSessionKey();          // 32 byte acak
    const enc = SecurityAgent.encryptWithPublicKey(serverPub, sessionKey);

    // 2) Kirim session key ter-enkripsi RSA (payload: opcode + hex)
    const payload = Buffer.concat([Buffer.from([OP.SECRET_KEY]), Buffer.from(enc, "utf8")]);
    void sock.sendTo("localhost", 2500, payload);

    // 3) Switch ke ChaCha20
    void sock.upgradeSecurity(sessionKey.toString("hex"));
  } else {
    // Setelah secure, semua paket berikutnya terenkripsi (data apa pun)
    std.println(`[secure] ${body.toString()}`);
  }
};
await sock.open();
await sock.waitClosed();
```

### Server side
```ts
import { SecurityAgent, NetSocket } from "@tsix/Application";

const OP = { REQ_KEY: 0x01, PUBKEY: 0x02, SECRET_KEY: 0x03 };
const keys = SecurityAgent.generateKeyPair();   // RSA key pair server
let secured = false;

const sock = new NetSocket({ port: 2500 });
sock.onData = async (pkt) => {
  const buf = Buffer.isBuffer(pkt.data) ? pkt.data : Buffer.from(String(pkt.data), "utf8");
  const op = buf[0];
  const body = buf.subarray(1);

  if (op === OP.REQ_KEY) {
    // Kirim public key: opcode + PEM
    const payload = Buffer.concat([Buffer.from([OP.PUBKEY]), Buffer.from(keys.publicKey, "utf8")]);
    await sock.reply(pkt, payload);
  } else if (op === OP.SECRET_KEY) {
    // Terima session key ter-enkripsi → decrypt → aktifkan ChaCha20
    const enc = body.toString("utf8");
    const sessionKey = SecurityAgent.decryptWithPrivateKey(keys.privateKey, enc);
    await sock.upgradeSecurity(sessionKey.toString("hex"));
    secured = true;
    std.println("[server] session key diterima, koneksi aman!");
  } else if (secured) {
    std.println(`[secure] ${body.toString()}`);   // data sudah terenkripsi
  }
};
await sock.open();
await sock.waitClosed();
```

> **Catatan binary vs plain:** kalau payload memakai opcode biner (Buffer), pastikan kedua
> sisi tidak merusak byte ≥ 0x80. Untuk handshake di atas, pakai `Buffer` (bukan string
> plaintext) — aman selama payloadnya ASCII (PEM & hex adalah ASCII).

### Kenapa RSA + ChaCha20 (bukan cuma RSA)?
- **RSA (asimetris)**: aman untuk pertukaran kunci, tapi lambat untuk data besar.
- **ChaCha20 (simetris)**: cepat untuk data berukuran apa pun.
- Kombinasi: **RSA sekali untuk kirim session key → ChaCha20 untuk semua data** = aman + cepat.
  Ini pola standar (mirip TLS handshake → record layer).

> Catatan: `SecurityAgent.generateSessionKey()` return `Buffer` 32 byte. `upgradeSecurity()`
> menerima hex string — jadi konversi `.toString("hex")`.

---

## 8. API ringkas

| Method | Kegunaan |
|---|---|
| `new NetSocket({ port, key?, binary?, iface? })` | Konfigurasi (port wajib) |
| `open()` / `listen()` | Socket + bind (plain), start recv-loop kalau `onData` ada |
| `upgradeSecurity(key?, { agent? })` | Switch ke enkripsi (default ChaCha20, bisa `aes-gcm`) |
| `sendTo(addr, port, data, flag?, srcPort?)` | Kirim data dari socket ini |
| `reply(pkt, data)` | Balas ke pengirim paket (shortcut sendTo ke pkt.src:pkt.port) |
| `recv()` | Baca satu paket manual (hanya kalau onData TIDAK diisi) |
| `waitClosed()` | Promise yang resolve saat socket ditutup |
| `close()` | Release port + normalisasi security agent (idempotent) |
| `netstat()` | Info interface MQTNL + statistik |

### Property
| Property | Arti |
|---|---|
| `port` | Port lokal yang ter-bind (null sebelum open) |
| `isOpen` | True selama socket terbuka |
| `isSecured` | True setelah `upgradeSecurity()` |
| `agent` | Nama agent enkripsi aktif (`chacha20` default) |

### Event
| Event | Dipanggil saat |
|---|---|
| `onData(pkt)` | Ada paket masuk (mode event) |
| `onError(err)` | Terjadi error |
| `onClose()` | Socket ditutup |

---

## 9. Checklist cepat (biar tidak salah)

- [ ] Set `onData` **sebelum** `open()` (kalau mau event-driven)
- [ ] Jangan set `onData` sekaligus pakai `recv()` manual (eksklusif)
- [ ] Port lokal **tetap** (bukan 0) kalau pakai enkripsi
- [ ] Kedua sisi pakai **key yang sama** + sama-sama `upgradeSecurity()`
- [ ] Untuk handshake: RSA kirim session key → `upgradeSecurity(sessionKey)` di kedua sisi
- [ ] `waitClosed()` untuk jaga proses tetap hidup; `close()` untuk cleanup
