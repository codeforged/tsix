import { Program, std, fs } from "@tsix/Application";
import { generateActivationKey } from "@tsix/ota-access";

const AK_FILE = "/opt/esp-ota/activation-keys.txt";

export const main = Program(async (args: string[]) => {
    const count = Math.min(Math.max(parseInt(args[0]) || 1, 1), 1000);

    await std.print(`[AK-GEN] Generating ${count} new Activation Keys...\n`);

    // Ensure directory exists (fs.mkdir is usually recursive or handles parents in TSIX VFS)
    // For now we assume /opt/esp-ota exists or fs.appendFile handles it.

    // AK dari crypto.randomInt (bukan Math.random): AK adalah satu-satunya
    // syarat untuk mengunduh firmware dari otad (SEC-29).
    let newKeys: string[] = [];
    for (let i = 0; i < count; i++) {
        newKeys.push(generateActivationKey());
    }

    try {
        let content = "";
        try {
            const existing = await fs.readFile(AK_FILE);
            if (existing) content = existing;
        } catch (e) {}

        content += newKeys.join("\n") + "\n";
        await fs.writeFile(AK_FILE, content);
        // Daftar AK hanya untuk root (otad berjalan sebagai root).
        await fs.chmod(AK_FILE, 0o600).catch(() => false);

        await std.print(`[AK-GEN] Success. Keys appended to ${AK_FILE}:\n`);
        for (const k of newKeys) {
            await std.print(`  - ${k}\n`);
        }
    } catch (e: any) {
        await std.print(`[AK-GEN] ERROR: ${e.message}\n`);
    }
});
