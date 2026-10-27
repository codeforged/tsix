import { UserLib } from "@tsix/UserLib";
import { PacketForwarder } from "@tsix/PacketForwarder";
import { Firewall, FIREWALL_DEFAULT_PATH } from "@tsix/Firewall";

/**
 * FORWARD - Packet Forwarder (Broker Bridge) Utility
 *
 * Bridges MQTNL traffic between two different MQTT brokers.
 *
 * Syntax:
 *   forward -s <broker_a> -d <broker_b>    # Bridge two brokers
 *   forward --start                         # Cek status bridge
 *   forward --stop                          # Stop bridge (PID file + SIGTERM)
 *   forward --top                           # Monitor real-time stats
 *
 * Firewall / ACL (opsional):
 *   forward --fw                            # Tampilkan aturan yang berlaku
 *   forward --fw-file <path>                # Pakai berkas aturan lain
 *   forward --no-fw                         # Matikan penyaringan
 *   forward --fw-check <src>:<sport> <dst>:<dport>
 *                                           # Uji satu paket terhadap aturan
 */

// Global forwarder instance
let globalForwarder: PacketForwarder | null = null;

export default class main {
  async execute(lib: UserLib, args: string[]) {
    if (args.includes("--help") || args.includes("-h")) {
      await this.showSyntax(lib);
      return;
    }
    // Parse arguments (--start/--stop/--top; backward-compat -start/-stop/-top)
    const hasStart = args.includes("--start") || args.includes("-start");
    const hasStop = args.includes("--stop") || args.includes("-stop");
    const hasTop = args.includes("--top") || args.includes("-top");
    const sourceIdx = args.indexOf("-s");
    const destIdx = args.indexOf("-d");

    const statsFile = "/tmp/forward.stats";
    const pidFile = "/tmp/forward.pid";

    // --- FIREWALL OPTIONS ---
    // `--fw-file <path>` untuk berkas aturan lain, `--no-fw` untuk mematikan
    // penyaringan, `--fw` untuk menampilkan aturan, `--fw-check` untuk menguji
    // satu paket (edukasi: "kenapa paket saya diblokir?").
    const fwFileIdx = args.indexOf("--fw-file");
    const fwPath =
      fwFileIdx !== -1 && args[fwFileIdx + 1]
        ? args[fwFileIdx + 1]
        : FIREWALL_DEFAULT_PATH;
    const fwDisabled = args.includes("--no-fw");
    const fwShow = args.includes("--fw") || args.includes("--fw-show");
    const fwCheckIdx = args.indexOf("--fw-check");

    // Helper: baca PID daemon bridge dari file (0 kalau tidak ada).
    const readBridgePid = async (): Promise<number> => {
      try {
        const raw = (await lib.fs.readFile(pidFile)) || "";
        const pid = parseInt(String(raw).trim(), 10);
        return Number.isFinite(pid) && pid > 0 ? pid : 0;
      } catch (e) {
        return 0;
      }
    };

    // --- FIREWALL: TAMPILKAN ATURAN (--fw) ---
    if (fwShow) {
      const fw = await Firewall.load({ path: fwPath });
      for (const line of fw.describe()) {
        await lib.std.print(`${line}\n`);
      }
      if (fw.warnings.length > 0) {
        await lib.std.print(`\n⚠️  Peringatan (${fw.warnings.length}):\n`);
        for (const w of fw.warnings) await lib.std.print(`   - ${w}\n`);
      }
      await lib.shell.exit(0);
      return;
    }

    // --- FIREWALL: UJI SATU PAKET (--fw-check src:sport dst:dport) ---
    if (fwCheckIdx !== -1) {
      await this.runFirewallCheck(lib, fwPath, args[fwCheckIdx + 1], args[fwCheckIdx + 2]);
      return;
    }

    // --- MONITOR COMMAND (--top) ---
    if (hasTop) {
      await this.runMonitor(lib, statsFile);
      return;
    }

    // --- STOP COMMAND (--stop) — berhentikan daemon via PID file + SIGTERM ---
    // Bridge berjalan sebagai daemon terpisah, jadi --stop di proses baru TIDAK
    // bisa memakai `globalForwarder` (state per-proses). Gunakan /tmp/forward.pid.
    if (hasStop) {
      const pid = await readBridgePid();
      if (!pid) {
        await lib.std.print("No bridge is running.\n");
        await lib.shell.exit(1);
        return;
      }

      await lib.std.print(`Stopping broker bridge (PID ${pid})...\n`);
      try {
        await lib.shell.kill(pid, 15); // SIGTERM → daemon stopForward + exit
        await lib.fs.unlink(pidFile);
        await lib.fs.unlink(statsFile);
      } catch (e) {}
      await lib.std.print("✅ Bridge stopped.\n");
      await lib.shell.exit(0);
      return;
    }

    // --- START COMMAND (--start) — cek status daemon via PID file ---
    if (hasStart) {
      const pid = await readBridgePid();
      if (pid) {
        await lib.std.print(
          `Bridge is already running (PID ${pid}). Use --stop to stop it.\n`,
        );
        await lib.shell.exit(0);
      } else {
        await lib.std.print(
          "No bridge running. Start with: forward -s <broker1> -d <broker2>\n",
        );
        await lib.shell.exit(1);
      }
      return;
    }

    // --- CREATE NEW BRIDGE ---
    if (sourceIdx !== -1 && destIdx !== -1) {
      const brokerA = args[sourceIdx + 1];
      const brokerB = args[destIdx + 1];

      if (!brokerA || !brokerB) {
        await lib.std.print("Error: Missing broker addresses.\n");
        await this.showSyntax(lib);
        return;
      }

      // Cegah duplikasi: kalau daemon bridge sudah ada (PID file), tolak start baru.
      const existingPid = await readBridgePid();
      if (existingPid) {
        await lib.std.print(
          `A broker bridge is already running (PID ${existingPid}). Use --stop first.\n`,
        );
        await lib.shell.exit(1);
        return;
      }

      await lib.std.print(
        `Establishing Broker Bridge: ${brokerA} <-> ${brokerB}\n`,
      );

      // Firewall dimuat SEBELUM bridge jalan supaya aturan sudah berlaku untuk
      // paket pertama. Berkas tidak ada = firewall non-aktif (perilaku lama).
      const firewall = fwDisabled ? null : await this.loadFirewall(lib, fwPath);
      if (firewall) {
        await lib.std.print(
          `🔥 Firewall: ${firewall.path} — ${firewall.active ? "AKTIF" : "non-aktif"}` +
            `${firewall.active ? ` (${firewall.summary()})` : ""}\n`,
        );
        for (const w of firewall.warnings) {
          await lib.std.print(`   ⚠️  ${w}\n`);
        }
      } else {
        await lib.std.print("🔥 Firewall: dimatikan (--no-fw)\n");
      }

      globalForwarder = new PacketForwarder(brokerA, brokerB);
      globalForwarder.setFirewall(firewall);
      const success = await globalForwarder.startForward();

      if (success) {
        await new Promise((r) => setTimeout(r, 2000));

        const stats = globalForwarder.getStats();
        if (stats.isRunning) {
          await lib.std.print(
            `✅ Broker Bridge is ACTIVE between ${stats.brokerA} and ${stats.brokerB}\n`,
          );
          await lib.std.print(
            "Running in background. Use 'forward --top' to monitor, 'forward --stop' to stop.\n",
          );

          if (await lib.shell.daemonize("Broker Bridge")) {
            await lib.std.log(
              `Bridge established: ${stats.brokerA} <-> ${stats.brokerB}`,
              "forward",
            );
          }

          // Daemon: tulis PID file + tangani SIGTERM supaya `forward --stop`
          // (dari proses lain) bisa mematikan bridge ini.
          try {
            await lib.fs.writeFile(pidFile, String(lib.getPid()));
          } catch (e) {}
          await lib.shell.onSignal("SIGTERM", async () => {
            try {
              if (globalForwarder) await globalForwarder.stopForward();
            } catch (e) {}
            try {
              await lib.fs.unlink(pidFile);
            } catch (e) {}
            await lib.shell.exit(0);
          });

          // Infinite loop to keep daemon alive and update dynamic stats
          while (true) {
            const currentStats = globalForwarder?.getStats();
            if (!currentStats || !currentStats.isRunning) break;

            // Save stats to file for the monitor
            try {
              await lib.fs.writeFile(statsFile, JSON.stringify(currentStats));
            } catch (e) {}

            await new Promise((r) => setTimeout(r, 1000));
          }
        } else {
          await lib.std.print(
            "⚠️  Bridge started but failed to connect to one or both brokers.\n",
          );
        }
      } else {
        await lib.std.print("❌ Failed to initialize bridge.\n");
        globalForwarder = null;
        await lib.shell.exit(1);
      }

      return;
    }

    await this.showSyntax(lib);
  }

