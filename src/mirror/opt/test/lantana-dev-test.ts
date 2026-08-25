import { UserLib } from "../../lib/UserLib";

/**
 * lantana-dev-test.ts — Emulator ESP (Sender) untuk Lantana IoT Stack
 *
 * Mensimulasikan device ESP32 yang mengirim data sensor ke daemon Lantana
 * (port 1000 default). Mendukung 2 format yang dipahami Lantana:
 *   - Plaintext : LANTANA|<nodeId>|<sensorId:value;sensorId:value;...>
 *   - Biner     : frame sensor Lantana [0x4C][0x01][nodeLen][node][cnt][sid][f32]...
 *
 * Usage:
 *   lantana-dev-test                              (plaintext, node esp32-dev-01)
 *   lantana-dev-test --binary                     (kirim frame biner)
 *   lantana-dev-test --node=gudang-a --interval=2000
 *   lantana-dev-test --target=leptopus --port=1000 --count=50
 *
 * (c) 2026 TSIX Project — Lantana Dev Test
 */
export default class LantanaDevTest {
    async execute(lib: UserLib, args: string[]) {
        const white = "\x1b[97m";
        const green = "\x1b[92m";
        const cyan = "\x1b[96m";
        const yellow = "\x1b[93m";
        const red = "\x1b[91m";
        const reset = "\x1b[0m";

        // ── Argumen ──
        const arg = (name: string, dflt: string) => {
            const a = args.find((x) => x.startsWith(`--${name}=`));
            return a ? a.split("=")[1] : dflt;
        };
        const useBinary = args.includes("--binary");

        const NODE_ID = arg("node", "esp32-dev-01");
        const TARGET_HOST = arg("target", "localhost");
        const TARGET_PORT = parseInt(arg("port", "1000"), 10);
        const MY_PORT = parseInt(arg("myport", "1001"), 10);
        const INTERVAL_MS = parseInt(arg("interval", "5000"), 10);
        const COUNT = parseInt(arg("count", "0"), 10); // 0 = tak terbatas
        const KEY_HEX = arg("key", "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619");

        // Sensor yang dikirim (id, nama kategori, nilai awal)
        const sensors = [
            { id: "01", cat: "temp", val: 25 },
            { id: "02", cat: "hum", val: 60 },
            { id: "03", cat: "pres", val: 1013 },
            { id: "04", cat: "light", val: 100 },
        ];

        await lib.std.print(`${white}=== Lantana Dev Test (ESP Emulator) ===${reset}\n`);
        await lib.std.print(`${cyan}Node   : ${NODE_ID}${reset}\n`);
        await lib.std.print(`${cyan}Target : ${TARGET_HOST}:${TARGET_PORT}${reset}\n`);
        await lib.std.print(`${cyan}Format : ${useBinary ? "BINARY (frame 0x4C)" : "PLAINTEXT (LANTANA|...)"}${reset}\n`);
        await lib.std.print(`${cyan}Every  : ${INTERVAL_MS}ms | Count: ${COUNT || "∞"}${reset}\n`);

        // ── Setup socket ──
        const socketFd = await lib.net.socket();
        if (socketFd < 0) return "Error: Gagal membuat socket MQTNL.\n";

        const bound = await lib.net.bind(socketFd, MY_PORT);
        if (!bound) {
            await lib.std.print(`${red}Error: Gagal bind port ${MY_PORT} (mungkin sudah dipakai).${reset}\n`);
            return;
        }

        // Upgrade security ChaCha20 untuk kirim & terima (key sama dengan config Lantana)
        await lib.net.ioctl(socketFd, 0x1001, { port: MY_PORT, sessionKey: KEY_HEX });
        await lib.net.ioctl(socketFd, 0x1001, { port: TARGET_PORT, sessionKey: KEY_HEX });

        // Binary mode MQTNL (jika --binary) — pakai jalur mqtnl@1.1/
        if (useBinary) {
            await lib.net.ioctl(socketFd, 0x1002, true);
        }

        // ── Background listener (untuk command/ACK dari Lantana) ──
        const relayListener = async () => {
            while (true) {
                const pkt = await lib.net.recv(socketFd);
                if (pkt && pkt.localPort === MY_PORT) {
                    await lib.std.print(`${yellow}[RX] Command dari ${pkt.src}:${pkt.port} -> ${JSON.stringify(pkt.data)}${reset}\n`);
                }
                await new Promise((r) => setTimeout(r, 100));
            }
        };
        relayListener();

        // ── Helper: bangun payload ──
        const buildPlain = (): string => {
            const parts = sensors.map((s) => `${s.id}:${s.val.toFixed(1)}`);
            return `LANTANA|${NODE_ID}|${parts.join(";")}`;
        };

        const buildBinary = (): Buffer => {
            const nodeBuf = Buffer.from(NODE_ID, "utf8");
            const chunks: Buffer[] = [Buffer.from([0x4c, 0x01, nodeBuf.length]), nodeBuf, Buffer.from([sensors.length])];
            for (const s of sensors) {
                const sidBuf = Buffer.from(s.id, "utf8");
                const vbuf = Buffer.alloc(4);
                vbuf.writeFloatLE(s.val, 0);
                chunks.push(Buffer.from([sidBuf.length]), sidBuf, vbuf);
            }
            return Buffer.concat(chunks);
        };

        // ── Sender loop ──
        let sent = 0;
        while (COUNT === 0 || sent < COUNT) {
            // Randomize sensor value (dengan drift natural)
            for (const s of sensors) {
                const delta = Math.floor(Math.random() * 21) - 10;
                s.val = Math.max(1, Math.min(1100, s.val + delta));
            }

            if (useBinary) {
                const frame = buildBinary();
                await lib.std.print(`${cyan}[TX] ${NODE_ID} -> ${TARGET_HOST}:${TARGET_PORT} (biner ${frame.length}B)${reset}\n`);
                await lib.net.sendto(socketFd, TARGET_HOST, TARGET_PORT, frame, 0, MY_PORT);
            } else {
                const data = buildPlain();
                await lib.std.print(`${cyan}[TX] ${NODE_ID} -> ${TARGET_HOST}:${TARGET_PORT} : ${data}${reset}\n`);
                await lib.net.sendto(socketFd, TARGET_HOST, TARGET_PORT, data, 0, MY_PORT);
            }

            sent++;
            await new Promise((r) => setTimeout(r, INTERVAL_MS));
        }

        await lib.std.print(`${green}Done — ${sent} paket terkirim.${reset}\n`);
        return "";
    }
}
