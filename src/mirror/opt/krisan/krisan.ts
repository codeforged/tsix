import { Program, std, shell, fs } from "../../lib/Application";
import { Window, div, button, span, h2, h3, paragraph, text, badge, taskbarButton, input } from "../../lib/emerald";
import * as bcrypt from "bcryptjs";

/**
 * krisan.ts — TSIX Window Manager (Krisan)
 * 
 * - Real app registry dari /opt/krisan/menu/*.menu
 * - Real app launching via shell.exec()
 * - Minimize/restore via GUI_REQ MINIMIZE_WINDOW/RESTORE_WINDOW
 * - Taskbar dinamis: pinned launchers + running indicators + minimize toggle
 */

// ================================================================
// APP REGISTRY — dibaca dari /opt/krisan/menu/*.menu
// ================================================================
interface AppEntry {
    id: string; icon: string; label: string; command: string;
    pinned: boolean;
}

async function loadMenuFromFiles(): Promise<AppEntry[]> {
    const menuDir = "/opt/krisan/menu";
    const apps: AppEntry[] = [];
    try {
        const files = await fs.ls(menuDir);
        for (const f of (files || [])) {
            if (f.type !== "FILE" || !f.name.endsWith(".menu")) continue;
            const content = await fs.readFile(menuDir + "/" + f.name);
            if (!content) continue;
            const lines = String(content).split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
            const item: Record<string, string> = {};
            for (const line of lines) {
                const [k, ...v] = line.split("=");
                if (k && v.length) item[k.trim()] = v.join("=").trim();
            }
            if (item.name && item.command) {
                apps.push({
                    id: f.name.replace(".menu", ""),
                    icon: item.icon || "📄",
                    label: item.name,
                    command: item.command,
                    pinned: item.taskbar_pinned === "true",
                });
            }
        }
    } catch (e) {
        await std.log("[krisan] Failed to read menu dir: " + e, "test-wm");
    }
    return apps;
}

