import { UserLib } from "../lib/UserLib";
import * as bcrypt from "bcryptjs";

export default class Login {
    /**
     * Batas percobaan login per proses. Setelah itu login keluar: di konsol
     * init men-spawn ulang (seperti getty di Unix), di sesi tssh koneksi putus.
     * Tanpa batas ini password bisa ditebak tanpa henti lewat tssh.
     */
    static readonly MAX_ATTEMPTS = 5;
    /** Jeda setelah percobaan gagal (ms), memperlambat tebakan beruntun. */
    failDelayMs = 2000;
    /** Password root bawaan checkout repo (`src/mirror/etc/shadow`), diketahui publik. */
    static readonly DEFAULT_ROOT_PASSWORD = "root";

    async execute(lib: UserLib, args: string[]) {
        // --- MODE VERIFY-ONLY (dipakai GUI login: Asteracea & Krisan) ---
        // Setelah WM login sekali sebagai user non-root, WM kehilangan hak baca
        // /etc/shadow (0640 root). Karena /bin/login.js SetUID root, verifikasi
        // password lewat sini — selalu bisa baca shadow walau dipanggil WM non-root.
        // Penggunaan: login.js --verify <username> <password> <resultFile>
        //   Result ditulis ke <resultFile>: "OK" / "FAIL:<pesan>".
        //   (Kanal file dipilih karena exit code anak tidak andal — WorkerEntry
        //   selalu menuntaskan dengan exit(0).)
        if (args && args[0] === "--verify") {
            const vUser = (args[1] || "").trim();
            const vPass = args[2] || "";
            const vOut = args[3] || "/tmp/verify-result.txt";
            let ok = false;
            let errMsg = "";
            try {
                const vShadow = (await lib.fs.readFile("/etc/shadow")) || "";
                const vLines = vShadow.split("\n").map(l => l.trim()).filter(l => l.length > 0);
                const vEntry = vLines.find(l => l.split(":")[0] === vUser);
                const vHash = vEntry ? vEntry.split(":")[1] : "";
                if (!vHash) {
                    errMsg = "account not found or no password";
                } else {
                    ok = bcrypt.compareSync(vPass, vHash);
                    if (!ok) errMsg = "password mismatch";
                }
            } catch (e: any) {
                errMsg = e.message || "verify error";
            }
            try {
                await lib.fs.writeFile(vOut, ok ? "OK" : "FAIL:" + errMsg);
            } catch (_) {
                /* tulis gagal — WM akan lihat file tidak ada → gagal login */
            }
            return; // selesai — biar WorkerEntry yang menuntaskan proses
        }

        let shuttingDown = false;
        await lib.shell.onSignal("SIGTERM", () => {
            shuttingDown = true;
        });

        if (shuttingDown) return;

        // `--remote`: login di-spawn daemon jarak jauh (tsshd). Flag ini dibuang
        // dari args supaya tidak dianggap username.
        const remote = !!args && args[0] === "--remote";
        if (remote) args = args.slice(1);

        let failures = 0;
        const failed = async (msg: string): Promise<boolean> => {
            await lib.std.print(msg);
            failures++;
            if (this.failDelayMs > 0) await new Promise(r => setTimeout(r, this.failDelayMs));
            if (failures >= Login.MAX_ATTEMPTS) {
                await lib.std.print("Login: Too many failed attempts\n");
                return true; // berhenti
            }
            return false;
        };

        try {
            while (true) {
                // Accept username from args or prompt
                let username = args && args.length > 0 ? args[0].trim() : "";
                if (!username) {
                    await lib.std.print("Username: ");
                    username = await lib.std.readLine();
                }
                if (username === null) break; // EOF

                const password = await (lib.std as any).readPassword("Password:🔑");

                // 1. Look up user in /etc/passwd to get UID/GID and Shell
                let passwdContent = "";
                try {
                    passwdContent = await lib.fs.readFile("/etc/passwd") || "";
                } catch (e) {
                    await lib.std.print("Login: System error (passwd missing)\n");
                    return;
                }

                const lines = passwdContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);
                const userEntry = lines.find(l => l.split(":")[0] === username.trim());
                if (!userEntry) {
                    if (await failed("Login: Invalid username or password\n")) return;
                    continue;
                }

                const parts = userEntry.split(":");
                const uid = parseInt(parts[2]);
                const gid = parseInt(parts[3]);
                const home = parts[5];
                const userShell = parts[6];

                // 2. Verify Password against /etc/shadow
                let shadowContent = "";
                try {
                    shadowContent = await lib.fs.readFile("/etc/shadow") || "";
                } catch (e) {
                    await lib.std.print("Login: System error (shadow missing)\n");
                    return;
                }

                const shadowLines = shadowContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);
                const shadowEntry = shadowLines.find(l => l.split(":")[0] === username.trim());
                if (!shadowEntry) {
                    if (await failed("Login: Account disabled or no password set\n")) return;
                    continue;
                }

                const hash = shadowEntry.split(":")[1];

                const match = bcrypt.compareSync(password, hash);
                if (!match) {
                    if (await failed("Login: Invalid username or password\n")) return;
                    continue;
                }

                // Password bawaan root (`root`) diketahui publik. Dari jarak jauh
                // ditolak; di konsol boleh, tapi diingatkan untuk diganti.
                const defaultRoot = uid === 0 && password === Login.DEFAULT_ROOT_PASSWORD;
                if (defaultRoot && remote) {
                    if (await failed(
                        "Login: Remote root login with the default password is disabled.\n" +
                        "       Change it first with `passwd` on the node's console.\n",
                    )) return;
                    continue;
                }

                // 3. SUCCESS! Setup session
                await lib.std.print(`\nWelcome to TSIX, ${username}!\n`);
                if (defaultRoot) {
                    await lib.std.print(
                        "\x1b[1;33m⚠️  root is still using the default password. Change it now with `passwd`.\x1b[0m\n",
                    );
                }

                // 3.1 Display MOTD (ASCII Banner & Random Phrase)
                try {
                    const banner = await lib.fs.readFile("/etc/motd");
                    if (banner) await lib.std.print(banner + "\n");

                    const phrasesJson = await lib.fs.readFile("/etc/motd.json");
                    if (phrasesJson) {
                        const phrases = JSON.parse(phrasesJson);
                        if (Array.isArray(phrases) && phrases.length > 0) {
                            const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];
                            await lib.std.print(`${randomPhrase}\n\n`);
                        }
                    }
                } catch (e) { }

