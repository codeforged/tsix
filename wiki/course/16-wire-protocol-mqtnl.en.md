---
module: 16
title: Wire Protocol MQTNL
part: VI
partTitle: Networking
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Wire Protocol MQTNL

**RFC-TSIX-EDU-002** | Sixteenth module of the TSIX curriculum. Understand the data format on top of MQTT: the JSON vs Binary dual protocol, magic byte detection, and fragmentation.

> MQTNL has **two wire protocols**: JSON v1.0 (readable) and Binary v1.1 (compact, without encryption — for byte-exact OTA). The driver detects the protocol from the **first magic byte** per srcAddress.

---

## Learning Objectives

- [ ] Explain the `IMQTNLProtocol` contract
- [ ] Distinguish the JSON v1.0 vs Binary v1.1 protocol
- [ ] Explain magic byte detection
- [ ] Explain 32KB fragmentation and 30s TTL reassembly
- [ ] Explain why userland never touches the protocol directly

---

## Core Concepts

### The IMQTNLProtocol Contract

All MQTNL wire protocols implement a single contract. This interface is the "only door" between the driver and the wire format — adding a new protocol (e.g. v2) only requires implementing a new class, without changing the driver.

```ts
export interface IMQTNLProtocol {
    /** Nama protokol (misal: "JSON", "Binary") */
    getName(): string;
    /** Byte pertama penanda protokol dalam byte stream.
     *  JSON: '[' (0x5B). Binary: 'B' (0x42). */
    getMagicChars(): number[];
    /** MQTT Topic Prefix (misal: "mqtnl@1.0/", "mqtnl@1.1/") */
    getTopicPrefix(): string;
    /** Objek packet internal → Buffer/String untuk dikirim ke broker MQTT */
    pack(packet: any): Buffer | string;
    /** Raw data yang diterima → objek packet internal */
    unpack(data: Buffer | string): any;
}
```

### Packet header (9 fields + payload)

The internal packet structure (the object that is `pack`ed/`unpack`ed) is identical for both protocols. The only difference is how fields are written to the wire.

| Field | JSON (index array) | Binary (offset) | Type |
|---|---|---|---|
| `srcAddress` | 0 | S_ADDR_LEN + S_ADDR | string |
| `srcPort` | 1 | S_PORT | u16 LE |
| `dstAddress` | 2 | D_ADDR_LEN + D_ADDR | string |
| `dstPort` | 3 | D_PORT | u16 LE |
| `packetCount` | 4 | PACKET_COUNT | u16 LE |
| `packetIndex` | 5 | PACKET_INDEX | u16 LE |
| `dataSize` | 6 | DATA_SIZE | u32 LE |
| `packetHeaderFlag` | 7 | FLAG | u8 |
| `forwarded` | 8 | FORWARDED | u8 |
| `payload` | 9 | PAYLOAD (remaining buffer) | string / Buffer |

> [!NOTE] `packetCount` and `packetIndex` are part of the header (not a separate feature). `packetCount` = the total number of chunks, `packetIndex` = the chunk number (0-based). `dataSize` = the **total** payload size before it is split (not the size per chunk).

### Dual protocol JSON vs Binary

| Aspect | JSON v1.0 | Binary v1.1 |
|---|---|---|
| Class | `MQTNLProtocolJSON` | `MQTNLProtocolBinary` |
| Topic prefix | `mqtnl@1.0/<addr>` | `mqtnl@1.1/<addr>` |
| Magic byte | `[` (0x5B) | `B` (0x42) + ver `0x01` |
| Wire format | JSON array (text, readable) | Compact binary buffer, byte-exact |
| Readability | easy for humans to read | hard to read (binary) |
| Size | larger (text overhead) | smaller & precise |
| Encryption | RSA handshake + ChaCha20-Poly1305 | no encryption (plain, for OTA) |
| Used for | general communication (default legacy) | byte-exact OTA firmware transfer |

![RSA handshake: SYN → SYN-ACK → ACK → encrypted DATA](/wiki/diagram/Networking-MQTNL-2.png)
*Source: [`wiki/diagram/Networking-MQTNL-2.mmd`](/wiki/diagram/Networking-MQTNL-2.mmd)*

### Binary v1.1 frame format

Byte-by-byte diagram of the binary frame (N = length of `srcAddress`, M = length of `dstAddress`, L = payload length):

```
| 0x42 | 0x01 |  len  | <src addr>      | srcPort |  len  | <dst addr>      | dstPort |
| MAGIC| VER  | sAL=N | srcAddr (N b)   |  u16LE  | dAL=M | dstAddr (M b)   |  u16LE  |

| pktCount | pktIndex | dataSize | flag | fwd | <payload>        |
|  u16LE   |  u16LE   |  u32LE   |  u8  | u8  | payload (L b)    |
```