// ================================================================
// STYLES
// ================================================================
const S = {
    taskbar: {
        position: "absolute", bottom: "0", left: "0", right: "0", height: "44px",
        background: "rgba(22,33,62,0.85)", backdropFilter: "blur(12px)",
        borderTop: "1px solid rgba(76,175,80,0.3)", display: "flex", alignItems: "center",
        padding: "0 12px", zIndex: "2000", boxShadow: "0 -2px 16px rgba(0,0,0,0.5)",
    } as Record<string, any>,
    btnStart: {
        background: "transparent", color: "#4caf50", border: "none", borderRadius: "6px",
        padding: "4px 14px", fontSize: "14px", fontWeight: "700", cursor: "pointer",
        height: "32px", display: "flex", alignItems: "center", gap: "6px",
        transition: "background 0.2s",
    } as Record<string, any>,
    taskbarDivider: {
        width: "1px", height: "24px", background: "rgba(255,255,255,0.1)", margin: "0 8px",
    } as Record<string, any>,
    clock: {
        marginLeft: "auto", color: "#aaa", fontSize: "11px", fontFamily: "monospace", paddingRight: "4px",
    } as Record<string, any>,
    desktop: {
        position: "absolute", top: "0", left: "0", right: "0", bottom: "44px",
        background: "radial-gradient(ellipse at center, #16213e 0%, #0d1b2a 60%, #0a0f1f 100%)",
        overflow: "hidden",
    } as Record<string, any>,
    launcherOverlay: {
        position: "absolute", top: "0", left: "0", right: "0", bottom: "0",
        background: "transparent", backdropFilter: "blur(0px)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: "2147483647",
        pointerEvents: "none", isolation: "isolate",
    } as Record<string, any>,
    launcherPanel: {
        background: "rgba(30,42,74,0.95)", border: "1px solid rgba(76,175,80,0.3)",
        borderRadius: "20px", padding: "36px 40px 28px", width: "720px", height: "580px", maxHeight: "580px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.8)", display: "flex", flexDirection: "column" as any,
        position: "relative", zIndex: "2147483647", pointerEvents: "auto", isolation: "isolate",
    } as Record<string, any>,
    launcherSearch: {
        width: "100%", padding: "12px 18px", background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.1)", borderRadius: "12px",
        color: "#e0e0e0", fontSize: "15px", outline: "none", marginBottom: "20px",
    } as Record<string, any>,
    launcherGrid: {
        display: "flex", flexWrap: "wrap" as any, gap: "14px", flex: "1",
        marginBottom: "20px", overflowY: "auto" as any, alignContent: "flex-start",
    } as Record<string, any>,
    launcherItem: {
        display: "flex", flexDirection: "column" as any, alignItems: "center",
        padding: "14px 10px", borderRadius: "14px", cursor: "pointer",
        width: "96px", border: "none", background: "transparent",
        transition: "background 0.15s",
    } as Record<string, any>,
    launcherFooter: {
        display: "flex", alignItems: "center", justifyContent: "space-between",
        borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: "12px",
    } as Record<string, any>,
    clientWindow: {
        position: "absolute", background: "#16213e", border: "1px solid #4caf50",
        borderRadius: "8px", minWidth: "300px", minHeight: "150px",
        boxShadow: "0 4px 20px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column" as any,
    } as Record<string, any>,
    clientTitlebar: {
        display: "flex", alignItems: "center", padding: "6px 10px",
        background: "#0f3460", borderRadius: "7px 7px 0 0",
        cursor: "move", userSelect: "none" as any, borderBottom: "1px solid #333",
    } as Record<string, any>,
    clientContent: { flex: "1", padding: "12px", overflow: "auto" } as Record<string, any>,
    clientClose: {
        background: "#f44336", color: "white", border: "none", borderRadius: "50%",
        width: "18px", height: "18px", fontSize: "10px", cursor: "pointer",
        marginLeft: "auto", display: "flex", alignItems: "center", justifyContent: "center",
        padding: "0", lineHeight: "1",
    } as Record<string, any>,
    // --- Login screen styles ---
    loginOverlay: {
        position: "absolute", top: "0", left: "0", right: "0", bottom: "0",
        background: "rgba(10,15,31,0.92)", display: "flex",
        alignItems: "center", justifyContent: "center", zIndex: "2147483647",
        pointerEvents: "auto",
    } as Record<string, any>,
    loginCard: {
        background: "rgba(22,33,62,0.98)", border: "1px solid rgba(76,175,80,0.25)",
        borderRadius: "16px", padding: "40px 36px 32px", width: "380px",
        boxShadow: "0 16px 48px rgba(0,0,0,0.7)", textAlign: "center",
    } as Record<string, any>,
    loginInput: {
        width: "100%", padding: "10px 14px", background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.12)", borderRadius: "8px",
        color: "#e0e0e0", fontSize: "14px", outline: "none", marginBottom: "12px",
    } as Record<string, any>,
    loginBtn: {
        width: "100%", padding: "10px", background: "#4caf50", color: "white",
        border: "none", borderRadius: "8px", fontSize: "14px", fontWeight: "600",
        cursor: "pointer", marginTop: "6px",
    } as Record<string, any>,
    loginError: {
        color: "#f44336", fontSize: "12px", marginTop: "12px", minHeight: "18px",
    } as Record<string, any>,
};

// ================================================================
// WALLPAPERS
// ================================================================
const WALLPAPERS = [
    { name: "Krisan", file: "/opt/krisan/wallpaper/krisan.b64", mime: "image/png", color: "#1a1a2e" },
    { name: "Krisan2", file: "/opt/krisan/wallpaper/krisan2.b64", mime: "image/png", color: "#2e4a3a" },
    { name: "Default", file: "/opt/krisan/wallpaper/default.b64", mime: "image/svg+xml", color: "#0a0f1f" },
    { name: "Ocean", file: "/opt/krisan/wallpaper/ocean.b64", mime: "image/jpeg", color: "#0c3483" },
    { name: "Forest", file: "/opt/krisan/wallpaper/forest.b64", mime: "image/jpeg", color: "#134e5e" },
    { name: "Night", file: "/opt/krisan/wallpaper/night.b64", mime: "image/jpeg", color: "#0f0c29" },
];

async function applyWallpaper(win: Window, wp: any): Promise<void> {
    try {
        const b64 = await fs.readFile(wp.file);
        if (!b64) return;
        const uri = `url(data:${wp.mime || "image/jpeg"};base64,${b64})`;
        await win.updateProps("desktop", {
            style: { ...S.desktop, background: `${uri} center/cover no-repeat, #0a0f1f` }
        });
        await saveWallpaper({ type: "image", mime: wp.mime, value: wp.file });
    } catch (e) { /* ignore */ }
}

