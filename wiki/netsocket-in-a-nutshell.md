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
| **Port lokal (pilih sendiri atau `0` = ephemeral)** | NetSocket bisa bind port tertentu ATAU minta port random dengan `port: 0`. Setelah `open()`, `sock.port` berisi **port ASLI** hasil pilihan kernel — dan `upgradeSecurity()` otomatis memasang session key ke port asli itu. Penting karena MQTNL mengenkripsi **per srcPort**. |
| **Biner TERSANDI (Binfeo)** | Protocol biner yang BISA dienkripsi utk komunikasi normal (bukan OTA). Pilih via `protocol: "Binfeo"` — driver enkripsi payload (Buffer utuh, byte ≥ 0x80 tidak rusak). |
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

### ✅ Port `0` = minta port random (ephemeral)

Sebagai pengirim, kita biasanya tidak peduli port lokal kita berapa — yang penting
port targetnya. Cukup pakai `port: 0`: kernel memilih port random yang available,
lalu `open()` mengisi `sock.port` dengan **port asli** hasil pilihan kernel:

```ts
const sock = new NetSocket({ port: 0, key: KEY_HEX });  // 0 = port random
await sock.open();
std.println(`local port = ${sock.port}`);               // port ASLI (mis. 13562)
await sock.upgradeSecurity();                           // key menempel ke port asli itu
```

Ini aman untuk mode terenkripsi: karena MQTNL encrypts **per srcPort**, session key
dari `upgradeSecurity()` otomatis dipasang ke `sock.port` (bukan ke 0). Jadi aturan
lama "port harus TETAP kalau mau enkripsi" **sudah tidak wajib lagi** — port tetap
cuma diperlukan kalau pihak lain harus tahu port kita dari awal (mis. receiver yang
menunggu di port tetap).

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
  const sock = new NetSocket({ port: 0 });   // 0 = port random (ephemeral)

  // onData SEBELUM open() — biar TX bisa menerima pong balik
  sock.onData = (pkt) => std.println(`[TX] ← ${pkt.src}:${pkt.port} -> ${pkt.data}`);

  await sock.open();                          // sock.port = port asli dari kernel
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

> Port boleh TETAP maupun `0` (ephemeral). Kalau `port: 0`, `sock.port` berisi port
> ASLI hasil pilihan kernel dan `upgradeSecurity()` otomatis memasang key ke port
> asli itu — jadi enkripsi tetap bekerja tanpa harus memilih port sendiri.

---

## 7. Contoh — Protocol biner TERSANDI (Binfeo)

**Binfeo** adalah protocol biner yang BISA DIENKRIPSI untuk komunikasi NORMAL
(BUKAN untuk ESP OTA). Berbeda dari OTA "Binary" (`mqtnl@1.1/`, magic `0x42`) yang
selalu **bypass enkripsi** supaya panjang byte persis, Binfeo (`mqtnl@1.2/`, magic
`0x66`) dikirim **terenkripsi oleh driver** — payload biner tetap utuh sampai
receiver (byte ≥ 0x80 tidak rusak), dan RX menerimanya sebagai `Buffer`.

| Protocol | Nama | Magic | Topic | Enkripsi driver |
|---|---|---|---|---|
| JSON (default) | `"JSON"` | `0x5B` `'['` | `mqtnl@1.0/` | string hex |
| Biner OTA | `"Binary"` | `0x42` `'B'` | `mqtnl@1.1/` | **tidak** (bypass, utk OTA) |
| **Biner tersandi** | `"Binfeo"` | `0x66` `'f'` | `mqtnl@1.2/` | **ya** (raw Buffer) |

Pilih lewat opsi `protocol` di `NetSocket` (mengalahkan `binary: true`):

```ts
const KEY_HEX =
  "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

// RX — bind port tetap, terima Buffer hasil dekripsi
const rx = new NetSocket({ port: 2700, key: KEY_HEX, protocol: "Binfeo" });
rx.onData = (pkt) => {
  const buf = Buffer.isBuffer(pkt.data) ? pkt.data : Buffer.from(pkt.data);
  std.println(`[RX] ${buf.toString("hex")}`);   // byte persis sama
};
await rx.open();
await rx.upgradeSecurity();       // key menempel ke port rx
await rx.waitClosed();

// TX — port ephemeral (0), kirim Buffer; driver enkripsi otomatis
const tx = new NetSocket({ port: 0, key: KEY_HEX, protocol: "Binfeo" });
await tx.open();                  // sock.port = port asli dari kernel
await tx.upgradeSecurity();       // key menempel ke port asli itu
await tx.sendTo("localhost", 2700, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x80, 0xff]));
await tx.close();
```

