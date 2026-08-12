
import { UserLib } from "../../lib/UserLib";
export class Main {
    async execute(lib: UserLib, args: string[]) {
        await lib.std.print("Hello from a package installed via TPKG! 📦\n");
    }
}
        