---
module: 15
title: Networking MQTNL
part: VI
partTitle: Networking
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Networking MQTNL

**RFC-TSIX-EDU-002** | Fifteenth module of the TSIX curriculum. Understand MQTNL (MQTT Network Layer) — the TSIX networking protocol that uses MQTT pub/sub as the wire, instead of IP/routing.

> Instead of TCP/IP, MQTNL uses **MQTT pub/sub as the wire**. Address = **node name** (string), port = **application endpoint** (PortManager). Connections are connectionless/UDP-like — there is no real listen/accept, only polling emulation.

---

## Learning Objectives

- [ ] Explain the concept of address = node name, port = application endpoint
- [ ] Explain the socket flow: bind → sendto → recvfrom
- [ ] Explain the role of PortManager and releasePortsByPid
- [ ] Explain why there is no listen/accept (polling emulation)
- [ ] List the networking syscalls (30–34)

---

## Core Concepts

### Model: MQTT pub/sub is the "wire"

MQTNL does not use TCP/IP. There is no IP address, no routing, no stateful connection. Instead, TSIX uses **MQTT pub/sub as the transport medium (wire)**:

- **Every node** connects to the **same MQTT broker**.
- **Address = node name** (string): `"tsix"`, `"tsix-node-2"`, `"esp32S3"`. This name is unique per device.
- **Topic = `mqtnl@1.0/<dstAddress>`** (JSON protocol) / `mqtnl@1.1/<dstAddress>` (Binary protocol). The topic content is an **MQTNL packet** (header + payload).
- **All nodes subscribe to `mqtnl@1.x/#`**, then **filter** packets by `dstAddress` (or `"*"` for broadcast). Packets for other nodes are dropped.

Sending is fire-and-forget without a session — that is why this model is **connectionless / UDP-like**.

### Address & Port

| Concept | Value | TCP/IP analog |
|---|---|---|
| Address | Node name (string) | IP address |
| Port | Application endpoint (0–65535) | TCP/UDP port |
| Wire | MQTT pub/sub topic | IP packet |
| Connection | Connectionless (fire-and-forget) | UDP |

Each `sendto()` creates a self-contained packet. The packet header carries the destination address & port, so no connection needs to be kept.

### Three Main Components

1. **SimpleMQTNLDriver** — *network interface* (`/dev/smqtnl0`, `/dev/smqtnl1`). Keeps the connection to the MQTT broker, publishes outbound packets, receives & filters inbound packets, 32KB fragmentation, reassembly, and decryption. Each instance has its own `localAddress` (node name).
2. **SocketDevice** — the abstraction of one socket: inbound data buffer + waiter list. Created per `SOCKET` syscall and stored in the FD table. It is passive — inbound data is `push`ed by the driver, and the application reads it via `recvfrom`.
3. **PortManager** — keeper of virtual ports 0–65535. `allocatePort()` for explicit bind, `allocateRandomPort(10000-20000)` for `bind(0)`, `releasePortsByPid()` when a process exits.

### Per-port handler

When an application `bind(port)`s, the kernel calls `driver.registerHandler(port, cb)`. This handler routes inbound data to the socket owned by the application:

```
bind(port)
  → PortManager.allocatePort(port, pid)
  → socket.setPort(port); socket.driver = targetDriver
  → driver.registerHandler(port, (data) => socket.push(data))
```

When a packet arrives, the driver calls the handler on `dstPort`. This is **per-port dispatch**: one driver serves many ports at once.

### Socket flow (summary)

```
App → socket() → bind(port) → driver.registerHandler(port)
  → sendto(addr, port, data) → driver.send → publish topic
  → MQTT broker → semua node subscribe 'mqtnl@1.x/#'
  → filter dstAddress → reassembly → decrypt → socket.push()
  → recvfrom() → buffer.shift()
```

### Syscall

```
SOCKET=30, BIND=31, SENDTO=32, RECVFROM=33, NETSTAT=34
```

There is no `listen/accept` at the syscall level. UserLib emulates it: `listen()` = `socket()` + `bind()`; `accept()` = polling `recv()` until the first packet arrives.

---

## Flow / How It Works

Sending flow from **App A** on node `"tsix"` (port N) to **App B** on node `"esp32S3"` (port M) via the MQTT broker:

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

Detailed steps:

