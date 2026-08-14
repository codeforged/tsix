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

  // 3. Format C array dirapikan per 8 kolom (baris baru)
  const columns = 8;
  const formattedRows = [];

  for (let i = 0; i < buffer.length; i += columns) {
    // Ambil potongan 8 byte
    const chunk = Array.from(buffer.slice(i, i + columns));

    // Ubah ke format 0xXX
    const hexParts = chunk.map(
      (b) => `0x${b.toString(16).toUpperCase().padStart(2, "0")}`,
    );

    // Gabungkan dengan koma, lalu beri indentasi spasi agar rapi sejajar
    formattedRows.push("    " + hexParts.join(", "));
  }

  // Gabungkan semua baris dengan koma dan baris baru (\n)
  const cArrayValues = "\n" + formattedRows.join(",\n") + "\n";
  const C_ARRAY = `char key[KEY_SIZE] = {${cArrayValues}};`;

  // Tampilkan hasil ke terminal TSIX via std
  std.println(`const KEY_HEX = "${KEY_HEX}";`);
  std.println(C_ARRAY);
});
