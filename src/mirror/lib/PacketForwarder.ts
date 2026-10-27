import * as mqtt from "mqtt";
import { Firewall, FirewallPacket } from "@tsix/Firewall";

/**
 * PACKET FORWARDER (Broker Bridge)
 *
 * Bridges MQTNL traffic between two different MQTT brokers.
 * Mirrors ALL MQTNL protocol versions bidirectional, byte-exact:
 *   - v1.0 JSON   (mqtnl@1.0/, magic '[' 0x5B)
 *   - v1.1 Binary (mqtnl@1.1/, magic 'B' 0x42 — OTA)
 *   - v1.2 Binfeo (mqtnl@1.2/, magic 'f' 0x66 — biner terenkripsi)
 */
const MQTNL_TOPICS = ["mqtnl@1.0/#", "mqtnl@1.1/#", "mqtnl@1.2/#"];

/**
 * Paket hanya di-forward bila `forwarded == 0` (origin dari broker lokal).
 * Paket yang sudah pernah di-bridge (forwarded >= 1) TIDAK di-forward balik —
 * mencegah "bounce" A↔B yang mengirim payload SAMA berkali-kali ke tujuan
 * (bug: tssh/telnet ke node di broker lain jadi karakter berlipat & login gagal).
 */

/** Header MQTNL yang sudah diurai — dipakai firewall + penanda `forwarded`. */
interface MqtnlHeader {
  format: "json" | "binary";
  srcAddress: string;
  srcPort: number;
  dstAddress: string;
  dstPort: number;
  forwarded: number;
  /** JSON: array hasil parse (dimutasi saat menaikkan `forwarded`). */
  arr?: any[];
  /** Binary: buffer asli (disalin saat menaikkan `forwarded`). */
  buf?: Buffer;
  /** Binary: offset byte `forwarded`. */
  fwdPos?: number;
}

export class PacketForwarder {
  private clientA: mqtt.MqttClient | null = null;
  private clientB: mqtt.MqttClient | null = null;
  private topics: string[] = MQTNL_TOPICS;
  private isRunning: boolean = false;

  // Config
  private brokerAUrl: string;
  private brokerBUrl: string;

  // Stats
  private packetsAtoB: number = 0;
  private packetsBtoA: number = 0;
  private bytesAtoB: number = 0;
  private bytesBtoA: number = 0;
  private startTime: number = 0;

  // Firewall (ACL) — null/undefined = tidak ada penyaringan
  private firewall: Firewall | null = null;
  private firewallBlocked: number = 0;
  private firewallLastBlock: string | null = null;

  constructor(brokerA: string, brokerB: string) {
    this.brokerAUrl = this.ensureMqttProtocol(brokerA);
    this.brokerBUrl = this.ensureMqttProtocol(brokerB);
  }

  /**
   * setFirewall(): pasang aturan ACL yang dievaluasi untuk setiap paket.
   *
   * Dipanggil `forward` setelah membaca `firewalltables.conf`. Tanpa pemanggilan
   * ini (atau dengan `null`), forwarder berperilaku seperti sebelumnya: semua
   * paket diteruskan.
   */
  public setFirewall(fw: Firewall | null): void {
    this.firewall = fw;
    this.firewallBlocked = 0;
    this.firewallLastBlock = null;

    if (fw) {
      console.log(`[PacketForwarder] Firewall: ${fw.path} — ${fw.active ? "AKTIF" : "non-aktif"} ${fw.summary()}`);
    }
  }

  /** Firewall yang sedang dipasang (null = tanpa penyaringan). */
  public getFirewall(): Firewall | null {
    return this.firewall;
  }

  private ensureMqttProtocol(url: string): string {
    if (
      !url.startsWith("mqtt://") &&
      !url.startsWith("ws://") &&
      !url.startsWith("wss://")
    ) {
      return `mqtt://${url}`;
    }
    return url;
  }

