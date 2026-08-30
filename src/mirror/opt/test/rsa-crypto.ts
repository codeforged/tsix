import { Program, std } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";

/**
 * RSA CRYPTO — contoh enkripsi/dekripsi asimetris (RSA-2048).
 *
 * Menunjukkan API static `SecurityAgent` untuk kriptografi RSA:
 *   1. generateKeyPair()        — pasangan kunci publik + privat
 *   2. getFingerprint()         — identitas visual node (SHA-256)
 *   3. encryptWithPublicKey()   — enkripsi dengan KUNCI PUBLIK
 *   4. decryptWithPrivateKey()  — dekripsi dengan KUNCI PRIVAT
 *   5. sign() / verify()        — tanda tangan digital (integritas)
 *   6. Hybrid handshake ala MQTNL — RSA enkripsi session key → ChaCha20 data
 *
 * Aturan penting RSA:
 *   - Enkripsi pakai kunci PUBLIK  → hanya pemilik kunci PRIVAT yang bisa baca.
 *   - Tanda tangan pakai kunci PRIVAT → siapa pun verifikasi dengan kunci PUBLIK.
 *   - RSA-2048 OAEP hanya ~214 byte per pesan → untuk data besar pakai hybrid
 *     (enkripsi session key dengan RSA, lalu data dengan ChaCha20/AES).
 *
 * Jalankan:  rsa-crypto
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
  await std.println(`${cyan}=== RSA Crypto Demo (RSA-2048) ===${reset}`);

  // 1) Generate pasangan kunci
  const keys = SecurityAgent.generateKeyPair();
  await std.println(
    `${dim}Public key : ${keys.publicKey.split("\n")[0]} ...${reset}`,
  );
  await std.println(
    `${dim}Private key: ${keys.privateKey.split("\n")[0]} ...${reset}`,
  );

  // 2) Fingerprint — identitas node (verifikasi visual)
  const fp = SecurityAgent.getFingerprint(keys.publicKey);
  await std.println(`${yellow}Fingerprint: ${fp}${reset}`);

  // 3) ENCRYPT dengan kunci PUBLIK → DECRYPT dengan kunci PRIVAT
  const secret = "TSIX rahasia — pesan terenkripsi RSA";
  await std.println(`\n${green}[ENCRYPT] pesan -> "${secret}"${reset}`);

  const cipherHex = SecurityAgent.encryptWithPublicKey(
    keys.publicKey,
    Buffer.from(secret, "utf8"),
  );
  await std.println(
    `${dim}[CIPHER ] ${cipherHex.substring(0, 60)}... (${cipherHex.length} hex chars)${reset}`,
  );

  const plain = SecurityAgent.decryptWithPrivateKey(
    keys.privateKey,
    cipherHex,
  ).toString("utf8");
  await std.println(`${green}[DECRYPT] -> "${plain}"${reset}`);
  await std.println(
    `${plain === secret ? green : red}[OK] round-trip ${plain === secret ? "BERHASIL" : "GAGAL"}${reset}`,
  );

  // 4) Salah kunci → dekripsi harus ditolak
  const otherKeys = SecurityAgent.generateKeyPair();
  try {
    SecurityAgent.decryptWithPrivateKey(otherKeys.privateKey, cipherHex);
    await std.println(
      `${red}[X] Kunci salah tidak ditolak (seharusnya gagal)!${reset}`,
    );
  } catch (_e) {
    await std.println(
      `${green}[OK] Kunci salah ditolak (dekripsi gagal)${reset}`,
    );
  }

  // 5) SIGN (kunci privat) + VERIFY (kunci publik) — integritas
  await std.println(
    `\n${yellow}[SIGN] menandatangani pesan dengan kunci PRIVAT${reset}`,
  );
  const signature = SecurityAgent.sign(keys.privateKey, secret);
  const valid = SecurityAgent.verify(keys.publicKey, secret, signature);
  await std.println(
    `${valid ? green : red}[VERIFY] tanda tangan ${valid ? "VALID" : "INVALID"}${reset}`,
  );

  // 6) Hybrid handshake ala MQTNL: RSA → session key, ChaCha20 → data
  await std.println(
    `\n${cyan}[HYBRID] handshake ala MQTNL (RSA + ChaCha20)${reset}`,
  );
  const sessionKey = SecurityAgent.generateSessionKey();
  const encKey = SecurityAgent.encryptWithPublicKey(keys.publicKey, sessionKey);
  const decKey = SecurityAgent.decryptWithPrivateKey(keys.privateKey, encKey);

  const agent = new SecurityAgent();
  agent.setSessionKey(decKey);
  const data = "Hello MQTNL via ChaCha20 session";
  const enc = agent.securePacketOut(data);
  const dec = agent.securePacketIn(enc);

  await std.println(
    `${dim}Session key (32B) RSA -> terdekripsi: ${sessionKey.equals(decKey)}${reset}`,
  );
  await std.println(`${green}ChaCha20 data : "${dec}"${reset}`);

  await std.println(
    `\n${dim}Catatan: RSA-2048 OAEP hanya ~214 byte/pesan — data besar pakai hybrid (session key).${reset}`,
  );
});
