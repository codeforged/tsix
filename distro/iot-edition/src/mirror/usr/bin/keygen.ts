import { Program, std } from "@tsix/Application";

export default Program(async (args) => {
  // 1. Generate 32 bytes data acak tanpa library 'crypto' Node.js
  const buffer = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    buffer[i] = Math.floor(Math.random() * 256);
  }

  // 2. Format string Hex (32 byte = 64 karakter hex)
  const KEY_HEX = Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // 3. Format untuk firmware — API key ditanam sebagai string hex (ramah dibaca)
  const C_STRING = `char apiKey[] = "${KEY_HEX}";`;

  // Tampilkan hasil ke terminal TSIX via std
  std.println(`const KEY_HEX = "${KEY_HEX}";`);
  std.println(`// === taruh di firmware (main.cpp) ===`);
  std.println(C_STRING);
});
