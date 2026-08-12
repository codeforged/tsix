import { IProgram, OSContext } from "../../lib/IProgram";
import { NetworkLib } from "../../lib/NetworkLib";

export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std } = os;
        const net = new NetworkLib(os);

        await std.print("Testing Multi-Interface Selection...\n");

        // Test 1: Default Bind (should be smqtnl0 / tsix-node-1)
        const fd1 = await net.socket();
        await net.bind(fd1, 20001);
        await std.print(`[FD=${fd1}] Bound to default interface.\n`);

        // Test 2: Specific Bind to smqtnl1 (tsix-node-2)
        const fd2 = await net.socket();
        // Assuming tsix-node-2 is the address for smqtnl1 defined in config
        const targetAddress = "tsix-node-2";
        await net.bind(fd2, 20002, targetAddress);
        await std.print(`[FD=${fd2}] Bound to ${targetAddress}.\n`);

        await std.print("Checking netstat...\n");
        const interfaces = await net.netstat();
        for (const iface of interfaces) {
            await std.print(`Interface: ${iface.interface} (${iface.address}) - Broker: ${iface.broker}\n`);
        }

        await std.print("Test Complete.\n");
    }
}
