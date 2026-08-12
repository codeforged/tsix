import { SimpleMQTNLDriver } from "../../../kernel/devices/SimpleMQTNLDriver";

async function main() {
    console.log("MQTNL Chunking Verification Tool");
    console.log("--------------------------------");

    // Address must match what's in sysconfig or just use a dummy for local test
    const broker = "mqtt://192.168.0.109";
    const myAddr = "antigonon-test"; // Use a unique one to avoid conflict

    const driver = new SimpleMQTNLDriver("test-smqtnl", broker, myAddr);

    console.log(`Connecting to ${broker} as ${myAddr}...`);

    // Give some time to connect
    await new Promise(r => setTimeout(r, 3000));

    const testPort = 9999;
    const largeDataSize = 100 * 1024; // 100KB (should trigger 4 chunks of 32KB)
    const largeData = "A".repeat(largeDataSize);

    driver.registerHandler(testPort, (packet) => {
        console.log(`\n[RCV] Received packet on port ${packet.localPort} from ${packet.src}`);
        console.log(`[RCV] Data length: ${packet.data.length} bytes`);

        if (packet.data === largeData) {
            console.log("✅ SUCCESS: Data reassembled perfectly!");
        } else {
            console.log("❌ FAILURE: Data mismatch or incomplete!");
            console.log(`Expected: ${largeDataSize}, Got: ${packet.data.length}`);
        }
        process.exit(0);
    });

    console.log(`[SEND] Sending ${largeDataSize} bytes to self (${myAddr}:${testPort})...`);
    const success = driver.send(myAddr, testPort, largeData);

    if (!success) {
        console.log("❌ Error: Failed to send packet (Broker offline?)");
        process.exit(1);
    }

    console.log("Waiting for reassembly...");

    // Safety timeout
    setTimeout(() => {
        console.log("❌ Timeout: No response received.");
        process.exit(1);
    }, 15000);
}

main().catch(err => {
    console.error("Test error:", err);
    process.exit(1);
});
