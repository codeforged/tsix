/**
 * launcher.ts — LCD LAUNCHER: run an LCD app with the VECTOR DEVICE (device
 * node) REDIRECTED to another panel.
 *
 * ── WHY THIS EXISTS ──
 * LCD apps must stay honest: they write to `/dev/lcd` (hardware) or name no
 * device at all (autodetect). An app must NOT hardcode
 * `lcd.setDevicePath("/dev/plcd")` merely to be testable without hardware —
 * that mixes deployment concerns into application code, and breaks the very
 * same app when it runs on a real device.
 *
 * Redirecting the device is the LAUNCHER's job, not the app's:
 *
 *   /opt/plcd/launcher /root/graphcalc.ts        # app → /dev/plcd (emulator)
 *   /opt/plcd/launcher graphcalc.ts              # path relative to cwd
 *   /opt/plcd/launcher test-LM6029 suite         # resolved through PATH
 *   /opt/plcd/launcher -d /dev/lcd graphcalc.ts  # back to the real LM6029 panel
 *   /opt/plcd/launcher -c                        # is /dev/plcd ready to use?
 *
 * ── HOW IT WORKS (3 steps, WITHOUT touching app code) ──
 * 1. `TSIX_LCD_DEV=<device>` is set in THIS PROCESS's environment. `lcdLib`
 *    reads it LAZILY (every time the device is used), so every `LcdLib`
 *    instance — including the `lcd` singleton the app imports — follows.
 *    `shell.setenv()` is called too, keeping the kernel-side env consistent
 *    (visible to `getenv`, inherited by children if the app spawns any).
 * 2. The `lcd` singleton is also `setDevicePath()`-ed (belt and braces).
 * 3. The application runs IN THIS PROCESS (in-process exec): its source is read
 *    from the VFS, transpiled with esbuild when `.ts`, then
 *    `Program.execute()` is called — exactly what WorkerEntry does.
 *
 *    In-process is a HARD REQUIREMENT, not just an optimization: `process.env`
 *    belongs to the WORKER (isolate), while the kernel's env lives in the PCB.
 *    If the app were spawned as a child process (`shell.exec`), the child worker
 *    would copy its env from the kernel MAIN THREAD — not from the launcher
 *    process — so this redirection would be lost. Because the app lives in the
 *    same worker, the env override above is guaranteed visible, with no extra
 *    worker (~+10 MB RSS) and no intermediate process.
 *
 *    Consequences: the process name in `ps` stays `launcher.js`, the app shares
 *    the launcher's sandbox/privileges, and apps that need host
 *    `global.require` (e.g. /opt/tbuild) are out of scope for this tool.
 *
 * ── SEE ALSO ──
 *   /opt/plcd/plcd-emulator.js — fake-panel viewer in the browser (DDC)
 *   /lib/lcdLib.ts             — `LCD_PSEUDO_DEVICE_PATH`, `LCD_DEVICE_ENV`
 *
 * Usage: launcher <app>        (deploy: `npm run vfs:bootstrap` / sync VFS)
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, fs, shell } from "@tsix/Application";
import { LCD_DEVICE_ENV, LCD_DEVICE_PATH, LCD_PSEUDO_DEVICE_PATH, lcd, type LcdInfo } from "@tsix/lcdLib";

/**
 * Host `require` (same pattern as `/opt/dome/dome.ts`). Used ONLY for esbuild
 * (`.ts` transpile), `module` and `path` (the in-process loader) — and
 * deliberately LAZY (inside functions) so `.js` apps never pay for loading
 * esbuild.
 */
const _hostRequire: any = require;

/** Default launcher device: the FAKE panel (emulator, no hardware). */
const DEFAULT_DEVICE = LCD_PSEUDO_DEVICE_PATH;

const HELP = [
    "🖥️  PLCD Launcher — run an LCD app with the device node redirected.",
    "",
    "Usage:",
    "  launcher [options] <app> [app-args...]",
    "",
    "Options:",
    "  -d, --device <node>  Target device node (default: /dev/plcd)",
    "  -c, --check          Check the device + print info; the app is NOT run",
    "  -f, --force          Run the app even if the device node is not ready",
    "  -h, --help           Show this help",
    "  --                   End launcher options (the rest belongs to the app)",
    "",
    "Examples:",
    "  launcher /root/graphcalc.ts        # 128x64 LCD app → /dev/plcd",
    "  launcher -d /dev/lcd graphcalc.ts  # back to the real LM6029 panel",
    "  launcher -c                        # is /dev/plcd ready to use?",
].join("\n");

