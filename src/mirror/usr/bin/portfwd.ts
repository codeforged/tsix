import { UserLib } from "@tsix/UserLib";
import { NetSocket } from "@tsix/NetworkLib";

interface ClientSession {
  clientSrc: string;
  clientPort: number;
  outSocket: NetSocket;
  lastActive: number;
}

/**
 * PORTFWD - Port Forwarder & Tunneling Utility Antar-Interface TSIX
 *
 * Stateful NAPT (Network Address Port Translation) dengan Point-to-Point Session Mapping,
 * Signal Handler Cleanup, & Auto Memory Cleanup (Anti-Memory Leak).
 *
 * Syntax:
 *   portfwd -s <iface_in>:<port_in> -d <iface_out>:<target_node>:<port_out>
 *
 * Example:
 *   portfwd -s smqtnl0:2000 -d smqtnl2:smartbulbtsix:24
 */
export default class main {
  private activeSessions = new Map<string, ClientSession>();
  private SESSION_TIMEOUT_MS = 60000; // 60 detik idle timeout

  async execute(lib: UserLib, args: string[]) {
    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
      await this.showHelp(lib);
      return;
    }

    let inIface = "smqtnl0";
    let inPort = 8080;
    let outIface = "smqtnl2";
    let outAddr = "jatitsix_3";
    let outPort = 80;

    const sIdx = args.indexOf("-s");
    if (sIdx !== -1 && args[sIdx + 1]) {
      const sParts = args[sIdx + 1].split(":");
      if (sParts.length >= 2) {
        inIface = sParts[0];
        inPort = parseInt(sParts[1], 10);
      }
    } else {
      inIface = this.getArg(args, "-in-iface", inIface);
      inPort = parseInt(this.getArg(args, "-in-port", String(inPort)), 10);
    }

    const dIdx = args.indexOf("-d");
    if (dIdx !== -1 && args[dIdx + 1]) {
      const dParts = args[dIdx + 1].split(":");
      if (dParts.length >= 3) {
        outIface = dParts[0];
        outAddr = dParts[1];
        outPort = parseInt(dParts[2], 10);
      } else if (dParts.length === 2) {
        outAddr = dParts[0];
        outPort = parseInt(dParts[1], 10);
      }
    } else {
      outIface = this.getArg(args, "-out-iface", outIface);
      outAddr = this.getArg(args, "-out-addr", outAddr);
      outPort = parseInt(this.getArg(args, "-out-port", String(outPort)), 10);
    }

    if (isNaN(inPort) || isNaN(outPort) || !outAddr) {
      await lib.std.print("❌ Invalid parameters.\n\n");
      await this.showHelp(lib);
      return;
    }

    await lib.std.print("🔄 TSIX Stateful NAPT Port Tunneling Active\n");
    await lib.std.print(`   📥 LISTEN : [${inIface}] Port ${inPort}\n`);
    await lib.std.print(`   📤 FORWARD: [${outIface}] -> Node '${outAddr}' Port ${outPort}\n\n`);

    // Main Inbound Socket
    const inSocket = new NetSocket({
      port: inPort,
      iface: inIface,
      binary: true,
      autoCleanup: false,
    });

    // Cleanup Timer untuk Sesi Idle (Mencegah Memory Leak & Release Port Kernel)
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, session] of this.activeSessions.entries()) {
        if (now - session.lastActive > this.SESSION_TIMEOUT_MS) {
          session.outSocket.close().catch(() => {});
          this.activeSessions.delete(key);
          lib.std.log(`[portfwd] Session ${key} expired & cleaned up.`, "portfwd");
        }
      }
    }, 15000);

    // Helper fungsi cleanup komprehensif saat sinyal/stop diterima
    const cleanupAllResources = async () => {
      clearInterval(cleanupInterval);
      for (const session of this.activeSessions.values()) {
        try {
          await session.outSocket.close();
        } catch (_) {}
      }
      this.activeSessions.clear();
      try {
        await inSocket.close();
      } catch (_) {}
    };

    // Register Signal Handlers (SIGINT = Ctrl+C, SIGTERM = kill -15)
    try {
      await lib.shell.onSignal("SIGINT", async () => {
        await lib.std.print("\n\nStopping portfwd...\n");
        await cleanupAllResources();
        await lib.shell.exit(130);
      });

      await lib.shell.onSignal("SIGTERM", async () => {
        await cleanupAllResources();
        await lib.shell.exit(143);
      });
    } catch (_) {}

    // Tangani data masuk di inSocket (smqtnl0)
    inSocket.onData = async (pkt) => {
      const sessionKey = `${pkt.src}:${pkt.port}`;
      let session = this.activeSessions.get(sessionKey);

      if (!session) {
        // Buat outbound socket dedicated per client (Point-to-Point mapping)
        const outSocket = new NetSocket({
          port: 0, // Port random/ephemeral dedicated di outIface
          iface: outIface,
          binary: true,
          autoCleanup: false,
        });

        // Set up callback balasan TERISOLASI khusus untuk client ini
        outSocket.onData = async (replyPkt) => {
          const s = this.activeSessions.get(sessionKey);
          if (s) {
            s.lastActive = Date.now();
          }
          await inSocket.sendTo(pkt.src, pkt.port, replyPkt.data);
        };

        try {
          await outSocket.open();
        } catch (err: any) {
          await lib.std.print(`❌ Gagal membuka outbound socket untuk ${sessionKey}: ${err.message}\n`);
          return;
        }

        session = {
          clientSrc: pkt.src,
          clientPort: pkt.port,
          outSocket,
          lastActive: Date.now(),
        };
        this.activeSessions.set(sessionKey, session);
      } else {
        session.lastActive = Date.now();
      }

      const dataBuf = NetSocket.toBuffer(pkt.data);
      await lib.std.log(
        `Forward [${inIface}:${inPort}] (${pkt.src}:${pkt.port}) -> [${outIface}] (${outAddr}:${outPort}) [${dataBuf.length} B]`,
        "portfwd"
      );

      // Kirim via dedicated outbound socket milik client ini
      await session.outSocket.sendTo(outAddr, outPort, pkt.data);
    };

    await inSocket.open();
    await lib.std.print("✅ Stateful Tunnel established and listening. Press Ctrl+C to exit.\n");

    // Cleanup saat socket ditutup
    inSocket.onClose = () => {
      void cleanupAllResources();
    };

    await inSocket.waitClosed();
  }

  private getArg(args: string[], flag: string, defaultVal: string): string {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
  }

  private async showHelp(lib: UserLib) {
    await lib.std.print("Syntax:\n");
    await lib.std.print(
      "  portfwd -s <iface_in>:<port_in> -d <iface_out>:<target_node>:<port_out>\n\n"
    );
    await lib.std.print("Example:\n");
    await lib.std.print(
      "  portfwd -s smqtnl0:2000 -d smqtnl2:smartbulbtsix:24\n"
    );
    await lib.shell.exit(0);
  }
}


