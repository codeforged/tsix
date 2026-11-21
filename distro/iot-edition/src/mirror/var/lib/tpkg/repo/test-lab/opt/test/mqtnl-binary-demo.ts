import { UserLib } from "../../lib/UserLib";

/**
 * MQTNL BINARY DEMO (Server-Side Style)
 * 
 * Aplikasi demo yang mensimulasikan Server (Listener) dan Client (Sender).
 * Menggunakan pola request-response seperti otad.ts untuk menangani
 * trafik MQTNL biner dari ESP8266/32.
 */
export default class MQTNLBinaryDemo {
    async execute(lib: UserLib, args: string[]) {
        const white = "\x1b[97m";
        const green = "\x1b[92m";
        const yellow = "\x1b[93m";
        const blue = "\x1b[94m";
        const red = "\x1b[91m";
        const reset = "\x1b[0m";

        const SERVER_PORT = 2000;
        const TARGET_ADDR = "antigonon"; // Alamat simpul (node) tujuan
        const SESSION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

        await lib.std.print(`${white}=== MQTNL Binary Server-Client Demo ===${reset}\n`);

        // 1. Setup Socket (Server/Listener)
        const socketFd = await lib.net.socket();
        if (socketFd < 0) return "Error: Gagal membuat socket MQTNL.\n";

        await lib.net.bind(socketFd, SERVER_PORT);
        
        // 2. Upgrade Security (ChaCha20)
        // Kita upgrade port SERVER_PORT supaya baik pengiriman maupun penerimaan di port ini terenkripsi.
        await lib.net.ioctl(socketFd, 0x1001, { port: SERVER_PORT, sessionKey: SESSION_KEY });
        
        // 3. Set Binary Mode (Default untuk demo ini)
        // Jalur khusus mqtnl@1.1/ sudah otomatis aktif di driver saat mode biner menyala.
        await lib.net.ioctl(socketFd, 0x1002, true);

        await lib.std.print(`${green}[SERVER] Listening on MQTNL Port ${SERVER_PORT} (Binary Mode)${reset}\n`);

        // --- LISTENER LOOP (Background) ---
        const startListener = async () => {
            while (true) {
                const pkt = await lib.net.recv(socketFd);
                if (pkt) {
                    await lib.std.print(`\n${yellow}[RECV] From ${pkt.src}:${pkt.port} -> Local Port: ${pkt.localPort}${reset}\n`);
                    
                    // Parse data jika string (agar bisa akses .cmd)
                    let data = pkt.data;
                    if (typeof data === "string") {
                        try { data = JSON.parse(data); } catch(e) {}
                    }

                    const displayData = typeof data === "string" ? data : JSON.stringify(data, null, 2);
                    await lib.std.print(`${white}Data Received: ${displayData}${reset}\n`);

                    // 1. SERVER LOGIC: Jika menerima request 'ota.check', kirim balasan
                    if (data && data.cmd === "ota.check") {
                        const res = { cmd: "ota.res", status: "UPDATE_AVAILABLE", ver: "1.1.2-BIN" };
                        await lib.std.print(`${blue}[SERVER REPLY] Sending update info back to ${pkt.src}...${reset}\n`);
                        await lib.net.sendto(socketFd, pkt.src, pkt.port, res, 0, SERVER_PORT);
                    }
                    
                    // 2. CLIENT LOGIC: Jika menerima balasan 'ota.res'
                    if (data && data.cmd === "ota.res") {
                        await lib.std.print(`${green}[CLIENT RECV] Got response from Server: ${data.status} (Ver: ${data.ver})${reset}\n`);
                        await lib.std.print(`\n${green}SUCCESS: Two-way Binary Communication via Port ${SERVER_PORT} Verified!${reset}\n`);
                    }
                }
                await new Promise(r => setTimeout(r, 100));
            }
        };

        // Jalankan listener di background
        startListener();

        // --- SENDER TRIGGER (Simulasi ESP) ---
        await lib.std.print(`${blue}[CLIENT] Simulating ESP Update Request in 3 seconds...${reset}\n`);
        
        setTimeout(async () => {
            const req = { cmd: "ota.check", mac: "AA:BB:CC:DD:EE:FF", current_ver: "1.0.0" };
            await lib.std.print(`${cyan}[CLIENT SEND] Sending request from port ${SERVER_PORT} (Encrypted Binary)...${reset}\n`);
            
            // Kita kirim ke diri sendiri menggunakan port 2000 sebagai source
            await lib.net.sendto(socketFd, TARGET_ADDR, SERVER_PORT, req, 0, SERVER_PORT);
        }, 3000);

        await lib.std.print(`${white}Aplikasi berjalan. Tunggu sejenak untuk interaksi...${reset}\n`);
        
        // Tunggu bentar buat liat hasil di TTY
        await new Promise(r => setTimeout(r, 15000));

        return "Demo Finished\n";
    }
}

const cyan = "\x1b[96m";
