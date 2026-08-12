import { IProgram, OSContext } from "../../lib/IProgram";
import { NetworkLib } from "../../lib/NetworkLib";

/**
 * IFCONFIG Utility
 * 
 * Configure or display network interface parameters.
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std } = os;

        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: ifconfig\nDisplay network interface information.\n");
            return;
        }

        const net = new NetworkLib(os);

        const data = await net.netstat(); // Returns { interfaces: [], defaultDevice: string }

        if (!data || !data.interfaces) {
            await std.print("Failed to retrieve network statistics.\n");
            return;
        }

        for (const iface of data.interfaces) {
            const stats = iface.params;
            const statusIcon = stats.connected ? "✅ Connected" : "❌ Disconnected";

            await std.print(`\n📡  Device:      ${iface.deviceName}\n`);
            await std.print(`   Address:     ${iface.address}\n`);
            await std.print(`   Broker:      ${iface.broker}\n`);
            await std.print(`   Status:      ${statusIcon}\n`);
            await std.print(`   Uptime:      ${this.formatTime(stats.uptime)}\n`);
            await std.print(`   Rx/Tx:       ${this.formatBytes(stats.rxBytes)} / ${this.formatBytes(stats.txBytes)}\n`);
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