Contoh lengkap: `netsocket-binfeo-rx.ts` / `netsocket-binfeo-tx.ts`.

> 📌 **Wire protocol dipin per-port (deterministik).** Sejak 2026-09-04,
> `NetSocket.open()` **selalu** memasang protocol per-port via ioctl `0x1002`:
> opsi `protocol` (`"Binfeo"`/`"Binary"`/`"JSON"`) → nama itu; `binary:true` →
> `"Binary"`; default → **`"JSON"`**. Driver kini mengutamakan override per-port
> ini di atas `protocolRegistry` (protocol "terakhir dipakai" peer). Efeknya:
> `binary:false` / `protocol:"JSON"` benar-benar menghasilkan wire JSON — tidak
> lagi "ikut Binfeo" hanya karena sebelumnya ada trafik Binfeo ke alamat yang sama
> (mis. setelah `scanif -p ... localhost`). Kalau memang mau biner tersandi,
> set eksplisit `protocol: "Binfeo"`.

---

## 8. Contoh 4 — RSA handshake untuk berbagi secret key ChaCha20

Pola ini dipakai di **TeleChat** dan **tpkgd**: RSA (asimetris) dipakai **sekali** untuk
mengirim session key ChaCha20 (simetris) dengan aman. Setelah itu semua data memakai
ChaCha20 (lebih cepat).

> **Irit data dengan opcode, bukan string panjang.** Jenis paket ditandai **opcode**
> di awal payload (`onData` tidak membawa field `flag`, jadi opcode ditaruh di payload).
> Pakai **satu karakter** (`"1"`, `"2"`, `"3"`) — bukan Buffer biner, karena protocol
> JSON default akan mengubah Buffer jadi JSON (`{"type":"Buffer",...}`) sehingga byte
> biner tidak sampai apa adanya. Karakter string lolos utuh.

```
Opcode (char pertama payload):
  "1" = REQUEST_KEY   (client → server, minta public key)
  "2" = PUBKEY        (server → client, diikuti public key PEM)
  "3" = SECRETKEY     (client → server, diikuti session key ter-enkripsi RSA)
  "4" = MSG           (dua arah, terenkripsi setelah handshake)
```

> ⚠️ JANGAN pakai `binary: true` untuk handshake ini — protocol Binary **bypass
> enkripsi saat TX** (dirancang untuk OTA/raw transfer). Karena kita butuh ChaCha20
> setelah handshake, gunakan protocol JSON default.

```
Client                                   Server
  │  generateKeyPair() (RSA)              │
  │  open() (plain)                       │
  │  ── "1" ───────────────────────────▶  │
  │                                       │  generateKeyPair() (RSA)
  │  ◀── "2"+publicKey ─────────────────  │
  │  generateSessionKey() (32 byte)       │
  │  encryptWithPublicKey(serverPub, sk)  │
  │  ── "3"+encSessionKey ──────────────▶ │  decryptWithPrivateKey(priv, enc) → sessionKey
  │                                       │  upgradeSecurity(sessionKey)
  │  upgradeSecurity(sessionKey)          │
  │  ◀═══ data terenkripsi ChaCha20 ═══▶  │
```

### Client side
```ts
import { Program, std, NetSocket } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";

// Opcode (char pertama payload)
const OP = { REQ_KEY: "1", PUBKEY: "2", SECRET_KEY: "3", MSG: "4" };

let handshaked = false; // true setelah upgradeSecurity() — channel terenkripsi

const sock = new NetSocket({ port: 0 });   // client: port random (ephemeral) — tidak peduli port lokal
sock.onData = (pkt) => {
  const text = String(pkt.data);
  const op = text.charAt(0);              // char pertama = opcode
  const body = text.slice(1);             // sisanya = data

  if (op === OP.PUBKEY && !handshaked) {
    // 1) Server kirim public key
    const serverPub = body;
    const sessionKey = SecurityAgent.generateSessionKey();          // 32 byte acak
    const enc = SecurityAgent.encryptWithPublicKey(serverPub, sessionKey);

    // 2) Kirim session key ter-enkripsi RSA (payload: opcode + hex)
    void sock.sendTo("localhost", 2500, OP.SECRET_KEY + enc);

    // 3) Switch ke ChaCha20, lalu kirim pesan terenkripsi
    void sock.upgradeSecurity(sessionKey.toString("hex")).then(async () => {
      handshaked = true;
      await sock.sendTo("localhost", 2500, OP.MSG + "hello, secure channel!");
    });
  } else if (op === OP.MSG && handshaked) {
    // Balasan terenkripsi dari server
    std.println(`[secure] ${body}`);
  }
};
await sock.open();
await sock.waitClosed();
```

