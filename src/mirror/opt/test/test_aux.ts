import { Program, std, os } from "@tsix/Application";

/**
 * TEST AUX APPLICATION (v2.1)
 * 
 * Bebas mau ditaruh di folder sedalam apapun di VFS, 
 * import @tsix tetap bakal jalan om! 🚀
 */
export const main = Program(async () => {
    await std.println("--- ISOLATED AUX TEST (v2.1) ---");

    try {
        await std.println("Mengambil angka via os.rand (Explicit)...");
        const num = await os.rand.getNumber();
        const fortune = await os.rand.getFortune();

        await std.println(`Angka: ${num} | Fortune: ${fortune}`);

        if (num > 500) {
            await std.println("Wih, angkanya gede om! Hoki nih! 🔥");
        } else {
            await std.println("Angkanya kecil om, sabar ya.. ☕");
        }

    } catch (e: any) {
        await std.println(`❌ Error: ${e.message}`);
    }

    await std.println("--------------------------------");
});
