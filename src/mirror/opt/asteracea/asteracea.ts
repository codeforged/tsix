import { Program, std, shell, fs } from "../../lib/Application";
import { theme } from "../../lib/theme";
import {
  Window,
  Screen,
  div,
  button,
  span,
  h2,
  h3,
  paragraph,
  text,
  image,
  badge,
  taskbarButton,
  input,
  textarea,
} from "../../lib/emerald";
import { IDOMNode } from "@common/GUITypes";

// ================================================================
// TYPES
// ================================================================

interface AppEntry {
  id: string;
  icon: string;
  label: string;
  command: string;
  params: string[]; // params dari .menu
  pinnedLauncher: boolean; // pinned_launcher dari .menu
  dcmLauncher: boolean; // dcm_launcher dari .menu → muncul di Desktop Context Menu
  maximizeOnStart: boolean; // maximize_on_start dari .menu
  group: string; // group dari .menu → pengelompokan di launcher box
}

/** State machine untuk aplikasi yang sedang berjalan */
type AppState = "LAUNCHING" | "RUNNING" | "MINIMIZED" | "ERROR" | "CLOSED";

interface AppInstance {
  appId: string;
  pid: number;
  wid: string;
  entry: AppEntry;
  state: AppState;
  taskbarId: string;
  error?: string;
  createdAt: number;
}

interface IPCMessage {
  type: string;
  wid?: string;
  pid?: number;
  appId?: string;
  payload: any;
  timestamp: number;
}

// ================================================================
// IPC QUEUE SYSTEM (Asteracea Message Bus)
// ================================================================

class MessageBus {
  private queue: IPCMessage[] = [];
  private processing = false;
  private handlers: Map<string, (msg: IPCMessage) => Promise<void>> = new Map();

  async push(msg: IPCMessage): Promise<void> {
    this.queue.push(msg);
    if (!this.processing) await this.processQueue();
  }

  private async processQueue(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const msg = this.queue.shift()!;
      const handler = this.handlers.get(msg.type);
      if (handler) {
        try {
          await handler(msg);
        } catch (e) {
          /* log */
        }
      }
    }
    this.processing = false;
  }

  on(type: string, handler: (msg: IPCMessage) => Promise<void>): void {
    this.handlers.set(type, handler);
  }
}

// ================================================================
// APP STATE MANAGER (Single Source of Truth)
// ================================================================

class AppStateManager {
  private apps: Map<string, AppInstance> = new Map();
  private byPid: Map<number, string> = new Map();
  private byWid: Map<string, string> = new Map();
  private focusedWid = "";

  add(appId: string, pid: number, entry: AppEntry): AppInstance {
    const inst: AppInstance = {
      appId,
      pid,
      wid: "",
      entry,
      state: "LAUNCHING",
      taskbarId: `tb-${appId}-${pid}`,
      createdAt: Date.now(),
    };
    this.apps.set(appId, inst);
    this.byPid.set(pid, appId);
    return inst;
  }

  setWid(appId: string, wid: string): void {
    const inst = this.apps.get(appId);
    if (!inst) return;
    inst.wid = wid;
    this.byWid.set(wid, appId);
  }

  setFocusedWid(wid: string): void {
    this.focusedWid = wid;
  }

  isFocused(wid: string): boolean {
    return this.focusedWid === wid;
  }

  transitionTo(appId: string, newState: AppState): void {
    const inst = this.apps.get(appId);
    if (inst) inst.state = newState;
  }

  removeByAppId(appId: string): AppInstance | undefined {
    const inst = this.apps.get(appId);
    if (inst) {
      this.byPid.delete(inst.pid);
      if (inst.wid) this.byWid.delete(inst.wid);
      if (this.focusedWid === inst.wid) this.focusedWid = "";
      this.apps.delete(appId);
    }
    return inst;
  }

  removeByPid(pid: number): AppInstance | undefined {
    const appId = this.byPid.get(pid);
    return appId ? this.removeByAppId(appId) : undefined;
  }

  getByPid(pid: number): AppInstance | undefined {
    const appId = this.byPid.get(pid);
    return appId ? this.apps.get(appId) : undefined;
  }

  getByWid(wid: string): AppInstance | undefined {
    const appId = this.byWid.get(wid);
    return appId ? this.apps.get(appId) : undefined;
  }

  getByAppId(appId: string): AppInstance | undefined {
    return this.apps.get(appId);
  }

  getAllRunning(): Map<string, AppInstance> {
    return new Map(this.apps);
  }

  countRunning(): number {
    return this.apps.size;
  }
}

// ================================================================
// APP REGISTRY — baca dari /opt/asteracea/menu/*.menu
// ================================================================

async function loadMenuFromFiles(): Promise<AppEntry[]> {
  const menuDir = "/opt/asteracea/menu";
  const apps: AppEntry[] = [];
  try {
    const files = await fs.ls(menuDir);
    for (const f of files || []) {
      if (f.type !== "FILE" || !f.name.endsWith(".menu")) continue;
      const content = await fs.readFile(menuDir + "/" + f.name);
      if (!content) continue;
      const lines = String(content)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
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
          params: item.params ? item.params.split(" ") : [],
          pinnedLauncher: item.pinned_launcher === "true",
          dcmLauncher: item.dcm_launcher === "true",
          maximizeOnStart: item.maximize_on_start === "true",
          group: item.group || "",
        });
      }
    }
  } catch (e) {
    await std.log("[asteracea] Failed to read menu dir: " + e, "asteracea");
  }
  return apps;
}

// ================================================================
// TRUST GATE — whitelist/blacklist aplikasi + konfirmasi user
// ================================================================
// Sebelum mengeksekusi aplikasi, Asteracea cek Trust DB:
//   - /opt/asteracea/trust/trusted.list  → diizinkan (eksekusi langsung)
//   - /opt/asteracea/trust/blocked.list  → diblokir (batalkan)
//   - tidak ada di keduanya              → konfirmasi user (trust / tidak)
// Key = command path aplikasi (bukan nama), supaya tidak mudah dimanipulasi.

const TRUST_DIR = "/opt/asteracea/trust";
const TRUSTED_FILE = TRUST_DIR + "/trusted.list";
const BLOCKED_FILE = TRUST_DIR + "/blocked.list";
// DDC Trust — terpisah: menandai app yang diizinkan/diblokir menjalankan NJ.
const DDC_TRUSTED_FILE = TRUST_DIR + "/ddc-trusted.list";
const DDC_BLOCKED_FILE = TRUST_DIR + "/ddc-blocked.list";

/** Baca satu baris list (trim + buang kosong). */
async function readList(path: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path);
    if (!raw) return [];
    return String(raw)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/** Tulis list (satu entri per baris). */
async function writeList(path: string, entries: string[]): Promise<void> {
  try {
    await fs.mkdir(TRUST_DIR);
  } catch (_) {}
  try {
    await fs.writeFile(path, entries.join("\n") + "\n");
  } catch (_) {}
}

/** Tambah satu entri ke list (jika belum ada). */
async function addToList(path: string, entry: string): Promise<void> {
  const list = await readList(path);
  if (!list.includes(entry)) {
    list.push(entry);
    await writeList(path, list);
  }
}

/** Cek status trust sebuah command. */
async function trustStatus(
  command: string,
): Promise<"trusted" | "blocked" | "unknown"> {
  const [trusted, blocked] = await Promise.all([
    readList(TRUSTED_FILE),
    readList(BLOCKED_FILE),
  ]);
  if (trusted.includes(command)) return "trusted";
  if (blocked.includes(command)) return "blocked";
  return "unknown";
}

/** Tambah ke trusted list. */
async function markTrusted(command: string): Promise<void> {
  const list = await readList(TRUSTED_FILE);
  if (!list.includes(command)) {
    list.push(command);
    await writeList(TRUSTED_FILE, list);
  }
  // Hapus dari blocked (kalau sebelumnya pernah diblokir)
  const blocked = await readList(BLOCKED_FILE);
  if (blocked.includes(command)) {
    await writeList(
      BLOCKED_FILE,
      blocked.filter((c) => c !== command),
    );
  }
  await std.log(`[asteracea] Trusted: ${command}`, "asteracea");
}

/** Tambah ke blocked list. */
async function markBlocked(command: string): Promise<void> {
  const list = await readList(BLOCKED_FILE);
  if (!list.includes(command)) {
    list.push(command);
    await writeList(BLOCKED_FILE, list);
  }
  // Hapus dari trusted (kalau sebelumnya pernah dipercaya)
  const trusted = await readList(TRUSTED_FILE);
  if (trusted.includes(command)) {
    await writeList(
      TRUSTED_FILE,
      trusted.filter((c) => c !== command),
    );
  }
  await std.log(`[asteracea] Blocked: ${command}`, "asteracea");
}

// ================================================================
// STYLES
// ================================================================

const S = {
  desktop: {
    position: "absolute",
    top: "0",
    left: "0",
    right: "0",
    bottom: "0",
    overflow: "hidden",
    cursor: "default",
  } as Record<string, any>,
  taskbarWrapper: {
    position: "absolute",
    bottom: "3px",
    left: "0",
    right: "0",
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
    cursor: "default",
  } as Record<string, any>,
  taskbarInner: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "6px 12px",
    background: "rgba(22,33,62,0.85)",
    backdropFilter: "blur(12px)",
    borderTop: "1px solid rgba(76,175,80,0.3)",
    borderRadius: "12px 12px 12px 12px",
    pointerEvents: "auto",
    boxShadow: "0 -2px 16px rgba(0,0,0,0.5)",
    maxWidth: "90vw",
    overflowX: "auto",
    overflowY: "hidden",
    scrollbarWidth: "thin",
    cursor: "default",
  } as Record<string, any>,
  tbBtn: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    background: "transparent",
    color: "#ccc",
    border: "none",
    borderBottom: "2px solid transparent",
    borderRadius: "3px",
    padding: "4px 10px",
    fontSize: "12px",
    cursor: "default",
    height: "28px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "160px",
    transition: "background 0.15s, border-color 0.15s",
    flexShrink: 0,
  } as Record<string, any>,
  tbBtnActive: {
    background: "rgba(76,175,80,0.15)",
    borderBottom: "2px solid #4caf50",
    color: "#4caf50",
  } as Record<string, any>,
  btnStart: {
    background: "transparent",
    color: "#4caf50",
    border: "none",
    borderRadius: "6px",
    padding: "4px 10px",
    fontSize: "16px",
    fontWeight: "700",
    cursor: "default",
    height: "32px",
    display: "flex",
    alignItems: "center",
    transition: "background 0.2s",
    flexShrink: 0,
  } as Record<string, any>,
  clock: {
    marginLeft: "auto",
    color: "#aaa",
    fontSize: "11px",
    fontFamily: "monospace",
    paddingRight: "4px",
    flexShrink: 0,
  } as Record<string, any>,
  launcherOverlay: {
    position: "fixed",
    top: "0",
    left: "0",
    right: "0",
    bottom: "0",
    background: "rgba(0,0,0,0)",
    backdropFilter: "blur(0px)",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "2147483647",
    pointerEvents: "none",
    isolation: "isolate",
  } as Record<string, any>,
  launcherPanel: {
    background: "rgba(30,42,74,0.95)",
    border: "1px solid rgba(76,175,80,0.3)",
    borderRadius: "20px",
    padding: "36px 40px 28px",
    width: "720px",
    height: "580px",
    maxHeight: "580px",
    boxShadow: "0 20px 60px rgba(0,0,0,0.8)",
    display: "flex",
    flexDirection: "column" as any,
    pointerEvents: "auto",
    isolation: "isolate",
  } as Record<string, any>,
  loginOverlay: {
    gap: "12px",
    position: "absolute",
    top: "0",
    left: "0",
    right: "0",
    bottom: "0",
    background: "rgba(10,15,31,0.92)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "2147483647",
    pointerEvents: "auto",
  } as Record<string, any>,
  loginCard: {
    background: "rgba(22,33,62,0.98)",
    border: "1px solid rgba(76,175,80,0.25)",
    borderRadius: "16px",
    padding: "40px 36px 32px",
    width: "380px",
    boxShadow: "0 16px 48px rgba(0,0,0,0.7)",
    textAlign: "center",
  } as Record<string, any>,
  loginInput: {
    width: "100%",
    padding: "10px 14px",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "8px",
    color: "#e0e0e0",
    fontSize: "14px",
    outline: "none",
    marginBottom: "12px",
  } as Record<string, any>,
};

