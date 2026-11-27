import { describe, it, expect } from "vitest";
import { SimpleMQTNLDriver } from "./SimpleMQTNLDriver";
import { MQTNLProtocolBinfeo } from "../../common/protocols/MQTNLProtocolBinfeo";
import { PacketFlags } from "../../common/PacketFlags";

/**
 * Protocol per-port + registry peer (N7) — REGRESI KONFLIK NetFS ↔ tssh.
 *
 * Kasus lapangan: mount NetFS ke node A sudah jalan (baca/tulis normal), lalu
 * `tssh` ke node B dijalankan — jalur NetFS ke node A langsung "terganggu"
 * (request dibuang, mount timeout) walaupun A sama sekali tidak terlibat.
 *
 * Penyebabnya bukan salah satu aplikasi, tapi interaksi dua hal di driver:
 *
 *   1. `protocolRegistry` (protocol "terakhir dipakai peer") diisi SEBELUM
 *      filter alamat — termasuk untuk paket yang came from ALAMAT SENDIRI
 *      (gema broker dari publish kita + loopback antar-socket lokal).
 *   2. Port channel NetFS kernel dulu TIDAK di-pin protocol-nya, jadi ia
 *      mewarisi registry/`activeProtocol` global.
 *
 * Akibatnya: satu paket Binfeo milik kita (tsshd/tssh) mengubah framing port
 * NetFS → payload sampai di daemon sebagai Buffer → request dibuang diam-diam.
 *
 * Test di bawah menjaga: (a) gema diri sendiri tidak menular, (b) protocol
 * peer tetap dipelajari (fitur multi-proto tidak dikorbankan), (c) pin
 * per-port dihormati & dibersihkan saat handler dilepas.
 */

const KEY_HEX =
  "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

/** Bangun paket seperti yang tiba dari broker (pack memakai framing protokol). */
function binfeoPacket(opts: {
  src: string;
  srcPort: number;
  dst: string;
  dstPort: number;
  payload: string;
}): Buffer {
  return new MQTNLProtocolBinfeo().pack({
    header: {
      srcAddress: opts.src,
      srcPort: opts.srcPort,
      dstAddress: opts.dst,
      dstPort: opts.dstPort,
      packetCount: 1,
      packetIndex: 0,
      dataSize: opts.payload.length,
      packetHeaderFlag: PacketFlags.FLAG_DATA,
      forwarded: 0,
    },
    payload: opts.payload,
  });
}

