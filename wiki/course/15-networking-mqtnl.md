---
module: 15
title: Networking MQTNL
part: VI
partTitle: Jaringan
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Networking MQTNL

**RFC-TSIX-EDU-002** | Modul kelima belas kurikulum TSIX. Memahami MQTNL (MQTT Network Layer) — protokol networking TSIX yang memakai MQTT pub/sub sebagai wire, bukan IP/routing.

> Alih-alih TCP/IP, MQTNL memakai **MQTT pub/sub sebagai wire**. Alamat = **nama node** (string), port = **endpoint aplikasi** (PortManager). Koneksi bersifat connectionless/UDP-like — tidak ada listen/accept sungguhan, hanya emulasi polling.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan konsep alamat = nama node, port = endpoint aplikasi
- [ ] Menjelaskan alur socket: bind → sendto → recvfrom
- [ ] Menjelaskan peran PortManager dan releasePortsByPid
- [ ] Menjelaskan mengapa tidak ada listen/accept (emulasi polling)
- [ ] Menyebutkan syscall networking (30–34) + SECAGENT_LIST (39)

---

## Konsep Inti

### Model: MQTT pub/sub adalah "wire"-nya

MQTNL tidak memakai TCP/IP. Tidak ada alamat IP, tidak ada routing, tidak ada koneksi stateful. Sebagai gantinya, TSIX memakai **MQTT pub/sub sebagai media transport (wire)**:

- **Setiap node** terhubung ke **MQTT broker** yang sama.
- **Alamat = nama node** (string): `"tsix"`, `"tsix-node-2"`, `"esp32S3"`. Nama ini unik per perangkat.
- **Topic = `mqtnl@1.0/<dstAddress>`** (protokol JSON) / `mqtnl@1.1/<dstAddress>` (protokol Binary). Isi topic adalah **paket MQTNL** (header + payload).
- **Semua node subscribe `mqtnl@1.x/#`**, lalu **menyaring** paket berdasarkan `dstAddress` (atau `"*"` untuk broadcast). Paket untuk node lain di-drop.

Pengiriman bersifat fire-and-forget tanpa sesi — karena itu model ini **connectionless / UDP-like**.

### Alamat & Port

| Konsep | Nilai | Analog TCP/IP |
|---|---|---|
| Alamat | Nama node (string) | IP address |
| Port | Endpoint aplikasi (0–65535) | Port TCP/UDP |
| Wire | Topic MQTT pub/sub | Paket IP |
| Koneksi | Connectionless (fire-and-forget) | UDP |

Setiap `sendto()` membuat paket mandiri. Header paket membawa alamat & port tujuan, jadi tidak perlu koneksi yang dijaga.

### Tiga Komponen Utama

1. **SimpleMQTNLDriver** — *network interface* (`/dev/smqtnl0`, `/dev/smqtnl1`). Menjaga koneksi ke broker MQTT, publish paket keluar, menerima & menyaring paket masuk, fragmentasi 32KB, reassembly, dan dekripsi. Tiap instance punya `localAddress` (nama node) sendiri.
2. **SocketDevice** — abstraksi satu socket: buffer data masuk + daftar waiter. Dibuat per syscall `SOCKET` dan disimpan di FD table. Bersifat pasif — data masuk di-`push` oleh driver, aplikasi membacanya lewat `recvfrom`.
3. **PortManager** — penjaga port virtual 0–65535. `allocatePort()` untuk bind eksplisit, `allocateRandomPort(10000-20000)` untuk `bind(0)`, `releasePortsByPid()` saat proses exit.

### Per-port handler

Ketika aplikasi `bind(port)`, kernel memanggil `driver.registerHandler(port, cb)`. Handler ini menyalurkan data masuk ke socket milik aplikasi:

```
bind(port)
  → PortManager.allocatePort(port, pid)
  → socket.setPort(port); socket.driver = targetDriver
  → driver.registerHandler(port, (data) => socket.push(data))
```

Saat paket tiba, driver memanggil handler pada `dstPort`. Inilah **dispatch per-port**: satu driver melayani banyak port sekaligus.

### Alur socket (ringkas)

