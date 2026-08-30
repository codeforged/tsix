import { UserLib } from "../lib/UserLib";

/**
 * SECAGENT — Utility melihat daftar Security Agent yang terdaftar di kernel.
 *
 * Security Agent = jenis enkripsi MQTNL yang bisa dipilih lewat
 * `upgradeSecurity(key, { agent: "<nama>" })` (Jalur A). Registrinya hidup di
 * SimpleMQTNLDriver (kernel); tool ini menanyakannya via syscall SECAGENT_LIST.
 *
 * Pemakaian:
 *   secagent            → tabel agent terdaftar
 *   secagent --list     → sama seperti di atas
 *   secagent --json     → output JSON (buat scripting)
 *
 * (c) 2026 TSIX Project
 */
export default class SecAgent {
  async execute(lib: UserLib, args: string[]): Promise<number> {
    const green = "\x1b[92m";
    const yellow = "\x1b[93m";
    const cyan = "\x1b[96m";
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";

    const isJson = args.includes("--json");

    let agents: string[] = [];
    try {
      agents = await lib.net.listAgents();
    } catch (e: any) {
      await lib.std.print(
        `${yellow}[secagent] Gagal mengambil daftar agent: ${e?.message}${reset}\n`,
      );
      return 1;
    }

    if (isJson) {
      await lib.std.print(
        JSON.stringify({ agents, count: agents.length }, null, 2) + "\n",
      );
      return 0;
    }

    await lib.std.print(
      `${cyan}=== Registered Security Agents (${agents.length}) ===${reset}\n`,
    );
    if (agents.length === 0) {
      await lib.std.print(`${dim}(belum ada agent terdaftar)${reset}\n`);
      return 0;
    }

    let i = 1;
    for (const name of agents) {
      const marker = name === "chacha20" ? " (default)" : "";
      await lib.std.print(
        `  ${green}${i}.${reset} ${name}${dim}${marker}${reset}\n`,
      );
      i++;
    }

    await lib.std.print(
      `${dim}Petunjuk: pilih via NetSocket.upgradeSecurity(key, { agent: "<nama>" })${reset}\n`,
    );

    return 0;
  }
}
