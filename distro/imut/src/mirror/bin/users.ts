import { UserLib } from "../lib/UserLib";

/**
 * USERS Utility
 * 
 * Print the user names of users currently logged in to the host.
 * (In this system, it lists all users in /etc/passwd).
 */
export default class Users {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: users\nPrint names of system users.\n");
            return 0;
        }
        try {
            const fd = await lib.fs.open("/etc/passwd");
            const content = await lib.fs.read(fd);
            await lib.fs.close(fd);

            const usernames = content
                .split("\n")
                .filter((l: string) => l.trim().length > 0)
                .map((l: string) => l.split(":")[0]);

            return usernames.join("  ") + "\n";
        } catch (e) {
            return "users: Failed to read /etc/passwd\n";
        }
    }
}