- Fixed header size = 18 bytes + N + M (`2 + 1 + N + 2 + 1 + M + 2 + 2 + 2 + 4 + 1 + 1`).
- Example: `srcAddress="tsix"` (N=4), `dstAddress="esp32S3"` (M=7) → header = 29 bytes.
- All fields are read in a deterministic order (no delimiter), so the address lengths must be sent (`S_ADDR_LEN`/`D_ADDR_LEN`).
- **There is no CRC/checksum** inside the frame. OTA integrity is protected by `dataSize` (u32) and the byte-exact raw path.

### Magic byte detection

The driver does not guess the protocol from the topic. It reads the **first byte** of the MQTT payload and matches it against `getMagicChars()` of each registered protocol:

```ts
// Detect protocol by Magic Byte (di SimpleMQTNLDriver.handleIncomingMessage)
const magicByte = Buffer.isBuffer(message) ? message[0] : (message as string).charCodeAt(0);
const proto = this.protocols.find(p => p.getMagicChars().includes(magicByte));
if (!proto) {
    this.logger.error(`Protocol mismatch on ${topic}. Magic: 0x${message[0].toString(16)}`);
    return;
}
packet = proto.unpack(message);

// [MULTI-PROTO] Register protocol untuk pengirim ini (per srcAddress)
this.protocolRegistry.set(packet.header.srcAddress, proto);
```

The result is stored in `protocolRegistry` **per `srcAddress`**. When sending back to that address, the driver uses the same protocol (default: JSON).

### Fragmentation & Reassembly

- **Fragmentation**: the payload is split into 32KB chunks (`packetSize = 32768`). Each chunk is sent as a separate MQTT packet with `packetCount`/`packetIndex` filled in.
- **Reassembly**: the receiver collects chunks in a session per `src:port->dst:port`. The session is complete when the number of unique chunks equals `packetCount`, then they are merged in order (`Buffer.concat` for Buffer, `join("")` for strings).
- **30 second TTL**: sessions that are incomplete within 30 seconds are dropped (`cleanupExpiredPackets`, run every 60 seconds).

```
SEND (TX)                                 RECEIVE (RX)
┌──────────────────┐                      ┌────────────────────────────┐
│ payload 70KB     │                      │ subscribe "mqtnl@1.x/#"    │
└────────┬─────────┘                      └─────────────┬──────────────┘
         ▼ pecah 32KB                                   ▼
┌──────────────────┐    publish 3 paket   ┌────────────────────────────┐
│ chunk 0 (idx 0)  │ ───────────────────▶ │ deteksi magic byte → unpack │
│ chunk 1 (idx 1)  │    topic per dst     │ filter dstAddress           │
│ chunk 2 (idx 2)  │                      └─────────────┬──────────────┘
└──────────────────┘                                    ▼
                                          ┌────────────────────────────┐
                                          │ reassembly by key           │
                                          │ src:port->dst:port          │
                                          │ TTL 30s → buang jika telat  │
                                          └─────────────┬──────────────┘
                                                        ▼
                                          ┌────────────────────────────┐
                                          │ gabung → decrypt → dispatch│
                                          │ ke handler port            │
                                          └────────────────────────────┘
```

![OTA firmware streaming via MQTNL Binary v1.1](/wiki/diagram/mqtnl-binary-ota-1.png)
*Source: [`wiki/diagram/mqtnl-binary-ota-1.mmd`](/wiki/diagram/mqtnl-binary-ota-1.mmd)*


### Send path (TX) — `SimpleMQTNLDriver.send()`

1. Determine the protocol: `protocolRegistry.get(address) || activeProtocol` (default JSON).
2. `useRaw = (protocol.getName() === "Binary")` — if Binary, **skip encryption** (`securedPayload = payload`), so the byte length is exact for OTA.
3. If JSON, encrypt the payload via `SecurityAgent.securePacketOut()` (RSA handshake → ChaCha20-Poly1305).
4. **Fragmentation**: split `securedPayload` into 32KB chunks (`this.packetSize`).
5. For each chunk `i`: create a packet object (`packetCount = chunks.length`, `packetIndex = i`, `dataSize = securedPayload.length`), `protocol.pack(packet)` → Buffer, then `publish` to the topic `${prefix}${address}` (or local loopback if the address is this node).

### Receive path (RX) — `SimpleMQTNLDriver.handleIncomingMessage()`

