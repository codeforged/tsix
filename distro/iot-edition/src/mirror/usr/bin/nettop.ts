import { IProgram, OSContext } from "../../lib/IProgram";
import { NetworkLib } from "../../lib/NetworkLib";

/**
 * NETTOP Utility
 * 
 * Display real-time network traffic statistics.
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, shell } = os;

        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: nettop\nMonitor network traffic in real-time.\n");
            return;
        }

        const net = new NetworkLib(os);

        let prevStats: Record<string, { rx: number, tx: number, time: number }> = {};
        const refreshRate = 1000;

        let lastLineCount = 0;
        let interrupted = false;

        // Handle Ctrl+C gracefully
        shell.onSignal("SIGINT", async () => {
            interrupted = true;
            await std.print("\n\n^C\nExiting nettop...\n");
            await std.print("\x1B[?25h"); // Show cursor
            await shell.exit(130);
        });

        try {
            while (!interrupted) {
                const data = await net.netstat();
                if (!data || !data.interfaces) break;

                // Move cursor UP to overwrite previous output
                if (lastLineCount > 0) {
                    await std.print(`\x1B[${lastLineCount}A\x1B[0G`);
                }

                // Calculate lines for next iteration: 
                // Header(2) + Interfaces(N) + Footer(1 (\n part of footer creates line, text stays on same line? No.))
                // Let's rely on empirical "3 + N" from trace.
                lastLineCount = 3 + data.interfaces.length;

                await std.print(`📡 MQTNL Network Traffic (refresh ${refreshRate}ms)\n\n`);

                for (const iface of data.interfaces) {
                    const currentRx = iface.params.rxBytes;
                    const currentTx = iface.params.txBytes;
                    const now = Date.now();

                    let rxRate = 0;
                    let txRate = 0;

                    if (prevStats[iface.deviceName]) {
                        const prev = prevStats[iface.deviceName];
                        const timeDelta = (now - prev.time) / 1000; // in seconds
                        if (timeDelta > 0) {
                            rxRate = (currentRx - prev.rx) / timeDelta;
                            txRate = (currentTx - prev.tx) / timeDelta;
                        }
                    }

                    // Update prev stats
                    prevStats[iface.deviceName] = { rx: currentRx, tx: currentTx, time: now };

                    // Formatting
                    const name = iface.deviceName.padEnd(15);
                    const txStr = this.formatBytes(currentTx).padStart(9);
                    const rxStr = this.formatBytes(currentRx).padStart(9);
                    const txRateStr = (this.formatBytes(txRate) + "/s").padStart(10);
                    const rxRateStr = (this.formatBytes(rxRate) + "/s").padStart(10);

                    await std.print(`📡 ${name} :: Tx ${txStr} / ${txRateStr} | Rx ${rxStr} / ${rxRateStr}\n`);
                }

                await std.print("\nPress Ctrl+C to exit...");
                await new Promise(r => setTimeout(r, refreshRate));
            }
        } catch (e) {
            // ignore
        } finally {
            if (!interrupted) {
                await std.print("\x1B[?25h"); // Show cursor
            }
        }
    }

    private formatBytes(bytes: number): string {
        if (bytes === 0) return "0.00 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    }
}