/** Parsed CLI arguments. */
interface LauncherOptions {
    /** Target device node (e.g. `/dev/plcd`). */
    device: string;
    /** `-c/--check`: verify the device only, never run the app. */
    check: boolean;
    /** `-f/--force`: run the app even if the device node is not ready. */
    force: boolean;
    /** `-h/--help`. */
    help: boolean;
    /** Target app (null = not given yet). */
    app: string | null;
    /** Args forwarded to the app VERBATIM (no app name, shell-style). */
    appArgs: string[];
}

// ================================================================
// CLI PARSING
// ================================================================

/**
 * Split launcher options from the app + its args. As soon as the first app
 * argument is found, EVERYTHING after it is forwarded verbatim — so app flags
 * (e.g. `--fast`) are never swallowed by the launcher.
 */
function parseOptions(argv: string[]): LauncherOptions {
    const opt: LauncherOptions = {
        device: DEFAULT_DEVICE,
        check: false,
        force: false,
        help: false,
        app: null,
        appArgs: [],
    };

    const rest = [...argv];
    while (rest.length > 0) {
        const arg = rest.shift()!;

        if (arg === "--") {
            opt.app = rest.shift() ?? null;
            opt.appArgs = rest;
            break;
        }
        if (arg === "-h" || arg === "--help") {
            opt.help = true;
            continue;
        }
        if (arg === "-c" || arg === "--check") {
            opt.check = true;
            continue;
        }
        if (arg === "-f" || arg === "--force") {
            opt.force = true;
            continue;
        }
        if (arg === "-d" || arg === "--device") {
            opt.device = (rest.shift() ?? "").trim() || opt.device;
            continue;
        }
        if (arg.startsWith("--device=")) {
            opt.device = arg.slice("--device=".length).trim() || opt.device;
            continue;
        }
        if (arg.startsWith("-") && arg.length > 1) {
            throw new Error(`unknown option: ${arg}`);
        }

        opt.app = arg;
        opt.appArgs = rest;
        break;
    }

    return opt;
}

// ================================================================
// APP RESOLUTION (shell conventions: PATH, `.js` sidecar before `.ts`)
// ================================================================

/** true when the path exists in the VFS and is a FILE. */
async function isFile(path: string): Promise<boolean> {
    try {
        const info = await fs.stat(path);
        return !!info && info.type === "FILE";
    } catch {
        return false;
    }
}

/** Join dir + name and collapse duplicate `//`. */
function joinPath(dir: string, name: string): string {
    return (dir.replace(/\/+$/, "") + "/" + name).replace(/\/+/g, "/");
}

/**
 * Resolve the app target: an absolute / cwd-relative path (one containing "/"),
 * or a binary name searched through the PATH directories. When the user SPELLS
 * OUT the extension (`graphcalc.ts`), that file is used — not its `.js` sidecar
 * (a sidecar can go stale when the `.ts` is edited from inside TSIX, e.g. via
 * atto). A name WITHOUT an extension tries `.js` first (cheaper: no transpile),
 * then `.ts`.
 */
async function resolveApp(cwd: string, target: string): Promise<string | null> {
    if (target.includes("/")) {
        const base = target.startsWith("/") ? target : joinPath(cwd, target);
        for (const candidate of [base, base + ".js", base + ".ts"]) {
            if (await isFile(candidate)) return candidate;
        }
        return null;
    }

    const pathValue = (await shell.getenv("PATH")) || "/bin";
    for (const dir of pathValue.split(":")) {
        if (!dir) continue;
        const base = joinPath(dir, target);
        for (const candidate of [base, base + ".js", base + ".ts"]) {
            if (await isFile(candidate)) return candidate;
        }
    }
    return null;
}

// ================================================================
// DEVICE REDIRECTION
// ================================================================

