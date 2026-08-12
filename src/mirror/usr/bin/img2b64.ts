import { Program, std, fs } from "@tsix/Application";

/**
 * IMG2B64 — Convert PNG/JPG to base64 .b64 file for PixelSpace wallpaper
 * 
 * Usage:
 *   img2b64 <source> [output]
 *   
 * Semua operasi di dalam VFS TSIX — gak sentuh host filesystem.
 */
export const main = Program(async (args: string[]) => {
    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
        await std.println("Usage: img2b64 <source> [output]");
        await std.println("  source   VFS path ke PNG/JPG");
        await std.println("  output   VFS path .b64 (default: <source>.b64)");
        await std.println("Contoh:");
        await std.println("  img2b64 /mnt/shared/foto.jpg");
        await std.println("  img2b64 /mnt/shared/bg.png /opt/krisan/wallpaper/krisan.b64");
        return;
    }

    const src = args[0];
    const dst = args[1] || src + ".b64";

    try {
        // Baca binary dari VFS → string (latin1 encoding)
        const raw = await fs.readFile(src);
        if (!raw) {
            await std.println(`[img2b64] ❌ Cannot read: ${src}`);
            return;
        }

        // Convert ke base64 via Node.js Buffer
        const b64 = Buffer.from(raw, "latin1").toString("base64");

        // Tulis .b64 ke VFS
        await fs.writeFile(dst, b64);
        await std.println(`[img2b64] ✅ ${dst} (${(b64.length / 1024).toFixed(0)} KB)`);
    } catch (e: any) {
        await std.println(`[img2b64] ❌ ${e.message}`);
    }
});
