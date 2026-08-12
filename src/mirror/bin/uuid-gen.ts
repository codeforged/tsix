import { UserLib } from "../lib/UserLib";

/**
 * UUID-GEN Utility
 * 
 * Sederhana saja, cuma buat generate UUID v4 random buat dipasang 
 * di hardcoded identity aplikasi om.
 */
export class main {
    public async execute(lib: UserLib, args: string[]) {
        // Simple UUID v4 generator
        const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });

        lib.std.print(uuid + "\n");
    }
}