  /**
   * loadFirewall(): muat aturan ACL dari VFS.
   *
   * Kegagalan TIDAK menghentikan bridge: berkas tidak ada / rusak berarti
   * "tanpa aturan" (semua lolos), dan peringatannya ditampilkan ke pengguna.
   * Ini menjaga perilaku `forward` lama tetap utuh.
   */
  private async loadFirewall(
    lib: UserLib,
    path: string,
  ): Promise<Firewall | null> {
    try {
      return await Firewall.load({
        path,
        reader: async (p: string) => await lib.fs.readFile(p),
      });
    } catch (e: any) {
      await lib.std.print(
        `⚠️  Firewall gagal dimuat (${e?.message ?? e}) — semua paket diteruskan.\n`,
      );
      return null;
    }
  }

  /**
   * runFirewallCheck(): tampilkan keputusan aturan untuk satu paket.
   *
   * Berguna untuk pendidikan: pengguna bisa melihat ATURAN MANA yang memblokir
   * tanpa harus menjalankan dua broker dan mengirim paket sungguhan.
   *
   *   forward --fw-check wintsix:5000 tsix-y:24
   */
  private async runFirewallCheck(
    lib: UserLib,
    fwPath: string,
    srcArg?: string,
    dstArg?: string,
  ) {
    const parse = (raw?: string): { address: string; port: number } | null => {
      if (!raw) return null;
      const idx = raw.lastIndexOf(":");
      if (idx <= 0) return null;
      const address = raw.slice(0, idx).trim();
      const port = parseInt(raw.slice(idx + 1), 10);
      if (!address || !Number.isFinite(port)) return null;
      return { address, port };
    };

    const src = parse(srcArg);
    const dst = parse(dstArg);
    if (!src || !dst) {
      await lib.std.print(
        "Syntax: forward --fw-check <srcAddress>:<srcPort> <dstAddress>:<dstPort>\n" +
          "Contoh: forward --fw-check wintsix:5000 tsix-y:24\n",
      );
      await lib.shell.exit(1);
      return;
    }

    const fw = await this.loadFirewall(lib, fwPath);
    if (!fw) {
      await lib.shell.exit(1);
      return;
    }

    for (const line of fw.describe()) {
      await lib.std.print(`${line}\n`);
    }

    const verdict = fw.evaluate({
      srcAddress: src.address,
      srcPort: src.port,
      dstAddress: dst.address,
      dstPort: dst.port,
    });

    await lib.std.print("\n");
    await lib.std.print(
      `Paket    : ${src.address}:${src.port} → ${dst.address}:${dst.port}\n`,
    );
    await lib.std.print(
      `Keputusan: ${verdict.allowed ? "✅ LEWAT" : "⛔ DIBLOKIR"} — ${verdict.reason}\n`,
    );

    if (!verdict.allowed) {
      await lib.std.print(
        "\nPetunjuk: ini alasan paket tidak menyeberang. Untuk melewatinya secara\n" +
          "sah, ubah aturan; untuk konsep tunnel (bypass terkendali), lihat\n" +
          "wiki/Tunnel-MQTNL.md.\n",
      );
    }

    await lib.shell.exit(verdict.allowed ? 0 : 3);
  }