```
App → socket() → bind(port) → driver.registerHandler(port)
  → sendto(addr, port, data) → driver.send → publish topic
  → MQTT broker → semua node subscribe 'mqtnl@1.x/#'
  → filter dstAddress → reassembly → decrypt → socket.push()
  → recvfrom() → buffer.shift()
```

### Syscall

```
SOCKET=30, BIND=31, SENDTO=32, RECVFROM=33, NETSTAT=34, SECAGENT_LIST=39
```

> `SECAGENT_LIST` (39) dipakai tool `secagent` untuk menampilkan agent enkripsi yang terdaftar di kernel.

Tidak ada `listen/accept` di level syscall. UserLib meng-emulasi: `listen()` = `socket()` + `bind()`; `accept()` = polling `recv()` sampai ada paket pertama.

---

## Alur / Cara Kerja

Alur pengiriman dari **App A** di node `"tsix"` (port N) ke **App B** di node `"esp32S3"` (port M) melalui MQTT broker:

```
        ┌────────────────────────────────────┐
        │            MQTT BROKER             │
        │    router publish / subscribe      │
        │    topic: mqtnl@1.0/esp32S3        │
        └─────────────────┬──────────────────┘
                          │  ② forward ke semua subscriber
        ┌─────────────────┴──────────────────┐
        ▼                                   ▼
┌───────────────────────┐   ┌───────────────────────┐
│ NODE "tsix"           │   │ NODE "esp32S3"        │
│  App A                │   │  App B                │
│  socket → bind(port N)│   │  socket → bind(port M)│
│  sendto("esp32S3",    │   │  recv(fd)             │
│    M, data)           │   │  → buffer.shift()     │
│      │                │   │      ▲                │
│      ▼ ① publish      │   │      │ ③ push         │
│  SimpleMQTNLDriver    │   │  SimpleMQTNLDriver    │
│  smqtnl0 ("tsix")     │   │  smqtnl1 ("esp32S3")  │
└───────────────────────┘   └───────────────────────┘
```

Langkah detail:

1. **SOCKET** — App A dan App B memanggil `socket()`. Kernel membuat `SocketDevice` baru dan menyisipkannya ke FD table (`context: "socket"`).
2. **BIND** — App A memanggil `bind(fd, N)`. Kernel menentukan driver target (default `smqtnl0`), memesan port N lewat `PortManager.allocatePort(N, pid)`, lalu `registerHandler(N, cb)` yang menyalurkan data ke socket A.
3. **SENDTO** — App A memanggil `sendto(fd, "esp32S3", M, data)`. Kernel memanggil `driver.send("esp32S3", M, data, FLAG_DATA, N)`.
4. **Fragmentasi** — `send()` memecah payload menjadi chunk 32KB bila perlu, lalu membungkus tiap chunk dalam paket ber-header 9 field.
5. **Publish** — driver publish tiap chunk ke topic `mqtnl@1.0/esp32S3` (`qos: 0`, `retain: false`).
6. **Broker & filter** — semua node subscribe `mqtnl@1.x/#` menerima paket. Tiap driver menyaring: paket hanya diproses bila `dstAddress` sama dengan `localAddress` (atau `"*"`). Paket lain di-drop. Paket yang dikirim sendiri (src = local) juga diabaikan.
7. **Reassembly & dekripsi** — driver tujuan merakit chunk (sesi per `srcAddr:srcPort → dstAddr:dstPort`, TTL 30s), lalu mendekripsi payload via agent yang terpasang di port (default `SecurityAgent`/"chacha20"; bisa di-upgrade ke agent lain via `upgradeSecurity(key, { agent })`, mis. `"aes-gcm"`).
8. **Dispatch** — driver memanggil handler pada `dstPort` → `socket.push({ src, port, localPort, data, isBinary, ts })` → data masuk buffer socket.
9. **RECVFROM** — App B memanggil `recv(fd)`. Kernel membaca buffer (`read()` = `buffer.shift()`). Jika kosong, kernel menunggu event-driven (`waitForData`) sampai data di-push.

> [!NOTE] **Loopback lokal.** Jika `dstAddress` sama dengan alamat node pengirim (atau `"localhost"`), paket tidak keluar ke broker — driver meneruskannya langsung ke instance driver lokal (`SimpleMQTNLDriver.findLocal()`), mirip `localhost` di OS sungguhan.