/**
 * Redirect the device to `target`:
 *  - env `TSIX_LCD_DEV` (read lazily by lcdLib → EVERY instance),
 *  - kernel env (`shell.setenv` → `getenv`, child processes),
 *  - the `lcd` singleton (`setDevicePath`).
 *
 * Returns the previous env value so it can be restored in `finally`.
 */
async function redirectDevice(target: string): Promise<string | undefined> {
    const previous = process.env[LCD_DEVICE_ENV];
    process.env[LCD_DEVICE_ENV] = target;
    try {
        await shell.setenv(LCD_DEVICE_ENV, target);
    } catch {
        /* kernel env failed — non-fatal: process.env is the primary source */
    }
    lcd.setDevicePath(target);
    return previous;
}

/** Restore the `TSIX_LCD_DEV` env to its value before the launcher ran. */
function restoreDeviceEnv(previous: string | undefined): void {
    if (previous === undefined) {
        delete process.env[LCD_DEVICE_ENV];
    } else {
        process.env[LCD_DEVICE_ENV] = previous;
    }
}

/** Device node + panel status (never kills the app when the node is missing). */
async function probeDevice(): Promise<{
    registered: boolean;
    info: LcdInfo | null;
    available: boolean;
}> {
    const info = await lcd.getInfo();
    return {
        registered: info !== null,
        info,
        available: info?.available === true,
    };
}

// ================================================================
// IN-PROCESS LOADER (mirrors WorkerEntry: VFS → transpile → Module)
// ================================================================

/**
 * Read (and, when needed, transpile) the app source, then `_compile()` it so the
 * `main` export (the class produced by `Program()`) can be instantiated.
 * Framework imports (`@tsix/*`, `@common/*`) are served automatically by the
 * `Module._load` hook WorkerEntry already installed for this worker (from the
 * in-memory `vfsCache`).
 */
function loadAppClass(appPath: string, source: string): any {
    const nodePath = _hostRequire("path");
    const Mod = _hostRequire("module");
    const fileName = appPath.split("/").pop() || "app";

    let code = source;
    if (!/\.js$/i.test(appPath)) {
        const esbuild = _hostRequire("esbuild"); // lazy: `.js` apps never touch esbuild
        code = esbuild.transformSync(source, {
            loader: "ts",
            format: "cjs",
            target: "node18",
            sourcefile: fileName,
            sourcemap: false,
        }).code;
    }

    // The physical filename is used for node_modules resolution; the VFS name is
    // used for module identity + stack traces (same convention as WorkerEntry).
    const physical = nodePath.join(process.cwd(), fileName);
    const mod = new Mod(physical, module.parent);
    mod.filename = appPath;
    mod.paths = Mod._nodeModulePaths(nodePath.dirname(physical));
    (mod as any)._compile(code, appPath);

    const exp = mod.exports;
    let AppClass: any = exp?.main || exp?.Main || exp?.default;
    if (typeof AppClass !== "function" && typeof exp === "function") AppClass = exp;
    if (typeof AppClass !== "function") {
        AppClass = Object.values(exp || {}).find((v) => typeof v === "function");
    }
    if (typeof AppClass !== "function") {
        throw new Error(
            `No 'main' (Program) export in ${appPath} — an app must ` +
                `\`export const main = Program(...)\` like every other TSIX app.`,
        );
    }
    return AppClass;
}

// ================================================================
// REPORTING TO THE TTY
// ================================================================

async function printBanner(
    appPath: string | null,
    device: string,
    probe: { registered: boolean; info: LcdInfo | null; available: boolean },
): Promise<void> {
    const redirected = device !== LCD_DEVICE_PATH;
    await std.println("");
    await std.println("╔══════════════════════════════════════════════╗");
    await std.println("║ 🖥️  PLCD LAUNCHER — device node redirected    ║");
    await std.println("╚══════════════════════════════════════════════╝");
    await std.println(`   app    : ${appPath ?? "— (--check mode, app not run)"}`);
    await std.println(`   device : ${LCD_DEVICE_PATH}${redirected ? `  →  ${device}` : "  (no redirect)"}`);

    if (!probe.registered) {
        await std.println(`   node   : ❌ not registered — is the driver for ${device} loaded by the kernel?`);
        return;
    }

    const info = probe.info!;
    const kind = info.pseudo ? "pseudo (software)" : "hardware";
    const flags = [
        `${info.width}×${info.height}`,
        `${info.framebufferSize} B`,
        `contrast ${info.contrast ?? "-"}`,
        `backlight ${info.backlight ? "ON" : "OFF"}`,
    ].join(" • ");
    await std.println(`   panel  : ${probe.available ? "✅ ready" : "❌ not ready"} • ${kind} • ${flags}`);
    if (!probe.available && info.lastError) {
        await std.println(`   error  : ${info.lastError}`);
    }
    if (info.pseudo) {
        await std.println("   viewer : run `plcd-emulator` (DDC) to watch this panel in the browser");
    }
    await std.println("");
}