async function saveWallpaper(wp: any): Promise<void> {
    try {
        await fs.writeFile("/opt/krisan/wallpaper.json", JSON.stringify(wp, null, 2));
    } catch (e) { /* ignore */ }
}

// ================================================================
// LOGIN SCREEN
// ================================================================
async function showLoginScreen(win: Window): Promise<string> {
    let loginUser = "root";
    // JANGAN prefill password — field ter-mask, prefill "1" (password default lama)
    // menempel di depan password baru → login selalu gagal setelah passwd diganti.
    let loginPass = "";

    // Mount login overlay
    await win.mount(
        div({ id: "login-overlay", style: S.loginOverlay },
            div({ id: "login-card", style: S.loginCard },
                span({ text: "🛡️", style: { fontSize: "48px", display: "block", marginBottom: "10px" } }),
                h2({ text: "TSIX Desktop", style: { color: "#4caf50", fontSize: "20px", marginBottom: "4px" } }),
                paragraph({ text: "Sign in to continue", style: { color: "#888", fontSize: "12px", marginBottom: "24px" } }),
                input({ id: "login-username", placeholder: "Username", value: loginUser, autofocus: "", type: "text", style: S.loginInput }),
                input({ id: "login-password", placeholder: "Password", type: "password", style: S.loginInput }),
                button({ id: "login-btn", text: "Sign In", style: S.loginBtn }),
                paragraph({ id: "login-error", text: "", style: S.loginError }),
            ),
        )
    );

    // Capture input values
    win.onInput("login-username", (ev: any) => { loginUser = ev.value || ""; });
    win.onInput("login-password", (ev: any) => { loginPass = ev.value || ""; });

    return new Promise<string>(async (resolve) => {
        // Click Sign In button
        win.onClick("login-btn", async () => {
            await tryLogin(win, loginUser, loginPass, resolve);
        });

        // Enter key di password field = klik Sign In
        win.onKeydown("login-password", async (ev: any) => {
            if (ev.value === "Enter") {
                await tryLogin(win, loginUser, loginPass, resolve);
            }
        });

        await win.flush();
    });

    await win.flush();

}

async function tryLogin(win: Window, username: string, password: string, resolve: (user: string) => void): Promise<void> {
    const errEl = "login-error";
    const u = username.trim();
    if (!u || !password) {
        await win.updateProps(errEl, { text: "Please enter username and password." });
        return;
    }

    try {
        // 1. Read /etc/passwd
        const passwdContent = await fs.readFile("/etc/passwd") || "";
        const lines = passwdContent.split("\n").map(l => l.trim()).filter(l => l);
        const userEntry = lines.find(l => l.split(":")[0] === u);
        if (!userEntry) {
            await win.updateProps(errEl, { text: "Invalid username or password." });
            return;
        }

        const parts = userEntry.split(":");
        const uid = parseInt(parts[2]);
        const gid = parseInt(parts[3]);
        const home = parts[5];

        // 2. Read /etc/shadow
        const shadowContent = await fs.readFile("/etc/shadow") || "";
        const shadowLines = shadowContent.split("\n").map(l => l.trim()).filter(l => l);
        const shadowEntry = shadowLines.find(l => l.split(":")[0] === u);
        if (!shadowEntry) {
            await win.updateProps(errEl, { text: "Account disabled or no password set." });
            return;
        }

        const hash = shadowEntry.split(":")[1];
        const match = bcrypt.compareSync(password, hash);
        if (!match) {
            await win.updateProps(errEl, { text: "Invalid username or password." });
            return;
        }

        // 3. SUCCESS — resolve supplementary groups
        const supplementaryGids: number[] = [gid];
        try {
            const groupContent = await fs.readFile("/etc/group") || "";
            const groupLines = groupContent.split("\n").map(l => l.trim()).filter(l => l);
            for (const gLine of groupLines) {
                const gParts = gLine.split(":");
                const groupGid = parseInt(gParts[2]);
                const groupUsers = gParts[3] ? gParts[3].split(",") : [];
                if (groupUsers.includes(u) && groupGid !== gid) {
                    supplementaryGids.push(groupGid);
                }
            }
        } catch (e) { /* ignore */ }

        // 4. Set identity (gid first, then uid — order matters on Unix)
        await shell.setgroups(supplementaryGids);
        await shell.setgid(gid);
        await shell.setuid(uid);
        await shell.setenv("USER", u);
        await shell.setenv("HOME", home);
        await shell.chdir(home);

        await std.log(`[krisan] User ${u} logged in (UID ${uid})`, "test-wm");

        // 5. Remove login overlay and resolve with username
        await win.unmount("login-overlay");
        resolve(u);
    } catch (e: any) {
        await win.updateProps(errEl, { text: "Login error: " + e.message });
    }
}