---

## Kode Sumber

| File | Peran |
|---|---|
| `src/kernel/devices/SimpleMQTNLDriver.ts` | Network interface MQTNL |
| `src/kernel/devices/SocketDevice.ts` | Socket = device (everything is a file) |
| `src/kernel/PortManager.ts` | Alokasi port virtual |
| `src/mirror/lib/NetworkLib.ts` | API `lib.net` + komponen `NetSocket` (single source of truth) |
| `src/mirror/lib/UserLib.ts` | Import & re-export `NetworkLib` dari `./NetworkLib` |
| `src/mirror/lib/Application.ts` | Proxy `net` + export `NetSocket`/`NetPacket` |
| `src/common/ISecurityAgent.ts` | Kontrak agent enkripsi (pluggable) |
| `src/common/AesGcmAgent.ts` | Contoh agent kustom AES-256-GCM |
| `src/kernel/Syscalls.ts` | Implementasi syscall SOCKET–NETSTAT (30–34) + SECAGENT_LIST (39) |
| `src/mirror/sbin/secagent.ts` | Tool daftar agent yang terdaftar |
| `src/sysconfig.json` | Konfigurasi interface network default |

> [!NOTE] **Satu `NetworkLib`.** Class `NetworkLib` kini tunggal di `NetworkLib.ts` dan menerima `dispatch` ATAU `OSContext` (kompatibel pemakai lama). Untuk aplikasi baru, disarankan `NetSocket` — API high-level yang membungkus lifecycle + events + security.

### Interface network default (`sysconfig.json`)

Saat boot, kernel membaca `cfg.network.interfaces` dan membuat satu `SimpleMQTNLDriver` per entri (`Kernel.ts` → "Initialize Network Interfaces"). Tiap interface punya **deviceName** (nama `/dev`), **address** (nama node), dan **broker**:

| deviceName | address (nama node) | broker | defaultPort |
|---|---|---|---|
| `smqtnl0` | `tsix` | `mqtt://192.168.1.204` | 1883 |
| `smqtnl1` | `tsix-node-2` | `mqtt://192.168.1.204` | 1883 |

`cfg.network.defaultDevice` = `smqtnl0`. Jika `bind()` tanpa argumen `address`, kernel memakai interface default ini.

---

## Snippet (level kode)

Semua snippet di bawah **disalin dari sumber** — "kode adalah kebenaran". Bagian yang dipangkas ditandai `// ...`.

### NetworkLib — pemakaian dari sisi app (`NetworkLib.ts`)

`lib.net` adalah instance `NetworkLib` (single source of truth di `NetworkLib.ts`). Konstruktornya menerima `dispatch` (dipakai `UserLib`) ATAU `OSContext` (dipakai `ping.ts`/`network-traffic.ts`). Socket dikembalikan sebagai **fd** (angka), bukan objek:

```ts
export class NetworkLib {
  // Menerima `dispatch` (UserLib) ATAU `OSContext` (app legacy) — disatukan
  // jadi satu source of truth (resolveDispatch memilih dispatch yang benar).
  constructor(source: DispatchFn | OSContext) { /* resolveDispatch(source) */ }

  public async socket(): Promise<number> {
    return await this.dispatch(SyscallCode.SOCKET, null);
  }

  public async bind(
    fd: number,
    port: number,
    address?: string,
  ): Promise<boolean> {
    return await this.dispatch(SyscallCode.BIND, { fd, port, address });
  }

  // listen() = socket + bind — emulasi, tidak ada syscall LISTEN
  public async listen(port: number): Promise<number> {
    const fd = await this.socket();
    const ok = await this.bind(fd, port);
    return ok ? fd : -1;
  }

  // accept() = polling recv() sampai ada paket pertama
  public async accept(serverFd: number): Promise<any> {
    while (true) {
      const pkt = await this.recv(serverFd);
      if (pkt) {
        return {
          fd: serverFd,
          src: pkt.src,
          port: pkt.port,
          localPort: pkt.localPort || 0,
          firstPkt: pkt,
        };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  public async sendto(
    fd: number,
    address: string,
    port: number,
    data: any,
    flag: number = 0,
    srcPort: number = 0,
  ): Promise<boolean> {
    return await this.dispatch(SyscallCode.SENDTO, {
      fd,
      address,
      port,
      data,
      flag,
      srcPort,
    });
  }

  public async recv(fd: number): Promise<any> {
    return await this.dispatch(SyscallCode.RECVFROM, fd);
  }
}
```

