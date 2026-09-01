import { UserLib } from "@tsix/UserLib";
import { PacketForwarder } from "@tsix/PacketForwarder";

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

      globalForwarder = new PacketForwarder(brokerA, brokerB);
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

  private async runMonitor(lib: UserLib, statsFile: string) {
    let interrupted = false;
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
    await lib.std.print("\nExample: forward -s localhost -d 192.168.0.109\n");
    await lib.shell.exit(1);
  }
}
