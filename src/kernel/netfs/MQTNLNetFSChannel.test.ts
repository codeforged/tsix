import { describe, it, expect, beforeEach } from "vitest";
import { MQTNLNetFSChannel } from "./MQTNLNetFSChannel";
import { SimpleMQTNLDriver } from "../devices/SimpleMQTNLDriver";
import { PortManager } from "../PortManager";
import { PacketFlags } from "../../common/PacketFlags";
import { NetFSError } from "../../common/netfs/NetFSProtocol";

/**
 * MQTNLNetFSChannel tests (N4)
 *
 * Menguji sisi KERNEL dari transport NetFS: alokasi port, registrasi handler,
 * pengiriman request, penerusan balasan, dan pelepasan resource saat umount.
 *
 * Driver MQTNL asli dipakai (supaya `instanceof` di resolveDriver valid), tapi
 * method jaringannya diganti spy — test tidak boleh menyentuh broker MQTT.
 */

describe("MQTNLNetFSChannel (N4)", () => {
  let driver: SimpleMQTNLDriver;
  let portManager: PortManager;
  let kernel: any;
  let sent: Array<Record<string, any>>;
  let handlers: Map<number, (msg: any) => void>;
  let ioctls: Array<Record<string, any>>;
  let unregistered: number[];

  beforeEach(() => {
    // Driver asli: constructor TIDAK menyambung ke broker (koneksi ada di init()).
    driver = new SimpleMQTNLDriver(
      "smqtnl_netfs_test",
      "mqtt://127.0.0.1:1883",
      "tsix_netfs_test",
    );

    sent = [];
    handlers = new Map();
    ioctls = [];
    unregistered = [];

    (driver as any).send = async (
      address: string,
      port: number,
      data: any,
      flag: number,
      srcPort: number,
    ) => {
      sent.push({ address, port, data, flag, srcPort });
      return true;
    };
    (driver as any).registerHandler = (port: number, cb: (m: any) => void) => {
      handlers.set(port, cb);
    };
    (driver as any).unregisterHandler = (port: number) => {
      handlers.delete(port);
      unregistered.push(port);
    };
    (driver as any).bindProcess = () => {};
    (driver as any).ioctl = (cmd: number, arg: any) => {
      ioctls.push({ cmd, ...arg });
      return true;
    };

    portManager = new PortManager();
    kernel = {
      devices: { smqtnl0: driver },
      getPortManager: () => portManager,
    };
  });

  it("N4.01 open() memesan port kernel dan mendaftarkan handler", () => {
    const ch = MQTNLNetFSChannel.open(kernel, {
      address: "tsix_2",
      port: 7777,
    });

    expect(ch.peer).toBe("tsix_2:7777");
    expect(ch.port).toBeGreaterThan(0);
    expect(portManager.isPortUsed(ch.port)).toBe(true);
    expect(handlers.has(ch.port)).toBe(true);

    void ch.close();
  });

  it("N4.02 send() mengirim sebagai paket DATA dari port lokal mount", async () => {
    const ch = MQTNLNetFSChannel.open(kernel, {
      address: "tsix_2",
      port: 7777,
    });

    const ok = await ch.send('{"id":1,"op":"info"}');

    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].address).toBe("tsix_2");
    expect(sent[0].port).toBe(7777);
    expect(sent[0].srcPort).toBe(ch.port);
    expect(sent[0].flag).toBe(PacketFlags.FLAG_DATA);

    await ch.close();
  });

  it("N4.03 balasan dari driver diteruskan ke driver NetFS", () => {
    const ch = MQTNLNetFSChannel.open(kernel, {
      address: "tsix_2",
      port: 7777,
    });

    const received: any[] = [];
    ch.onMessage((raw) => received.push(raw));

    // Simulasi paket masuk (bentuk yang dikirim driver MQTNL ke handler).
    handlers.get(ch.port)!({
      src: "tsix_2",
      port: 7777,
      localPort: ch.port,
      data: '{"id":1,"ok":true}',
    });

    expect(received).toEqual(['{"id":1,"ok":true}']);

    // Paket kosong (mis. ping) tidak boleh diteruskan sebagai request.
    handlers.get(ch.port)!({ src: "tsix_2", port: 7777, data: "" });
    expect(received).toHaveLength(1);

    void ch.close();
  });

  it("N4.04 close() melepas port + handler, dan send ditolak setelahnya", async () => {
    const ch = MQTNLNetFSChannel.open(kernel, {
      address: "tsix_2",
      port: 7777,
    });
    const port = ch.port;

    await ch.close();

    expect(handlers.has(port)).toBe(false);
    expect(unregistered).toContain(port);
    expect(portManager.isPortUsed(port)).toBe(false);
    expect(await ch.send("{}")).toBe(false);

    // close() ganda harus aman (dipanggil umount + cleanup).
    await ch.close();
  });

  it("N4.05 interface tidak dikenal → NetFSError EIO (mount gagal cepat)", () => {
    const empty = { devices: {}, getPortManager: () => portManager };

    expect(() =>
      MQTNLNetFSChannel.open(empty, { address: "tsix_2", port: 7777, iface: "smqtnl99" }),
    ).toThrow(NetFSError);
  });

  it("N4.06 key mengaktifkan enkripsi pada port lokal mount", () => {
    const key = "a".repeat(64);
    const ch = MQTNLNetFSChannel.open(kernel, {
      address: "tsix_2",
      port: 7777,
      key,
      agent: "aes-gcm",
    });

    expect(ioctls).toHaveLength(1);
    expect(ioctls[0].cmd).toBe(0x1001); // SMQTNL_IOCTL_UPGRADE_SECURITY
    expect(ioctls[0].port).toBe(ch.port);
    expect(ioctls[0].sessionKey).toBe(key);
    expect(ioctls[0].agent).toBe("aes-gcm");

    void ch.close();
  });

  it("N4.07 alamat node lokal juga bisa dipakai sebagai 'iface'", () => {
    // "tsix_netfs_test" = localAddress driver → di-resolve via findLocal().
    const ch = MQTNLNetFSChannel.open(kernel, {
      address: "tsix_netfs_test",
      port: 7777,
      iface: "tsix_netfs_test",
    });

    expect(ch.peer).toBe("tsix_netfs_test:7777");

    void ch.close();
  });
});