1. **SOCKET** — App A and App B call `socket()`. The kernel creates a new `SocketDevice` and inserts it into the FD table (`context: "socket"`).
2. **BIND** — App A calls `bind(fd, N)`. The kernel determines the target driver (default `smqtnl0`), reserves port N via `PortManager.allocatePort(N, pid)`, then `registerHandler(N, cb)` routes data to socket A.
3. **SENDTO** — App A calls `sendto(fd, "esp32S3", M, data)`. The kernel calls `driver.send("esp32S3", M, data, FLAG_DATA, N)`.
4. **Fragmentation** — `send()` splits the payload into 32KB chunks when needed, then wraps each chunk in a packet with a 9-field header.
5. **Publish** — the driver publishes each chunk to the topic `mqtnl@1.0/esp32S3` (`qos: 0`, `retain: false`).
6. **Broker & filter** — all nodes subscribed to `mqtnl@1.x/#` receive the packet. Each driver filters: a packet is processed only when `dstAddress` equals its `localAddress` (or `"*"`). Other packets are dropped. Packets sent by the node itself (src = local) are also ignored.
7. **Reassembly & decryption** — the destination driver reassembles the chunks (session per `srcAddr:srcPort → dstAddr:dstPort`, TTL 30s), then decrypts the payload via `SecurityAgent` (the port can be upgraded to ChaCha20-Poly1305 via ioctl `0x1001`).
8. **Dispatch** — the driver calls the handler on `dstPort` → `socket.push({ src, port, localPort, data, isBinary, ts })` → data enters the socket buffer.
9. **RECVFROM** — App B calls `recv(fd)`. The kernel reads the buffer (`read()` = `buffer.shift()`). If empty, the kernel waits event-driven (`waitForData`) until data is pushed.

> [!NOTE] **Local loopback.** If `dstAddress` equals the sender node's own address (or `"localhost"`), the packet does not go out to the broker — the driver forwards it directly to the local driver instance (`SimpleMQTNLDriver.findLocal()`), similar to `localhost` on a real OS.

---

## Source Code

| File | Role |
|---|---|
| `src/kernel/devices/SimpleMQTNLDriver.ts` | MQTNL network interface |
| `src/kernel/devices/SocketDevice.ts` | Socket = device (everything is a file) |
| `src/kernel/PortManager.ts` | Virtual port allocation |
| `src/mirror/lib/NetworkLib.ts` | `lib.net` API (legacy, OSContext-based) |
| `src/mirror/lib/UserLib.ts` | Inline `lib.net` (new, `this.dispatch`) |
| `src/kernel/Syscalls.ts` | SOCKET–NETSTAT syscall implementation (30–34) |
| `src/sysconfig.json` | Default network interface configuration |

> [!WARNING] **Dual NetworkLib.** There are two `lib.net` implementations: inline in `UserLib.ts` (new) and `NetworkLib.ts` (legacy, OSContext-based). Both reach the same syscalls.

### Default network interfaces (`sysconfig.json`)

At boot, the kernel reads `cfg.network.interfaces` and creates one `SimpleMQTNLDriver` per entry (`Kernel.ts` → "Initialize Network Interfaces"). Each interface has a **deviceName** (`/dev` name), an **address** (node name), and a **broker**:

| deviceName | address (node name) | broker | defaultPort |
|---|---|---|---|
| `smqtnl0` | `tsix` | `mqtt://192.168.1.204` | 1883 |
| `smqtnl1` | `tsix-node-2` | `mqtt://192.168.1.204` | 1883 |

`cfg.network.defaultDevice` = `smqtnl0`. If `bind()` is called without an `address` argument, the kernel uses this default interface.

---

## Snippet (code level)

All snippets below are **copied from the source** — "code is truth". Trimmed parts are marked `// ...`.

### NetworkLib — usage from the app side (`UserLib.ts`)

`lib.net` is a `NetworkLib` instance on `UserLib` (new apps) and on `NetworkLib.ts` (legacy apps based on `OSContext`). A socket is returned as an **fd** (number), not an object:

```ts
export class NetworkLib {
  constructor(
    private dispatch: (code: SyscallCode, args: any) => Promise<any>,
  ) { }

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

Usage example (server–client pattern):

```ts
// Server di node "tsix"
const fd = await lib.net.listen(8080);              // socket + bind(8080)
const client = await lib.net.accept(fd);            // polling recv → { src, port, firstPkt }
const data = await lib.net.recv(fd);                // baca data

// Client mengirim ke node "esp32S3", port 5000
await lib.net.sendto(fd, "esp32S3", 5000, JSON.stringify({ cmd: "ping" }));
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

> [!TIP] `releasePortsByPid()` is called when a process exits — a **safety net** if an application forgets to release its ports.

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

### BIND — connecting a socket to the driver & port (`Syscalls.ts`)

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

## Exercises / Practice

1. Read `wiki/Networking-MQTNL.md` — the complete flow and topics.
2. Read `src/kernel/PortManager.ts` — understand `allocateRandomPort` and `releasePortsByPid`.
3. Run two nodes (e.g. `tsix` and `esp32S3` on an MQTT broker) — send a message between them.
4. Read `src/kernel/devices/SocketDevice.ts` — explain how a socket becomes an `IDevice`.
5. From an app, run `lib.net.netstat()` — compare the result with the interface table in `sysconfig.json`.

---

## References

- `wiki/Networking-MQTNL.md` — full MQTNL documentation
- `wiki/course/00-overview.md` §7 — Networking MQTNL
- `src/kernel/devices/SimpleMQTNLDriver.ts` — network interface
- `src/kernel/devices/SocketDevice.ts` — socket = device
- `src/kernel/PortManager.ts` — virtual port allocation
- `src/kernel/Syscalls.ts` — SOCKET–NETSTAT syscall implementation (30–34)
- `src/sysconfig.json` — default network interfaces

---

*Module 15 — done. Continue to [Module 16 — Wire Protocol MQTNL](16-wire-protocol-mqtnl.en.md).*