// ================================================================
// MAIN
// ================================================================
export const main = Program(async (args: string[]) => {
    await std.log("=== TSIX Window Manager v3 ===", "test-wm");

    // Load menu dari filesystem
    const APPS = await loadMenuFromFiles();
    await std.log(`[krisan] Loaded ${APPS.length} apps from /opt/krisan/menu/`, "test-wm");

    const win = new Window("TSIX WM Desktop", undefined, true, undefined, undefined, true);

    const wmLib = (global as any)._tsixLib as any;
    if (wmLib?.onEvent) {
        wmLib.onEvent("ipc_message", (msg: any) => {
            const payload = msg?.data || msg;
            if (!payload) return;

            // Handle GUI_WINDOW_ERROR before wid guard — std.error() may send without wid
            if (payload.type === "GUI_WINDOW_ERROR") {
                if (payload.pid) {
                    const txt = (payload.context ? `[${payload.context}] ` : "") + (payload.error || "Unknown error");
                    pendingErrors.set(payload.pid, txt);
                }
                return;
            }

            if (!payload.wid) return;

            if (payload.type === "GUI_WINDOW_CREATED") {
                if (!payload.pid) return;
                const appId = runningAppByPid.get(payload.pid);
                if (!appId) return;
                const info = runningApps.get(appId);
                if (!info) return;
                info.wid = payload.wid;
                void std.log(`[krisan] Tracked window ${payload.wid} for ${appId} (pid=${payload.pid})`, "test-wm");
                // Set data-wid di taskbar button agar dome bisa cari button spesifik by wid
                void win.updateProps(info.taskbarId, { 'data-wid': payload.wid });
                return;
            }

            const appId = Array.from(runningApps.entries()).find(([, info]) => info.wid === payload.wid)?.[0];
            if (!appId) return;
            const info = runningApps.get(appId);
            if (!info) return;

            if (payload.type === "GUI_WINDOW_MINIMIZED") {
                info.minimized = true;
                void win.updateProps(info.taskbarId, {
                    className: "tsix-taskbar-btn",
                    style: { borderBottom: "2px solid transparent" },
                });
                const badgeId = `${info.taskbarId}-badge`;
                void win.updateProps(badgeId, {
                    className: "tsix-badge",
                    style: { background: "#ff9800", boxShadow: "0 0 9px #ff9800" },
                });
            } else if (payload.type === "GUI_WINDOW_RESTORED") {
                info.minimized = false;
                void win.updateProps(info.taskbarId, {
                    className: "tsix-taskbar-btn active",
                    style: { borderBottom: "2px solid #4caf50" },
                });
                const badgeId = `${info.taskbarId}-badge`;
                void win.updateProps(badgeId, {
                    className: "tsix-badge tsix-badge-pulse",
                    style: { background: "#4caf50", boxShadow: "0 0 9px #4caf50" },
                });
            } else if (payload.type === "GUI_WINDOW_CLOSED") {
                // Check pending errors from std.error() before cleanup
                const errMsg = pendingErrors.get(info.pid) || null;
                if (errMsg) {
                    pendingErrors.delete(info.pid);
                    void showError(win, appId, errMsg);
                }
                runningApps.delete(appId);
                runningAppByPid.delete(info.pid);
                void win.unmount(info.taskbarId);
                if (runningApps.size === 0) {
                    void win.updateProps("welcome", { style: { display: "block" } });
                }
            }
        });
    }

    let launcherOpen = false;
    let running = true;

    // ================================================================
    // LOGIN SCREEN
    // ================================================================
    let loggedInUser = await showLoginScreen(win);

    // ================================================================
    // BUILD INITIAL UI
    // ================================================================
    // Load wallpaper config
    let wallpaperBg = S.desktop.background; // default gradient fallback
    try {
        const wpRaw = await fs.readFile("/opt/krisan/wallpaper.json");
        if (wpRaw) {
            const wp = JSON.parse(wpRaw);
            if (wp.type === "image" && wp.value) {
                const b64 = await fs.readFile(wp.value);
                if (b64) {
                    const mime = wp.mime || "image/jpeg";
                    wallpaperBg = `url(data:${mime};base64,${b64}) center/cover no-repeat, #0a0f1f`;
                }
            } else if (wp.type === "gradient") {
                wallpaperBg = wp.value;
            }
        }
    } catch (e) { /* use default */ }

    await win.mount(
        div({ id: "wm-root", style: { width: "100%", height: "100%", position: "relative" } },

            // DESKTOP
            div({ id: "desktop", style: { ...S.desktop, background: wallpaperBg } },
            ),

            // LAUNCHER OVERLAY (hidden)
            div({ id: "launcher-overlay", style: { ...S.launcherOverlay, display: "none" } },
                div({ id: "launcher-panel", style: S.launcherPanel },
                    input({ id: "launcher-search", placeholder: "🔍  Cari aplikasi...", style: S.launcherSearch }),
                    div({ id: "launcher-grid", style: S.launcherGrid }),
                    div({ id: "launcher-wallpapers", style: { display: "flex", alignItems: "center", gap: "8px", padding: "0 0 14px 0", borderBottom: "1px solid rgba(255,255,255,0.06)", marginBottom: "12px" } },
                        span({ text: "🖼️", style: { fontSize: "14px", marginRight: "4px" } }),
                        ...WALLPAPERS.map((wp, i) =>
                            div({
                                id: `wp-${i}`,
                                style: {
                                    width: "40px", height: "28px", borderRadius: "6px",
                                    background: wp.color,
                                    cursor: "pointer", border: "2px solid rgba(255,255,255,0.1)",
                                    boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
                                    transition: "transform 0.15s, border-color 0.15s",
                                },
                            })
                        ),
                    ),
                    div({ id: "launcher-footer", style: S.launcherFooter },
                        div({ style: { display: "flex", alignItems: "center", gap: "8px" } },
                            span({ text: "👤", style: { fontSize: "18px" } }),
                            span({ id: "launcher-user", text: "tsix", style: { color: "#4caf50", fontSize: "12px", fontWeight: "600" } }),
                        ),
                        div({ style: { display: "flex", gap: "6px" } },
                            button({ id: "launcher-logout", text: "🚪 Logout", style: { background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: "6px", padding: "5px 12px", fontSize: "11px", cursor: "pointer" } }),
                            button({ id: "launcher-reboot", text: "🔄 Reboot", style: { background: "rgba(244,67,54,0.2)", color: "#f44336", border: "1px solid #f44336", borderRadius: "6px", padding: "5px 12px", fontSize: "11px", cursor: "pointer" } }),
                        ),
                    ),
                ),
            ),

            // TASKBAR
            div({ id: "taskbar", style: S.taskbar },
                button({ id: "btn-start", text: "☰", style: S.btnStart }),
                div({ style: S.taskbarDivider }),
                div({ id: "taskbar-pinned", style: { display: "flex", alignItems: "center", gap: "2px" } }),
                div({ style: S.taskbarDivider }),
                div({ id: "taskbar-running", style: { display: "flex", alignItems: "center", gap: "2px", flex: "1", overflow: "hidden" } }),
                span({ id: "clock", text: getClock(), style: S.clock }),
            ),
        )
    );

    // Update launcher user display with actual login name
    await win.updateProps("launcher-user", { text: loggedInUser });

    // ================================================================
    // POPULATE PINNED LAUNCHERS on taskbar
    // ================================================================
    for (const app of APPS.filter(a => a.pinned)) {
        const btnId = `pinned-${app.id}`;
        // onClickId in initial mount props → browser sets up click relay
        // during buildDOM (no race condition with UPDATE_PROPS flush).
        await win.mount(
            button({
                id: btnId,
                onClickId: btnId,
                style: {
                    display: "flex", alignItems: "center", background: "transparent",
                    color: "#ccc", border: "none", borderBottom: "2px solid transparent",
                    borderRadius: "3px", padding: "4px 10px", fontSize: "12px",
                    cursor: "pointer", height: "28px", transition: "background 0.15s",
                },
            }, span({ style: { fontSize: "14px" } }, text(app.icon))),
            "taskbar-pinned",
        );
        win.onClick(btnId, () => openApp(win, app));
    }

    // ================================================================
    // EVENTS
    // ================================================================
    // Wallpaper picker
    for (let i = 0; i < WALLPAPERS.length; i++) {
        const wp = WALLPAPERS[i];
        win.onClick(`wp-${i}`, async () => {
            await applyWallpaper(win, wp);
            await std.log(`[krisan] Wallpaper set to: ${wp.name}`, "krisan");
        });
    }

    win.onClick("btn-start", async () => {
        launcherOpen = !launcherOpen;
        await toggleLauncher(win, launcherOpen, APPS, () => { launcherOpen = false; });
    });

    win.onClick("desktop", async () => {
        if (launcherOpen) {
            launcherOpen = false;
            await toggleLauncher(win, false, APPS);
        }
    });

    win.onClick("launcher-logout", async () => {
        await toggleLauncher(win, false, APPS);
        launcherOpen = false;

        // Close all running apps
        await closeAllRunningApps(win);

        // Hide desktop, show login screen
        await win.updateProps("wm-root", { style: { display: "none" } });
        loggedInUser = await showLoginScreen(win);

        // Login success — show desktop again, update user display
        await win.updateProps("launcher-user", { text: "👤 " + loggedInUser });
        await win.updateProps("wm-root", { style: { display: "block" } });
        await win.updateProps("welcome", { style: { display: "block" } });
        // Reset launcher state
        launcherOpen = false;
        await win.updateProps("btn-start", { style: { ...S.btnStart, background: "transparent" } });
    });

    // --- Launcher search (fuzzy) ---
    let searchTimeout: any = null;
    win.onInput("launcher-search", async (ev: any) => {
        // Debounce 150ms — jangan rebuild grid setiap ketikan
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(async () => {
            await buildLauncherGrid(win, ev.value || "", APPS, () => { launcherOpen = false; });
            await win.flush();
        }, 150);
    });

    win.onClick("launcher-reboot", async () => {
        await toggleLauncher(win, false, APPS);
        await closeAllRunningApps(win);
        await std.log("[krisan] Rebooting system...", "krisan");
        await shell.shutdown(1); // exit code 1 = reboot
        running = false;
        await win.close();
    });

    win.onClose(() => { running = false; });

    // ================================================================
    // FLUSH — pastikan semua onClickId terkirim ke browser
    // ================================================================
    await win.flush();

    // ================================================================
    // CLOCK
    // ================================================================
    const clockInterval = setInterval(() => {
        win.updateProps("clock", { text: getClock() });
    }, 15000);

    // ================================================================
    // MAIN LOOP
    // ================================================================
    while (running) {
        await new Promise(r => setTimeout(r, 500));
    }

    clearInterval(clockInterval);
    await win.close();
});

