import { Program, std } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";

/**
 * CHA2POLY1305 CRYPTO — contoh enkripsi/dekripsi ChaCha20-Poly1305 STANDALONE.
 *
 * `SecurityAgent` adalah class murni di `src/common/SecurityAgent.ts` — bisa
 * dipakai INDEPENDEN tanpa networking sama sekali (persis yang dilakukan
 * airterm/tssh/scp/tpkg: mereka enkripsi payload sendiri di aplikasi).
 *
 * Yang ditunjukkan:
 *   1. generateSessionKey() — session key 32 byte
 *   2. securePacketOut()    — enkripsi → string HEX [IV12 + Tag16 + Cipher]
 *   3. securePacketIn()     — dekripsi balik
 *   4. securePacketOutRaw() / securePacketInRaw() — jalur Buffer (biner)
 *   5. Tanpa key → passthrough plain (mode handshake)
 *   6. Kunci salah / ciphertext dirusak → GAGAL (AEAD authentication)
 *
 * Jalankan:  cha2poly1305-crypto
 *
 * (c) 2026 TSIX Project
 */

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

export const main = Program(async () => {
  await std.println(
    `${cyan}=== ChaCha20-Poly1305 Crypto (standalone) ===${reset}`,
  );

  // 1) Session key 32 byte (64 hex) — "secret" bersama antara pengirim & penerima
  const key = SecurityAgent.generateSessionKey();
  await std.println(
    `${dim}Session key : ${key.toString("hex").substring(0, 24)}...${reset}`,
  );

  const alice = new SecurityAgent();
  alice.setSessionKey(key);

  // 2) ENCRYPT string → HEX [IV(12) + Tag(16) + Ciphertext]
  const secret = "Pesan rahasia ChaCha20-Poly1305";
  await std.println(`\n${green}[ENCRYPT] "${secret}"${reset}`);
  const cipher = alice.securePacketOut(secret);
  await std.println(
    `${dim}[CIPHER ] ${cipher.substring(0, 56)}... (${cipher.length} hex chars)${reset}`,
  );
  await std.println(
    `${dim}[BAGIAN ] IV=${cipher.substring(0, 24)} Tag=${cipher.substring(24, 56)}${reset}`,
  );

  // 3) DECRYPT
  const plain = alice.securePacketIn(cipher);
  await std.println(`${green}[DECRYPT] "${plain}"${reset}`);
  await std.println(
    `${plain === secret ? green : red}[OK] round-trip ${plain === secret ? "BERHASIL" : "GAGAL"}${reset}`,
  );

  // 4) Jalur Buffer (biner) — securePacketOutRaw / securePacketInRaw
  await std.println(
    `\n${yellow}[BINARY ] securePacketOutRaw -> securePacketInRaw${reset}`,
  );
  const frame = Buffer.from("0x4C 0x01 frame biner MQTNL", "utf8");
  const encBuf = alice.securePacketOutRaw(frame) as Buffer;
  const decBuf = alice.securePacketInRaw(encBuf);
  await std.println(
    `${dim}${frame.length}B -> ${encBuf.length}B (IV+Tag) -> "${decBuf}"${reset}`,
  );
  await std.println(
    `${decBuf === frame.toString("utf8") ? green : red}[OK] Buffer ${decBuf === frame.toString("utf8") ? "BERHASIL" : "GAGAL"}${reset}`,
  );

  // 5) Tanpa key → passthrough (dipakai untuk handshake awal)
  await std.println(
    `\n${cyan}[PLAIN  ] tanpa key → passthrough (mode handshake)${reset}`,
  );
  const plainAgent = new SecurityAgent();
  await std.println(
    `${dim}"${plainAgent.securePacketOut("hello handshake")}"${reset}`,
  );

  // 6) Kunci salah → gagal (AEAD authenticate)
  await std.println(`\n${red}[EVE    ] dekripsi dengan kunci salah${reset}`);
  const eve = new SecurityAgent();
  eve.setSessionKey(SecurityAgent.generateSessionKey());
  const decWrong = eve.securePacketIn(cipher);
  await std.println(
    `${decWrong === "" ? green : red}[OK] hasil dekripsi = ${JSON.stringify(decWrong)} → ${decWrong === "" ? "DITOLAK" : "?!?"}${reset}`,
  );

  // 7) Ciphertext dirusak → gagal (auth tag mismatch)
  const tampered =
    cipher.substring(0, cipher.length - 2) +
    (cipher.endsWith("00") ? "ff" : "00");
  const decTampered = alice.securePacketIn(tampered);
  await std.println(
    `${decTampered === "" ? green : red}[OK] ciphertext dirusak → ${decTampered === "" ? "DITOLAK" : "?!?"}${reset}`,
  );
});