Contoh pemakaian (pola server–client):

```ts
// Server di node "tsix"
const fd = await lib.net.listen(8080);              // socket + bind(8080)
const client = await lib.net.accept(fd);            // polling recv → { src, port, firstPkt }
const data = await lib.net.recv(fd);                // baca data

// Client mengirim ke node "esp32S3", port 5000
await lib.net.sendto(fd, "esp32S3", 5000, JSON.stringify({ cmd: "ping" }));
```

### NetSocket — API high-level ala Cashew (`NetworkLib.ts`)

`NetSocket` membungkus syscall + security + lifecycle jadi komponen: instantiate → event → open → close. Security tidak otomatis — switch eksplisit via `upgradeSecurity(key, { agent })`:

```ts
const sock = new NetSocket({ port: 8080, key: KEY_HEX });

sock.onData = (pkt) => std.println(`[${pkt.src}:${pkt.port}] ${pkt.data}`);
sock.onError = (err) => std.println(`ERR: ${err.message}`);

await sock.open();                                         // socket + bind (plain dulu)
await sock.upgradeSecurity(KEY_HEX);                       // switch ke chacha20 (default)
await sock.upgradeSecurity(KEY_HEX, { agent: "aes-gcm" }); // atau agent kustom
await sock.sendTo("esp32S3", 5000, JSON.stringify({ cmd: "ping" }));

await sock.waitClosed();                                   // jaga proses tetap hidup
await sock.close();                                        // release port + normalisasi agent
```

### PortManager — bind & release (`PortManager.ts`)

```ts
public allocatePort(port: number, pid?: number): boolean {
    if (port < 0 || port > 65535) return false;
    if (this.usedPorts.has(port)) return false;

    this.usedPorts.add(port);
    if (pid !== undefined) this.portOwner.set(port, pid);
    return true;
}

public allocateRandomPort(min: number = 10000, max: number = 20000): number | null {
    for (let i = 0; i < 100; i++) {
        const port = Math.floor(Math.random() * (max - min + 1)) + min;
        if (!this.usedPorts.has(port)) {
            this.usedPorts.add(port);
            return port;
        }
    }
    return null;
}

public releasePortsByPid(pid: number): void {
    const toRelease: number[] = [];
    this.portOwner.forEach((owner, port) => {
        if (owner === pid) toRelease.push(port);
    });
    for (const port of toRelease) {
        this.usedPorts.delete(port);
        this.portOwner.delete(port);
    }
}
```

> [!TIP] `releasePortsByPid()` dipanggil saat proses exit — **jaring pengaman** jika aplikasi lupa melepas port.

### SocketDevice — buffer & handler dispatch (`SocketDevice.ts`)

```ts
public push(data: any) {
    this.buffer.push(data);
    // Bangunkan semua reader yang sedang nunggu data (event-driven)
    while (this.waiters.length > 0) {
        const w = this.waiters.shift()!;
        w();
    }
}

public read(): any {
    return this.buffer.shift() || null;
}

public async waitForData(timeoutMs: number): Promise<boolean> {
    if (this.buffer.length > 0) return true;
    return new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onData = () => {
            if (timer) clearTimeout(timer);
            const idx = this.waiters.indexOf(onData);
            if (idx >= 0) this.waiters.splice(idx, 1);
            resolve(true);
        };
        timer = setTimeout(() => {
            const idx = this.waiters.indexOf(onData);
            if (idx >= 0) this.waiters.splice(idx, 1);
            resolve(false);
        }, timeoutMs);
        this.waiters.push(onData);
    });
}
```

### SimpleMQTNLDriver — init & send (`SimpleMQTNLDriver.ts`)