1. Detect the protocol from the **first magic byte** of the MQTT payload.
2. `proto.unpack(message)` → packet object. Store the protocol in `protocolRegistry` per `srcAddress`.
3. **Packet filter**: drop packets whose `dstAddress` is not a local address (except `"*"`).
4. **Reassembly**: store `packet.payload` in the session `src:port->dst:port`. If not complete yet → wait for the next chunk.
5. If complete: merge the chunks in order → **decrypt** (Binary: `securePacketInRaw` + plain fallback; JSON: `securePacketIn`).
6. **Dispatch**: send `{src, port, localPort, data, isBinary, ts}` to the destination port handler (or serve PING/broadcast).

---

## Snippet (code level)

> All snippets below are **VERIFIED** — copied directly from the source.

### JSON v1.0 — pack/unpack (`MQTNLProtocolJSON.ts`)

```ts
export class MQTNLProtocolJSON implements IMQTNLProtocol {
    getName(): string { return "JSON"; }
    getMagicChars(): number[] { return [0x5B]; } // '['
    getTopicPrefix(): string { return "mqtnl@1.0/"; }

    pack(packet: any): string {
        return JSON.stringify([
            packet.header.srcAddress, packet.header.srcPort,
            packet.header.dstAddress, packet.header.dstPort,
            packet.header.packetCount, packet.header.packetIndex,
            packet.header.dataSize, packet.header.packetHeaderFlag,
            packet.header.forwarded, packet.payload,
        ]);
    }

    unpack(data: Buffer | string): any {
        const str = Buffer.isBuffer(data) ? data.toString("utf8") : data;
        const packed = JSON.parse(str);
        return {
            header: {
                srcAddress: packed[0], srcPort: packed[1],
                dstAddress: packed[2], dstPort: packed[3],
                packetCount: packed[4], packetIndex: packed[5],
                dataSize: packed[6], packetHeaderFlag: packed[7],
                forwarded: packed[8],
            },
            payload: packed[9],
        };
    }
}
```

### Binary v1.1 — pack/unpack (`MQTNLProtocolBinary.ts`)

```ts
export class MQTNLProtocolBinary implements IMQTNLProtocol {
    getName(): string { return "Binary"; }
    getMagicChars(): number[] { return [0x42]; } // 'B'
    getTopicPrefix(): string { return "mqtnl@1.1/"; }

    pack(packet: any): Buffer {
        const srcAddr = Buffer.from(packet.header.srcAddress || "", "utf8");
        const dstAddr = Buffer.from(packet.header.dstAddress || "", "utf8");
        const payload = Buffer.isBuffer(packet.payload)
            ? packet.payload
            : Buffer.from(packet.payload || "", "utf8");

        const headerSize = 2 + 1 + srcAddr.length + 2 + 1 + dstAddr.length
                         + 2 + 2 + 2 + 4 + 1 + 1;
        const buf = Buffer.alloc(headerSize + payload.length);
        let offset = 0;
        buf.writeUInt8(0x42, offset++);              // Magic 'B'
        buf.writeUInt8(0x01, offset++);              // Proto Ver 1
        buf.writeUInt8(srcAddr.length, offset++);
        srcAddr.copy(buf, offset); offset += srcAddr.length;
        buf.writeUInt16LE(packet.header.srcPort, offset); offset += 2;
        buf.writeUInt8(dstAddr.length, offset++);
        dstAddr.copy(buf, offset); offset += dstAddr.length;
        buf.writeUInt16LE(packet.header.dstPort, offset); offset += 2;
        buf.writeUInt16LE(packet.header.packetCount, offset); offset += 2;
        buf.writeUInt16LE(packet.header.packetIndex, offset); offset += 2;
        buf.writeUInt32LE(packet.header.dataSize, offset); offset += 4;
        buf.writeUInt8(packet.header.packetHeaderFlag, offset++);
        buf.writeUInt8(packet.header.forwarded, offset++);
        payload.copy(buf, offset);
        return buf;
    }

    unpack(data: Buffer | string): any {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
        let offset = 0;
        if (buffer.readUInt8(offset++) !== 0x42) throw new Error("Invalid Magic Byte");
        if (buffer.readUInt8(offset++) !== 0x01) throw new Error("Invalid Protocol Version");

        const srcAddrLen = buffer.readUInt8(offset++);
        const srcAddress = buffer.subarray(offset, offset + srcAddrLen).toString("utf8");
        offset += srcAddrLen;
        const srcPort = buffer.readUInt16LE(offset);
        offset += 2;

        const dstAddrLen = buffer.readUInt8(offset++);
        const dstAddress = buffer.subarray(offset, offset + dstAddrLen).toString("utf8");
        offset += dstAddrLen;
        const dstPort = buffer.readUInt16LE(offset);
        offset += 2;

        const packetCount = buffer.readUInt16LE(offset);
        offset += 2;
        const packetIndex = buffer.readUInt16LE(offset);
        offset += 2;
        const dataSize = buffer.readUInt32LE(offset);
        offset += 4;
        const packetHeaderFlag = buffer.readUInt8(offset++);
        const forwarded = buffer.readUInt8(offset++);
        const payload = buffer.subarray(offset);

        return {
            header: { srcAddress, srcPort, dstAddress, dstPort,
                      packetCount, packetIndex, dataSize,
                      packetHeaderFlag, forwarded },
            payload: payload,
        };
    }
}
```