### Server side
```ts
import { Program, std, NetSocket } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";

const OP = { REQ_KEY: "1", PUBKEY: "2", SECRET_KEY: "3", MSG: "4" };
const keys = SecurityAgent.generateKeyPair();   // RSA key pair server
let secured = false;

const sock = new NetSocket({ port: 2500 });
sock.onData = async (pkt) => {
  const text = String(pkt.data);
  const op = text.charAt(0);
  const body = text.slice(1);

  // Handshake sudah selesai — abaikan paket handshake yang terulang.
  if (secured && (op === OP.REQ_KEY || op === OP.SECRET_KEY)) return;

  if (op === OP.REQ_KEY) {
    // Kirim public key: opcode + PEM
    await sock.reply(pkt, OP.PUBKEY + keys.publicKey);
  } else if (op === OP.SECRET_KEY) {
    // Terima session key ter-enkripsi → decrypt → aktifkan ChaCha20
    const enc = body;
    const sessionKey = SecurityAgent.decryptWithPrivateKey(keys.privateKey, enc);
    await sock.upgradeSecurity(sessionKey.toString("hex"));
    secured = true;
    std.println("[server] session key diterima, koneksi aman!");
  } else if (op === OP.MSG && secured) {
    // Data sudah terenkripsi (ChaCha20) — baca & balas lewat channel yang sama.
    std.println(`[secure] ${body}`);
    await sock.reply(pkt, OP.MSG + `echo: ${body}`);
  }
};
await sock.open();
await sock.waitClosed();
```

> **Catatan protocol:** pakai protocol JSON default (jangan `binary: true`) untuk
> handshake ini — protocol Binary **bypass enkripsi saat TX** (untuk OTA/raw transfer),
> sedangkan kita butuh ChaCha20 setelah handshake. Opcode sebagai **string char**
> (`"1"`/`"2"`/`"3"`) lolos utuh di JSON protocol (Buffer biner malah diubah jadi
> `{"type":"Buffer",...}`).

> **Setelah handshake — ngobrol dua arah terenkripsi.** Begitu kedua sisi
> `upgradeSecurity(sessionKey)`, semua `sendTo`/`reply` berikutnya otomatis terenkripsi
> ChaCha20 (driver memakai session key per port). Contoh nyata di
> `netsocket-rsacha-client.ts` / `netsocket-rsacha-server.ts`: client kirim
> `"hello N from client"` → server terima (decrypt) → balas `"echo: ..."` → client
> tampilkan. Selama keduanya memakai session key yang sama, pesan terbaca dua arah.

### Kenapa RSA + ChaCha20 (bukan cuma RSA)?
- **RSA (asimetris)**: aman untuk pertukaran kunci, tapi lambat untuk data besar.
- **ChaCha20 (simetris)**: cepat untuk data berukuran apa pun.
- Kombinasi: **RSA sekali untuk kirim session key → ChaCha20 untuk semua data** = aman + cepat.
  Ini pola standar (mirip TLS handshake → record layer).

> Catatan: `SecurityAgent.generateSessionKey()` return `Buffer` 32 byte. `upgradeSecurity()`
> menerima hex string — jadi konversi `.toString("hex")`.

---

## 9. API ringkas

| Method | Kegunaan |
|---|---|
| `new NetSocket({ port, key?, binary?, protocol?, iface? })` | Konfigurasi (port wajib) — `protocol` mis. `"Binfeo"` utk biner tersandi |
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
| `port` | Port lokal yang ter-bind — untuk `port: 0`, berisi port ASLI hasil pilihan kernel (null sebelum open) |
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

## 10. Checklist cepat (biar tidak salah)

- [ ] Set `onData` **sebelum** `open()` (kalau mau event-driven)
- [ ] Jangan set `onData` sekaligus pakai `recv()` manual (eksklusif)
- [ ] Port lokal boleh **tetap** atau `0` (ephemeral) — `upgradeSecurity()` otomatis memakai `sock.port` (port asli). Port tetap cuma perlu kalau pihak lain harus tahu port kita dari awal
- [ ] Kedua sisi pakai **key yang sama** + sama-sama `upgradeSecurity()`
- [ ] Untuk handshake: RSA kirim session key → `upgradeSecurity(sessionKey)` di kedua sisi
- [ ] `waitClosed()` untuk jaga proses tetap hidup; `close()` untuk cleanup
