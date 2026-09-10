import { IProgram, OSContext } from "../../lib/IProgram";
import { NetworkLib } from "../../lib/NetworkLib";

/**
 * IFCONFIG Utility
 *
 * Display (or change) MQTNL network interfaces.
 *
 *   ifconfig                 → show all interfaces + active default
 *   ifconfig -a              → same as no argument
 *   ifconfig <iface>         → make <iface> the default at RUNTIME
 *                              (deviceName "smqtnl1" or address "mactsix_2")
 *
 * The default change lives in kernel memory only: `sysconfig.json` is NOT
 * modified and the original default returns after a reboot.
 */
export class main implements IProgram {
  async execute(os: OSContext, args: string[]): Promise<void> {
    const { std } = os;

    if (args.includes("--help") || args.includes("-h")) {
      await std.print("Usage: ifconfig [<interface>]\n\n");
      await std.print("  ifconfig                 Show all interfaces\n");
      await std.print("  ifconfig -a              Same as no argument\n");
      await std.print(
        "  ifconfig <dev|address>   Set the default interface (runtime)\n\n",
      );
      await std.print("Examples:\n");
      await std.print("  ifconfig                 Show interface status\n");
      await std.print(
        "  ifconfig smqtnl1         Use 'smqtnl1' as the default\n",
      );
      await std.print("  ifconfig mactsix_2       Address works too\n\n");
      await std.print(
        "Note: the change is in-memory (runtime) only — sysconfig.json is\n",
      );
      await std.print("not modified, and the default is restored after a reboot.\n");
      return;
    }

    const net = new NetworkLib(os);

    // Argumen non-flag = interface/address yang mau dijadikan default.
    const target = args.find((a) => a && !a.startsWith("-"));

    if (target) {
      try {
        const res = await net.setDefaultDevice(target);
        const prev = res?.previous ?? "-";
        const next = res?.defaultDevice ?? target;
        await std.print(`✅ Default interface: ${prev} → ${next}\n`);
      } catch (e: any) {
        await std.print(`ifconfig: ${e?.message || e}\n`);
      }
      return;
    }

    const data = await net.netstat(); // Returns { interfaces: [], defaultDevice: string }

    if (!data || !data.interfaces) {
      await std.print("Failed to retrieve network statistics.\n");
      return;
    }

    for (const iface of data.interfaces) {
      const stats = iface.params;
      const statusIcon = stats.connected ? "✅ Connected" : "❌ Disconnected";
      const defaultTag =
        iface.deviceName === data.defaultDevice ? "  ⭐ default" : "";

      await std.print(`\n📡  Device:      ${iface.deviceName}${defaultTag}\n`);
      await std.print(`   Address:     ${iface.address}\n`);
      await std.print(`   Broker:      ${iface.broker}\n`);
      await std.print(`   Status:      ${statusIcon}\n`);
      await std.print(`   Uptime:      ${this.formatTime(stats.uptime)}\n`);
      await std.print(
        `   Rx/Tx:       ${this.formatBytes(stats.rxBytes)} / ${this.formatBytes(stats.txBytes)}\n`,
      );
      await std.print(`   Total bind/connections: ${stats.binds}\n`);
    }

    await std.print(`\n   Default Interface : ${data.defaultDevice}\n`);
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  private formatTime(ms: number): string {
    if (!ms) return "unknown";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }
}
