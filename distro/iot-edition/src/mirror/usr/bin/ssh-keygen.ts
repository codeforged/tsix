import { UserLib } from "../../lib/UserLib";
import { SecurityAgent } from "@common/SecurityAgent";

export default class SshKeygen {
    async execute(lib: UserLib, args: string[]) {
        const green = "\x1b[92m";
        const white = "\x1b[97m";
        const red = "\x1b[91m";
        const reset = "\x1b[0m";

        // 1. Check Permissions
        const { uid } = await lib.shell.whoami();
        if (uid !== 0) {
            return `${red}ssh-keygen: Permission denied (must be root)${reset}\n`;
        }

        const keyDir = "/etc/keys/rsa";
        const pubPath = `${keyDir}/id_rsa.pub`;
        const privPath = `${keyDir}/id_rsa`;

        // 2. Check for existing keys
        let keyExists = false;
        try {
            const pubKey = await lib.fs.readFile(pubPath);
            if (pubKey) keyExists = true;
        } catch (e) { }

        if (keyExists) {
            await lib.std.print(`${white}System already has an RSA identity in ${keyDir}.${reset}\n`);
            await lib.std.print(`${white}Do you want to overwrite it? (y/n): ${reset}`);
            const confirm = await lib.std.readLine();
            if (confirm?.toLowerCase() !== "y") {
                return "Aborted.\n";
            }
        }

        await lib.std.print(`${white}Generating new RSA key pair (2048-bit)...${reset}\n`);

        try {
            const { publicKey, privateKey } = SecurityAgent.generateKeyPair();

            // Ensure directory exists
            try { await lib.fs.mkdir("/etc/keys"); } catch (e) { }
            try { await lib.fs.mkdir("/etc/keys/rsa"); } catch (e) { }

            // Save keys
            await lib.fs.writeFile(pubPath, publicKey);
            await lib.fs.writeFile(privPath, privateKey);

            await lib.std.print(`${green}Keys successfully saved to ${keyDir}.${reset}\n`);

            // Calculate and display fingerprint
            const fingerprint = await lib.shell.getFingerprint();
            if (fingerprint) {
                await lib.std.print(`${white}Your identification has been saved in ${privPath}.${reset}\n`);
                await lib.std.print(`${white}Your public key has been saved in ${pubPath}.${reset}\n`);
                await lib.std.print(`${white}The key fingerprint is:${reset}\n`);
                await lib.std.print(`${white}SHA256:${fingerprint}${reset}\n`);
            }

            return "";
        } catch (error: any) {
            return `${red}ssh-keygen: Error generating keys: ${error.message}${reset}\n`;
        }
    }
}
