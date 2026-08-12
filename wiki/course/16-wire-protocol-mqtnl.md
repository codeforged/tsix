---
module: 16
title: Wire Protocol MQTNL
part: VI
partTitle: Jaringan
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Wire Protocol MQTNL

**RFC-TSIX-EDU-002** | Modul keenam belas kurikulum TSIX. Memahami format data di atas MQTT: dual protocol JSON vs Binary, deteksi magic byte, dan fragmentasi.

> MQTNL punya **dua protokol wire**: JSON v1.0 (readable) dan Binary v1.1 (kompak, tanpa enkripsi — untuk OTA byte-exact). Driver mendeteksi protokol dari **magic byte pertama** per srcAddress.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan kontrak `IMQTNLProtocol`
- [ ] Membedakan protocol JSON v1.0 vs Binary v1.1
- [ ] Menjelaskan deteksi magic byte
- [ ] Menjelaskan fragmentasi 32KB dan reassembly TTL 30s
- [ ] Menjelaskan mengapa userland tidak menyentuh protokol langsung

---

## Konsep Inti

### Kontrak IMQTNLProtocol

Semua protokol wire MQTNL mengimplementasi satu kontrak. Interface ini adalah "satu-satunya pintu" antara driver dan wire format — menambah protokol baru (mis. v2) cukup dengan mengimplementasi class baru, tanpa mengubah driver.

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

### Header paket (9 field + payload)

Struktur paket internal (objek yang di-`pack`/`unpack`) identik untuk kedua protokol. Bedanya hanya cara field ditulis ke wire.

| Field | JSON (index array) | Binary (offset) | Tipe |
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
| `payload` | 9 | PAYLOAD (sisa buffer) | string / Buffer |

> [!NOTE] `packetCount` dan `packetIndex` adalah bagian dari header (bukan fitur terpisah). `packetCount` = jumlah total chunk, `packetIndex` = nomor chunk (0-based). `dataSize` = ukuran payload **total** sebelum dipecah (bukan ukuran per chunk).

### Dual protocol JSON vs Binary

| Aspek | JSON v1.0 | Binary v1.1 |
|---|---|---|
| Class | `MQTNLProtocolJSON` | `MQTNLProtocolBinary` |
| Topic prefix | `mqtnl@1.0/<addr>` | `mqtnl@1.1/<addr>` |
| Magic byte | `[` (0x5B) | `B` (0x42) + ver `0x01` |
| Bentuk wire | JSON array (teks, readable) | Buffer biner kompak, byte-exact |
| Keterbacaan | mudah dibaca manusia | sulit dibaca (biner) |
| Ukuran | lebih besar (overhead teks) | lebih kecil & presisi |
| Enkripsi | RSA handshake + ChaCha20-Poly1305 | tanpa enkripsi (plain, untuk OTA) |
| Pakai untuk | komunikasi umum (default legacy) | transfer firmware OTA byte-exact |

![Handshake RSA: SYN → SYN-ACK → ACK → DATA terenkripsi](/wiki/diagram/Networking-MQTNL-2.png)
*Sumber: [`wiki/diagram/Networking-MQTNL-2.mmd`](/wiki/diagram/Networking-MQTNL-2.mmd)*

### Format frame Binary v1.1

Diagram byte-per-byte dari frame biner (N = panjang `srcAddress`, M = panjang `dstAddress`, L = panjang payload):

```
| 0x42 | 0x01 |  len  | <src addr>      | srcPort |  len  | <dst addr>      | dstPort |
| MAGIC| VER  | sAL=N | srcAddr (N b)   |  u16LE  | dAL=M | dstAddr (M b)   |  u16LE  |

| pktCount | pktIndex | dataSize | flag | fwd | <payload>        |
|  u16LE   |  u16LE   |  u32LE   |  u8  | u8  | payload (L b)    |
```

- Ukuran header tetap = 18 byte + N + M (`2 + 1 + N + 2 + 1 + M + 2 + 2 + 2 + 4 + 1 + 1`).
- Contoh: `srcAddress="tsix"` (N=4), `dstAddress="esp32S3"` (M=7) → header = 29 byte.
- Urutan pembacaan seluruh field deterministik (tanpa delimiter), jadi panjang alamat wajib dikirim (`S_ADDR_LEN`/`D_ADDR_LEN`).
- **Tidak ada CRC/checksum** di dalam frame. Integritas OTA dijaga oleh `dataSize` (u32) dan jalur raw yang byte-exact.

### Deteksi magic byte

Driver tidak menebak protokol dari topic. Ia membaca **byte pertama** payload MQTT lalu mencocokkannya ke `getMagicChars()` tiap protokol terdaftar:

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

