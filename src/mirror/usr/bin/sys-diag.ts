import { Program, std, fs, shell, os } from "@tsix/Application";

/**
 * SYS-DIAG Utility
 * 
 * System diagnostic tool for TSIX. Check system health and integrity.
 */
export const main = Program(async (args) => {
    if (args.includes("--help") || args.includes("-h")) {
        await std.print("Usage: sys-diag\nRun system integrity diagnostics.\n");
        return;
    }
    await std.println("==================================================");
    await std.println("          TSIX SYSTEM DIAGNOSTIC TOOL             ");
    await std.println("==================================================\n");

    // 1. Basic System info via uname syscall
    const uname = await std.uname();
    await std.println("--- System Information ---");
    await std.println(`  Architecture : ${uname.machine}`);
    await std.println(`  Kernel Vers  : ${uname.version}`);
    await std.println(`  Codename     : ${uname.codename}`);
    await std.println(`  Runtime      : ${uname.runtime}`);
    await std.println(`  Engine       : ${uname.engine}`);
    await std.println(`  Distro       : ${uname.distroname}`);
    await std.println(`  Current PID  : ${os.pid}`);
    await std.println("");

    // 2. Identity Info via whoami
    const user = await shell.whoami();
    await std.println("--- Identity ---");
    await std.println(`  User         : ${user.username}`);
    await std.println(`  UID / GID    : ${user.uid} / ${user.gid}`);
    await std.println(`  RUID         : ${user.ruid}`);
    await std.println(`  Groups       : ${user.groups.join(", ")}`);
    await std.println("");

    // 3. Environment Variables
    await std.println("--- Environment Variables ---");
    const envVars = ["PATH", "HOME", "SHELL", "USER", "HOSTNAME", "TERM", "COLUMNS", "LINES"];
    for (const v of envVars) {
        const val = await shell.getenv(v);
        await std.println(`  ${v.padEnd(12)}: ${val || "(not set)"}`);
    }
    await std.println("");

    // 4. File System Integrity (/bin)
    await std.println("--- Binary Integrity (/bin) ---");
    const testBins = ["ls.ts", "ls.js", "tsh.ts", "tsh.js"];
    for (const b of testBins) {
        try {
            const stat = await fs.stat(`/bin/${b}`);
            if (stat) {
                const modeStr = "0" + stat.mode.toString(8);
                const content = await fs.readFile(`/bin/${b}`);
                const preview = content ? content.substring(0, 60).replace(/\n/g, "\\n") : "(empty)";
                await std.println(`  ${b.padEnd(10)}: Size=${stat.size.toString().padEnd(6)} Mode=${modeStr} Preview: ${preview}...`);
            } else {
                await std.println(`  ${b.padEnd(10)}: MISSING`);
            }
        } catch (e: any) {
            await std.println(`  ${b.padEnd(10)}: ERROR (${e.message})`);
        }
    }
    await std.println("");

    // 5. Functional Tests
    await std.println("--- Functional tests ---");

    // Test A: Direct LS syscall
    await std.print("  [TEST] Direct fs.ls('/') check: ");
    try {
        const rootItems = await fs.ls("/");
        if (Array.isArray(rootItems)) {
            await std.println(`OK (Found ${rootItems.length} items)`);
        } else {
            await std.println("FAILED (Not an array)");
        }
    } catch (e: any) {
        await std.println(`FAILED (${e.message})`);
    }

    // Test B: Shell execution of ls (compiled)
    await std.print("  [TEST] shell.exec('ls') result: ");
    try {
        const result = await shell.exec("ls", []);
        if (typeof result === "string") {
            if ((result as string).length === 0) {
                await std.println("EMPTY (Success code but no output)");
            } else {
                await std.println(`OK (Length: ${(result as string).length})`);
            }
        } else if (result && (result as any).pid) {
            await std.println(`STARTED (PID: ${result.pid}, waiting...)`);
            await shell.waitpid(result.pid);
            await std.println("    PID finished.");
        }
    } catch (e: any) {
        await std.println(`CRASHED (${e.message})`);
    }

    // Test D: Argument handling
    await std.print("  [TEST] shell.exec('ls', ['/bin']) result: ");
    try {
        const resultDir = await shell.exec("ls", ["/bin"]);
        if (typeof resultDir === "string") {
            await std.println(resultDir.length === 0 ? "EMPTY" : `OK (Length: ${resultDir.length})`);
        } else if (resultDir && (resultDir as any).pid) {
            await std.println(`STARTED (PID: ${(resultDir as any).pid})`);
            await shell.waitpid((resultDir as any).pid);
            await std.println("    PID finished.");
        }
    } catch (e: any) {
        await std.println(`CRASHED (${e.message})`);
    }

    // Test E: Relative path vs Absolute
    const cwd = await shell.getcwd();
    await std.println(`  Current Directory: ${cwd}`);
    await std.print("  [TEST] Execution of './ls.js' in /bin: ");
    if (cwd === "/bin") {
        try {
            const resRel = await shell.exec("./ls.js", ["/root"]);
            await std.println(resRel ? "OK" : "EMPTY");
        } catch (e: any) { await std.println(`FAILED (${e.message})`); }
    } else {
        await std.println("SKIP (Not in /bin)");
    }
    await std.println("");

    // 6. Permissions / Sandbox test
    await std.println("--- Sandbox Constraints ---");
    try {
        // Attempt restricted module load
        const cryptoAvailable = typeof require !== "undefined";
        await std.println(`  require access: ${cryptoAvailable ? "AVAILABLE" : "RESTRICTED"}`);

        const isGlobalProcess = typeof (global as any).process !== "undefined";
        await std.println(`  global.process: ${isGlobalProcess ? "LEAKED" : "PROTECTED"}`);
    } catch (e) { }

    await std.println("\n==================================================");
    await std.println("            DIAGNOSTIC REPORT ENDED               ");
    await std.println("==================================================");

    return "Summary written to stdout.";
});
