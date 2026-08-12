import { UserLib } from "@tsix/UserLib";
import { SecurityAgent } from "@common/SecurityAgent";

export default class Init {
    async execute(lib: UserLib, args: string[]) {
        const green = "\x1b[92m";
        const white = "\x1b[97m";
        const reset = "\x1b[0m";
        const ok = `${green}[  ${green}OK${green}  ]${reset} `;

        await lib.std.print(`${ok} [INIT] TSIX System Initialization sequence starting...\n`);

        // --- 1. ENFORCE PERMISSIONS ---
        try {
            await lib.std.print(`${ok} [INIT] Checking system binary security state...\n`);
            // Runtime mengeksekusi sidecar .js (bukan source .ts), jadi chmod harus di .js
            await lib.fs.chmod("/bin/passwd.js", 2541);
            await lib.std.print(`${ok} [INIT] SetUID bit applied to: /bin/passwd.js\n`);
            await lib.fs.chmod("/bin/sudo.js", 2541);
            await lib.std.print(`${ok} [INIT] SetUID bit applied to: /bin/sudo.js\n`);
            await lib.std.print(`${ok} [INIT] System binary permissions enforced.\n`);
        } catch (e: any) {
            await lib.std.print(`Init: Warning - Failed to enforce permissions: ${e.message}\n`);
        }

        await lib.std.print(`${ok} [INIT] Synchronizing terminal state with Kernel TTY subsystem...\n`);

        // --- 1.5 IDENTITY MANAGEMENT (RSA) ---
        try {
            const keyDir = "/etc/keys/rsa";
            await lib.std.print(`${ok} [INIT] Checking System Identity (RSA)...\n`);

            let keyExists = false;
            try {
                const pubKey = await lib.fs.readFile(`${keyDir}/id_rsa.pub`);
                if (pubKey) keyExists = true;
            } catch (e) { }

            if (!keyExists) {
                await lib.std.print(`${ok} [INIT] No Identity found. Generating new system RSA keys...\n`);
                const { publicKey, privateKey } = SecurityAgent.generateKeyPair();

                try { await lib.fs.mkdir("/etc/keys"); } catch (e) { }
                try { await lib.fs.mkdir("/etc/keys/rsa"); } catch (e) { }

                await lib.fs.writeFile(`${keyDir}/id_rsa.pub`, publicKey);
                await lib.fs.writeFile(`${keyDir}/id_rsa`, privateKey);
                await lib.std.print(`${ok} [INIT] System Identity created and persisted in ${keyDir}.\n`);
                await lib.std.print(`${ok} [INIT] RSA keypair generated (2048-bit).\n`);

                // Calculate and display fingerprint
                const fingerprint = await lib.shell.getFingerprint();
                if (fingerprint) {
                    const shortFp = fingerprint.substring(0, 16) + "...";
                    await lib.std.print(`${ok} [INIT] Fingerprint: ${shortFp} (SHA256).\n`);
                    const colorBar = SecurityAgent.generateVisualIdentity(fingerprint);
                    await lib.std.ioctl(1, 33, colorBar); // SET_VISUAL_IDENTITY
                }
            } else {
                await lib.std.print(`${ok} [INIT] System Identity verified.\n`);

                // Display fingerprint for existing keys
                const fingerprint = await lib.shell.getFingerprint();
                if (fingerprint) {
                    const shortFp = fingerprint.substring(0, 16) + "...";
                    await lib.std.print(`${ok} [INIT] Fingerprint: ${shortFp} (SHA256).\n`);
                    const colorBar = SecurityAgent.generateVisualIdentity(fingerprint);
                    await lib.std.ioctl(1, 33, colorBar); // SET_VISUAL_IDENTITY
                }
                await lib.std.print(`${ok} [INIT] Cryptographic subsystem ready (RSA-2048 + ChaCha20-Poly1305).\n`);
            }
        } catch (e: any) {
            await lib.std.print(`Init: Warning - Identity management failed: ${e.message}\n`);
        }

        await lib.std.print(`${ok} [INIT] Entering runlevel 3 (Multi-User Mode).\n`);
        await lib.std.print(`${ok} [INIT] Initializing system services...\n`);

        // --- 1.7 EXECUTE RC.LOCAL (STARTUP SCRIPTS) ---
        // Safe Mode (`npm start -- --safe-mode`): kernel menyetel env TSIX_SAFE_MODE=1
        // → startup scripts (rc.local) dinonaktifkan untuk troubleshooting.
        const safeMode = (await lib.shell.getenv("TSIX_SAFE_MODE")) === "1";
        if (safeMode) {
            await lib.std.print(`${ok} [INIT] SAFE MODE active — skipping /etc/rc.local (startup daemons disabled).\n`);
        } else {
            try {
                const rcLocalPath = "/etc/rc.local.js";
                let rcLocalExists = false;
                try {
                    const content = await lib.fs.readFile(rcLocalPath);
                    if (content) rcLocalExists = true;
                } catch (e) { }

                if (rcLocalExists) {
                    await lib.std.print(`${ok} [INIT] Executing startup scripts (/etc/rc.local)...\n`);
                    const result = await lib.shell.exec(rcLocalPath, [], undefined, undefined, undefined);
                    if (result) {
                        // Wait for rc.local to complete
                        const exitCode = await lib.shell.waitpid(result.pid);
                        if (exitCode === 0) {
                            await lib.std.print(`${ok} [INIT] Startup scripts completed successfully.\n`);
                        } else {
                            await lib.std.print(`Init: Warning - rc.local exited with code ${exitCode}\n`);
                        }
                    }
                } else {
                    await lib.std.print(`${ok} [INIT] No startup scripts found (skipping /etc/rc.local).\n`);
                }
            } catch (e: any) {
                await lib.std.print(`Init: Warning - Failed to execute rc.local: ${e.message}\n`);
            }
        }



        // --- 2. MANAGED TERMINAL SERVICES ---
        // Kita simpan daftar PID login yang sedang jalan di tiap TTY
        const terminals: Map<number, number> = new Map();

        const spawnLogin = async (ttyId: number) => {
            try {
                if (ttyId > 1)
                    await lib.std.print(`${ok} Initializing session on TTY${ttyId}...\n`);
                const result = await lib.shell.exec("/bin/login.js", [], undefined, undefined, ttyId);
                if (result && result.pid) {
                    terminals.set(ttyId, result.pid);
                    await lib.std.log(`Login service spawned on TTY${ttyId} (PID ${result.pid})`, "init");
                    // Kita nungguin di background (thread terpisah di Worker)
                    this.monitorProcess(lib, ttyId, result.pid, spawnLogin);
                }
            } catch (e: any) {
                await lib.std.print(`Init: Error spawning login on TTY${ttyId}: ${e.message}\n`);
            }
        };
        // Start login on all TTYs
        await lib.std.print(`${ok} Init: Starting multi-terminal login services (TTY2-6)...\n`);
        for (let i = 2; i <= 6; i++) {
            await spawnLogin(i);
        }
        await lib.std.print(`${ok} Init: All terminal services are now online and monitored.\n`);
        await lib.std.print(`${ok} System enters runlevel 3 (Multi-User Mode).\n\n`);

        const banner = `
   __       _     
  / /______(_)  __
 / __/ ___/ / |/_/
/ /_(__  ) />  <  
\\__/____/_/_/|_|  
            `;
        await lib.std.print("\x1b[32m" + banner + "\x1b[0m\n");

        // Display visual fingerprint color bar
        const fingerprint = await lib.shell.getFingerprint();
        if (fingerprint) {
            const colorBar = SecurityAgent.generateVisualIdentity(fingerprint);
            await lib.std.print(colorBar + "\n\n");
        }

        lib.std.print("\n");
        await spawnLogin(1);

        // Init process must never exit
        while (true) {
            await new Promise(r => setTimeout(r, 10000));
        }
    }

    private async monitorProcess(lib: UserLib, ttyId: number, pid: number, respawn: (tty: number) => Promise<void>) {
        const exitCode = await lib.shell.waitpid(pid);
        await lib.std.print(`Init: Process on TTY${ttyId} (PID ${pid}) exited with code ${exitCode}. Respawning...\n`);
        await new Promise(r => setTimeout(r, 1000)); // Delay sedikit biar nggak spam kalau crash loop
        await respawn(ttyId);
    }
}