  /**
   * startForward(): Connect to both brokers and start mirroring
   */
  public async startForward(): Promise<boolean> {
    if (this.isRunning) return false;

    try {
      this.clientA = mqtt.connect(this.brokerAUrl);
      this.clientB = mqtt.connect(this.brokerBUrl);
      this.startTime = Date.now();

      // --- Broker A Setup ---
      this.clientA.on("connect", () => {
        console.log(
          `[PacketForwarder] Connected to Broker A: ${this.brokerAUrl}`,
        );
        this.subscribeAll(this.clientA);
      });

      this.clientA.on("message", (topic, message) => {
        this.bridge(message, topic, this.clientB, "A->B");
      });

      // --- Broker B Setup ---
      this.clientB.on("connect", () => {
        console.log(
          `[PacketForwarder] Connected to Broker B: ${this.brokerBUrl}`,
        );
        this.subscribeAll(this.clientB);
      });

      this.clientB.on("message", (topic, message) => {
        this.bridge(message, topic, this.clientA, "B->A");
      });

      this.clientA.on("error", (e) =>
        console.error(`[Broker A] Error: ${e.message}`),
      );
      this.clientB.on("error", (e) =>
        console.error(`[Broker B] Error: ${e.message}`),
      );

      this.isRunning = true;
      return true;
    } catch (e: any) {
      console.error(`[PacketForwarder] Start failed: ${e.message}`);
      return false;
    }
  }

  /**
   * bridge(): Forward packets from one broker to another.
   * Payload diteruskan byte-exact (tanpa re-encode) — hanya counter
   * `forwarded` di header yang di-increment untuk loop prevention.
   */
  private bridge(
    message: Buffer,
    topic: string,
    targetClient: mqtt.MqttClient | null,
    direction: string,
  ) {
    if (!targetClient || !targetClient.connected) return;

    const MAX_FORWARD = 5;
    const header = this.readHeader(message, topic);
    if (!header) return; // bukan MQTNL yang dikenal
    if (header.forwarded >= MAX_FORWARD) return; // sudah pernah di-bridge (anti-loop)

    // --- FIREWALL (ACL) ---
    // Dievaluasi SEBELUM `forwarded` dinaikkan supaya paket yang diblokir tidak
    // pernah menyentuh broker tujuan. Tanpa firewall, tidak ada perubahan
    // perilaku sama sekali.
    if (this.firewall && this.firewall.active) {
      const verdict = this.firewall.evaluate(
        this.toFirewallPacket(header),
      );
      if (!verdict.allowed) {
        this.firewallBlocked++;
        this.firewallLastBlock = `${direction} ${header.srcAddress}:${header.srcPort} → ${header.dstAddress}:${header.dstPort} — ${verdict.reason}`;
        console.warn(`[FW BLOCK] ${this.firewallLastBlock}`);
        return;
      }
    }

    const next = this.markForwarded(header);
    if (!next) return;

    targetClient.publish(topic, next, (err) => {
      if (!err) {
        if (direction === "A->B") {
          this.packetsAtoB++;
          this.bytesAtoB += next.length;
        } else {
          this.packetsBtoA++;
          this.bytesBtoA += next.length;
        }

        // Periodic reporting
        const total = this.packetsAtoB + this.packetsBtoA;
        if (total % 100 === 0) {
          console.log(
            `[PacketForwarder] Bridged: A->B: ${this.packetsAtoB} pkts, B->A: ${this.packetsBtoA} pkts`,
          );
        }
      }
    });
  }

  /** Subscribe ke semua prefix protokol MQTNL. */
  private subscribeAll(client: mqtt.MqttClient | null) {
    for (const t of this.topics) {
      client?.subscribe(t);
    }
  }

  /**
   * readHeader(): urai header MQTNL (JSON v1.0 / biner v1.1 & v1.2).
   *
   * Dipisah dari `markForwarded()` supaya firewall bisa memeriksa
   * `src/dst address & port` SEBELUM paket diubah. Return null kalau bukan
   * MQTNL yang dikenal atau header terpotong — sama seperti perilaku lama
   * (paket seperti itu memang tidak pernah diteruskan).
   */
  private readHeader(message: Buffer, topic: string): MqtnlHeader | null {
    // ── v1.0 JSON: [srcAddr, srcPort, dstAddr, dstPort, ..., forwarded(idx 8)] ──
    if (topic.startsWith("mqtnl@1.0/")) {
      try {
        const arr = JSON.parse(message.toString("utf8"));
        if (!Array.isArray(arr)) return null;
        return {
          format: "json",
          srcAddress: String(arr[0] ?? ""),
          srcPort: Number(arr[1]) || 0,
          dstAddress: String(arr[2] ?? ""),
          dstPort: Number(arr[3]) || 0,
          forwarded: Number(arr[8]) || 0,
          arr,
        };
      } catch {
        return null; // bukan JSON MQTNL yang valid → drop
      }
    }

    // ── v1.1 Binary (0x42) / v1.2 Binfeo (0x66) ──
    // Layout: magic(2)+srcLen(1)+src+srcPort(2)+dstLen(1)+dst+dstPort(2)
    //         +count(2)+index(2)+dataSize(4)+flag(1)+forwarded(1)
    const magic = message[0];
    if (
      (magic === 0x42 || magic === 0x66) &&
      message[1] === 0x01 &&
      message.length >= 6
    ) {
      const srcLen = message[2];
      const dstLenPos = 5 + srcLen; // magic(2)+srcLen(1)+srcAddr(srcLen)+srcPort(2) → dstLen
      if (dstLenPos >= message.length) return null;
      const dstLen = message[dstLenPos];
      const fwdPos = 17 + srcLen + dstLen;
      if (fwdPos >= message.length) return null;

      const srcStart = 3;
      const srcPortPos = srcStart + srcLen;
      const dstStart = dstLenPos + 1;
      const dstPortPos = dstStart + dstLen;
      if (dstPortPos + 2 > message.length) return null;

      return {
        format: "binary",
        srcAddress: message.subarray(srcStart, srcStart + srcLen).toString("utf8"),
        srcPort: message.readUInt16LE(srcPortPos),
        dstAddress: message.subarray(dstStart, dstStart + dstLen).toString("utf8"),
        dstPort: message.readUInt16LE(dstPortPos),
        forwarded: message[fwdPos],
        buf: message,
        fwdPos,
      };
    }

    return null; // protokol tak dikenal → jangan diteruskan
  }