### Fragmentation — 32KB loop (`SimpleMQTNLDriver.send()`)

```ts
// --- FRAGMENTATION LAYER ---
const chunks: (string | Buffer)[] = [];
if (securedPayload.length === 0) {
    chunks.push(useRaw ? Buffer.alloc(0) : "");
} else {
    for (let i = 0; i < securedPayload.length; i += this.packetSize) {
        if (typeof securedPayload === "string") {
            chunks.push(securedPayload.substring(i, i + this.packetSize));
        } else {
            chunks.push(securedPayload.subarray(i, i + this.packetSize));
        }
    }
}

const packetCount = chunks.length;
const topic = `${prefix}${address}`;

for (let i = 0; i < packetCount; i++) {
    const packet = {
        header: {
            srcAddress: this.localAddress,
            srcPort: srcPort,
            dstAddress: address,
            dstPort: port,
            packetCount: packetCount,        // jumlah total chunk
            packetIndex: i,                  // chunk ke-i (0-based)
            dataSize: securedPayload.length, // ukuran TOTAL payload
            packetHeaderFlag: flag,
            forwarded: 0,
        },
        payload: chunks[i],
    };
    const payloadBuffer = protocol.pack(packet);
    this.txBytes += payloadBuffer.length;
    // publish ke topic (atau loopback lokal jika alamat = node ini)
}
```

### Reassembly — merging chunks (`SimpleMQTNLDriver.handleIncomingMessage()`)

```ts
// --- REASSEMBLY LAYER ---
const key = `${packet.header.srcAddress}:${packet.header.srcPort}->${packet.header.dstAddress}:${packet.header.dstPort}`;

if (!this.receivedPackets.has(key)) {
    this.receivedPackets.set(key, {
        total: packet.header.packetCount,
        received: new Map(),
        timestamp: Date.now(),
    });
}

const session = this.receivedPackets.get(key)!;
session.received.set(packet.header.packetIndex, packet.payload);
session.timestamp = Date.now();

if (session.received.size < session.total) {
    return; // belum lengkap — tunggu chunk berikutnya
}

// Semua chunk tiba!
this.receivedPackets.delete(key);

const entries = Array.from(session.received.entries()).sort((a, b) => a[0] - b[0]);
const assembledPayload = Buffer.isBuffer(entries[0][1])
    ? Buffer.concat(entries.map(e => e[1] as Buffer))
    : entries.map(e => e[1] as string).join("");
```

### 30 second TTL — expired session cleanup

```ts
private cleanupExpiredPackets() {
    const now = Date.now();
    const ttl = 30000; // 30 detik untuk chunk yang ditinggalkan
    for (const [key, session] of this.receivedPackets.entries()) {
        if (now - session.timestamp > ttl) {
            this.logger.warn(`[REASSEMBLY] Dropped incomplete packet from ${key} (TTL Expired)`);
            this.receivedPackets.delete(key);
        }
    }
}
```

---

## Exercises / Practice

1. Read `src/common/protocols/MQTNLProtocolJSON.ts` — understand the JSON packet structure (10-element array).
2. Read `src/common/protocols/MQTNLProtocolBinary.ts` — compute the binary header size for `srcAddress="tsix"` and `dstAddress="esp32S3"` (answer: 29 bytes).
3. Read `src/kernel/devices/SimpleMQTNLDriver.ts` — trace the TX path (`send`) and RX path (`handleIncomingMessage`), then find `packetSize` and `ttl`.
4. Read `wiki/mqtnl_binary_ota.md` — how Binary is used for byte-exact OTA.
5. Explain why Binary v1.1 deliberately has no encryption.
6. Experiment: send a payload larger than 32KB from an application, observe the `[FRAGMENTATION]` and `[REASSEMBLY]` logs.

---

## References

- `wiki/mqtnl-ota.md`, `wiki/mqtnl_binary_ota.md` — OTA via MQTNL
- `wiki/course/00-overview.md` §7
- `src/common/protocols/IMQTNLProtocol.ts`, `MQTNLProtocolJSON.ts`, `MQTNLProtocolBinary.ts`

---

*Module 16 — done. Part VI complete. Continue to [Module 17 — PixelSpace Protocol](17-pixelspace-protocol.en.md).*
