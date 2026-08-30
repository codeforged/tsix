import { Program, std } from "@tsix/Application";
import { AesGcmAgent } from "@common/AesGcmAgent";

/**
 * AESGCM CRYPTO — contoh enkripsi/dekripsi AES-256-GCM STANDALONE.
 *
 * `AesGcmAgent` (src/common/AesGcmAgent.ts) adalah contoh agent enkripsi
 * kustom yang mengimplementasikan kontrak `ISecurityAgent`. Seperti
 * `SecurityAgent` (ChaCha20), ia class MURNI — bisa dipakai INDEPENDEN,
 * tanpa networking. Format wire dibuat sama: [IV(12) + Tag(16) + Cipher].
 *
 * Yang ditunjukkan:
 *   1. setSessionKey()        — key 32 byte (64 hex) via string/Buffer
 *   2. securePacketOut()      — enkripsi → string HEX [IV12 + Tag16 + Cipher]
 *   3. securePacketIn()       — dekripsi balik
 *   4. securePacketOutRaw() / securePacketInRaw() — jalur Buffer (biner)
 *   5. Tanpa key → passthrough plain (mode handshake)
 *   6. Kunci salah / ciphertext dirusak → GAGAL (AEAD authentication)
 *
 * Jalankan:  aesgcm-crypto
 *
 * (c) 2026 TSIX Project
 */

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

// Key 32 byte (64 hex) — bisa lewat string hex ATAU Buffer.
const KEY_HEX =
  "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

export const main = Program(async () => {
  await std.println(`${cyan}=== AES-256-GCM Crypto (standalone) ===${reset}`);

  const alice = new AesGcmAgent();
  alice.setSessionKey(KEY_HEX);
  await std.println(
    `${dim}Session key : ${KEY_HEX.substring(0, 24)}...${reset}`,
  );

  // 1) ENCRYPT string → HEX [IV(12) + Tag(16) + Ciphertext]
  const secret = "Pesan rahasia AES-256-GCM";
  await std.println(`\n${green}[ENCRYPT] "${secret}"${reset}`);
  const cipher = alice.securePacketOut(secret);
  await std.println(
    `${dim}[CIPHER ] ${cipher.substring(0, 56)}... (${cipher.length} hex chars)${reset}`,
  );
  await std.println(
    `${dim}[BAGIAN ] IV=${cipher.substring(0, 24)} Tag=${cipher.substring(24, 56)}${reset}`,
  );

  // 2) DECRYPT
  const plain = alice.securePacketIn(cipher);
  await std.println(`${green}[DECRYPT] "${plain}"${reset}`);
  await std.println(
    `${plain === secret ? green : red}[OK] round-trip ${plain === secret ? "BERHASIL" : "GAGAL"}${reset}`,
  );

  // 3) Jalur Buffer (biner) — securePacketOutRaw / securePacketInRaw
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

  // 4) Tanpa key → passthrough (handshake awal)
  await std.println(
    `\n${cyan}[PLAIN  ] tanpa key → passthrough (mode handshake)${reset}`,
  );
  const plainAgent = new AesGcmAgent();
  await std.println(
    `${dim}"${plainAgent.securePacketOut("hello handshake")}"${reset}`,
  );

  // 5) Kunci salah → gagal (AEAD authenticate)
  await std.println(`\n${red}[EVE    ] dekripsi dengan kunci salah${reset}`);
  const eve = new AesGcmAgent();
  eve.setSessionKey(
    "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  );
  const decWrong = eve.securePacketIn(cipher);
  await std.println(
    `${decWrong === "" ? green : red}[OK] hasil dekripsi = ${JSON.stringify(decWrong)} → ${decWrong === "" ? "DITOLAK" : "?!?"}${reset}`,
  );

  // 6) Ciphertext dirusak → gagal (auth tag mismatch)
  const tampered =
    cipher.substring(0, cipher.length - 2) +
    (cipher.endsWith("00") ? "ff" : "00");
  const decTampered = alice.securePacketIn(tampered);
  await std.println(
    `${decTampered === "" ? green : red}[OK] ciphertext dirusak → ${decTampered === "" ? "DITOLAK" : "?!?"}${reset}`,
  );
});