  /**
   * markForwarded(): naikkan `forwarded` satu langkah (anti-loop).
   * Payload TIDAK disentuh — JSON diserialisasi ulang dari array yang sama,
   * biner hanya di-patch satu byte, sehingga isi (termasuk ciphertext
   * OTA/Binfeo) tetap byte-exact.
   */
  private markForwarded(header: MqtnlHeader): Buffer | null {
    if (header.format === "json") {
      if (!header.arr) return null;
      header.arr[8] = header.forwarded + 1;
      return Buffer.from(JSON.stringify(header.arr), "utf8");
    }

    if (header.fwdPos === undefined || !header.buf) return null;
    const out = Buffer.from(header.buf); // salinan — patch 1 byte
    out[header.fwdPos] = header.forwarded + 1;
    return out;
  }

  /** Proyeksi header → objek yang dipahami `Firewall.evaluate()`. */
  private toFirewallPacket(header: MqtnlHeader): FirewallPacket {
    return {
      srcAddress: header.srcAddress,
      srcPort: header.srcPort,
      dstAddress: header.dstAddress,
      dstPort: header.dstPort,
    };
  }

  /**
   * nextHop(): validasi protokol + tandai `forwarded = 1`.
   * Dipertahankan sebagai jalur tunggal "baca header → naikkan forwarded"
   * (dipakai uji dan pemanggil lama yang tidak butuh firewall).
   */
  private nextHop(message: Buffer, topic: string): Buffer | null {
    const MAX_FORWARD = 5; // Izinkan hingga 5-hop bridge (Node A -> Node B -> Node C -> Node D)

    const header = this.readHeader(message, topic);
    if (!header) return null;
    if (header.forwarded >= MAX_FORWARD) return null; // cap MAX_FORWARD untuk anti-looping
    return this.markForwarded(header);
  }

  /**
   * stopForward(): Disconnect from both brokers
   */
  public async stopForward(): Promise<boolean> {
    if (!this.isRunning) return false;

    try {
      if (this.clientA)
        await new Promise<void>((r) => this.clientA!.end(false, () => r()));
      if (this.clientB)
        await new Promise<void>((r) => this.clientB!.end(false, () => r()));

      this.isRunning = false;
      console.log(
        `[PacketForwarder] Bridge stopped. Stats: A->B: ${this.packetsAtoB}, B->A: ${this.packetsBtoA}`,
      );
      return true;
    } catch (e: any) {
      console.error(`[PacketForwarder] Stop failed: ${e.message}`);
      return false;
    }
  }

  public getStats() {
    return {
      brokerA: this.brokerAUrl,
      brokerB: this.brokerBUrl,
      isRunning: this.isRunning,
      packetsAtoB: this.packetsAtoB,
      packetsBtoA: this.packetsBtoA,
      bytesAtoB: this.bytesAtoB,
      bytesBtoA: this.bytesBtoA,
      uptime: this.isRunning ? Date.now() - this.startTime : 0,
      firewall: {
        enabled: !!this.firewall,
        active: !!this.firewall?.active,
        path: this.firewall?.path ?? null,
        rules: this.firewall?.summary() ?? null,
        blocked: this.firewallBlocked,
        lastBlock: this.firewallLastBlock,
      },
    };
  }
}