```ts
public init(ctx: KContext): void {
    this.client = mqtt.connect(this.brokerUrl);

    this.client.on("connect", () => {
        for (const proto of this.protocols) {
            const prefix = proto.getTopicPrefix();
            this.client?.subscribe(`${prefix}#`);   // subscribe "mqtnl@1.0/#" & "mqtnl@1.1/#"
        }
    });

    this.client.on("message", (topic, message) => {
        this.handleIncomingMessage(topic, message);
    });
}
```

```ts
public async send(address: string, port: number, data: any, flag: PacketFlags = PacketFlags.FLAG_DATA, srcPort: number = 0) {
    // [LOOPBACK] Reserved alias "localhost" selalu menunjuk ke interface
    // pengirim sendiri — mirip localhost di OS sungguhan.
    if (address === "localhost") {
        address = this.localAddress;
    }

    // [LOOPBACK] Kalau tujuan adalah alamat lokal (milik node ini), kirim
    // langsung ke receiver tanpa keluar ke broker MQTT.
    const localTarget = SimpleMQTNLDriver.findLocal(address);

    // Cek koneksi hanya untuk paket yang benar-benar keluar ke broker.
    if (!localTarget && (!this.client || !this.client.connected)) return false;

    // ... (normalisasi payload, pemilihan protokol JSON/Binary, enkripsi,
    //      fragmentasi 32KB, header 9 field) — lihat file sumber

    const topic = `${prefix}${address}`;   // mis. "mqtnl@1.0/esp32S3"

    for (let i = 0; i < packetCount; i++) {
        // ... (bungkus packet, protocol.pack)
        if (localTarget) {
            localTarget.handleIncomingMessage(topic, payloadBuffer);   // LOOPBACK lokal
        } else {
            await new Promise((resolve) => {
                this.client!.publish(topic, payloadBuffer, { qos: 0, retain: false }, (err) => {
                    if (err) this.logger.error(`MQTT Publish error: ${err.message}`);
                    resolve(true);
                });
            });
        }
    }
    return true;
}
```

### BIND — menghubungkan socket ke driver & port (`Syscalls.ts`)

```ts
case SyscallCode.BIND: {
    const { fd, port, address } = args as {
        fd: number;
        port: number;
        address?: string;
    };
    const entry = pcb.fdTable[fd];
    if (!entry || !(entry.device instanceof SocketDevice))
        throw new Error("Invalid Socket FD");

    const socket = entry.device as SocketDevice;
    if (socket.bound) throw new Error("Socket already bound");

    // ... pilih targetDriver (dari `address`, atau cfg.network.defaultDevice)

    const portMgr = this.kernel.getPortManager();
    let actualPort = port;

    if (port === 0) {
        const randomPort = portMgr.allocateRandomPort();
        if (randomPort === null) throw new Error("No random ports available");
        actualPort = randomPort;
    } else {
        if (!portMgr.allocatePort(port, pcb.pid))
            throw new Error(`Port ${port} already in use`);
    }

    socket.setPort(actualPort);
    socket.driver = targetDriver;

    // Register handler
    targetDriver.registerHandler(actualPort, (data) => {
        socket.push(data);
    });

    return true;
}
```

---

## Latihan / Praktik

1. Baca `wiki/Networking-MQTNL.md` — alur lengkap dan topik.
2. Baca `src/kernel/PortManager.ts` — pahami `allocateRandomPort` dan `releasePortsByPid`.
3. Jalankan dua node (mis. `tsix` dan `esp32S3` di MQTT broker) — kirim pesan antar keduanya.
4. Baca `src/kernel/devices/SocketDevice.ts` — jelaskan bagaimana socket menjadi `IDevice`.
5. Dari aplikasi, jalankan `lib.net.netstat()` — bandingkan hasilnya dengan tabel interface di `sysconfig.json`.

---

## Referensi

- `wiki/Networking-MQTNL.md` — dokumentasi lengkap MQTNL
- `wiki/course/00-overview.md` §7 — Networking MQTNL
- `src/kernel/devices/SimpleMQTNLDriver.ts` — network interface
- `src/kernel/devices/SocketDevice.ts` — socket = device
- `src/kernel/PortManager.ts` — alokasi port virtual
- `src/kernel/Syscalls.ts` — implementasi syscall SOCKET–NETSTAT (30–34)
- `src/sysconfig.json` — interface network default

---

*Modul 15 — selesai. Lanjut ke [Modul 16 — Wire Protocol MQTNL](16-wire-protocol-mqtnl.md).*
