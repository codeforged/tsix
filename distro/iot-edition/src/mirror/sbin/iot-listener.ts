// -- 1. Buat Databasenya
// CREATE DATABASE IF NOT EXISTS antigonon_iot;
// USE antigonon_iot;
// -- 2. Buat Tabel Sensor
// CREATE TABLE IF NOT EXISTS sensor_data (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     node_id VARCHAR(50),      -- Akan berisi 'esp32S3'
//     sensor_id VARCHAR(10),    -- '01', '02', dst
//     value FLOAT,              -- Nilai sensornya
//     timestamp DATETIME,       -- Waktu pencatatan
//     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
// );
// -- 3. Cek data nanti pake ini
// -- SELECT * FROM sensor_data ORDER BY created_at DESC LIMIT 10;
import { UserLib } from "../lib/UserLib";
export default class IotListener {
    async execute(lib: UserLib, args: string[]) {
        const white = "\x1b[97m";
        const green = "\x1b[92m";
        const yellow = "\x1b[93m";
        const blue = "\x1b[94m";
        const red = "\x1b[91m";
        const reset = "\x1b[0m";

        const DB_DEVICE = "/dev/mysql";
        const SENSOR_PORT = 1000;
        const RELAY_PORT = 1001;
        const KEY_HEX = "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

        // Parse Flags
        const dbPushEnabled = args.includes("--db-push") || args.includes("-d");

        // Simulated MySQL Config
        const DB_CONFIG = {
            host: "your ip/hostname",
            user: "your db user",
            password: "your password",
            database: "your db"
        };

        // await lib.std.print(`${white}Starting IoT Listener Service (Antigonon IoT)...${reset}\n`);
        if (dbPushEnabled) {
            // await lib.std.print(`${yellow}Database Push: ENABLED${reset}\n`);
        } else {
            // await lib.std.print(`${blue}Database Push: DISABLED (Display only)${reset}\n`);
        }

        // 1. Open Database Device (Optional)
        let dbFd = -1;
        if (dbPushEnabled) {
            dbFd = await lib.fs.open(DB_DEVICE, "w");
            if (dbFd < 0) {
                return `Error: Could not open ${DB_DEVICE}. Check if MySQLDevice is loaded.\n`;
            }

            // 1.1 Connect to MySQL (Simulated)
            await lib.std.print(`${white}Connecting to MySQL at ${DB_CONFIG.host}...${reset}\n`);
            const connected = await lib.fs.ioctl(dbFd, 0x2001, DB_CONFIG);
            if (!connected) {
                return `Error: Database connection failed (Auth/Host error).\n`;
            }
            await lib.std.print(`${green}Database connected stable. Using DB: ${DB_CONFIG.database}${reset}\n`);
        }

        // 2. Setup MQTNL Socket
        const socketFd = await lib.net.socket();
        if (socketFd < 0) return "Error: Could not create socket.\n";

        // Bind to sensor port
        //const bound = await lib.net.bind(socketFd, SENSOR_PORT, "smqtnl1");
        const bound = await lib.net.bind(socketFd, SENSOR_PORT);
        if (!bound) return `Error: Could not bind to port ${SENSOR_PORT}.\n`;

        // 3. Upgrade Security to ChaCha20
        await lib.net.ioctl(socketFd, 0x1001, { port: SENSOR_PORT, sessionKey: KEY_HEX });
        // await lib.std.print(`${green}MQTNL Security Upgraded: ChaCha20-Poly1305 Active on port ${SENSOR_PORT}.${reset}\n`);

        // await lib.std.print(`${blue}Monitoring Sensors: 01 (Temp), 02 (Hum), 03 (Pres), 04 (Light)${reset}\n`);

        // Shared state for IPC
        let lastNodeId = "—";
        const sensorValues: Record<string, number> = {};
        const relayStates: Record<string, boolean> = { RELAY_1: false, RELAY_2: false };

        // IPC handler: dashboard request data
        lib.onEvent("ipc_message", (msg: any) => {
            const payload = msg?.data || msg;
            if (payload && payload.type === "GET_DATA") {
                const fromPid = payload.fromPid || msg?.fromPid;
                if (!fromPid) return;
                lib.shell.send(fromPid, {
                    type: "SENSOR_DATA",
                    nodeId: lastNodeId,
                    sensors: { ...sensorValues },
                    relays: { ...relayStates },
                    timestamp: Date.now(),
                }).catch(() => { });
            }
        });

        // Background loop
        while (true) {
            const pkt = await lib.net.recv(socketFd);
            if (pkt) {
                const data = pkt.data; // Format: 01:45;02:23;03:88;04:12
                //await lib.std.print(`${yellow}[RECV] From ${pkt.src}:${pkt.port} -> ${data}${reset}\n`);

                lastNodeId = pkt.src || lastNodeId;
                const sensors = data.split(";");
                let temp = 0;
                let light = 0;

                for (const s of sensors) {
                    const [id, valStr] = s.split(":");
                    const val = parseInt(valStr);

                    // Simpan ke shared state
                    sensorValues[id] = val;

                    // Map sensors for logic
                    if (id === "01") temp = val;
                    if (id === "04") light = val;

                    // Push to Database (Only if enabled)
                    if (dbPushEnabled && dbFd >= 0) {
                        const sql = `INSERT INTO sensor_data (node_id, sensor_id, value, timestamp) VALUES ('${pkt.src}', '${id}', ${val}, NOW())`;
                        await lib.fs.write(dbFd, sql);
                    }
                }

                // --- RELAY LOGIC ---
                const fanOn = temp > 30;
                const lampOn = light < 20;

                if (fanOn) {
                    //await lib.std.print(`${yellow}[LOGIC] Temp high (${temp}), triggering FAN ON...${reset}\n`);
                    await lib.net.sendto(socketFd, pkt.src, pkt.port, "RELAY_1:ON", 0, SENSOR_PORT);
                } else {
                    await lib.net.sendto(socketFd, pkt.src, pkt.port, "RELAY_1:OFF", 0, SENSOR_PORT);
                }
                relayStates.RELAY_1 = fanOn;

                if (lampOn) {
                    //await lib.std.print(`${yellow}[LOGIC] Low light (${light}), triggering LAMP ON...${reset}\n`);
                    await lib.net.sendto(socketFd, pkt.src, pkt.port, "RELAY_2:ON", 0, SENSOR_PORT);
                } else {
                    await lib.net.sendto(socketFd, pkt.src, pkt.port, "RELAY_2:OFF", 0, SENSOR_PORT);
                }
                relayStates.RELAY_2 = lampOn;
            }

            // Allow multitasking gap
            await new Promise(r => setTimeout(r, 100));
        }
    }
}