                // 3.5. Resolve Supplementary Groups from /etc/group
                const supplementaryGids: number[] = [gid]; // Start with primary gid
                try {
                    const groupContent = await lib.fs.readFile("/etc/group") || "";
                    const groupLines = groupContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);
                    for (const gLine of groupLines) {
                        const gParts = gLine.split(":");
                        const groupGid = parseInt(gParts[2]);
                        const groupUsers = gParts[3] ? gParts[3].split(",") : [];
                        if (groupUsers.includes(username.trim()) && groupGid !== gid) {
                            supplementaryGids.push(groupGid);
                        }
                    }
                } catch (e) {
                    // Ignore group errors
                }

                // Set Identity - GID must come BEFORE UID
                // Once UID is changed to non-root, the process loses privilege to change GID.
                await lib.shell.setgroups(supplementaryGids);
                await lib.shell.setgid(gid);
                await lib.shell.setuid(uid);

                // Set Env
                await lib.shell.setenv("USER", username.trim());
                await lib.shell.setenv("HOME", home);
                await lib.shell.chdir(home);

                // 4. Exec Shell
                const result = await lib.shell.exec(userShell);
                if (result && result.pid) {
                    await lib.std.log(`Shell spawned for user ${username.trim()} (UID ${uid}, PID ${result.pid})`, "login");
                    // Wait for shell to exit
                    await lib.shell.waitpid(result.pid);
                }
                break; // Exit after one session
            }
        } catch (e: any) {
            await lib.std.print(`Login Crashed: ${e.message}\n`);
        }
    }
}