  private async runMonitor(lib: UserLib, statsFile: string) {    let interrupted = false;
    let lastLines = 0;
    let prevStats: any = null;

    await lib.shell.onSignal("SIGINT", async () => {
      interrupted = true;
      await lib.std.print("\n\nExiting monitor...\n");
      await lib.shell.exit(0);
    });

    await lib.std.print("\x1B[2J\x1B[H"); // Clear screen

    while (!interrupted) {
      const dataStr = await lib.fs.readFile(statsFile);
      if (!dataStr) {
        if (lastLines > 0) await lib.std.print(`\x1B[${lastLines}A\x1B[0G`);
        await lib.std.print(
          "Waiting for forwarder stats... (Is the bridge running?)\n",
        );
        lastLines = 1;
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      try {
        const stats = JSON.parse(dataStr);
        const now = Date.now();

        // Move cursor up to overwrite and CLEAR from cursor to end of screen
        if (lastLines > 0) {
          await lib.std.print(`\x1B[${lastLines}A\x1B[J\x1B[0G`);
        }

        // Rates calculation
        let rateAtoB = 0;
        let rateBtoA = 0;
        if (prevStats) {
          const dt = (now - prevStats.time) / 1000;
          if (dt > 0.1) {
            // Min 100ms for calculation
            rateAtoB = (stats.bytesAtoB - prevStats.bytesAtoB) / dt;
            rateBtoA = (stats.bytesBtoA - prevStats.bytesBtoA) / dt;
          }
        }
        prevStats = {
          bytesAtoB: stats.bytesAtoB,
          bytesBtoA: stats.bytesBtoA,
          time: now,
        };

        // Build output
        const uptime = Math.floor(stats.uptime / 1000);
        const h = Math.floor(uptime / 3600)
          .toString()
          .padStart(2, "0");
        const m = Math.floor((uptime % 3600) / 60)
          .toString()
          .padStart(2, "0");
        const s = Math.floor(uptime % 60)
          .toString()
          .padStart(2, "0");

        let output = "";
        output += `📡 MQTNL Broker Bridge Monitor\n`;
        output += `------------------------------------------------------\n`;
        output += `Bridge: ${stats.brokerA} <-> ${stats.brokerB}\n`;
        output += `Status: ${stats.isRunning ? "ACTIVE" : "INACTIVE"} | Uptime: ${h}:${m}:${s}\n\n`;
        output += `Traffic Flow:\n`;
        output += `  A -> B: ${stats.packetsAtoB.toString().padStart(8)} pkts | ${this.formatBytes(stats.bytesAtoB).padStart(10)} | Rate: ${this.formatBytes(rateAtoB).padStart(9)}/s\n`;
        output += `  B -> A: ${stats.packetsBtoA.toString().padStart(8)} pkts | ${this.formatBytes(stats.bytesBtoA).padStart(10)} | Rate: ${this.formatBytes(rateBtoA).padStart(9)}/s\n`;

        // Firewall: tampilkan hanya kalau aktif, supaya tampilan lama tidak berubah.
        const fw = stats.firewall;
        if (fw?.enabled) {
          output += `\nFirewall: ${fw.active ? `AKTIF (${fw.rules})` : "non-aktif"}`;
          output += ` | Blocked: ${fw.blocked ?? 0}\n`;
          if (fw.lastBlock) output += `Last block: ${fw.lastBlock}\n`;
        }

        output += `\nPress Ctrl+C to exit...`;

        await lib.std.print(output);
        lastLines = output.split("\n").length;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await lib.std.print(`Error reading stats: ${msg}\n`);
      }

      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  private async showSyntax(lib: UserLib) {
    await lib.std.print("Syntax: forward -s <broker_a> -d <broker_b>\n");
    await lib.std.print("        forward --start   # Cek status bridge\n");
    await lib.std.print("        forward --stop    # Stop bridge\n");
    await lib.std.print(
      "        forward --top     # Monitor real-time stats\n",
    );
    await lib.std.print("\nFirewall (ACL, opsional):\n");
    await lib.std.print(
      "        forward --fw      # Tampilkan aturan dari /etc/packetforwarder/firewalltables.conf\n",
    );
    await lib.std.print(
      "        forward --fw-check <src>:<port> <dst>:<port>   # Uji satu paket\n",
    );
    await lib.std.print(
      "        forward --fw-file <path>   # Pakai berkas aturan lain\n",
    );
    await lib.std.print("        forward --no-fw            # Matikan ACL\n");
    await lib.std.print("\nExample: forward -s localhost -d 192.168.0.109\n");
    await lib.shell.exit(1);
  }
}