Hasilnya disimpan di `protocolRegistry` **per `srcAddress`**. Saat mengirim balik ke alamat itu, driver memakai protokol yang sama (default: JSON).

### Fragmentasi & Reassembly

- **Fragmentasi**: payload dipecah menjadi potongan 32KB (`packetSize = 32768`). Setiap potongan dikirim sebagai paket MQTT terpisah dengan `packetCount`/`packetIndex` yang diisi.
- **Reassembly**: penerima mengumpulkan chunk dalam sesi per `src:port->dst:port`. Sesi dianggap lengkap saat jumlah chunk unik = `packetCount`, lalu digabung berurutan (`Buffer.concat` untuk Buffer, `join("")` untuk string).
- **TTL 30 detik**: sesi yang tidak lengkap dalam 30 detik dibuang (`cleanupExpiredPackets`, dijalankan tiap 60 detik).

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

![Streaming firmware OTA via MQTNL Binary v1.1](/wiki/diagram/mqtnl-binary-ota-1.png)
*Sumber: [`wiki/diagram/mqtnl-binary-ota-1.mmd`](/wiki/diagram/mqtnl-binary-ota-1.mmd)*


### Jalur kirim (TX) — `SimpleMQTNLDriver.send()`

1. Tentukan protokol: `protocolRegistry.get(address) || activeProtocol` (default JSON).
2. `useRaw = (protocol.getName() === "Binary")` — jika Binary, **lewati enkripsi** (`securedPayload = payload`), supaya panjang byte pas untuk OTA.
3. Jika JSON, enkripsi payload via `SecurityAgent.securePacketOut()` (RSA handshake → ChaCha20-Poly1305).
4. **Fragmentasi**: pecah `securedPayload` menjadi chunk 32KB (`this.packetSize`).
5. Untuk tiap chunk `i`: buat objek packet (`packetCount = chunks.length`, `packetIndex = i`, `dataSize = securedPayload.length`), `protocol.pack(packet)` → Buffer, lalu `publish` ke topic `${prefix}${address}` (atau loopback lokal jika alamatnya node ini).

### Jalur terima (RX) — `SimpleMQTNLDriver.handleIncomingMessage()`

1. Deteksi protokol dari **magic byte pertama** payload MQTT.
2. `proto.unpack(message)` → objek packet. Simpan protokol di `protocolRegistry` per `srcAddress`.
3. **Filter paket**: buang paket yang `dstAddress` bukan alamat lokal (kecuali `"*"`).
4. **Reassembly**: simpan `packet.payload` di sesi `src:port->dst:port`. Jika belum lengkap → tunggu chunk berikutnya.
5. Jika lengkap: gabung chunk berurutan → **decrypt** (Binary: `securePacketInRaw` + fallback plain; JSON: `securePacketIn`).
6. **Dispatch**: kirim `{src, port, localPort, data, isBinary, ts}` ke handler port tujuan (atau layani PING/broadcast).

---

## Snippet (level kode)

> Semua snippet di bawah **VERIFIED** — disalin langsung dari sumber.

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

### Fragmentasi — loop 32KB (`SimpleMQTNLDriver.send()`)

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

### Reassembly — gabung chunk (`SimpleMQTNLDriver.handleIncomingMessage()`)

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

### TTL 30 detik — pembersihan sesi kadaluarsa

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

## Latihan / Praktik

1. Baca `src/common/protocols/MQTNLProtocolJSON.ts` — pahami struktur packet JSON (array 10 elemen).
2. Baca `src/common/protocols/MQTNLProtocolBinary.ts` — hitung ukuran header binary untuk `srcAddress="tsix"` dan `dstAddress="esp32S3"` (jawaban: 29 byte).
3. Baca `src/kernel/devices/SimpleMQTNLDriver.ts` — telusuri jalur TX (`send`) dan RX (`handleIncomingMessage`), lalu cari `packetSize` dan `ttl`.
4. Baca `wiki/mqtnl_binary_ota.md` — bagaimana Binary dipakai untuk OTA byte-exact.
5. Jelaskan mengapa Binary v1.1 sengaja tanpa enkripsi.
6. Eksperimen: kirim payload > 32KB dari aplikasi, amati log `[FRAGMENTATION]` dan `[REASSEMBLY]`.

---

## Referensi

- `wiki/mqtnl-ota.md`, `wiki/mqtnl_binary_ota.md` — OTA via MQTNL
- `wiki/course/00-overview.md` §7
- `src/common/protocols/IMQTNLProtocol.ts`, `MQTNLProtocolJSON.ts`, `MQTNLProtocolBinary.ts`

---

*Modul 16 — selesai. Bagian VI tuntas. Lanjut ke [Modul 17 — PixelSpace Protocol](17-pixelspace-protocol.md).*