describe("SimpleMQTNLDriver — protocol per-port & registry peer (N7)", () => {
  it("N7.01 gema paket milik sendiri TIDAK mengubah framing port lain", async () => {
    const NODE = "__n7_local";
    const drv = new SimpleMQTNLDriver("smqtnl0", "mqtt://dummy", NODE);

    // Relay netfsd: port 7778 di-pin JSON (seperti NetSocket) + session key.
    drv.ioctl(0x1002, { port: 7778, protocol: "JSON" });
    drv.ioctl(0x1001, { port: 7778, sessionKey: KEY_HEX });
    const got: any[] = [];
    drv.registerHandler(7778, (pkt: any) => got.push(pkt));

    // Channel NetFS kernel: port ephemeral, TIDAK di-pin (di-pin di
    // MQTNLNetFSChannel.open(); di sini sengaja tanpa pin untuk menguji
    // ketahanan driver).
    const CH = 12345;
    drv.ioctl(0x1001, { port: CH, sessionKey: KEY_HEX });
    drv.registerHandler(CH, () => {});

    // tssh client: port lokalnya di-pin Binfeo.
    drv.ioctl(0x1002, { port: 4777, protocol: "Binfeo" });

    // 1) Broker memantulkan kembali paket Binfeo yang KITA publish.
    const request = JSON.stringify({ v: 1, id: 7, op: "read", path: "/x" });
    (drv as any).handleIncomingMessage(
      "mqtnl@1.2/__n7_remote",
      binfeoPacket({
        src: NODE,
        srcPort: 4777,
        dst: "__n7_remote",
        dstPort: 24,
        payload: request,
      }),
    );

    // Gema diri sendiri tidak boleh dianggap "peer bicara Binfeo".
    expect((drv as any).protocolRegistry.has(NODE)).toBe(false);

    // 2) Channel NetFS kirim request (localhost → alamat node sendiri).
    await drv.send("localhost", 7778, request, PacketFlags.FLAG_DATA, CH);

    const pkt = got[0];
    expect(pkt).toBeTruthy();
    expect(pkt.isBinary).toBe(false); // tetap JSON, bukan Binfeo
    expect(pkt.data).toBe(request); // dan payload utuh (tidak jadi Buffer)
  });

  it("N7.02 protocol PEER lain tetap dipelajari (multi-proto tidak rusak)", () => {
    const NODE = "__n7_dst";
    const PEER = "__n7_peer";
    const drv = new SimpleMQTNLDriver("smqtnl0", "mqtt://dummy", NODE);
    drv.registerHandler(24, () => {});

    (drv as any).handleIncomingMessage(
      "mqtnl@1.2/" + NODE,
      binfeoPacket({
        src: PEER,
        srcPort: 24,
        dst: NODE,
        dstPort: 24,
        payload: "halo",
      }),
    );

    expect((drv as any).protocolRegistry.get(PEER)?.getName()).toBe("Binfeo");
  });

  it("N7.03 pin protocol per-port tetap dihormati", async () => {
    const NODE = "__n7_pin";
    const drv = new SimpleMQTNLDriver("smqtnl0", "mqtt://dummy", NODE);
    drv.ioctl(0x1002, { port: 4777, protocol: "Binfeo" });
    const got: any[] = [];
    drv.registerHandler(7778, (pkt: any) => got.push(pkt));

    await drv.send("localhost", 7778, '{"a":1}', PacketFlags.FLAG_DATA, 4777);

    expect(got[0]?.isBinary).toBe(true);
  });

  it("N7.04 unregisterHandler() membuang pin protocol port (tidak bocor ke port yang dipakai ulang)", () => {
    const drv = new SimpleMQTNLDriver("smqtnl0", "mqtt://dummy", "__n7_unreg");
    drv.ioctl(0x1002, { port: 6123, protocol: "Binfeo" });
    drv.registerHandler(6123, () => {});

    expect((drv as any).portProtocols.get(6123)).toBe("Binfeo");

    drv.unregisterHandler(6123);

    expect((drv as any).portProtocols.has(6123)).toBe(false);
  });
});

/**
 * SEC-23 — payload Buffer di jalur JSON pada port yang punya session key.
 *
 * Objek sudah di-stringify sebelum sampai ke tahap enkripsi, tapi Buffer
 * dulu keluar sebagai `JSON.stringify(buffer)` TANPA enkripsi.
 */
describe("SimpleMQTNLDriver — Buffer di port terenkripsi (SEC-23)", () => {
  async function sendAndSniff(opts: { key: boolean; payload: any }) {
    const drv = new SimpleMQTNLDriver("smqtnl0", "mqtt://dummy", "__sec23");
    if (opts.key) drv.ioctl(0x1001, { port: 5001, sessionKey: KEY_HEX });
    const published: Buffer[] = [];
    (drv as any).client = {
      connected: true,
      publish: (_t: string, m: any, _o?: any, cb?: any) => {
        published.push(Buffer.from(m));
        if (typeof _o === "function") _o();
        else if (typeof cb === "function") cb();
      },
    };
    const tx: any[] = [];
    drv.onSniff((s: any) => {
      if (s.dir === "TX") tx.push(s);
    });
    try {
      await drv.send("__sec23_peer", 9000, opts.payload, PacketFlags.FLAG_DATA, 5001);
    } catch (_) {
      /* tanpa broker sungguhan publish boleh gagal; sniff TX sudah terjadi */
    }
    expect(published.length).toBeGreaterThan(0); // benar-benar keluar ke broker
    return { raw: tx.map((s) => String(s.raw)).join(""), wire: Buffer.concat(published).toString("latin1") };
  }

  it("Buffer + session key → yang keluar terenkripsi (bukan JSON plaintext)", async () => {
    const { raw, wire } = await sendAndSniff({ key: true, payload: Buffer.from("rahasia-buffer") });
    expect(raw).not.toContain('"type":"Buffer"');
    expect(wire).not.toContain('"type":"Buffer"');
    expect(wire).not.toContain("104,97,104,97"); // bukan daftar byte plaintext
    expect(raw.length).toBeGreaterThan(0);
  });

  it("string + session key → tetap terenkripsi (perilaku lama)", async () => {
    const { wire } = await sendAndSniff({ key: true, payload: "rahasia-string" });
    expect(wire).not.toContain("rahasia");
  });

  it("Buffer tanpa session key → tetap JSON seperti dulu (tidak ada perubahan wire)", async () => {
    const buf = Buffer.from("halo");
    const { raw } = await sendAndSniff({ key: false, payload: buf });
    expect(raw).toBe(JSON.stringify(buf));
  });
});

