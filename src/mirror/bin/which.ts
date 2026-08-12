import { IProgram, OSContext } from "../lib/IProgram";

/**
 * WHICH Utility
 *
 * Mencari lokasi executable di dalam direktori yang terdaftar pada
 * environment variable PATH — sama seperti `which` di Linux.
 *
 * Kegunaan utama: memastikan path mana yang AKAN dijalankan oleh shell
 * ketika sebuah command di-launch, berdasarkan urutan direktori PATH.
 *
 * Logika resolusi sengaja ditiru 1:1 dari `resolveBinary` di shell,
 * supaya hasilnya akurat dengan yang benar-benar dieksekusi:
 *   - Jika nama mengandung "/"      -> treat sebagai path langsung.
 *   - Selain itu                    -> cari di tiap direktori PATH (urut),
 *                                      cek `dir/cmd`, lalu `dir/cmd.js`, lalu `dir/cmd.ts`.
 *
 * Flags:
 *   -a    Tampilkan SEMUA kecocokan di seluruh PATH (bukan hanya yang pertama)
 *   -h    Tampilkan bantuan ini
 */
export class main implements IProgram {
  async execute(
    { fs, shell, std }: OSContext,
    args: string[],
  ): Promise<string | void> {
    if (args.includes("--help") || args.includes("-h")) {
      await std.print(
        "Usage: which [-a] [command...]\n\n" +
          "Locate a command in the PATH environment variable and print\n" +
          "the full path that would be executed when launching it.\n\n" +
          "Options:\n" +
          "  -a    Print ALL matches in PATH, not just the first one\n",
      );
      return;
    }

    const showAll = args.includes("-a");
    const commands = args.filter((a) => a !== "-a");

    if (commands.length === 0) {
      await std.print("Usage: which [-a] [command...]\n");
      return;
    }

    // Baca PATH persis seperti yang dibaca shell saat resolve binary
    const pathVal = (await shell.getenv("PATH")) || "/bin";
    const dirs = pathVal.split(":").filter((d) => d.length > 0);

    let output = "";
    for (const cmd of commands) {
      const matches = await this.resolve(cmd, dirs, fs);

      // Linux `which` tidak mencetak apa-apa untuk command yang tidak ketemu
      if (matches.length === 0) continue;

      const shown = showAll ? matches : matches.slice(0, 1);
      output += shown.join("\n") + "\n";
    }

    if (output) await std.print(output);
  }

  /**
   * Meniru resolveBinary dari shell:
   * mengembalikan daftar path yang valid (dalam urutan prioritas).
   */
  private async resolve(
    cmd: string,
    dirs: string[],
    fs: any,
  ): Promise<string[]> {
    const isFile = async (p: string): Promise<boolean> => {
      try {
        const info = await fs.stat(p);
        return !!info && info.type === "FILE";
      } catch {
        return false;
      }
    };

    // 1. Nama mengandung "/" -> path langsung, cukup satu hasil.
    //    (tsh.ts hanya cek `cmd` lalu `cmd.ts` — tanpa `cmd.js`)
    if (cmd.includes("/")) {
      for (const p of [cmd, cmd + ".ts"]) {
        if (await isFile(p)) return [p];
      }
      return [];
    }

    // 2. Cari di direktori PATH (urutan kiri-ke-kanan = prioritas)
    const found: string[] = [];
    for (const dir of dirs) {
      const base = (dir.endsWith("/") ? dir + cmd : dir + "/" + cmd).replace(
        /\/+/g,
        "/",
      );
      const alternatives = [base, base + ".js", base + ".ts"];

      // Ambil match pertama per direktori saja (sama seperti shell),
      // lalu lanjut ke direktori berikutnya untuk mode -a.
      for (const p of alternatives) {
        if (await isFile(p)) {
          found.push(p);
          break;
        }
      }
    }
    return found;
  }
}
