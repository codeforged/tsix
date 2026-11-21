import { UserLib } from "../../lib/UserLib";

export class main {
    private isRunning: boolean = true;

    public async execute(lib: UserLib, args: string[]) {
        const myUuid = "6e8bc0f8-c2b5-11d0-a765-00a0c91e6bf6"; // Hard-coded identity

        lib.std.print("[Listener] Registering persistent identity...\n");
        const ok = await lib.shell.registerIdentity(myUuid);
        if (ok) {
            lib.std.print(`[Listener] Identity registered: ${myUuid}\n`);
        } else {
            lib.std.print("[Listener] Warning: Failed to register identity. Maybe already in use?\n");
        }

        lib.std.print("[Listener] Starting up. My PID: " + lib.getPid() + "\n");
        lib.std.print("[Listener] Waiting for messages...\n");

        // Listen to IPC messages
        lib.onEvent("ipc_message", (msg: any) => {
            lib.std.print(`\n[IPC-RECEIVED] From PID ${msg.fromPid} (${msg.fromUser}):\n`);
            lib.std.print(` -> Content: ${JSON.stringify(msg.data)}\n`);
            lib.std.print(`root@tsix-vm:${lib.shell.getcwd()}# `); // Print prompt back
        });

        // Loop to keep app alive
        while (this.isRunning) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}
