import { UserLib } from "../lib/UserLib";

export default class Esp32Demo {
    async execute(lib: UserLib, args: string[]) {
        const white = "\x1b[97m";
        const green = "\x1b[92m";
        const cyan = "\x1b[96m";
        const magenta = "\x1b[95m";
        const reset = "\x1b[0m";

        const TARGET_HOST = "leptopus";
        const TARGET_PORT = 1000;
        const MY_PORT = 1001; // Relay listen port
        const KEY_HEX = "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";
        // Node ID unik untuk simulator ini — supaya multi-device teruji di Lantana
        const NODE_ID = args.find((a) => a.startsWith("--node="))?.split("=")[1] || "esp32-demo-01";
        // --binary → kirim frame biner Lantana (0x4C 0x01 ...)
        const useBinary = args.includes("--binary");

        await lib.std.print(`${white}Starting ESP32 Simulator (Sensynx Node: ${NODE_ID})...${reset}\n`);

        // 1. Setup Socket
        const socketFd = await lib.net.socket();
        await lib.net.bind(socketFd, MY_PORT);

        // Upgrade security for BOTH send and receive
        await lib.net.ioctl(socketFd, 0x1001, { port: MY_PORT, sessionKey: KEY_HEX });
        await lib.net.ioctl(socketFd, 0x1001, { port: TARGET_PORT, sessionKey: KEY_HEX });

        // Jika binary → aktifkan protocol biner MQTNL v1.1
        if (useBinary) {
            await lib.net.ioctl(socketFd, 0x1002, true);
        }

        const sensorIds = ["01", "02", "03", "04"];
        let sensorVals = [25, 60, 1013, 100]; // Temp, Hum, Pres, Light

        // Background listener for Relays
        const relayListener = async () => {
            while (true) {
                const pkt = await lib.net.recv(socketFd);
                if (pkt && pkt.localPort === MY_PORT) {
                    await lib.std.print(`${magenta}[HARDWARE] Received CMD: ${pkt.data}${reset}\n`);
                }
                await new Promise(r => setTimeout(r, 100));
            }
        };
        relayListener();

        // Sender Loop
        while (true) {
            // Randomize sensors
            for (let i = 0; i < sensorVals.length; i++) {
                const delta = Math.floor(Math.random() * 21) - 10;
                sensorVals[i] = Math.max(1, Math.min(1100, sensorVals[i] + delta));
            }

            if (useBinary) {
                // Frame biner Lantana: [0x4C][0x01][nodeLen][node...][cnt][sidLen][sid...][f32 value]...
                const nodeBuf = Buffer.from(NODE_ID, "utf8");
                const parts: Buffer[] = [];
                parts.push(Buffer.from([0x4c, 0x01, nodeBuf.length]));
                parts.push(nodeBuf);
                parts.push(Buffer.from([sensorIds.length]));
                for (let i = 0; i < sensorIds.length; i++) {
                    const sidBuf = Buffer.from(sensorIds[i], "utf8");
                    parts.push(Buffer.from([sidBuf.length]));
                    parts.push(sidBuf);
                    const vb = Buffer.alloc(4);
                    vb.writeFloatLE(sensorVals[i], 0);
                    parts.push(vb);
                }
                const frame = Buffer.concat(parts);
                await lib.std.print(`${cyan}[TX] Sending binary frame (${frame.length}B) for ${NODE_ID}${reset}\n`);
                await lib.net.sendto(socketFd, TARGET_HOST, TARGET_PORT, frame, 0, MY_PORT);
            } else {
                // Protokol plaintext Lantana ber-nodeId: LANTANA|<nodeId>|id:val;id:val;...
                const data = `LANTANA|${NODE_ID}|${sensorIds[0]}:${sensorVals[0]};${sensorIds[1]}:${sensorVals[1]};${sensorIds[2]}:${sensorVals[2]};${sensorIds[3]}:${sensorVals[3]}`;
                await lib.std.print(`${cyan}[TX] Sending sensor data: ${data}${reset}\n`);
                await lib.net.sendto(socketFd, TARGET_HOST, TARGET_PORT, data, 0, MY_PORT);
            }

            await new Promise(r => setTimeout(r, 5000)); // Every 5 seconds
        }
    }
}