// ================================================================
// LOGIN SCREEN
// ================================================================

async function showLoginScreen(win: Window): Promise<string> {
  let loginUser = "";
  // JANGAN prefill password — field bertipe password ter-mask, user tidak bisa
  // melihat karakter awal. Prefill "1" (password default lama) akan "menempel"
  // di depan password baru → login selalu gagal setelah passwd diganti.
  let loginPass = "";

  await win.mount(
    div(
      { id: "login-overlay", style: S.loginOverlay },
      div(
        { id: "login-card", style: S.loginCard },
        span({
          text: "🛡️",
          style: { fontSize: "48px", display: "block", marginBottom: "10px" },
        }),
        h2({
          text: "Asteracea Desktop",
          style: { color: "#4caf50", fontSize: "20px", marginBottom: "4px" },
        }),
        paragraph({
          text: "Sign in to continue",
          style: { color: "#888", fontSize: "12px", marginBottom: "24px" },
        }),
        input({
          id: "login-username",
          placeholder: "Username",
          value: loginUser,
          autofocus: "",
          type: "text",
          style: S.loginInput,
        }),
        input({
          id: "login-password",
          placeholder: "Password",
          // value TIDAK di-prefill — biar password yang diketik bersih.
          type: "password",
          style: S.loginInput,
        }),
        button({ id: "login-btn", text: "Sign In" }),
        paragraph({
          id: "login-error",
          text: "",
          style: {
            color: "#f44336",
            fontSize: "12px",
            marginTop: "12px",
            minHeight: "18px",
          },
        }),
      ),
    ),
  );

  win.onInput("login-username", (ev: any) => {
    loginUser = ev.value || "";
  });
  win.onInput("login-password", (ev: any) => {
    loginPass = ev.value || "";
  });

  return new Promise<string>(async (resolve) => {
    const tryLoginAction = async () =>
      await tryLogin(win, loginUser, loginPass, resolve);
    win.onClick("login-btn", tryLoginAction);
    win.onKeydown("login-password", async (ev: any) => {
      if (ev.value === "Enter") await tryLoginAction();
    });
    await win.flush();
  });
}

async function tryLogin(
  win: Window,
  username: string,
  password: string,
  resolve: (user: string) => void,
): Promise<void> {
  const errEl = "login-error";
  const u = username.trim();
  if (!u || !password) {
    await win.updateProps(errEl, {
      text: "Please enter username and password.",
    });
    return;
  }
  try {
    const passwdContent = (await fs.readFile("/etc/passwd")) || "";
    const lines = passwdContent
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l);
    const userEntry = lines.find((l) => l.split(":")[0] === u);
    if (!userEntry) {
      await win.updateProps(errEl, { text: "Invalid username or password." });
      return;
    }
    const parts = userEntry.split(":");
    const uid = parseInt(parts[2]);
    const gid = parseInt(parts[3]);
    const home = parts[5];

    // Verifikasi password via /bin/login.js --verify (SetUID root).
    // Setelah login pertama sebagai user non-root, WM sudah drop privilege dan
    // TIDAK bisa lagi baca /etc/shadow (0640 root). login.js SetUID root selalu
    // bisa baca shadow → hasil ditulis ke file temp, lalu dibaca di sini.
    const verifyOut = `/tmp/verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
    let authOk = false;
    let verifyErr = "";
    try {
      const vp = await shell.exec("/bin/login.js", [
        "--verify",
        u,
        password,
        verifyOut,
      ]);
      if (vp && vp.pid) {
        await shell.waitpid(vp.pid);
        const res = (await fs.readFile(verifyOut)) || "";
        const txt = String(res).trim();
        if (txt === "OK") authOk = true;
        else if (txt.startsWith("FAIL:")) verifyErr = txt.substring(5).trim();
      }
    } catch (e: any) {
      await win.updateProps(errEl, { text: "Login error: " + e.message });
      return;
    } finally {
      try {
        await fs.unlink(verifyOut);
      } catch (_) {
        /* file mungkin belum sempat dibuat */
      }
    }
    if (!authOk) {
      await win.updateProps(errEl, {
        text: verifyErr
          ? "Login error: " + verifyErr
          : "Invalid username or password.",
      });
      return;
    }

    const supplementaryGids: number[] = [gid];
    try {
      const groupContent = (await fs.readFile("/etc/group")) || "";
      const groupLines = groupContent
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l);
      for (const gLine of groupLines) {
        const gParts = gLine.split(":");
        const groupGid = parseInt(gParts[2]);
        const groupUsers = gParts[3] ? gParts[3].split(",") : [];
        if (groupUsers.includes(u) && groupGid !== gid)
          supplementaryGids.push(groupGid);
      }
    } catch (e) {
      /* ignore */
    }

    // Urutan set identitas:
    //  - Kalau WM sedang jalan sebagai user non-root (setelah logout), restore
    //    UID root DULU via Saved UID di kernel — supaya bebas setgid/setgroups
    //    dan setuid ke user target. Ini menangani SEMUA arah login ulang
    //    (non-root → root, non-root → non-root, dst).
    //  - Setelah itu drop ke identitas target: gid & groups DULU, baru uid
    //    (kalau uid duluan, proses kehilangan privilege sebelum selesai set
    //    gid/groups).
    const curWho = await shell.whoami();
    if (curWho.uid !== 0) {
      await shell.setuid(0);
    }
    await shell.setgroups(supplementaryGids);
    await shell.setgid(gid);
    await shell.setuid(uid);
    await shell.setenv("USER", u);
    await shell.setenv("HOME", home);
    await shell.chdir(home);

    await std.log(`[asteracea] User ${u} logged in (UID ${uid})`, "asteracea");
    await win.unmount("login-overlay");
    resolve(u);
  } catch (e: any) {
    await win.updateProps(errEl, { text: "Login error: " + e.message });
  }
}

// ================================================================
// SHOW ERROR — tampilkan error popup di overlay layer
// ================================================================

async function showError(win: Window, title: string, msg: string) {
  showModal(win, "❌", title, msg, "#f44336");
}

// ================================================================
// HANDLE WM ERROR — catat + tampilkan error, jangan exit
// (dipakai safety net global supaya WM tidak pernah crash)
// ================================================================

async function handleWmError(win: Window | null, kind: string, msg: string) {
  try {
    await std.log(`[asteracea] ${kind}: ${msg}`, "asteracea");
  } catch (_) {
    /* log gagal — jangan crash lagi */
  }
  try {
    if (win) await showError(win, kind, msg);
  } catch (_) {
    /* popup gagal (window rusak) — jangan crash lagi */
  }
}

// ================================================================
// SHOW ALERT — tampilkan info popup (dipakai untuk notif detail)
// ================================================================

async function showAlertDialog(win: Window, title: string, msg: string) {
  showModal(win, "🔔", title, msg, "#4caf50");
}

async function showModal(
  win: Window,
  icon: string,
  title: string,
  msg: string,
  borderColor: string,
) {
  const eid = `__err_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  try {
    await win.mount(
      div(
        {
          id: eid,
          style: {
            position: "fixed",
            inset: "0",
            zIndex: "9999999999",
            pointerEvents: "auto",
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          },
        },
        div(
          {
            style: {
              background: "#16213e",
              border: `2px solid ${borderColor}`,
              borderRadius: "12px",
              padding: "24px 32px",
              maxWidth: "500px",
              pointerEvents: "auto",
            },
          },
          span({
            text: icon,
            style: {
              fontSize: "40px",
              display: "block",
              marginBottom: "10px",
              textAlign: "center",
            },
          }),
          h2({
            text: title,
            style: {
              color: borderColor,
              fontSize: "16px",
              marginBottom: "8px",
              textAlign: "center",
            },
          }),
          paragraph({
            text: msg,
            style: {
              color: "#ccc",
              fontSize: "12px",
              marginBottom: "20px",
              textAlign: "center",
              whiteSpace: "pre-wrap",
            },
          }),
          div(
            { style: { display: "flex", justifyContent: "center" } },
            button({
              id: `${eid}-ok`,
              text: "OK",
              style: {
                background: borderColor,
                color: "white",
                border: "none",
                borderRadius: "6px",
                padding: "8px 36px",
                cursor: "pointer",
                fontSize: "14px",
                fontWeight: "600",
              },
            }),
          ),
        ),
      ),
      "launcher-overlay",
    );
    win.onClick(`${eid}-ok`, async () => {
      await win.unmount(eid);
    });
    await win.flush();
  } catch (_) {
    /* ignore */
  }
}

// ================================================================
// WALLPAPER DIALOG — browse jpg/png, preview, apply
// ================================================================

const WALLPAPERS = [
  {
    name: "Default",
    file: "/opt/asteracea/wallpaper/default.b64",
    mime: "image/svg+xml",
    color: "#0a0f1f",
  },
];

function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "bmp") return "image/bmp";
  if (ext === "svg") return "image/svg+xml";
  return "image/jpeg";
}

