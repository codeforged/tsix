import { describe, expect, it } from "vitest";
import { NetSocket, PskSocket } from "./NetworkLib";

describe("NetSocket PSK", () => {
  it("menurunkan session key 32 byte yang deterministik dari passphrase", () => {
    const key = NetSocket.derivePskSessionKey("rahasia-bersama");

    expect(key).toBe(
      "98a2601a1a7cbd18b271d0e4c41d06827eb0cbf7108f627c6ccb4d4d60dde0a6",
    );
    expect(NetSocket.derivePskSessionKey("rahasia-bersama")).toBe(key);
    expect(NetSocket.derivePskSessionKey("rahasia-lain")).not.toBe(key);
  });

  it("memakai PSK 64-hex sebagai byte mentah", () => {
    expect(NetSocket.derivePskSessionKey("11".repeat(32))).toBe(
      "4b3c417bee63deccf5298a1592e4801be46fd79fb7cfd4ad3eaaeb8ffeb6c8d2",
    );
  });

  it("menolak PSK kosong", () => {
    expect(() => NetSocket.derivePskSessionKey("")).toThrow(/non-kosong/);
  });

  it("menolak upgradePsk() sebelum socket dibuka", async () => {
    const sock = new NetSocket({ port: 2700, psk: "rahasia-bersama" });

    await expect(sock.upgradePsk()).rejects.toThrow(/belum dibuka/);
  });
});

describe("PskSocket", () => {
  it("menurunkan kunci handshake 32 byte dari PSK", () => {
    expect(
      PskSocket.deriveHandshakeKey("rahasia-bersama").toString("hex"),
    ).toBe(
      "672829351bb6ed264ddb6af765f75439552adc73b76d649fce87d91bbc4122dd",
    );
  });

  it("mewajibkan peer untuk client dan PSK non-kosong", () => {
    expect(
      () => new PskSocket({ role: "client", port: 2700, psk: "x" }),
    ).toThrow(/peer/);
    expect(
      () => new PskSocket({ role: "server", port: 2700, psk: "" }),
    ).toThrow(/psk/);
  });
});
