import { Program, std, fs } from "@tsix/Application";

const AK_FILE = "/opt/esp-ota/activation-keys.txt";
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generateAK(): string {
    let result = "";
    for (let i = 0; i < 6; i++) {
        result += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
    }
    return result;
}

export const main = Program(async (args: string[]) => {
    const count = parseInt(args[0]) || 1;

    await std.print(`[AK-GEN] Generating ${count} new Activation Keys...\n`);

    // Ensure directory exists (fs.mkdir is usually recursive or handles parents in TSIX VFS)
    // For now we assume /opt/esp-ota exists or fs.appendFile handles it.
    
    let newKeys: string[] = [];
    for (let i = 0; i < count; i++) {
        newKeys.push(generateAK());
    }

    try {
        let content = "";
        try {
            const existing = await fs.readFile(AK_FILE);
            if (existing) content = existing;
        } catch (e) {}

        content += newKeys.join("\n") + "\n";
        await fs.writeFile(AK_FILE, content);

        await std.print(`[AK-GEN] Success. Keys appended to ${AK_FILE}:\n`);
        for (const k of newKeys) {
            await std.print(`  - ${k}\n`);
        }
    } catch (e: any) {
        await std.print(`[AK-GEN] ERROR: ${e.message}\n`);
    }
});