async function showWallpaperDialog(win: Window) {
  const did = `__wp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const overlayId = did;
  const fileListId = `${did}-list`;
  const pathBarId = `${did}-path`;
  const statusId = `${did}-status`;
  const previewId = `${did}-preview`;
  const imgId = `${did}-img`;
  const btnApplyId = `${did}-apply`;
  const btnCancelId = `${did}-cancel`;

  let currentDir = "/mnt/shared";
  let entries: any[] = [];
  let selectedFile: string | null = null;
  let selectedB64: string | null = null;

  async function refreshFileList() {
    await win.updateProps(statusId, { text: "" });
    await win.updateProps(pathBarId, { text: "📂 " + (currentDir || "/") });
    // Reset preview
    await win.setContent(
      previewId,
      span({
        id: `${did}-preview-empty`,
        text: "Pilih file gambar untuk pratinjau",
        style: { color: "#666", fontSize: "11px", fontStyle: "italic" },
      }),
    );

    try {
      entries = (await fs.ls(currentDir)) || [];
      entries.sort((a: any, b: any) => {
        if (a.type !== b.type) return a.type === "DIRECTORY" ? -1 : 1;
        return (a.name || "").localeCompare(b.name || "");
      });
    } catch (e: any) {
      entries = [];
      await win.updateProps(statusId, { text: "⚠️ " + (e.message || "Error") });
    }

    // Filter: show dirs + image files (.jpg/.jpeg/.png/.gif)
    const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".bmp"];
    const visible = entries.filter(
      (e: any) =>
        e.type === "DIRECTORY" ||
        imageExts.some((ext) => (e.name || "").toLowerCase().endsWith(ext)),
    );

    const rows: any[] = [];
    if (currentDir !== "/") {
      const backId = `${did}-back`;
      rows.push(
        div(
          {
            id: backId,
            onClickId: backId,
            style: {
              display: "flex",
              alignItems: "center",
              padding: "3px 8px",
              cursor: "pointer",
              borderRadius: "4px",
              marginBottom: "1px",
              fontSize: "12px",
              fontFamily: "monospace",
              color: "#4caf50",
            },
          },
          span({ text: "📁 ..", style: { flex: "1", fontWeight: "700" } }),
        ),
      );
      win.onClick(backId, async () => {
        const parts = currentDir.replace(/\/$/, "").split("/");
        parts.pop();
        currentDir = parts.join("/") || "/";
        selectedFile = null;
        selectedB64 = null;
        await refreshFileList();
      });
    }

    for (let i = 0; i < visible.length; i++) {
      const e = visible[i];
      const rid = `${did}-row_${i}`;
      const isDir = e.type === "DIRECTORY";
      rows.push(
        div(
          {
            id: rid,
            onClickId: rid,
            style: {
              display: "flex",
              alignItems: "center",
              padding: "3px 8px",
              cursor: "pointer",
              borderRadius: "4px",
              marginBottom: "1px",
              fontSize: "12px",
              fontFamily: "monospace",
              color: isDir ? "#4caf50" : "#e0e0e0",
            },
          },
          span({
            text: (isDir ? "📁" : "🖼️") + " " + e.name,
            style: { flex: "1" },
          }),
        ),
      );
      win.onClick(rid, async () => {
        if (isDir) {
          currentDir = currentDir.replace(/\/$/, "") + "/" + e.name;
          selectedFile = null;
          selectedB64 = null;
          await refreshFileList();
        } else {
          selectedFile = e.name;
          const fp = currentDir.replace(/\/$/, "") + "/" + e.name;
          await win.updateProps(statusId, { text: "📥 Loading..." });
          try {
            const raw = await fs.readFile(fp);
            if (raw) {
              const mime = mimeFromName(e.name);
              const b64 = Buffer.from(raw, "latin1").toString("base64");
              selectedB64 = b64;
              // Enable apply button
              await win.updateProps(btnApplyId, {
                style: {
                  background: "#4caf50",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  padding: "6px 20px",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer",
                  opacity: "1",
                },
              });
              // Show preview using IDOMNode img tag directly
              const dataUri = `data:${mime};base64,${b64}`;
              const previewNode: IDOMNode = {
                id: imgId,
                tag: "img",
                props: {
                  src: dataUri,
                  alt: e.name,
                  style: {
                    maxWidth: "100%",
                    maxHeight: "140px",
                    borderRadius: "8px",
                    objectFit: "contain",
                  },
                },
                children: [],
              };
              await win.setContent(previewId, previewNode);
              await win.updateProps(statusId, { text: "✅ " + e.name });
            }
          } catch (err: any) {
            await win.updateProps(statusId, {
              text: "❌ " + (err.message || "Gagal baca file"),
            });
          }
        }
      });
    }

    await win.setContent(fileListId, ...rows);
    await win.flush();
  }

  // --- MOUNT DIALOG ---
  await win.mount(
    div(
      {
        id: overlayId,
        style: {
          position: "fixed",
          inset: "0",
          zIndex: "9999999998",
          pointerEvents: "auto",
          background: "rgba(0,0,0,0.75)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        },
      },
      div(
        {
          style: {
            background: "#1a1a2e",
            border: "1px solid rgba(76,175,80,0.3)",
            borderRadius: "16px",
            width: "620px",
            height: "560px",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 16px 48px rgba(0,0,0,0.7)",
            overflow: "hidden",
          },
        },
        // Header
        div(
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              borderBottom: "1px solid #333",
            },
          },
          h2({
            text: "🖼️ Ganti Wallpaper",
            style: { margin: "0", fontSize: "15px", color: "#4caf50" },
          }),
          button({
            id: btnCancelId,
            text: "✕",
            style: {
              background: "transparent",
              color: "#888",
              border: "none",
              fontSize: "16px",
              cursor: "pointer",
              padding: "2px 6px",
              borderRadius: "4px",
            },
          }),
        ),
        // Body
        div(
          {
            style: {
              flex: "1",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              minHeight: "0",
            },
          },
          // Path bar
          div(
            {
              style: {
                padding: "6px 14px",
                borderBottom: "1px solid #333",
                fontSize: "11px",
                fontFamily: "monospace",
                color: "#aaa",
                background: "#0f3460",
              },
            },
            span({ id: pathBarId, text: "📂 " + currentDir }),
          ),
          // File list
          div({
            id: fileListId,
            style: { flex: "1", overflowY: "auto", padding: "4px 8px" },
          }),
          // Preview area
          div(
            {
              id: previewId,
              style: {
                height: "160px",
                borderTop: "1px solid #333",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "8px",
                overflow: "hidden",
              },
            },
            span({
              id: `${did}-preview-empty`,
              text: "Pilih file gambar untuk pratinjau",
              style: { color: "#666", fontSize: "11px", fontStyle: "italic" },
            }),
          ),
        ),
        // Footer
        div(
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 16px",
              borderTop: "1px solid #333",
            },
          },
          span({
            id: statusId,
            text: "",
            style: {
              color: "#888",
              fontSize: "11px",
              flex: "1",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            },
          }),
          div(
            { style: { display: "flex", gap: "6px" } },
            button({
              id: btnCancelId + "_2",
              text: "Batal",
              style: {
                background: "transparent",
                color: "#aaa",
                border: "1px solid #555",
                borderRadius: "6px",
                padding: "6px 16px",
                fontSize: "12px",
                cursor: "pointer",
              },
            }),
            button({
              id: btnApplyId,
              text: "Terapkan",
              style: {
                background: "#4caf50",
                color: "white",
                border: "none",
                borderRadius: "6px",
                padding: "6px 20px",
                fontSize: "12px",
                fontWeight: "600",
                cursor: "pointer",
                opacity: "0.5",
              },
            }),
          ),
        ),
      ),
    ),
    "launcher-overlay",
  );

  // --- WIRE EVENTS ---
  // Cancel
  win.onClick(btnCancelId, async () => {
    _wpDialogId = "";
    await win.unmount(overlayId);
  });
  win.onClick(btnCancelId + "_2", async () => {
    _wpDialogId = "";
    await win.unmount(overlayId);
  });

  // Apply
  win.onClick(btnApplyId, async () => {
    if (!selectedFile || !selectedB64) return;
    const mime = mimeFromName(selectedFile);
    const b64Name = selectedFile.replace(/\.(jpg|jpeg|png|gif|bmp)$/i, ".b64");
    const b64Path = `/opt/asteracea/wallpaper/current-wp.b64`;
    try {
      // Pastikan direktori wallpaper ada — dibuat saat runtime, tidak ada di host source.
      // Tanpa ini, fs.writeFile(b64Path) gagal diam-diam (parent dir tidak ada),
      // sehingga wallpaper.json tersimpan tapi file b64 tidak → blank setelah reboot.
      try {
        await fs.mkdir("/opt/asteracea/wallpaper");
      } catch (_) {
        /* sudah ada */
      }
      // Save b64 file
      await fs.writeFile(b64Path, selectedB64);
      // Update wallpaper.json
      await fs.writeFile(
        "/opt/asteracea/wallpaper.json",
        JSON.stringify(
          {
            type: "image",
            mime,
            value: b64Path,
          },
          null,
          2,
        ),
      );
      // Apply — kirim b64 langsung, jangan baca ulang file
      await applyWallpaper(win, {
        name: selectedFile,
        file: b64Path,
        mime,
        color: "#333",
        b64: selectedB64,
      });
      await win.updateProps(statusId, { text: "✅ Wallpaper diterapkan!" });
      _wpDialogId = "";
      setTimeout(async () => {
        try {
          await win.unmount(overlayId);
        } catch (_) {}
      }, 600);
    } catch (e: any) {
      await win.updateProps(statusId, { text: "❌ " + (e.message || "Gagal") });
    }
  });

  // Browse default start dir
  try {
    const shared = await fs.ls("/mnt/shared");
    if (shared) currentDir = "/mnt/shared";
  } catch (_) {
    try {
      const home = await fs.ls("/root");
      currentDir = "/root";
    } catch (_2) {}
  }

  await refreshFileList();
  await win.flush();
}

// ================================================================
// FUZZY SEARCH
// ================================================================

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

// ================================================================
// MAIN — Asteracea Window Manager
// ================================================================

export const main = Program(async (args: string[]) => {
  // --- DAEMONIZE: lepas dari TTY (biar tidak ganggu console tty1) ---
  // stdio dialihkan ke /dev/null → output tidak menumpuk di console tempat
  // user mengetik. std.log/std.error tetap masuk /var/log/syslog (via VFS,
  // bukan stdout), dan GUI tetap jalan normal karena render lewat DOME.
  try {
    const ok = await shell.daemonize("Asteracea Window Manager");
    await std.log(
      ok
        ? "[asteracea] Daemonized (detached from TTY)"
        : "[asteracea] Daemonize skipped",
      "asteracea",
    );
  } catch (e: any) {
    await std.log(`[asteracea] Daemonize warning: ${e.message}`, "asteracea");
  }

  await std.log("=== Asteracea Window Manager v1 ===", "asteracea");

  // Load menu dari filesystem
  const APPS = await loadMenuFromFiles();
  await std.log(
    `[asteracea] Loaded ${APPS.length} apps from /opt/asteracea/menu/`,
    "asteracea",
  );

  // Init core systems
  const bus = new MessageBus();
  const appState = new AppStateManager();

  // Create WM window (fullscreen, frameless)
  const win = new Window(
    "Asteracea Desktop",
    undefined,
    true,
    undefined,
    undefined,
    true,
  );

  // ================================================================
  // SAFETY NET — WM TIDAK BOLEH MATI karena error yang tidak tertangkap
  // ================================================================
  // WorkerEntry.ts menangkap unhandledRejection/uncaughtException lalu memanggil
  // realExit(1) → seluruh worker (termasuk WM) mati. Untuk Asteracea kita
  // override: hapus handler fatal bawaan, ganti dengan handler yang mencatat +
  // menampilkan error ke user, TAPI tidak meng-exit. Dengan begitu apapun yang
  // terjadi (mis. user non-root coba reboot → Permission Denied, app rusak, dll)
  // WM tetap hidup dan error tetap terlihat.
  try {
    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");

    process.on("unhandledRejection", (reason: any) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      const stack =
        reason instanceof Error && reason.stack ? "\n" + reason.stack : "";
      void handleWmError(win, "Unhandled Rejection", msg + stack);
    });

    process.on("uncaughtException", (err: any) => {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? "\n" + err.stack : "";
      void handleWmError(win, "Uncaught Exception", msg + stack);
    });
    await std.log(
      "[asteracea] Safety net installed (WM akan bertahan dari error)",
      "asteracea",
    );
  } catch (e: any) {
    await std.log(`[asteracea] Safety net warning: ${e.message}`, "asteracea");
  }

  // --- REGISTER ASTERACEA IDENTITY ---
  // App client tinggal shell.send("3ec3ffe9-...", msg), seperti CoCreateInstance di COM
  const AST_UUID = "3ec3ffe9-e0a6-411f-b7e3-c9ff0b00556c";
  try {
    const ok = await shell.registerIdentity(AST_UUID);
    if (!ok)
      await std.log(
        "[asteracea] Warning: Failed to register identity",
        "asteracea",
      );
    else
      await std.log(
        `[asteracea] Identity registered: ${AST_UUID}`,
        "asteracea",
      );
  } catch (e: any) {
    await std.log(
      `[asteracea] Identity registration error: ${e.message}`,
      "asteracea",
    );
  }

  // --- LOAD PREFS ---
  let prefs: any = {
    notifications: { duration: 5, maxLog: 100, position: "ne" },
  };
  try {
    const raw = await fs.readFile("/opt/asteracea/prefs.json");
    if (raw) prefs = JSON.parse(String(raw));
  } catch (_) {
    /* use defaults */
  }
  const notifDuration = prefs.notifications?.duration || 5000;
  const notifMaxLog = prefs.notifications?.maxLog || 100;
  const notifPosition = prefs.notifications?.position || "ne";

  // --- NOTIFICATION SYSTEM (cascade stack with auto-reposition) ---
  const positionStyles: Record<string, Record<string, any>> = {
    ne: { top: "16px", right: "16px" },
    nw: { top: "16px", left: "16px" },
    se: { bottom: "16px", right: "16px" },
    sw: { bottom: "16px", left: "16px" },
    n: { top: "16px", left: "50%", transform: "translateX(-50%)" },
    s: { bottom: "16px", left: "50%", transform: "translateX(-50%)" },
    e: { top: "50%", right: "16px", transform: "translateY(-50%)" },
    w: { top: "50%", left: "16px", transform: "translateY(-50%)" },
  };
  const notifPosStyle = positionStyles[notifPosition] || positionStyles.ne;
  const isTop =
    notifPosition.startsWith("n") ||
    notifPosition === "e" ||
    notifPosition === "w";
  const slideDir = isTop ? "translateY(-24px)" : "translateY(24px)";
  const NOTIF_CONTAINER_ID = "__asteracea_notif__";
  const activeNotifs: { id: string; timer: any }[] = [];
  const notifHistory: {
    title: string;
    message: string;
    timestamp: number;
    read: boolean;
  }[] = [];
  let unreadCount = 0;
  let _cachedRingtoneB64: string | null = null;

  async function getRingtoneB64(): Promise<string | null> {
    if (_cachedRingtoneB64) return _cachedRingtoneB64;
    try {
      const raw = await fs.readFile("/opt/asteracea/notif-ringtone.mp3");
      if (raw) {
        _cachedRingtoneB64 = Buffer.from(raw, "latin1").toString("base64");
        return _cachedRingtoneB64;
      }
    } catch (_) {
      /* file not found */
    }
    return null;
  }

  async function playNotificationSound() {
    try {
      const b64 = await getRingtoneB64();
      if (!b64) return;
      await shell.send("da8711c2-5ca9-4f00-ad13-f1226f95594c", {
        type: "PLAY_SOUND",
        data: b64,
      });
    } catch (_) {
      /* DOME might not be ready */
    }
  }

  async function updateBadge() {
    if (unreadCount > 0) {
      await win.updateProps("tb-notif-wrap", {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginLeft: "6px",
          marginRight: "4px",
          cursor: "pointer",
          flexShrink: 0,
        },
      } as any);
      await win.updateProps("tb-notif-count", { text: String(unreadCount) });
    } else {
      await win.updateProps("tb-notif-wrap", {
        style: {
          display: "none",
          alignItems: "center",
          justifyContent: "center",
          marginLeft: "6px",
          marginRight: "4px",
          cursor: "pointer",
          flexShrink: 0,
        },
      } as any);
    }
  }

  // Taskbar badge click → overlay history (unread only)
  win.onClick("tb-notif-wrap", async () => {
    const overlayId = "__notif_overlay__";
    try {
      await win.unmount(overlayId);
    } catch (_) {}
    // Hanya tampilkan notif yang BELUM dibaca
    const items = notifHistory
      .filter((n) => !n.read)
      .slice()
      .reverse();
    const rows: IDOMNode[] = [];
    for (let i = 0; i < Math.min(items.length, 20); i++) {
      const n = items[i];
      const time = new Date(n.timestamp).toLocaleTimeString();
      const readBtnId = `__nr_${i}`;
      rows.push(
        div(
          {
            id: `__nh_${i}`,
            style: {
              padding: "10px 12px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
              display: "flex",
              alignItems: "flex-start",
              gap: "8px",
              opacity: n.read ? "0.5" : "1",
            },
          },
          div(
            { style: { flex: "1" } },
            div(
              {
                style: {
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: "4px",
                },
              },
              span({
                text: n.title,
                style: {
                  color: "#4caf50",
                  fontSize: "12px",
                  fontWeight: "700",
                },
              }),
              span({
                text: time,
                style: {
                  color: "#888",
                  fontSize: "10px",
                  fontFamily: "monospace",
                },
              }),
            ),
            n.message.length > 120
              ? div(
                  {
                    id: `__nmsg_${i}`,
                    onClickId: `__nmsg_${i}`,
                    style: { cursor: "pointer" },
                  },
                  paragraph({
                    text: n.message.substring(0, 120) + " ...",
                    style: {
                      color: "#ccc",
                      fontSize: "11px",
                      margin: "0",
                      lineHeight: "1.3",
                    },
                  }),
                  span({
                    text: "🔍 Tap to read more",
                    style: { color: "#4caf50", fontSize: "9px" },
                  }),
                )
              : paragraph({
                  text: n.message,
                  style: {
                    color: "#ccc",
                    fontSize: "11px",
                    margin: "0",
                    lineHeight: "1.3",
                  },
                }),
          ),
          !n.read
            ? button({
                id: readBtnId,
                text: "✓",
                style: {
                  background: "rgba(76,175,80,0.2)",
                  color: "#4caf50",
                  border: "1px solid #4caf50",
                  borderRadius: "50%",
                  width: "26px",
                  height: "26px",
                  cursor: "pointer",
                  fontSize: "13px",
                  fontWeight: "700",
                  flexShrink: 0,
                },
              })
            : span({}),
        ),
      );

      win.onClick(readBtnId, async () => {
        if (!n.read) {
          n.read = true;
          unreadCount = Math.max(0, unreadCount - 1);
        }
        await updateBadge();
        // Update opacity langsung — tandai sudah dibaca tanpa nutup overlay
        try {
          await win.updateProps(`__nh_${i}`, {
            style: { opacity: "0.5" },
          } as any);
        } catch (_) {}
        try {
          await win.updateProps(readBtnId, {
            style: { display: "none" },
          } as any);
        } catch (_) {}
        // Auto-close overlay kalau semua notif sudah dibaca
        if (unreadCount === 0) {
          try {
            await win.unmount(overlayId);
          } catch (_) {}
        }
      });

      // Klik truncated text → tampilkan alert lengkap + auto mark read
      const msgClickId = `__nmsg_${i}`;
      if (n.message.length > 120) {
        win.onClick(msgClickId, async () => {
          if (!n.read) {
            n.read = true;
            unreadCount = Math.max(0, unreadCount - 1);
          }
          await updateBadge();
          try {
            await win.updateProps(`__nh_${i}`, {
              style: { opacity: "0.5" },
            } as any);
          } catch (_) {}
          try {
            await win.updateProps(readBtnId, {
              style: { display: "none" },
            } as any);
          } catch (_) {}
          await showAlertDialog(win, n.title, n.message);
        });
      }
    }

    try {
      await win.unmount(overlayId);
    } catch (_) {}
    await win.mount(
      div(
        {
          id: overlayId,
          style: {
            position: "fixed",
            bottom: "52px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: "9999998",
            pointerEvents: "auto",
            background: "rgba(22,33,62,0.98)",
            border: "1px solid rgba(76,175,80,0.3)",
            borderRadius: "12px",
            width: "340px",
            maxHeight: "400px",
            overflowY: "auto",
            boxShadow: "0 12px 40px rgba(0,0,0,0.7)",
            display: "flex",
            flexDirection: "column",
          },
        },
        div(
          { style: { flex: "1", overflowY: "auto" } },
          ...rows,
          rows.length === 0
            ? div(
                {
                  style: {
                    padding: "20px",
                    textAlign: "center",
                    color: "#888",
                    fontSize: "12px",
                  },
                },
                span({ text: "No notifications" }),
              )
            : div({}),
        ),
        // Footer — Mark All Read button (hanya tampil kalau ada unread)
        rows.length > 0
          ? div(
              {
                style: {
                  padding: "10px 12px",
                  borderTop: "1px solid rgba(255,255,255,0.08)",
                  display: "flex",
                  justifyContent: "center",
                  flexShrink: 0,
                },
              },
              button({
                id: "__notif_mark_all__",
                text: "✅ Mark All as Read",
                style: {
                  background: "rgba(76,175,80,0.2)",
                  color: "#4caf50",
                  border: "1px solid #4caf50",
                  borderRadius: "8px",
                  padding: "6px 20px",
                  cursor: "pointer",
                  fontSize: "12px",
                  fontWeight: "600",
                },
              }),
            )
          : div({}),
      ),
      "launcher-overlay",
    );

    // Handler: Mark All Read — gunakan notifHistory langsung, bukan closure items
    win.onClick("__notif_mark_all__", async () => {
      for (const n of notifHistory) {
        if (!n.read) {
          n.read = true;
          unreadCount = Math.max(0, unreadCount - 1);
        }
      }
      await updateBadge();
      try {
        await win.unmount(overlayId);
      } catch (_) {}
    });

    await win.flush();
  });

  // Mount flex container
  await win.mount(
    div({
      id: NOTIF_CONTAINER_ID,
      style: {
        position: "fixed",
        zIndex: "9999999",
        pointerEvents: "none",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        ...notifPosStyle,
      },
    }),
    "launcher-overlay",
  );

  async function repositionAll() {
    // Reposition gak perlu — flex container auto-handle!
    // Cukup pastikan zIndex berurutan
    for (let i = 0; i < activeNotifs.length; i++) {
      const n = activeNotifs[i];
      try {
        await win.updateProps(n.id, {
          style: { zIndex: String(9999999 - i) },
        } as any);
      } catch (_) {}
    }
  }

  async function pushNotification(title: string, message: string) {
    const nid = `__an_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    // Track history + unread
    notifHistory.push({ title, message, timestamp: Date.now(), read: false });
    unreadCount++;
    await updateBadge();

    // Play ringtone (async, jangan block notif)
    playNotificationSound();

    // Log
    try {
      const logLine = `[${new Date().toISOString()}] ${title}: ${message}\n`;
      let logContent = "";
      try {
        logContent =
          (await fs.readFile("/opt/asteracea/desktop-notif.log")) || "";
      } catch (_) {}
      const lines = logContent.split("\n").filter((l) => l.trim());
      lines.push(logLine.trim());
      while (lines.length > notifMaxLog) lines.shift();
      await fs.writeFile(
        "/opt/asteracea/desktop-notif.log",
        lines.join("\n") + "\n",
      );
    } catch (_) {}

    try {
      await win.mount(
        div(
          {
            id: nid,
            style: {
              pointerEvents: "auto",
              background: "rgba(30,42,74,0.95)",
              border: "1px solid rgba(76,175,80,0.4)",
              borderRadius: "12px",
              padding: "16px 20px",
              minWidth: "280px",
              maxWidth: "380px",
              boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
              opacity: "0",
              transform: slideDir,
              transition: "opacity 0.3s ease-out, transform 0.3s ease-out",
            },
          },
          div(
            {
              style: {
                display: "flex",
                justifyContent: "space-between",
                marginBottom: "6px",
              },
            },
            span({
              text: title,
              style: { color: "#4caf50", fontSize: "13px", fontWeight: "700" },
            }),
            span({
              text: new Date().toLocaleTimeString(),
              style: {
                color: "#888",
                fontSize: "10px",
                fontFamily: "monospace",
              },
            }),
          ),
          paragraph({
            text: message,
            style: {
              color: "#ccc",
              fontSize: "12px",
              margin: "0",
              lineHeight: "1.4",
            },
          }),
        ),
        NOTIF_CONTAINER_ID,
      );
    } catch (e) {
      return;
    }

    activeNotifs.push({ id: nid, timer: null as any });
    await repositionAll();

    // Animasi masuk
    await new Promise((r) => setTimeout(r, 50));
    try {
      await win.updateProps(nid, {
        style: { opacity: "", transform: "" },
      } as any);
    } catch (_) {}

    // Timer auto-dismiss
    const timer = setTimeout(async () => {
      try {
        await win.updateProps(nid, {
          style: { opacity: "0", transform: slideDir },
        } as any);
        await new Promise((r) => setTimeout(r, 280));
      } catch (_) {}
      try {
        await win.unmount(nid);
      } catch (_) {}
      const i = activeNotifs.findIndex((x) => x.id === nid);
      if (i >= 0) {
        activeNotifs.splice(i, 1);
        await repositionAll();
      }
    }, notifDuration);
    activeNotifs[activeNotifs.length - 1].timer = timer;
  }

  // ================================================================
  // WRITE PID FILE — agar emerald bisa broadcast event ke Asteracea
  // ================================================================
  try {
    await fs.mkdir("/opt/asteracea");
    await fs.writeFile("/opt/asteracea/wm-pid", String(shell.getPid()));
    await std.log(`[asteracea] WM PID=${shell.getPid()}`, "asteracea");
  } catch (_) {
    /* ignore */
  }

  // --- LOAD & APPLY THEME ---
  try {
    await theme.loadCurrent();
    theme.watch();
    const psList = await shell.ps();
    const domePid =
      (psList.find((p: any) => p.name?.includes("dome")) || {}).pid || 0;
    if (domePid) {
      await theme.applyToDome(domePid, win.wid);
      await std.log(
        `[asteracea] Theme applied via DOME PID=${domePid}`,
        "asteracea",
      );
    }
  } catch (e: any) {
    await std.log(`[asteracea] Theme load warning: ${e.message}`, "asteracea");
  }

  // ================================================================
  // BUILD INITIAL UI
  // ================================================================
  await win.mount(
    div(
      {
        id: "wm-root",
        style: { width: "100%", height: "100%", position: "relative" },
      },

      // DESKTOP BACKGROUND
      div({
        id: "desktop",
        style: {
          ...S.desktop,
          background:
            "radial-gradient(ellipse at center, #16213e 0%, #0d1b2a 60%, #0a0f1f 100%)",
        },
      }),

      // LAUNCHER OVERLAY (hidden by default, mounted to __tsix_overlay_layer__ via DOME routing)
      div(
        {
          id: "launcher-overlay",
          style: { ...S.launcherOverlay, display: "none" },
        },
        div(
          { id: "launcher-panel", style: S.launcherPanel },
          input({
            id: "launcher-search",
            placeholder: "🔍  Cari aplikasi...",
            style: {
              width: "100%",
              padding: "12px 18px",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "12px",
              color: "#e0e0e0",
              fontSize: "15px",
              outline: "none",
              marginBottom: "20px",
            },
          }),
          div({
            id: "launcher-grid",
            style: {
              display: "flex",
              flexWrap: "wrap" as any,
              gap: "14px",
              flex: "1",
              marginBottom: "20px",
              overflowY: "auto" as any,
              alignContent: "flex-start",
            },
          }),
          div(
            {
              id: "launcher-footer",
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderTop: "1px solid rgba(255,255,255,0.08)",
                paddingTop: "12px",
              },
            },
            div(
              { style: { display: "flex", alignItems: "center", gap: "8px" } },
              span({ text: "👤", style: { fontSize: "18px" } }),
              span({
                id: "launcher-user",
                text: "tsix",
                style: {
                  color: "#4caf50",
                  fontSize: "12px",
                  fontWeight: "600",
                },
              }),
            ),
            div(
              { style: { display: "flex", gap: "6px" } },
              button({
                id: "launcher-logout",
                text: "🚪 Logout",
                style: {
                  background: "transparent",
                  color: "#aaa",
                  border: "1px solid #555",
                  borderRadius: "6px",
                  padding: "5px 12px",
                  fontSize: "11px",
                  cursor: "pointer",
                },
              }),
              button({
                id: "launcher-reboot",
                text: "🔄 Reboot",
                style: {
                  background: "rgba(244,67,54,0.2)",
                  color: "#f44336",
                  border: "1px solid #f44336",
                  borderRadius: "6px",
                  padding: "5px 12px",
                  fontSize: "11px",
                  cursor: "pointer",
                },
              }),
            ),
          ),
        ),
      ),

      // TASKBAR WRAPPER (centered)
      div(
        { id: "taskbar-wrapper", style: S.taskbarWrapper },
        div(
          { id: "taskbar-inner", style: S.taskbarInner },
          // Grid icon (buka launcher)
          button({ id: "btn-start", text: "☰", style: S.btnStart }),
          // Pinned launchers container
          div({
            id: "tb-pinned",
            style: { display: "flex", gap: "2px", flexShrink: 0 },
          }),
          // Running apps container
          div({
            id: "tb-running",
            style: { display: "flex", gap: "2px", flexShrink: 0 },
          }),
          // Notification badge + Clock
          div(
            {
              id: "tb-notif-wrap",
              style: {
                display: "none",
                alignItems: "center",
                justifyContent: "center",
                marginLeft: "6px",
                marginRight: "4px",
                cursor: "pointer",
                flexShrink: 0,
              },
              onClickId: "tb-notif-wrap",
            },
            div(
              {
                id: "tb-notif-badge",
                style: {
                  background: "#f44336",
                  color: "white",
                  width: "22px",
                  height: "22px",
                  borderRadius: "50%",
                  textAlign: "center",
                  fontSize: "12px",
                  fontWeight: "700",
                  lineHeight: "22px",
                  boxShadow: "0 0 6px rgba(244,67,54,0.5)",
                },
              },
              span({
                id: "tb-notif-count",
                text: "0",
                style: { fontSize: "12px", fontWeight: "700" },
              }),
            ),
          ),
          span({
            id: "clock",
            text: getClock(),
            style: {
              ...S.clock,
              marginLeft:
                notifPosition === "nw" ||
                notifPosition === "sw" ||
                notifPosition === "w"
                  ? "auto"
                  : "initial",
            },
          }),
        ),
      ),
    ),
  );

  // ================================================================
  // LOAD SAVED WALLPAPER
  // ================================================================
  try {
    const wpRaw = await fs.readFile("/opt/asteracea/wallpaper.json");
    if (wpRaw) {
      const wp = JSON.parse(String(wpRaw));
      if (wp.value) {
        await applyWallpaper(win, {
          name: "saved",
          file: wp.value,
          mime: wp.mime || "image/jpeg",
          color: "#333",
        });
        await std.log(
          `[asteracea] Wallpaper restored: ${wp.value}`,
          "asteracea",
        );
      }
    }
  } catch (_) {
    /* no saved wallpaper */
  }

  let launcherOpen = false;
  let running = true;
  let searchTimeout: any = null;
  const pendingErrors = new Map<number, string>();
  // ================================================================
  // LOGIN SCREEN
  // ================================================================
  // Taskbar hidup di overlay layer (selalu di atas semua window) —
  // sembunyikan selama login, tampilkan lagi setelah login sukses.
  await win.updateProps("taskbar-wrapper", { style: { display: "none" } });
  const loggedInUser = await showLoginScreen(win);
  await win.updateProps("taskbar-wrapper", { style: { display: "flex" } });
  await win.updateProps("launcher-user", { text: loggedInUser });

  // ================================================================
  // AUTORUN — jalankan aplikasi dari prefs.json setelah login
  // ================================================================
  try {
    const prefsRaw = await fs.readFile("/opt/asteracea/prefs.json");
    if (prefsRaw) {
      const prefs = JSON.parse(String(prefsRaw));
      const autorunList: string[] = prefs.autorun || [];
      for (const menuFile of autorunList) {
        const appId = menuFile.replace(/\.menu$/i, "");
        const app = APPS.find((a) => a.id === appId);
        if (!app) {
          await std.log(
            `[asteracea] Autorun: app not found for "${menuFile}"`,
            "asteracea",
          );
          continue;
        }
        await std.log(
          `[asteracea] Autorun: launching ${app.label} (${app.command})`,
          "asteracea",
        );
        // openApp handle permission check internally via shell.exec
        try {
          await openApp(win, app, bus, appState, pendingErrors);
        } catch (e: any) {
          await std.log(
            `[asteracea] Autorun: ${app.label} failed — ${e.message}`,
            "asteracea",
          );
        }
      }
    }
  } catch (e: any) {
    await std.log(
      `[asteracea] Autorun: error reading prefs — ${e.message}`,
      "asteracea",
    );
  }

  // ================================================================
  // POPULATE PINNED LAUNCHERS
  // ================================================================
  for (const app of APPS.filter((a) => a.pinnedLauncher)) {
    const btnId = `pl-${app.id}`;
    // Include badge from start (hidden), jadi gak perlu mount terpisah nantinya
    await win.mount(
      button(
        {
          id: btnId,
          onClickId: btnId,
          style: { ...S.tbBtn } as any,
          title: app.label,
        },
        span({ style: { fontSize: "14px" } }, text(app.icon)),
        badge({
          id: `${btnId}-badge`,
          color: "#4caf50",
          size: 6,
          style: { display: "none" },
        }),
      ),
      "tb-pinned",
    );
    win.onClick(btnId, async (ev: any) => {
      try {
        await openApp(win, app, bus, appState, pendingErrors, !!ev.shiftKey);
      } catch (e: any) {
        await std.log(
          `[asteracea] Launcher error: ${e?.message || e}`,
          "asteracea",
        );
      }
    });
  }

  // ================================================================
  // BUILD LAUNCHER GRID (initial)
  // ================================================================
  await buildLauncherGrid(
    win,
    "",
    APPS,
    () => {
      launcherOpen = false;
      toggleLauncher(win, false);
    },
    bus,
    appState,
    pendingErrors,
  );

  // ================================================================
  // EVENTS
  // ================================================================

  // Grid icon toggle launcher
  win.onClick("btn-start", async () => {
    try {
      launcherOpen = !launcherOpen;
      await toggleLauncher(win, launcherOpen);
      if (launcherOpen)
        await buildLauncherGrid(
          win,
          "",
          APPS,
          () => {
            launcherOpen = false;
            toggleLauncher(win, false);
          },
          bus,
          appState,
          pendingErrors,
        );
    } catch (e: any) {
      await std.log(
        `[asteracea] Start menu error: ${e?.message || e}`,
        "asteracea",
      );
    }
  });

  // Click desktop — close launcher + dismiss notif overlay
  win.onClick("desktop", async () => {
    try {
      if (launcherOpen) {
        launcherOpen = false;
        await toggleLauncher(win, false);
      }
    } catch (e: any) {
      await std.log(
        `[asteracea] Desktop click error: ${e?.message || e}`,
        "asteracea",
      );
    }
    try {
      await win.unmount("__notif_overlay__");
    } catch (_) {}
  });

  // Launcher search
  win.onInput("launcher-search", async (ev: any) => {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
      try {
        await buildLauncherGrid(
          win,
          ev.value || "",
          APPS,
          () => {
            launcherOpen = false;
            toggleLauncher(win, false);
          },
          bus,
          appState,
          pendingErrors,
        );
        await win.flush();
      } catch (e: any) {
        await std.log(
          `[asteracea] Search error: ${e?.message || e}`,
          "asteracea",
        );
      }
    }, 150);
  });

  // Logout
  win.onClick("launcher-logout", async () => {
    try {
      await toggleLauncher(win, false);
      launcherOpen = false;
      await closeAllRunningApps(win, appState);
      await win.updateProps("wm-root", { style: { display: "none" } });
      await win.updateProps("taskbar-wrapper", { style: { display: "none" } });
      const newUser = await showLoginScreen(win);
      await win.updateProps("launcher-user", { text: newUser });
      await win.updateProps("wm-root", { style: { display: "block" } });
      await win.updateProps("taskbar-wrapper", { style: { display: "flex" } });
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      await std.log(`[asteracea] Logout error: ${errMsg}`, "asteracea");
      void showError(win, "Logout Error", errMsg);
      // Pastikan desktop tampil lagi walau logout gagal di tengah jalan
      try {
        await win.updateProps("wm-root", { style: { display: "block" } });
        await win.updateProps("taskbar-wrapper", {
          style: { display: "flex" },
        });
      } catch (_) {}
    }
  });

  // Reboot
  win.onClick("launcher-reboot", async () => {
    await toggleLauncher(win, false);
    await std.log("[asteracea] Rebooting system...", "asteracea");
    // SHUTDOWN bisa REJECT — mis. user non-root → "Permission Denied: Only root
    // or root group members can shutdown original system". Tangkap & tampilkan,
    // JANGAN sampai mematikan WM. App tidak ditutup dulu — baru ditutup setelah
    // shutdown terbukti sukses (sistem akan reboot).
    try {
      await shell.shutdown(1);
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      await std.log(`[asteracea] Reboot failed: ${errMsg}`, "asteracea");
      void showError(win, "Reboot Gagal", errMsg);
      return;
    }
    await closeAllRunningApps(win, appState);
    running = false;
    await win.close();
  });

  // ================================================================
  // IPC — MessageBus setup
  // ================================================================
  const lib = (global as any)._tsixLib as any;
  if (lib?.onEvent) {
    lib.onEvent("ipc_message", async (msg: any) => {
      // msg.data = { fromPid, fromUser, data: actualPayload }
      const payloadWrapper = msg?.data;
      const payload = payloadWrapper?.data || payloadWrapper || msg;
      if (!payload) return;

      // --- DESKTOP NOTIFICATION ---
      if (payload.type === "DESKTOP_NOTIF") {
        await pushNotification(
          payload.title || "Notification",
          payload.message || "",
        );
        return;
      }

      if (payload.type === "FOCUS") {
        if (payload.wid && appState.getByWid(payload.wid)) {
          appState.setFocusedWid(payload.wid);
        }
        return;
      }

      // --- DDC TRUST GATE — app minta izin jalankan NJ di browser ---
      if (payload.type === "DDC_TRUST") {
        const fromPid = payloadWrapper?.fromPid || payload.fromPid || 0;
        const appName = payload.appName || `PID ${fromPid}`;
        // Cek ddc trust list (terpisah dari list launcher)
        const [ddcTrusted, ddcBlocked] = await Promise.all([
          readList(DDC_TRUSTED_FILE),
          readList(DDC_BLOCKED_FILE),
        ]);
        let allowed: boolean;
        if (ddcTrusted.includes(appName)) {
          allowed = true;
        } else if (ddcBlocked.includes(appName)) {
          allowed = false;
        } else {
          // Unknown → prompt user (confirm bawaan Emerald, di overlay teratas)
          const ans = await win.confirm(
            "🛡️ Allow Native JS (DDC)?",
            `App "${appName}" wants to run Native JavaScript (NJ) in the browser.\n\n` +
              `NJ runs with full page DOM access, so it could affect other windows.\n\n` +
              `Allow this app to use DDC?\n` +
              `  • Yes → allow & remember\n` +
              `  • No → block & remember\n` +
              `  • Cancel → allow once (not remembered)`,
            ["✅ Yes", "🚫 No", "Cancel"],
          );
          if (ans === "✅ Yes") {
            allowed = true;
            await addToList(DDC_TRUSTED_FILE, appName);
          } else if (ans === "🚫 No") {
            allowed = false;
            await addToList(DDC_BLOCKED_FILE, appName);
          } else {
            // Cancel = user tidak yakin → TOLAK (jangan jalankan NJ)
            allowed = false;
          }
        }
        // Balas ke pemanggil (fire-and-forget — ddc.ts pakai timeout juga)
        try {
          await shell.send(fromPid, {
            type: "DDC_TRUST_RESULT",
            requestId: payload.requestId,
            appName,
            allowed,
          });
        } catch (_) {}
        return;
      }

      // Desktop right-click context menu — posisi mouse dari value JSON
      if (
        payload.eventType === "contextmenu_desktop" &&
        payload.targetId === "__window__"
      ) {
        let cx = 200,
          cy = 200;
        try {
          const pos = JSON.parse(payload.value || "{}");
          cx = pos.x || cx;
          cy = pos.y || cy;
        } catch (_) {}
        void showDesktopContextMenu(win, cx, cy, bus, appState, pendingErrors);
        return;
      }

      // GUI_WINDOW_ERROR — tampilkan LANGSUNG, jangan nunggu app exit
      if (payload.type === "GUI_WINDOW_ERROR" && payload.pid) {
        // Bersihkan file path dari noise Windows (D:\bin\ → /bin/)
        let fileInfo = (payload.file || "").replace(/^[A-Za-z]:[\/\\]/, "/");
        // Bersihkan juga sisa "<anonymous> (" dari fileHint regex
        fileInfo = fileInfo
          .replace(/^.*?\(/, "")
          .replace(/\)\s*$/, "")
          .trim();
        // Bersihkan drive letter dari seluruh error message
        const cleanError = (payload.error || "Unknown error")
          .replace(/[A-Za-z]:[\\/]/g, "/")
          .replace(/\\/g, "/");
        const txt = (fileInfo ? `[${fileInfo}] ` : "") + cleanError;
        const appLabel =
          appState.getByPid(payload.pid)?.entry?.label ||
          payload.context ||
          `PID ${payload.pid}`;
        // Simpan dan langsung tampilkan — app mungkin tidak akan exit
        pendingErrors.set(payload.pid, txt);
        void showError(win, String(appLabel), txt);
        return;
      }

      // GUI_WINDOW_CREATED — track wid
      if (payload.type === "GUI_WINDOW_CREATED" && payload.pid) {
        const inst = appState.getByPid(payload.pid);
        if (inst) {
          // App yang di-launch dari launcher — udah ada entry
          appState.setWid(inst.appId, payload.wid);
          appState.transitionTo(inst.appId, "RUNNING");
          // Maximize on start jika opsi aktif
          if (inst.entry.maximizeOnStart && inst.pid) {
            try {
              await shell.send(inst.pid, {
                type: "GUI_EVENT",
                wid: payload.wid,
                targetId: "__window__",
                eventType: "maximize_window",
              });
            } catch (_) {
              /* app might ignore */
            }
          }
          // Pinned apps punya TB button dengan id pl-${appId}, bukan tb-${appId}-${pid}
          const targetId = inst.entry.pinnedLauncher
            ? `pl-${inst.entry.id}`
            : inst.taskbarId;
          await win.updateProps(targetId, { "data-wid": payload.wid } as any);
        } else {
          // FOREIGN APP — dijalankan dari terminal/shell/file-cruiser
          // Auto-create temporary AppEntry + taskbar button
          await registerForeignApp(
            win,
            payload.pid,
            payload.wid,
            payload.title || `PID ${payload.pid}`,
            payload.icon || "▶️",
            appState,
          );
        }
        return;
      }

      // Cari app by wid
      const inst = appState.getByWid(payload.wid);
      if (!inst) return;

      // Lifecycle events
      if (payload.type === "GUI_WINDOW_MINIMIZED") {
        appState.transitionTo(inst.appId, "MINIMIZED");
        const tbId = inst.entry.pinnedLauncher
          ? `pl-${inst.entry.id}`
          : inst.taskbarId;
        await win.updateProps(tbId, { style: S.tbBtn } as any);
      } else if (payload.type === "GUI_WINDOW_RESTORED") {
        appState.transitionTo(inst.appId, "RUNNING");
        const tbId = inst.entry.pinnedLauncher
          ? `pl-${inst.entry.id}`
          : inst.taskbarId;
        await win.updateProps(tbId, {
          style: { ...S.tbBtn, ...S.tbBtnActive },
        } as any);
      } else if (
        payload.type === "GUI_WINDOW_MAXIMIZED" ||
        payload.type === "GUI_WINDOW_UNMAXIMIZED"
      ) {
        // Maximize/unmaximize (mis. lewat context menu taskbar) = window aktif.
        // Sinkronkan state WM agar klik taskbar berikutnya jadi minimize toggle.
        appState.transitionTo(inst.appId, "RUNNING");
        const tbId = inst.entry.pinnedLauncher
          ? `pl-${inst.entry.id}`
          : inst.taskbarId;
        await win.updateProps(tbId, {
          style: { ...S.tbBtn, ...S.tbBtnActive },
        } as any);
      } else if (payload.type === "GUI_WINDOW_CLOSED") {
        // Cek pending error sebelum cleanup
        const errMsg = pendingErrors.get(inst.pid) || null;
        if (errMsg) {
          pendingErrors.delete(inst.pid);
          void showError(win, inst.entry.label, errMsg);
        }
        // Cleanup
        appState.removeByAppId(inst.appId);
        if (inst.entry.pinnedLauncher) {
          // Pinned: sembunyiin badge + reset style, jangan unmount button-nya
          await win.updateProps(`pl-${inst.entry.id}-badge`, {
            style: { display: "none" },
          } as any);
          await win.updateProps(`pl-${inst.entry.id}`, { style: S.tbBtn } as any);
        } else {
          await win.unmount(inst.taskbarId);
        }
      }
    });
  }

  // ================================================================
  // FLUSH & CLOCK
  // ================================================================
  await win.flush();

  const clockInterval = setInterval(() => {
    win.updateProps("clock", { text: getClock() });
  }, 15000);

  // ================================================================
  // WATCHDOG — cek PID tiap 30 detik, cleanup yang mati mendadak
  // ================================================================
  const watchdogInterval = setInterval(async () => {
    try {
      const allProcs: any[] = (await shell.ps()) || [];
      const livePids = new Set<number>(allProcs.map((p: any) => p.pid));
      for (const [appId, inst] of appState.getAllRunning()) {
        if (!livePids.has(inst.pid)) {
          await std.log(
            `[asteracea] Watchdog: ${inst.entry.label} (PID ${inst.pid}) died unexpectedly`,
            "asteracea",
          );
          const errMsg = pendingErrors.get(inst.pid) || null;
          if (errMsg) {
            pendingErrors.delete(inst.pid);
            void showError(win, inst.entry.label, errMsg);
          }
          appState.removeByAppId(appId);
          await win.unmount(inst.taskbarId);
        }
      }
    } catch (_) {
      /* ignore watchdog errors */
    }
  }, 30000);

  // ================================================================
  // GRACEFUL SHUTDOWN
  // ================================================================
  async function gracefulShutdown() {
    running = false;
    clearInterval(clockInterval);
    clearInterval(watchdogInterval);

    // Send SIGTERM ke semua running apps
    for (const [, inst] of appState.getAllRunning()) {
      try {
        if (inst.pid) await shell.kill(inst.pid, 15); // SIGTERM
      } catch (_) {}
    }

    // Tunggu 3 detik
    await new Promise((r) => setTimeout(r, 3000));

    // SIGKILL survivors
    for (const [, inst] of appState.getAllRunning()) {
      try {
        if (inst.pid) await shell.kill(inst.pid, 9); // SIGKILL
      } catch (_) {}
    }
  }

  win.onClose(async () => {
    try {
      await gracefulShutdown();
    } catch (e: any) {
      await std.log(
        `[asteracea] Shutdown error: ${e?.message || e}`,
        "asteracea",
      );
    }
    try {
      await win.close();
    } catch (_) {}
  });

  // ================================================================
  // MAIN LOOP
  // ================================================================
  while (running) {
    await new Promise((r) => setTimeout(r, 500));
  }

  clearInterval(clockInterval);
  clearInterval(watchdogInterval);
  await win.close();
});