// ================================================================
// HELPERS
// ================================================================

function getClock(): string {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

async function toggleLauncher(win: Window, open: boolean, apps: AppEntry[], onAppPicked?: () => void) {
    if (open) {
        await win.updateProps("launcher-overlay", { style: { ...S.launcherOverlay, display: "flex" } });
        await win.updateProps("btn-start", { style: { ...S.btnStart, background: "rgba(76,175,80,0.15)" } });
        await buildLauncherGrid(win, "", apps, onAppPicked);
    } else {
        await win.updateProps("launcher-overlay", { style: { ...S.launcherOverlay, display: "none" } });
        await win.updateProps("btn-start", { style: { ...S.btnStart, background: "transparent" } });
    }
}

/** Fuzzy match: semua karakter query muncul berurutan di target. */
function fuzzyMatch(query: string, target: string): boolean {
    if (!query) return true;
    let qi = 0;
    const q = query.toLowerCase();
    const t = target.toLowerCase();
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) qi++;
    }
    return qi === q.length;
}

async function buildLauncherGrid(win: Window, filter: string, apps: AppEntry[], onAppPicked?: () => void) {
    const q = filter.toLowerCase();
    const filtered = apps.filter(a => {
        if (!q) return true;
        return fuzzyMatch(q, a.label) || fuzzyMatch(q, a.id);
    });
    await win.setContent("launcher-grid",
        ...filtered.map(app => div({
            id: `lg-${app.id}`,
            style: S.launcherItem,
        },
            span({ text: app.icon, style: { fontSize: "28px", marginBottom: "4px" } }),
            span({ text: app.label, style: { color: "#ccc", fontSize: "10px", textAlign: "center" } }),
        )),
    );
    for (const app of filtered) {
        win.onClick(`lg-${app.id}`, async () => {
            if (onAppPicked) onAppPicked();
            await toggleLauncher(win, false, apps);
            await openApp(win, app);
        });
    }
    await win.flush();
}

