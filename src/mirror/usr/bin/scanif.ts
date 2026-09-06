import { IProgram, OSContext } from "../../lib/IProgram";
import { NetworkLib, SMQTNL_IOCTL } from "../../lib/NetworkLib";
import { PacketFlags } from "@common/PacketFlags";

/**
 * SCANIF Utility
 *
 * Network interface scanner untuk MQTNL: discovery interface yang online
 * (broadcast ping), daftar port yang di-bind per interface lokal (`-l`),
 * dan scan port terbuka di node remote (`-p`).
 */
export class main implements IProgram {
  async execute(os: OSContext, args: string[]): Promise<void> {
    const { std } = os;
    const net = new NetworkLib(os);

    // `scanif` (tanpa arg) = broadcast ping; help hanya lewat -h/--help.
    if (args.includes("-h") || args.includes("--help")) {
      await std.print(
        "\x1B[1;36mSCANIF for TSIX\x1B[0m (Standard MQTNL Interface Scanner)\n",
      );
      await std.print("Usage: scanif [options]\n");
      await std.print("       scanif -l\n");
      await std.print("       scanif -p <ports> <target>\n\n");
      await std.print("Options:\n");
      await std.print(
        "  (tanpa flag)    Broadcast ping - cari semua interface/node yang online\n",
      );
      await std.print(
        "  -l              List port yang sedang di-bind (listening) per interface lokal\n",
      );
      await std.print(
        "  -p <ports>      Port scan (Check specific ports - e.g. -p 24,2222 or -p 1-100)\n",
      );
      await std.print("  -v              Verbose output\n\n");
      await std.print("Example:\n");
      await std.print(
        "  scanif                  (Broadcast ping semua interface)\n",
      );
      await std.print(
        "  scanif -l               (Lihat port yang di-bind per interface)\n",
      );
      await std.print(
        "  scanif -p 24,2222 localhost   (Cek port service di node sendiri)\n",
      );
      await std.print(
        "  scanif -p 1-1024 <node>       (Cek range port di node remote)\n",
      );
      return;
    }

    const verbose = args.includes("-v");

    // --- MODE -l: daftar port yang sedang di-bind per interface lokal ---
    // Kernel (via netstat) tahu persis port mana yang di-bind — tidak perlu
    // scan range seperti ke node remote.
    if (args.includes("-l") || args.includes("--local")) {
      const st = await net.netstat();
      if (!st || !Array.isArray(st.interfaces)) {
        await std.print("scanif: gagal membaca netstat.\n");
        return;
      }
      for (const iface of st.interfaces) {
        const istats = iface.params || {};
        const statusIcon = istats.connected
          ? "✅ Connected"
          : "❌ Disconnected";
        const boundPorts: any[] = Array.isArray(istats.boundPorts)
          ? istats.boundPorts
          : [];
        await std.print(
          `\n📡  ${iface.deviceName} (${iface.address}) — ${statusIcon}\n`,
        );
        if (boundPorts.length === 0) {
          await std.print("   Bound ports: (none)\n");
        } else {
          const labels = boundPorts.map((b: any) =>
            b && typeof b === "object" && b.proc
              ? `${b.port} (${b.proc})`
              : String(typeof b === "object" && b ? b.port : b),
          );
          await std.print(`   Bound ports: ${labels.join(", ")}\n`);
        }
      }
      await std.print(`\n   Default Interface : ${st.defaultDevice || "-"}\n`);
      return;
    }

    const isDiscovery = !args.includes("-p");

    // Target & port list dipisah supaya nilai -p tidak ikut dianggap target.
    let targets: string[] = [];
    let ports: number[] = [];

    if (isDiscovery) {
      // Mode default: broadcast ping — tidak perlu target, cukup "*".
      targets = ["*"];
    } else {
      // Mode port scan: -p <ports> <target...>
      const pIdx = args.indexOf("-p");
      if (pIdx + 1 >= args.length) {
        await std.print(
          "scanif: -p butuh daftar port (e.g. scanif -p 24,2222 localhost)\n",
        );
        return;
      }
      const pArg = args[pIdx + 1];
      if (pArg.includes("-")) {
        const [s, e] = pArg.split("-").map((p) => parseInt(p));
        if (isNaN(s) || isNaN(e)) {
          await std.print(`scanif: daftar port tidak valid: ${pArg}\n`);
          return;
        }
        for (let p = s; p <= e; p++) ports.push(p);
      } else {
        ports = pArg
          .split(",")
          .map((p) => parseInt(p))
          .filter((p) => !isNaN(p));
        if (ports.length === 0) {
          await std.print(`scanif: daftar port tidak valid: ${pArg}\n`);
          return;
        }
      }
      // Target = argumen non-flag SELAIN nilai -p (jangan anggap port sbg target)
      targets = args.filter((a, i) => !a.startsWith("-") && i !== pIdx + 1);
      if (targets.length === 0) {
        await std.print(
          "scanif: -p butuh target (e.g. scanif -p 24,2222 localhost)\n",
        );
        return;
      }
    }

    if (isDiscovery) {
      // Broadcast ping — default scanif (tanpa -p). Selalu kirim ke "*".
      await std.print(
        `Starting TSIX Interface Discovery (\x1B[33mBroadcast *\x1B[0m)...\n`,
      );

      const fd = await net.socket();
      const localPort = await net.bind(
        fd,
        49152 + Math.floor(Math.random() * 1000),
      );
      // Discovery memakai JSON v1.0 agar kompatibel dengan node lama
      // (mis. Felica) yang belum subscribe/menangani Binfeo v1.2.
      // Node baru tetap wajib mendukung JSON untuk ping/discovery dasar.

      const scanStart = Date.now();
      const port = 65534; // Broadcast ping port (NOS standard)
      await net.sendTo(
        fd,
        "*",
        port,
        "TSIX_DISCOVERY",
        PacketFlags.FLAG_BROADCAST_PING,
        localPort,
      );

      const found: Set<string> = new Set();
      const start = Date.now();
      const timeout = 2500;

      while (Date.now() - start < timeout) {
        const reply = await net.recvFrom(fd, 500);
        if (reply && reply.src) {
          const rtt = Date.now() - scanStart;
          //if (!found.has(reply.src)) // <-- Komen itu jika deteksi juga berlaku pada interface diri sendiri
          {
            found.add(reply.src);
            let identity = reply.data || "Unknown";
            if (Buffer.isBuffer(identity)) identity = identity.toString("utf8");
            if (typeof identity === "object") {
              try {
                identity = JSON.stringify(identity);
              } catch {
                identity = "Unknown";
              }
            }
            identity = String(identity);
            if (identity.length > 18) {
              identity = `${identity.slice(0, 18)}...`;
            }
            await std.print(
              `Found node: \x1B[1;32m${reply.src.padEnd(15)}\x1B[0m | Identity: ${identity} | RTT: ${rtt}ms\n`,
            );
          }
        }
      }

      // --- SELF / LOCAL INTERFACES ---
      // Broadcast tidak di-loopback ke pengirim + ada self-filter di driver,
      // jadi interface sendiri tidak akan pernah membalas broadcast-nya.
      // Supaya tetap "terlihat", tampilkan interface lokal yang Connected
      // sebagai node yang ditemukan — analog nmap yang melihat IP-nya sendiri
      // saat menscan subnet.
      try {
        const st = await net.netstat();
        if (st && Array.isArray(st.interfaces)) {
          for (const iface of st.interfaces) {
            if (iface.params && iface.params.connected) {
              const selfName = iface.address || iface.deviceName;
              if (!found.has(selfName)) {
                found.add(selfName);
                await std.print(
                  `Found node: \x1B[1;36m${selfName.padEnd(15)}\x1B[0m | Identity: \x1B[1;33mlocal interface\x1B[0m | RTT: 0ms (self)\n`,
                );
              }
            }
          }
        }
      } catch {
        // netstat gagal → abaikan, hasil broadcast tetap ditampilkan
      }

      await std.print(
        `\nScan complete. \x1B[1;36mDiscovery session ended.\x1B[0m\n`,
      );
    } else {
      // Port Scan — daftar port sudah diparsing di atas (variabel `ports`)
      for (const target of targets) {
        await std.print(`Scanning ports on \x1B[33m${target}\x1B[0m...\n`);

        const fd = await net.socket();
        const localPort = await net.bind(
          fd,
          54321 + Math.floor(Math.random() * 100),
        );
        await net.ioctl(fd, SMQTNL_IOCTL.SET_BINARY_MODE, {
          port: localPort,
          protocol: "Binfeo",
        });

        let openCount = 0;
        for (const port of ports) {
          if (verbose) await std.print(`Checking ${target}:${port}... `);

          const start = Date.now();
          await net.sendTo(
            fd,
            target,
            port,
            "PROBE",
            PacketFlags.FLAG_PING_REQUEST,
            localPort,
          );

          const reply = await net.recvFrom(fd, 1000);
          if (reply) {
            const rtt = Date.now() - start;
            if (verbose) await std.print(`\x1B[32mUP\x1B[0m\n`);
            await std.print(
              `PORT \x1B[1m${port.toString().padEnd(5)}\x1B[0m: \x1B[32mOPEN\x1B[0m (Response in ${rtt}ms from ${reply.src})\n`,
            );
            openCount++;
          } else if (verbose) {
            await std.print(`\x1B[31mTIMEOUT\x1B[0m\n`);
          }
        }

        await std.print(
          `\nScanif done: ${target} scanned. ${openCount} ports responded.\n`,
        );
      }
    }
  }
}
