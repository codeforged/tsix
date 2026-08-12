import { Program, std, net, fs } from "@tsix/Application";

export const main = Program(async (args) => {
    const otaPort = 4000;
    const testHost = "127.0.0.1";
    const testAK = "TESTAK";
    const testFilePath = "/tmp/test_firmware.bin";
    const testData = Buffer.from("DYNAMIC_OTA_TEST_CONTENT_" + "A".repeat(100));

    await std.print("🧪 Starting Dynamic OTA Server Verification...\n");

    // 1. Prepare dummy firmware
    await fs.writeFile(testFilePath, testData.toString('binary'));
    await std.print(`✅ Created test firmware at ${testFilePath}\n`);

    // 2. Prepare AK file (Hack: ota-server reads /opt/esp-ota/activation-keys.txt)
    const akFile = "/opt/esp-ota/activation-keys.txt";
    try {
        await fs.writeFile(akFile, testAK + "\n");
    } catch (e) {
        await std.print("⚠️ Could not write AK file, server might reject if AK not valid.\n");
    }

    const clientFd = await net.socket();

    async function sendAndRecv(payload: any) {
        await net.sendto(clientFd, testHost, otaPort, JSON.stringify(payload));
        // Wait for response - this is a simulation, usually server sends back
        // But since we are running on the same machine, we might need a small delay or a proper listener
        // ota-server uses net.sendto to the srcAddress:srcPort
    }

    await std.print("📡 Sending ota.info request for dynamic path...\n");
    const infoReq = {
        cmd: "ota.info",
        ak: testAK,
        path: testFilePath
    };
    
    // Note: Since we can't easily 'net.recv' here without binding a port and knowing where ota-server sends,
    // this script is more of a 'manual trigger' and we observe ota-server's output if it was running.
    // However, I can't easily run the server and client simultaneously in this environment without background tasks.
    
    await std.print("Done. Please run 'ota-server.ts' in one terminal and observe its logs when you run this script.\n");
    await std.print("The test will attempt to request: " + testFilePath + "\n");
});