// ================================================================
// HELPERS
// ================================================================

function getClock(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

// ================================================================
// DESKTOP CONTEXT MENU
// ================================================================

// ID dialog wallpaper yang sedang terbuka (vestigial — hanya di-set, dipakai
// showWallpaperDialog). Dideklarasikan module-level agar tidak error TS.
let _wpDialogId = "";
let _ctxMenuId = "";

async function showDesktopContextMenu(
  win: Window,
  clientX: number,
  clientY: number,
  bus?: MessageBus,
  appState?: AppStateManager,
  pendingErrors?: Map<number, string>,
) {
  // Hapus menu lama — pakai fixed ID + unmount rekursif
  try {
    await win.unmount("__ctx_menu");
  } catch (_) {}

  const mid = "__ctx_menu";
  _ctxMenuId = mid;

  // Adjust position: clamp biar gak mentok tepi
  let left = Math.max(5, Math.min(clientX, 1900));
  let top = Math.max(5, Math.min(clientY, 1000));

  // Load menu untuk cari dcm_launcher apps
  let dcmApps: AppEntry[] = [];
  try {
    const allApps = await loadMenuFromFiles();
    dcmApps = allApps.filter((a) => a.dcmLauncher);
  } catch (_) {}

  // Bangun menu items dinamis
  const menuItems: any[] = [];
  // Static: Refresh
  menuItems.push(
    div(
      {
        id: mid + "_refresh",
        onClickId: mid + "_refresh",
        style: {
          padding: "10px 16px",
          cursor: "pointer",
          fontSize: "13px",
          color: "#e0e0e0",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        },
      },
      span({ text: "🔄" }),
      span({ text: "Refresh" }),
    ),
  );
  // Static: Change Wallpaper
  menuItems.push(
    div(
      {
        id: mid + "_wallpaper",
        onClickId: mid + "_wallpaper",
        style: {
          padding: "10px 16px",
          cursor: "pointer",
          fontSize: "13px",
          color: "#e0e0e0",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        },
      },
      span({ text: "🖼️" }),
      span({ text: "Change Wallpaper" }),
    ),
  );
  // Dynamic: dcm_launcher apps (Task Manager, dll)
  for (const app of dcmApps) {
    const divId = mid + "_dcm_" + app.id;
    menuItems.push(
      div(
        {
          id: divId,
          onClickId: divId,
          style: {
            padding: "10px 16px",
            cursor: "pointer",
            fontSize: "13px",
            color: "#e0e0e0",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          },
        },
        span({ text: app.icon }),
        span({ text: app.label }),
      ),
    );
  }
  // Add bottom border to last static item if dcmApps exist
  if (dcmApps.length > 0) {
    const lastStaticIdx = 1; // Wallpaper
    (menuItems[lastStaticIdx].props.style as any).borderBottom =
      "1px solid rgba(255,255,255,0.06)";
  }

  await win.mount(
    div(
      {
        id: mid,
        style: {
          position: "fixed",
          zIndex: "9999999999",
          pointerEvents: "auto",
          top: "0",
          left: "0",
          right: "0",
          bottom: "0",
        },
      },
      // Backdrop (transparent, catch all clicks → dismiss)
      div({
        id: mid + "_bg",
        onClickId: mid + "_bg",
        style: { position: "absolute", inset: "0" },
      }),
      // Menu panel di posisi mouse
      div(
        {
          id: mid + "_menu",
          style: {
            position: "fixed",
            left: left + "px",
            top: top + "px",
            background: "#1e2a4a",
            border: "1px solid #4caf50",
            borderRadius: "10px",
            padding: "6px 0",
            minWidth: "180px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
          },
        },
        ...menuItems,
      ),
    ),
    "launcher-overlay",
  );

  const closeMenu = async () => {
    _ctxMenuId = "";
    await win.unmount(mid);
  };
  // Click events — DCM langsung hilang setelah aksi
  win.onClick(mid + "_bg", closeMenu);
  win.onClick(mid + "_refresh", async () => {
    await closeMenu();
    if (bus && appState)
      await refreshMenus(win, bus, appState, pendingErrors || new Map());
  });
  win.onClick(mid + "_wallpaper", async () => {
    await closeMenu();
    await showWallpaperDialog(win);
  });
  // Dynamic click handlers untuk dcm_launcher apps
  for (const app of dcmApps) {
    const divId = mid + "_dcm_" + app.id;
    win.onClick(divId, async () => {
      await closeMenu();
      if (bus && appState) {
        try {
          await openApp(win, app, bus, appState, pendingErrors || new Map());
        } catch (e: any) {
          await std.log(
            `[asteracea] DCM launch error: ${e?.message || e}`,
            "asteracea",
          );
        }
      }
    });
  }
  await win.flush();
}

async function refreshMenus(
  win: Window,
  bus?: MessageBus,
  appState?: AppStateManager,
  pendingErrors?: Map<number, string>,
) {
  await std.log("[asteracea] Refreshing menus...", "asteracea");
  // Clear pinned launchers
  try {
    await win.setContent("tb-pinned");
  } catch (_) {}
  // Reload
  const apps = await loadMenuFromFiles();
  for (const app of apps.filter((a) => a.pinnedLauncher)) {
    const btnId = `pl-${app.id}`;
    await win.mount(
      button(
        {
          id: btnId,
          onClickId: btnId,
          style: { ...S.tbBtn } as any,
          title: app.label,
        },
        span({ style: { fontSize: "14px" } }, text(app.icon)),
        // Badge hidden by default
        badge({
          id: `${btnId}-badge`,
          color: "#4caf50",
          size: 6,
          style: { display: "none" },
        }),
      ),
      "tb-pinned",
    );
    win.onClick(btnId, async (ev: any) => {
      if (bus && appState) {
        try {
          await openApp(
            win,
            app,
            bus,
            appState,
            pendingErrors || new Map(),
            !!ev.shiftKey,
          );
        } catch (e: any) {
          await std.log(
            `[asteracea] Launcher error: ${e?.message || e}`,
            "asteracea",
          );
        }
      }
    });
  }
  await win.flush();
  await std.log("[asteracea] Menus refreshed", "asteracea");
}

async function toggleLauncher(win: Window, open: boolean) {
  if (open) {
    await win.updateProps("launcher-overlay", {
      style: { ...S.launcherOverlay, display: "flex" },
    } as any);
    await win.updateProps("btn-start", {
      style: { ...S.btnStart, background: "rgba(76,175,80,0.15)" },
    } as any);
  } else {
    await win.updateProps("launcher-overlay", {
      style: { ...S.launcherOverlay, display: "none" },
    } as any);
    await win.updateProps("btn-start", {
      style: { ...S.btnStart, background: "transparent" },
    } as any);
  }
}

async function buildLauncherGrid(
  win: Window,
  filter: string,
  apps: AppEntry[],
  onAppPicked?: () => void,
  bus?: MessageBus,
  appState?: AppStateManager,
  pendingErrors?: Map<number, string>,
) {
  const q = filter.toLowerCase();
  const filtered = apps.filter(
    (a) => !q || fuzzyMatch(q, a.label) || fuzzyMatch(q, a.id),
  );

  // ── KELOMPOKKAN berdasarkan group ──
  // - App TANPA group (group kosong) → tampil PALING ATAS.
  // - App ber-group → dikelompokkan per group (urut abjad).
  const groups = new Map<string, AppEntry[]>();
  const noGroup: AppEntry[] = [];
  for (const app of filtered) {
    if (app.group && app.group.trim()) {
      const g = app.group.trim();
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(app);
    } else {
      noGroup.push(app);
    }
  }
  const groupNames = Array.from(groups.keys()).sort((a, b) =>
    a.localeCompare(b),
  );

  const makeAppCard = (app: AppEntry): any =>
    div(
      {
        id: `lg-${app.id}`,
        style: {
          display: "flex",
          flexDirection: "column" as any,
          alignItems: "center",
          padding: "14px 10px",
          borderRadius: "14px",
          cursor: "pointer",
          width: "96px",
          border: "none",
          background: "transparent",
          transition: "background 0.15s",
        },
      },
      span({
        text: app.icon,
        style: { fontSize: "28px", marginBottom: "4px" },
      }),
      span({
        text: app.label,
        style: { color: "#ccc", fontSize: "10px", textAlign: "center" },
      }),
    );

  const makeGroupHeader = (label: string): any =>
    div({
      style: {
        width: "100%",
        color: "#8fa1c7",
        fontSize: "11px",
        fontWeight: "700",
        textTransform: "uppercase" as any,
        letterSpacing: "1px",
        margin: "10px 0 2px",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        paddingBottom: "4px",
      },
      text: label,
    });

  const children: any[] = [];

  // 1) Tanpa group — paling atas
  if (noGroup.length > 0) {
    children.push(makeGroupHeader("Aplikasi"));
    children.push(...noGroup.map(makeAppCard));
  }

  // 2) Group-group (urut abjad)
  for (const g of groupNames) {
    children.push(makeGroupHeader(g));
    children.push(...groups.get(g)!.map(makeAppCard));
  }

  await win.setContent("launcher-grid", ...children);

  // Click handlers — tetap per app (sama seperti sebelumnya)
  for (const app of filtered) {
    win.onClick(`lg-${app.id}`, async (ev: any) => {
      try {
        if (onAppPicked) onAppPicked();
        await toggleLauncher(win, false);
        if (appState && pendingErrors)
          await openApp(
            win,
            app,
            bus!,
            appState,
            pendingErrors,
            !!ev.shiftKey,
          );
      } catch (e: any) {
        await std.log(`[asteracea] Launcher error: ${e.message}`, "asteracea");
      }
    });
  }
  await win.flush();
}

// ================================================================
// APP LAUNCHER
// ================================================================

async function openApp(
  win: Window,
  app: AppEntry,
  bus: MessageBus,
  appState: AppStateManager,
  pendingErrors: Map<number, string>,
  forceNew = false,
) {
  // If already running — restore/minimize toggle
  const existing = appState.getByAppId(app.id);
  if (existing && !forceNew) {
    // Toggle minimize/restore
    if (existing.state === "MINIMIZED") {
      appState.transitionTo(existing.appId, "RUNNING");
      if (existing.wid && existing.pid) {
        await shell.send(existing.pid, {
          type: "GUI_EVENT",
          wid: existing.wid,
          targetId: "__window__",
          eventType: "restore_window",
        });
      }
      const tbId = existing.entry.pinnedLauncher
        ? `pl-${existing.entry.id}`
        : existing.taskbarId;
      await win.updateProps(tbId, {
        style: { ...S.tbBtn, ...S.tbBtnActive },
      } as any);
    } else if (
      existing.state === "RUNNING" &&
      appState.isFocused(existing.wid)
    ) {
      appState.transitionTo(existing.appId, "MINIMIZED");
      if (existing.wid && existing.pid) {
        await shell.send(existing.pid, {
          type: "GUI_EVENT",
          wid: existing.wid,
          targetId: "__window__",
          eventType: "minimize_window",
        });
      }
      const tbId = existing.entry.pinnedLauncher
        ? `pl-${existing.entry.id}`
        : existing.taskbarId;
      await win.updateProps(tbId, { style: S.tbBtn } as any);
    } else if (existing.state === "RUNNING" && existing.wid) {
      await shell.send("da8711c2-5ca9-4f00-ad13-f1226f95594c", {
        type: "FOCUS_WINDOW",
        wid: existing.wid,
      });
      appState.setFocusedWid(existing.wid);
      const tbId = existing.entry.pinnedLauncher
        ? `pl-${existing.entry.id}`
        : existing.taskbarId;
      await win.updateProps(tbId, {
        style: { ...S.tbBtn, ...S.tbBtnActive },
      } as any);
    }
    return;
  }

  // ── Launch via shell.exec ──
  // NOTE: Trust gate TIDAK lagi di sini. Hanya DDC (mountDDC) yang di-gate —
  //   karena NJ (Native JS) yang dieksekusi di browser adalah satu-satunya
  //   ancaman DOM nyata. TGA non-DDC (declarative) & CLI/daemon dianggap
  //   trusted & langsung jalan tanpa prompt.
  //
  // PENTING: shell.exec() BISA REJECT — mis. target tidak punya flag eksekusi
  // → kernel lempar "Permission Denied: Cannot execute ...". Dulu rejection ini
  // tidak di-catch → jadi Unhandled Rejection → WorkerEntry realExit(1) → WM
  // (Asteracea) crash. Sekarang ditangkap & ditampilkan ke user, bukan dimatikan.
  let proc: any;
  try {
    proc = await shell.exec(`${app.command}`, app.params || []);
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    await std.log(
      `[asteracea] Failed to launch ${app.label} (${app.command}): ${errMsg}`,
      "asteracea",
    );
    void showError(
      win,
      app.label,
      `Failed to run the application.\n\n${errMsg}`,
    );
    return;
  }
  if (!proc || !proc.pid) {
    await std.log(`[asteracea] Failed to launch ${app.command}`, "asteracea");
    return;
  }
  await std.log(
    `[asteracea] Launched ${app.label} PID=${proc.pid}`,
    "asteracea",
  );

  // Track as running
  const stateAppId = forceNew ? `${app.id}#${proc.pid}` : app.id;
  // A forced instance needs its own taskbar button, even when the app is pinned.
  const launchEntry =
    forceNew && app.pinnedLauncher ? { ...app, pinnedLauncher: false } : app;
  const inst = appState.add(stateAppId, proc.pid, launchEntry);
  const btnId = inst.taskbarId;

  // Mount taskbar button — reuse PL id if pinned, else create new TB
  const isPinned = launchEntry.pinnedLauncher;
  const containerId = isPinned ? "tb-pinned" : "tb-running";
  if (!isPinned) {
    await win.mount(
      button(
        {
          id: btnId,
          onClickId: btnId,
          style: { ...S.tbBtn, ...S.tbBtnActive } as any,
          title: app.label,
        },
        span({ style: { fontSize: "14px" } }, text(app.icon)),
        badge({ id: `${btnId}-badge`, color: "#4caf50", size: 6 }),
      ),
      containerId,
    );
  } else {
    // PL pinned — show RI badge + active style (badge sudah include dari awal)
    const badgeId = isPinned ? `pl-${app.id}-badge` : `${btnId}-badge`;
    try {
      await win.updateProps(badgeId, {
        style: {
          display: "inline-block",
          background: "#4caf50",
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          boxShadow: "0 0 9px #4caf50",
          animation: "tsix-pulse 1.4s ease-in-out infinite",
        },
      });
    } catch (_) {}
    // Update pinned button style jadi active
    if (isPinned) {
      try {
        await win.updateProps(`pl-${app.id}`, {
          style: { ...S.tbBtn, ...S.tbBtnActive },
        } as any);
      } catch (_) {}
    }
  }

  // Click handler — minimize/restore toggle
  // Pinned apps: style di-update ke pl-${app.id}, bukan inst.taskbarId
  const tbStyleId = isPinned ? `pl-${app.id}` : btnId;
  win.onClick(btnId, async () => {
    const i = appState.getByPid(inst.pid);
    if (!i || !i.wid || !i.pid) return;
    if (i.state === "MINIMIZED") {
      appState.transitionTo(i.appId, "RUNNING");
      await shell.send(i.pid, {
        type: "GUI_EVENT",
        wid: i.wid,
        targetId: "__window__",
        eventType: "restore_window",
      });
      await win.updateProps(tbStyleId, {
        style: { ...S.tbBtn, ...S.tbBtnActive },
      } as any);
    } else if (appState.isFocused(i.wid)) {
      appState.transitionTo(i.appId, "MINIMIZED");
      await shell.send(i.pid, {
        type: "GUI_EVENT",
        wid: i.wid,
        targetId: "__window__",
        eventType: "minimize_window",
      });
      await win.updateProps(tbStyleId, { style: S.tbBtn } as any);
    } else {
      await shell.send("da8711c2-5ca9-4f00-ad13-f1226f95594c", {
        type: "FOCUS_WINDOW",
        wid: i.wid,
      });
      appState.setFocusedWid(i.wid);
      await win.updateProps(tbStyleId, {
        style: { ...S.tbBtn, ...S.tbBtnActive },
      } as any);
    }
  });

  await win.flush();

  // ================================================================
  // WAITPID — deteksi exit, cek pending errors
  // ================================================================
  (async () => {
    try {
      await shell.waitpid(proc.pid);
    } catch (_) {
      /* process already dead */
    }

    // Cek pending error (dari std.error() atau Runtime Error via IPC)
    const errMsg = pendingErrors.get(proc.pid) || null;
    if (errMsg) {
      pendingErrors.delete(proc.pid);
      void showError(win, app.label, errMsg);
    }

    // Hapus TB dari taskbar jika masih ada
    if (appState.getByPid(proc.pid)) {
      appState.removeByPid(proc.pid);
      if (isPinned) {
        try {
          await win.updateProps(`pl-${app.id}-badge`, {
            style: { display: "none" },
          } as any);
        } catch (_) {}
        try {
          await win.updateProps(`pl-${app.id}`, { style: S.tbBtn } as any);
        } catch (_) {}
      } else {
        try {
          await win.unmount(inst.taskbarId);
        } catch (_) {}
      }
    }
  })();
}

async function applyWallpaper(
  win: Window,
  wp: {
    name: string;
    file?: string;
    mime: string;
    color: string;
    b64?: string;
  },
) {
  try {
    const b64 = wp.b64 || (wp.file ? await fs.readFile(wp.file) : null);
    if (!b64) return;
    const uri = `url(data:${wp.mime || "image/jpeg"};base64,${b64})`;
    await win.updateProps("desktop", {
      style: {
        ...S.desktop,
        background: `${uri} center/cover no-repeat, #0a0f1f`,
      },
    });
  } catch (e) {
    /* ignore */
  }
}

// ================================================================
// FOREIGN APP — register app yang dijalankan dari luar launcher
// (terminal, shell, file-cruiser, dll). Auto-create taskbar button.
// ================================================================

/** Counter untuk ID unik foreign apps */
let _foreignAppCounter = 0;

async function registerForeignApp(
  win: Window,
  pid: number,
  wid: string,
  title: string,
  icon: string,
  appState: AppStateManager,
) {
  // Buat AppEntry sementara untuk app yang tidak dikenal
  _foreignAppCounter++;
  const appId = `__foreign_${pid}`;
  const entry: AppEntry = {
    id: appId,
    icon: icon || "▶️",
    label: title,
    command: "",
    params: [],
    pinnedLauncher: false,
    dcmLauncher: false,
    maximizeOnStart: false,
    group: "",
  };

  const inst = appState.add(appId, pid, entry);
  appState.setWid(appId, wid);
  appState.transitionTo(appId, "RUNNING");

  // Mount taskbar button di tb-running
  const btnId = inst.taskbarId;
  await win.mount(
    button(
      {
        id: btnId,
        onClickId: btnId,
        style: { ...S.tbBtn, ...S.tbBtnActive } as any,
        "data-wid": wid,
        title, // tooltip (→ data-tt di DOME) — konsisten dgn taskbar app terdaftar
      },
      span({ style: { fontSize: "14px" } }, text(icon || "▶️")),
      badge({ id: `${btnId}-badge`, color: "#4caf50", size: 6 }),
    ),
    "tb-running",
  );

  // Click handler — minimize/restore toggle
  win.onClick(btnId, async () => {
    const i = appState.getByAppId(appId);
    if (!i || !i.wid || !i.pid) return;
    if (i.state === "MINIMIZED") {
      appState.transitionTo(appId, "RUNNING");
      await shell.send(i.pid, {
        type: "GUI_EVENT",
        wid: i.wid,
        targetId: "__window__",
        eventType: "restore_window",
      });
      await win.updateProps(btnId, {
        style: { ...S.tbBtn, ...S.tbBtnActive },
      } as any);
    } else {
      appState.transitionTo(appId, "MINIMIZED");
      await shell.send(i.pid, {
        type: "GUI_EVENT",
        wid: i.wid,
        targetId: "__window__",
        eventType: "minimize_window",
      });
      await win.updateProps(btnId, { style: S.tbBtn } as any);
    }
  });

  await win.flush();

  // Waitpid — cleanup saat app exit
  (async () => {
    try {
      await shell.waitpid(pid);
    } catch (_) {}
    if (appState.getByAppId(appId)) {
      appState.removeByAppId(appId);
      try {
        await win.unmount(btnId);
      } catch (_) {}
    }
  })();

  await std.log(
    `[asteracea] Foreign app registered: ${title} (PID ${pid})`,
    "asteracea",
  );
}

async function closeAllRunningApps(win: Window, appState: AppStateManager) {
  for (const [appId, inst] of appState.getAllRunning()) {
    try {
      if (inst.wid && inst.pid) {
        await shell.send(inst.pid, {
          type: "GUI_EVENT",
          wid: inst.wid,
          targetId: "__window__",
          eventType: "close_window",
        });
      }
      await win.unmount(inst.taskbarId);
    } catch (e) {
      /* ignore */
    }
  }
}
