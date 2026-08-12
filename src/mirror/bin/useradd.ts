import { UserLib } from "../lib/UserLib";
import * as bcrypt from "bcryptjs";

/**
 * USERADD Utility
 * 
 * Create a new user or update default new user information.
 */
export default class UserAdd {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: useradd <username>\n" +
                "Create a new system user.\n");
            return 0;
        }
        const { uid } = await lib.shell.whoami();
        if (uid !== 0) {
            return "useradd: Permission denied (must be root)\n";
        }

        if (args.length < 1) {
            return "Usage: useradd <username>\n";
        }

        const username = args[0];

        // 1. Password Prompt
        const password = await (lib.std as any).readPassword(`Enter password for ${username}: `);
        const confirm = await (lib.std as any).readPassword(`Retype password: `);

        if (password !== confirm) {
            return "useradd: Passwords do not match\n";
        }

        // Hash it
        const salt = bcrypt.genSaltSync(10);
        const hash = bcrypt.hashSync(password, salt);

        // 2. Read /etc/passwd
        let passwdContent = await lib.fs.readFile("/etc/passwd") || "";
        if (!passwdContent) {
            return "useradd: Failed to read /etc/passwd\n";
        }

        const lines = passwdContent.split("\n").filter(l => l.trim().length > 0);

        // Check if user exists
        if (lines.some(l => l.split(":")[0] === username)) {
            return `useradd: user '${username}' already exists\n`;
        }

        // Find max UID
        let maxUid = 0;
        lines.forEach(l => {
            const parts = l.split(":");
            const u = parseInt(parts[2]);
            if (!isNaN(u) && u >= maxUid) maxUid = u;
        });

        const newUid = maxUid < 1000 ? 1000 : maxUid + 1;
        const newGid = 100; // Default to 'users' group (GID 100)
        const home = `/home/${username}`;
        const shell = "/bin/tsh.ts";

        // x means password in /etc/shadow
        const newLine = `${username}:x:${newUid}:${newGid}:${username}:${home}:${shell}`;

        // 3. Write back to /etc/passwd
        const passwdSuccess = await lib.fs.writeFile("/etc/passwd", passwdContent.trim() + "\n" + newLine + "\n");
        if (!passwdSuccess) {
            return "useradd: Failed to write /etc/passwd\n";
        }

        // 4. Update /etc/shadow
        let shadowContent = await lib.fs.readFile("/etc/shadow") || "";

        const shadowLine = `${username}:${hash}:${Math.floor(Date.now() / 86400000)}:0:99999:7:::`;
        const shadowSuccess = await lib.fs.writeFile("/etc/shadow", shadowContent.trim() + "\n" + shadowLine + "\n");
        if (!shadowSuccess) {
            return "useradd: Failed to update /etc/shadow\n";
        }

        // 5. Create Home Directory
        try {
            await lib.fs.mkdir(home);
            await lib.fs.chown(home, newUid, newGid);
            await lib.fs.chmod(home, 0o700); // More private
        } catch (e) {
            // Non-fatal error
            await lib.std.print(`Warning: Could not create home directory ${home}\n`);
        }

        return `User '${username}' (UID: ${newUid}) added successfully.\n`;
    }
}
