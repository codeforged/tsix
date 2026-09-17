import { describe, it, expect } from "vitest";
import { parseNetFSPayload } from "./NetFSProtocol";

/**
 * NetFS protocol helpers (N6) — decoder payload.
 *
 * Fokus: `parseNetFSPayload()` harus menerima payload dari framing APA PUN,
 * karena penerima tidak mengontrol protocol per-port yang dipilih pengirim.
 * Regresi nyata: payload biner (Binfeo) tiba sebagai Buffer → dulu di-drop
 * diam-diam sehingga mount NetFS tampak hang.
 */

describe("parseNetFSPayload (N6)", () => {
  const msg = { v: 1, id: 42, op: "read", path: "/docs/a.txt" };

  it("N6.01 string JSON → objek", () => {
    expect(parseNetFSPayload(JSON.stringify(msg))).toEqual(msg);
  });

  it("N6.02 Buffer JSON (framing biner Binfeo/Binary) → objek", () => {
    expect(parseNetFSPayload(Buffer.from(JSON.stringify(msg), "utf8"))).toEqual(
      msg,
    );
  });

  it("N6.03 Buffer hasil dekripsi dengan konten UTF-8 multi-byte", () => {
    const payload = { id: 7, op: "touch", path: "/é—ñ.txt", args: ["naïve ✓"] };
    const buf = Buffer.from(JSON.stringify(payload), "utf8");

    expect(parseNetFSPayload(buf)).toEqual(payload);
  });

  it("N6.04 artefak IPC { type: 'Buffer', data: [...] } → objek", () => {
    const buf = Buffer.from(JSON.stringify(msg), "utf8");
    expect(
      parseNetFSPayload({ type: "Buffer", data: [...buf] }),
    ).toEqual(msg);
  });

  it("N6.05 objek yang sudah diparse → diteruskan apa adanya", () => {
    expect(parseNetFSPayload(msg)).toBe(msg);
  });

  it("N6.06 payload tidak valid → null (bukan lempar, bukan Buffer mentah)", () => {
    expect(parseNetFSPayload("bukan json")).toBeNull();
    expect(parseNetFSPayload(Buffer.from([0x00, 0x01, 0xff]))).toBeNull();
    expect(parseNetFSPayload("")).toBeNull();
    expect(parseNetFSPayload(null)).toBeNull();
    expect(parseNetFSPayload(undefined)).toBeNull();
    expect(parseNetFSPayload(12345)).toBeNull();
  });
});
