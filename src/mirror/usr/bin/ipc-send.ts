import { UserLib } from "../../lib/UserLib";

export class main {
    public async execute(lib: UserLib, args: string[]) {
        if (args.length < 2) {
            lib.std.print("Usage: ipc-send <targetPid> <message>\n");
            return;
        }

        const rawTarget = args[0];
        // Check if rawTarget is purely numeric to distinguish between PID and UUID
        const isNumeric = /^\d+$/.test(rawTarget);
        const targetPid = isNumeric ? parseInt(rawTarget) : rawTarget;
        const message = args.slice(1).join(" ");

        lib.std.print(`[Sender] Sending to ${typeof targetPid === 'string' ? 'UUID' : 'PID'} ${targetPid}: "${message}"\n`);

        try {
            const success = await lib.shell.send(targetPid, { text: message, timestamp: Date.now() });
            if (success) {
                lib.std.print("[Sender] Message sent successfully!\n");
            } else {
                lib.std.print("[Sender] Failed to send message. Target PID might not exist.\n");
            }
        } catch (e: any) {
            lib.std.print("[Sender] Error: " + e.message + "\n");
        }
    }
}