/**
 * SEC-22 — protocolRegistry tidak boleh diracun paket palsu.
 *
 * Registry ("protocol terakhir dipakai peer") dulu diisi dari paket APA PUN
 * yang terdengar, termasuk yang ditujukan ke node lain, berdasarkan
 * srcAddress yang bisa dipalsukan. Selain itu `Binary` (jalur OTA yang
 * melewati enkripsi driver) tidak boleh pernah dipilih lewat registry.
 */
import { MQTNLProtocolBinary } from "../../common/protocols/MQTNLProtocolBinary";

function binaryPacket(src: string, dst: string, dstPort: number): Buffer {
  return new MQTNLProtocolBinary().pack({
    header: {
      srcAddress: src,
      srcPort: 4000,
      dstAddress: dst,
      dstPort,
      packetCount: 1,
      packetIndex: 0,
      dataSize: 4,
      packetHeaderFlag: PacketFlags.FLAG_DATA,
      forwarded: 0,
    },
    payload: "halo",
  });
}

describe("SimpleMQTNLDriver — protocolRegistry (SEC-22)", () => {
  it("paket untuk node LAIN tidak mengubah registry", () => {
    const drv = new SimpleMQTNLDriver("smqtnl0", "mqtt://dummy", "__s22_me");
    (drv as any).handleIncomingMessage("mqtnl@1.1/__s22_other", binaryPacket("__s22_victim", "__s22_other", 24));
    expect((drv as any).protocolRegistry.has("__s22_victim")).toBe(false);
  });

  it("broadcast dengan src palsu tidak mengubah registry", () => {
    const drv = new SimpleMQTNLDriver("smqtnl0", "mqtt://dummy", "__s22_me2");
    (drv as any).handleIncomingMessage("mqtnl@1.1/*", binaryPacket("__s22_victim", "*", 24));
    expect((drv as any).protocolRegistry.has("__s22_victim")).toBe(false);
  });

  async function sendAfterPoison(opts: { secured: boolean }) {
    const me = opts.secured ? "__s22_me3" : "__s22_me4";
    const drv = new SimpleMQTNLDriver("smqtnl0", "mqtt://dummy", me);
    drv.registerHandler(24, () => {});
    if (opts.secured) drv.ioctl(0x1001, { port: 5100, sessionKey: KEY_HEX });
    // Paket Binary yang (seolah) ditujukan ke kita dari "korban".
    (drv as any).handleIncomingMessage("mqtnl@1.1/" + me, binaryPacket("__s22_victim", me, 24));

    const topics: string[] = [];
    (drv as any).client = {
      connected: true,
      publish: (t: string, _m: any, o?: any, cb?: any) => {
        topics.push(t);
        if (typeof o === "function") o();
        else if (typeof cb === "function") cb();
      },
    };
    await drv.send("__s22_victim", 9000, "data", PacketFlags.FLAG_DATA, 5100);
    expect(topics.length).toBeGreaterThan(0);
    return topics;
  }

  it("port dengan session key tidak pernah diturunkan ke Binary oleh registry", async () => {
    const topics = await sendAfterPoison({ secured: true });
    expect(topics.every((t) => !t.startsWith("mqtnl@1.1/"))).toBe(true);
  });

  it("port tanpa session key tetap mengikuti peer Binary (kompatibilitas OTA otad ↔ ESP)", async () => {
    const topics = await sendAfterPoison({ secured: false });
    expect(topics.every((t) => t.startsWith("mqtnl@1.1/"))).toBe(true);
  });
});