// ================================================================
// CLIENT WINDOWS — real app launching + minimize/restore
// ================================================================
/** Track running apps: appId → { pid, wid, minimized, taskbarId } */
interface RunningApp {
    pid: number;
    wid: string;
    minimized: boolean;
    taskbarId: string;
}
const runningApps = new Map<string, RunningApp>();
const runningAppByPid = new Map<number, string>();
/** PID → error message, diisi oleh std.error() dari app sebelum exit */
const pendingErrors = new Map<number, string>();

async function closeAllRunningApps(win: Window): Promise<void> {
    for (const [appId, info] of runningApps) {
        try {
            if (info.wid && info.pid) {
                // Send close event directly to the app — avoids GUI_REQ permission error
                await shell.send(info.pid, {
                    type: "GUI_EVENT", wid: info.wid,
                    targetId: "__window__", eventType: "close_window",
                });
            }
            await win.unmount(info.taskbarId);
        } catch (e) { /* ignore */ }
    }
    runningApps.clear();
    runningAppByPid.clear();
}

async function openApp(win: Window, app: AppEntry) {
    // If already running, restore if minimized, otherwise focus
    const existing = runningApps.get(app.id);
    if (existing) {
        if (existing.minimized) {
            existing.minimized = false;
            if (existing.wid && existing.pid) {
                await shell.send(existing.pid, {
                    type: "GUI_EVENT", wid: existing.wid,
                    targetId: "__window__", eventType: "restore_window",
                });
            }
            await win.updateProps(existing.taskbarId, {
                className: "tsix-taskbar-btn active",
                style: { borderBottom: "2px solid #4caf50" },
            });
        }
        // Focus — skip for now (z-index via GUI_REQ would hit same permission issue)
        return;
    }

    // Launch real app via shell.exec()
    const proc = await shell.exec(`/bin/${app.command}.ts`, []);
    if (!proc || !proc.pid) {
        await std.log(`[krisan] Failed to launch ${app.command}`, "test-wm");
        return;
    }
    await std.log(`[krisan] Launched ${app.label} PID=${proc.pid}`, "test-wm");

    // Track as running
    const runId = `run-${app.id}`;
    runningApps.set(app.id, {
        pid: proc.pid,
        wid: "",
        minimized: false,
        taskbarId: runId,
    });
    runningAppByPid.set(proc.pid, app.id);

    // Running indicator with badge
    await win.mount(
        taskbarButton({ id: runId, icon: app.icon, label: app.label, badge: badge({ id: `${runId}-badge`, color: "#4caf50" }), active: true }),
        "taskbar-running",
    );

    await win.updateProps("welcome", { style: { display: "none" } });

    // Taskbar click → minimize/restore toggle
    win.onClick(runId, async () => {
        const info = runningApps.get(app.id);
        if (!info || !info.wid || !info.pid) return;
        if (info.minimized) {
            // RESTORE
            info.minimized = false;
            await shell.send(info.pid, {
                type: "GUI_EVENT", wid: info.wid,
                targetId: "__window__", eventType: "restore_window",
            });
            await win.updateProps(runId, {
                className: "tsix-taskbar-btn active",
                style: { borderBottom: "2px solid #4caf50" },
            });
        } else {
            // MINIMIZE
            info.minimized = true;
            await shell.send(info.pid, {
                type: "GUI_EVENT", wid: info.wid,
                targetId: "__window__", eventType: "minimize_window",
            });
            await win.updateProps(runId, {
                className: "tsix-taskbar-btn",
                style: { borderBottom: "2px solid transparent" },
            });
        }
    });

    await win.flush();
}
