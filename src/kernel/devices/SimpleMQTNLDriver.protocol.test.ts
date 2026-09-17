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
