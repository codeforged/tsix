import { Program, std } from "@tsix/Application";
import { ConfigParser } from "@tsix/ConfigParser";

export const main = Program(async () => {
  // 1. Inisialisasi class dengan path target
  const config = new ConfigParser("/etc/test.conf");

  // 2. Muat file dari storage/VFS
  const success = await config.load();
  if (!success) {
    // Sebabnya ada di stats.lastError — library tidak mencetak sendiri ke TTY,
    // jadi pesan galat ditampilkan di sini biar jelas berkas mana yang gagal.
    const { lastError } = config.getStats();
    std.println(`Gagal memuat konfigurasi /etc/test.conf: ${lastError}`);
    return;
  }

  std.println("--- Eksperimen Ekstraksi Nilai ---");

  // 3. Ambil data dengan metode .get(section, identifier)
  const item1 = config.get("section1", "item1");   // Output: 1234 (number)
  const item2 = config.get("section1", "item2");   // Output: abcd (string)
  const item21 = config.get("section2", "item21"); // Output: [123, 456, 789] (array)
  const item22 = config.get("section2", "item22"); // Output: ["abc", 123, "xyz"] (array)

  std.println(`Item 1: ${item1} (${typeof item1})`);
  std.println(`Item 2: ${item2} (${typeof item2})`);
  std.println(`Item 21: ${JSON.stringify(item21)} (Array: ${Array.isArray(item21)})`);
  std.println(`Item 22: ${JSON.stringify(item22)} (Array: ${Array.isArray(item22)})`);

  // 4. Cek statistik penguraian file jika dibutuhkan
  std.println("\n--- Statistik Parser ---");
  std.println(JSON.stringify(config.getStats(), null, 2));
});
