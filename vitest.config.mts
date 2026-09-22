import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Konfigurasi Vitest
 *
 * KENAPA ADA: sebagian modul userland memakai alias import (`@common/*`,
 * `@tsix/*`) karena di RUNTIME alias itu yang diterjemahkan loader VFS
 * (`WorkerEntry` → `/lib/common`, `/lib`). Vitest tidak membaca `paths` dari
 * `tsconfig.json` secara otomatis, jadi tanpa alias di sini suite yang mengimpor
 * modul ber-alias gagal di level file ("Cannot find package '@common/...'") —
 * bukan karena kodenya salah, tapi karena resolusi modul test.
 *
 * Peta alias sengaja SAMA dengan `tsconfig.json` supaya kode tidak perlu
 * "dibengkokkan" demi test.
 *
 * Tidak ada efek runtime: file ini hanya dibaca oleh vitest.
 */
const abs = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    test: {
        // Default 5s terlalu ketat: sebagian test melakukan kriptografi nyata
        // (generate RSA 2048-bit, `SecurityAgent.generateKeyPair`) dan saat
        // seluruh suite berjalan paralel CPU rebutan → test yang benar jadi
        // timeout alias flaky. 20s masih ketat untuk mendeteksi hang nyata.
        testTimeout: 20_000,
    },
    resolve: {
        // URUTAN PENTING: `.ts` didahulukan dari `.js` supaya sidecar hasil
        // transpile yang ada di repo (mis. `lib/NetworkLib.js`, `lib/UserLib.js`)
        // TIDAK menang atas sumber aslinya. Sidecar itu `require` relatif ke
        // `../../common/*` yang hanya ada sebagai `.ts`, sehingga memuatnya
        // membuat suite gagal di level file.
        extensions: [".ts", ".mts", ".tsx", ".js", ".mjs", ".jsx", ".json"],
        alias: {
            "@common": abs("./src/common"),
            "@userland": abs("./src/userland"),
            "@tsix": abs("./src/mirror/lib"),
            "@bin": abs("./src/mirror/bin"),
        },
    },
});