// ================================================================
// MAIN
// ================================================================

export const main = Program(async (args: string[]) => {
    let opt: LauncherOptions;
    try {
        opt = parseOptions(args);
    } catch (err: any) {
        await std.println(`launcher: ${err.message}`);
        await std.println("");
        await std.println(HELP);
        await shell.exit(64);
        return;
    }

    // `-c/--check` may be used without an app (pure device verification); otherwise an app is required.
    if (opt.help || (!opt.app && !opt.check)) {
        await std.println(HELP);
        if (!opt.help) await shell.exit(64);
        return;
    }

    // ── Resolve the app target (skipped in --check mode without an app) ──
    let appPath: string | null = null;
    if (opt.app) {
        const cwd = await shell.getcwd();
        appPath = await resolveApp(cwd, opt.app);
        if (!appPath) {
            await std.println(`launcher: ${opt.app}: app not found (cwd ${cwd})`);
            await std.error(`launcher: ${opt.app}: app not found`, "launcher");
            await shell.exit(127);
            return;
        }
    }

    // ── Redirect the device, then run the app ──
    const previousEnv = await redirectDevice(opt.device);
    try {
        const probe = await probeDevice();
        await printBanner(appPath, opt.device, probe);
        await std.log(
            `[launcher] ${appPath ?? "-"} → ${opt.device}` + `${probe.available ? "" : " (device not ready)"}`,
            "plcd",
        );

        if (!probe.registered || !probe.available) {
            if (!opt.force) {
                await std.println(`❌ Node ${opt.device} is not ready — app NOT started.`);
                await std.println(
                    probe.registered
                        ? "   Driver registered but the panel is not alive: check SPI/addon in /var/log/syslog."
                        : "   Node not registered: make sure the driver is loaded at boot (restart the kernel after syncing the VFS).",
                );
                await std.println("   Use --force to run the app anyway.");
                await shell.exit(2);
                return;
            }
            await std.println(`⚠️  Node ${opt.device} is not ready — running because of --force.`);
        }

        // `-c` (or no app given): the device has been verified and reported.
        if (opt.check || !appPath) return;

        // ── Load the app from the VFS (the exec bit is not required: in-process) ──
        const source = await fs.readFile(appPath);
        if (source === null || source === undefined || source === "") {
            throw new Error(`Cannot read app source from the VFS: ${appPath}`);
        }
        if (source.includes("setDevicePath(")) {
            await std.println(
                "⚠️  This app calls lcd.setDevicePath() itself — consider removing it:\n" +
                    "    redirecting the device is the launcher's job, not the app's.",
            );
        }

        const AppClass = loadAppClass(appPath, source);
        const lib = (global as any)._tsixLib;
        const previousFilename = (global as any).__filename;
        (global as any).__filename = appPath; // error reports point at the app, not the launcher
        try {
            const app = new AppClass();
            await app.execute(lib, opt.appArgs);
        } finally {
            (global as any).__filename = previousFilename;
        }
    } catch (err: any) {
        const detail = err?.stack || err?.message || String(err);
        await std.error(detail, appPath ?? "launcher");
        await std.println(`\n[launcher] Runtime Error: ${err?.message || err}\n`);
        await shell.exit(1);
    } finally {
        restoreDeviceEnv(previousEnv);
        try {
            await lcd.close(); // the app may leave a dangling FD behind
        } catch {
            /* ignore: the app may already have closed the FD */
        }
    }
});
