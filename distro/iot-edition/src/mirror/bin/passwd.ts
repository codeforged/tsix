import { UserLib } from "../lib/UserLib";
import * as bcrypt from "bcryptjs";

/**
 * PASSWD Utility
 * 
 * Change user password.
 */
export default class Passwd {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: passwd [user]\n" +
                "Change password for user (default: current user).\n");
            return 0;
        }
        const { uid, ruid, username: effectiveUser } = await lib.shell.whoami();

        // 1. Resolve calling username from RUID
        const passwdContent = await lib.fs.readFile("/etc/passwd") || "";
        const passwdLines = passwdContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);

        let callerUsername = effectiveUser;
        if (ruid !== 0) {
            const callerEntry = passwdLines.find(l => parseInt(l.split(":")[2]) === ruid);
            if (callerEntry) {
                callerUsername = callerEntry.split(":")[0].trim();
            }
        }

        let targetUser = (args[0] || callerUsername).trim();

        // 2. Permission Check
        if (targetUser !== callerUsername && ruid !== 0) {
            await lib.std.print("passwd: You may only change your own password.\n");
            return 1;
        }

        // 3. Load /etc/shadow
        const shadowContent = await lib.fs.readFile("/etc/shadow");
        if (!shadowContent) {
            await lib.std.print("passwd: Error reading /etc/shadow\n");
            return 1;
        }

        const lines = shadowContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);
        const userLineIndex = lines.findIndex(l => l.startsWith(targetUser + ":"));

        if (userLineIndex === -1) {
            await lib.std.print(`passwd: User '${targetUser}' not found in /etc/shadow\n`);
            return 1;
        }

        const userParts = lines[userLineIndex].split(":");
        const oldHash = userParts[1];

        // 4. Verify Old Password (unless root is changing another user's password)
        if (ruid !== 0 || targetUser === callerUsername) {
            await lib.std.print(`Changing password for ${targetUser}.\n`);
            const oldPass = await lib.std.readPassword("(current) UNIX password: ");

            if (!bcrypt.compareSync(oldPass, oldHash)) {
                await lib.std.print("passwd: Authentication token manipulation error\n");
                return 1;
            }
        } else {
            await lib.std.print(`Changing password for ${targetUser} (as root).\n`);
        }

        // 4. Prompt for New Password
        let newPass = "";
        let confirmPass = "";

        while (true) {
            newPass = await lib.std.readPassword("Enter new UNIX password: ");

            if (newPass.length < 1) {
                await lib.std.print("Password cannot be empty.\n");
                continue;
            }

            confirmPass = await lib.std.readPassword("Retype new UNIX password: ");

            if (newPass !== confirmPass) {
                await lib.std.print("Passwords do not match. Try again.\n");
                continue;
            }
            break;
        }

        // 5. Update /etc/shadow
        const salt = bcrypt.genSaltSync(10);
        const newHash = bcrypt.hashSync(newPass, salt);
        userParts[1] = newHash;
        lines[userLineIndex] = userParts.join(":");

        const newShadowContent = lines.join("\n") + "\n";
        const success = await lib.fs.writeFile("/etc/shadow", newShadowContent);

        if (success) {
            await lib.std.print("passwd: password updated successfully\n");
            return 0;
        } else {
            await lib.std.print("passwd: error writing to /etc/shadow\n");
            return 1;
        }
    }
}
