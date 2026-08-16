/**
 * telechat.ts — 💬 TeleChat Client: Chat GUI E2E antar node TSIX
 *
 * Client (GUI) untuk server chat /opt/telechatd/telechatd.ts (daemon headless).
 *
 * Keamanan E2E (ditiru dari air-type):
 *   - Handshake RSA (public key server + fingerprint) → negosiasi session key
 *     ChaCha20-Poly1305 32-byte yang DINAMIS per koneksi (bukan key statis).
 *   - Anti-MITM via known_hosts (fingerprint server, seperti SSH).
 *   - Setelah handshake, semua payload chat dienkripsi end-to-end per link.
 *
 * Identitas 3 lapis (spek §2.1):
 *   - clientId : UUID persisten di /etc/telechat/config.json — TIDAK berubah
 *                saat aplikasi ditutup/dibuka (basis anti-duplikat reconnect).
 *   - nickname : label visual unik antar pengguna aktif.
 *
 * Konfigurasi & data (/etc/telechat/):
 *   /etc/telechat/config.json    — { server, port, nickname, clientId, ... }
 *   /etc/telechat/history.json   — riwayat chat per-room
 *   /etc/telechat/known_hosts    — fingerprint server (anti MITM)
 *
 * Jalankan:
 *   telechat <serverAddr> [port] [nick]   (GUI)
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, shell, net, fs } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";
import { PacketFlags } from "@common/PacketFlags";
import { IDOMNode } from "@common/GUITypes";
import {
  TForm,
  TPanel,
  TLabel,
  TButton,
  TEdit,
  TStatusBar,
  TSplitHorizontal,
  HStack,
  TDialogs,
  TScrollBox,
  TTimer,
} from "@tsix/cashew";

export const appMode = "gui";

// ────────────────────────────────────────────────────────────
// KONSTANTA
// ────────────────────────────────────────────────────────────
const DEFAULT_PORT = 2510; // port chat default (server telechatd)
const RSA_DIR = "/etc/keys/rsa"; // identitas RSA node (id_rsa / id_rsa.pub)
const CONFIG_PATH = "/etc/telechat/config.json";
const HISTORY_PATH = "/etc/telechat/history.json";
const KNOWN_HOSTS_PATH = "/etc/telechat/known_hosts";
const FLAG = PacketFlags.FLAG_DATA;
const LOBBY = "#lobby";
// Identity Asteracea (Window Manager) — untuk push desktop notification (toast).
const AST_IDENTITY = "3ec3ffe9-e0a6-411f-b7e3-c9ff0b00556c";

interface ChatMsg {
  from: string;
  text: string;
  ts: number;
  own?: boolean;
  sys?: boolean;
  err?: boolean;
}

/** clientId stabil (persisted di config) — identitas unik pengguna anti-duplikat reconnect. */
function genClientId(): string {
  const r4 = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
  return `${r4()}${r4()}-${r4()}-${r4()}-${r4()}${r4()}`;
}

export const main = Program(async (args: string[]) => {
  // ──────────────────────────────────────────────────────────
  // ARGS + CONFIG LOAD
  // ──────────────────────────────────────────────────────────
  const pos = args.filter((a) => !a.startsWith("-"));

  let cfg: any = {
    server: "",
    port: DEFAULT_PORT,
    nickname: "",
    clientId: "",
    heartbeatInterval: 15, // 10–30 dtk per spek §4.4
    active_status: 1,
    phone_number: "",
    email: "",
  };
  try {
    cfg = { ...cfg, ...JSON.parse((await fs.readFile(CONFIG_PATH)) || "{}") };
  } catch (_) {
    /* config optional */
  }

  const heartbeatIntervalSec = Math.max(
    3,
    parseInt(cfg.heartbeatInterval) || 15,
  );
  const pingIntervalMs = heartbeatIntervalSec * 1000;

  // clientId STABIL — identitas unik pengguna (tersimpan di config.json).
  let clientId = cfg.clientId || genClientId();
  let nickname = cfg.nickname || (await shell.getenv("HOSTNAME")) || "user";
  let activeStatus = clampInt(cfg.active_status, 0, 2, 1);
  let role = "guest";

  let port = cfg.port || DEFAULT_PORT;
  let serverAddr = cfg.server || "";
  let nicknameProvided = !!cfg.nickname;

  serverAddr = pos[0] || serverAddr;
  if (pos[1]) port = parseInt(pos[1]) || port;
  if (pos[2]) {
    nickname = pos[2];
    nicknameProvided = true;
  }

  await std.log(
    `[telechat] Mode: CLIENT | nick=${nickname} | port=${port}`,
    "telechat",
  );

  // ──────────────────────────────────────────────────────────
  // STATE APLIKASI
  // ──────────────────────────────────────────────────────────
  let running = true;
  let connected = false;
  let connecting = false;
  let banned = false;
  let currentRoom = LOBBY;
  const rooms: string[] = [LOBBY];
  const history: Record<string, ChatMsg[]> = {};
  const membersByRoom: Record<string, { nick: string; lastSeen: number }[]> =
    {};
  let onlineMaxAge = 60; // sinyal <= 60 dtk → Online (hijau), > 60 → Offline (merah)
  let inputText = "";
  let serverInputText = "";
  let clientFd = -1;
  let clientLocalPort = 0;

  // ──────────────────────────────────────────────────────────
  // PERSISTENSI HISTORY (load awal)
  // ──────────────────────────────────────────────────────────
  try {
    const raw = await fs.readFile(HISTORY_PATH);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const k of Object.keys(parsed)) {
          if (Array.isArray(parsed[k]) && parsed[k].length > 0) {
            history[k] = parsed[k];
            if (!rooms.includes(k)) rooms.push(k);
          }
        }
      }
    }
  } catch (_) {
    /* belum ada history */
  }

  // ──────────────────────────────────────────────────────────
  // UI (Cashew)
  // ──────────────────────────────────────────────────────────
  const form = new TForm({ title: "💬 TeleChat", width: 900, height: 600 });

  // ── Top Toolbar (spek §5): input alamat server + Connect/Disconnect ──
  const serverInput = new TEdit("server-input", {
    flex: "1",
    minWidth: "0",
    fontSize: "12px",
  });
  serverInput.placeholder = "Server address (e.g., tsix-node-2:2510)…";
  serverInput.onInput = (val) => {
    serverInputText = val;
  };
  if (serverAddr) serverInput.text = `${serverAddr}:${port}`;

  const btnConnect = new TButton("btn-connect", {
    height: "32px",
    padding: "0 16px",
    fontSize: "12px",
    fontWeight: "700",
    background: "rgba(33,150,243,0.15)",
    color: "#2196f3",
    border: "1px solid #2196f3",
  });
  btnConnect.caption = "Connect";
  btnConnect.onClick = () => void toggleConnect();

  // ── Header ──
  const lblTitle = new TLabel("lbl-title", {
    color: "var(--accent, #4caf50)",
    fontWeight: "700",
    fontSize: "15px",
  });
  lblTitle.caption = "💬 TeleChat";

  const lblRole = new TLabel("lbl-role", {
    padding: "2px 8px",
    borderRadius: "10px",
    fontSize: "11px",
    fontWeight: "700",
  });
  lblRole.caption = "👤 guest";

  const lblNick = new TLabel("lbl-nick", { fontSize: "12px" });
  lblNick.caption = `🧑 ${nickname}`;

  const lblStatusTop = new TLabel("lbl-status", {
    color: "var(--text-muted, #888)",
    fontSize: "11px",
  });
  lblStatusTop.caption = "⏳ initializing…";

  const btnNewRoom = new TButton("btn-newroom", {
    height: "28px",
    padding: "0 10px",
    fontSize: "12px",
    background: "rgba(33,150,243,0.12)",
    color: "#2196f3",
    border: "1px solid rgba(33,150,243,0.4)",
  });
  btnNewRoom.caption = "＋ New Room";
  btnNewRoom.onClick = () => void createRoom();

  form.add(
    HStack(
      { padding: "0 0 6px 0", gap: "8px", flexWrap: "nowrap" },
      serverInput,
      btnConnect,
    ),
  );
  form.add(
    HStack(
      { padding: "2px 0 8px 0", gap: "10px" },
      lblTitle,
      lblRole,
      lblNick,
      lblStatusTop,
    ),
  );

  // ── Panel kiri (30%) — room list + anggota #lobby ──
  const leftPanel = new TPanel("left-panel", {
    padding: "6px",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    background: "var(--surface, rgba(0,0,0,0.2))",
  });
  const lblRooms = new TLabel("lbl-rooms", {
    color: "var(--text-muted, #888)",
    fontSize: "11px",
    fontWeight: "700",
  });
  lblRooms.caption = "📁 CHAT ROOMS";
  leftPanel.add(lblRooms);

  const roomListBox = TScrollBox("room-list", {
    flex: "1",
    minHeight: "0",
    background: "var(--surface, rgba(0,0,0,0.2))",
    border: "1px solid var(--border, #333)",
    borderRadius: "6px",
    padding: "4px",
  });
  leftPanel.add(roomListBox);

  const btnNewRoom2 = new TButton("btn-newroom2", {
    height: "28px",
    padding: "0 8px",
    fontSize: "12px",
    background: "rgba(33,150,243,0.12)",
    color: "#2196f3",
    border: "1px solid rgba(33,150,243,0.4)",
    display: "none",
  });
  btnNewRoom2.caption = "＋ Create Room";
  btnNewRoom2.onClick = () => void createRoom();
  leftPanel.add(btnNewRoom2);

  // ── Panel kanan (70%) — history + activity + input ──
  const rightPanel = new TPanel("right-panel", {
    padding: "6px",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    background: "transparent",
  });
  const lblRoom = new TLabel("lbl-room", {
    color: "var(--accent, #4caf50)",
    fontWeight: "700",
    fontSize: "13px",
  });
  lblRoom.caption = LOBBY;
  rightPanel.add(lblRoom);

  const historyBox = TScrollBox("history", {
    flex: "1",
    minHeight: "0",
    background: "var(--bg, #0d1b2a)",
    border: "1px solid var(--border, #333)",
    borderRadius: "6px",
    padding: "6px",
    overflowY: "auto",
  });
  rightPanel.add(historyBox);

  const input = new TEdit("msg-input", { flex: "1", minWidth: "0" });
  input.placeholder = `Write a message in ${currentRoom}… (Enter to send, / for commands)`;
  input.props.autofocus = true;
  // PENTING: set onInput SEBELUM form.run() — cashew auto-bind event saat run().
  input.onInput = (val) => {
    inputText = val;
  };

  const btnSend = new TButton("send-btn", {
    height: "34px",
    padding: "0 16px",
    background: "rgba(76,175,80,0.18)",
    color: "#4caf50",
    border: "1px solid #4caf50",
  });
  btnSend.caption = "➤ Send";
  btnSend.onClick = () => void sendMessage();

  rightPanel.add(HStack({ padding: "0" }, input, btnSend));

  form.add(TSplitHorizontal(leftPanel, rightPanel, "0 0 30%"));

  // Status bar bawah
  const statusBar = new TStatusBar("status");
  statusBar.text = `📡 ${serverAddr || "?"}:${port} · 🔒 E2E chacha20 (RSA handshake)`;
  form.add(statusBar);

  // Timer managed (TTimer) — auto-cleanup saat form ditutup.
  // presence: refresh warna indikator tiap 4 dtk (umur sinyal bertambah).
  const presenceTimer = new TTimer("tmr-presence", 4000, false);
  presenceTimer.onTimer = () => {
    if (running) void renderRooms();
  };
  form.add(presenceTimer);

  // ping: heartbeat keepalive ke server (interval dari config, spek §4.4).
  const pingTimer = new TTimer("tmr-ping", pingIntervalMs, false);
  pingTimer.onTimer = () => {
    if (running && connected && clientFd >= 0) {
      void clientSend({ t: "ping", ts: Date.now() }).catch(() => {});
    }
  };
  form.add(pingTimer);

  // ──────────────────────────────────────────────────────────
  // FUNGSI RENDER UI
  // ──────────────────────────────────────────────────────────
  function clampInt(v: any, min: number, max: number, def: number): number {
    const n = parseInt(v);
    if (isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
  }

  function setStatus(text: string) {
    try {
      statusBar.text = text;
      lblStatusTop.caption = text;
    } catch (_) {
      /* ignore */
    }
  }

  let msgSeq = 0;
  async function renderHistory() {
    const msgs = history[currentRoom] || [];
    const nodes: IDOMNode[] = msgs.map((m) => {
      msgSeq++;
      const idBase = `msg${msgSeq}`;
      const time = new Date(m.ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      const style: Record<string, any> = {
        padding: "3px 8px",
        borderRadius: "6px",
        marginBottom: "3px",
        fontSize: "12px",
        lineHeight: "1.45",
        wordBreak: "break-word",
        background:
          m.sys || m.err
            ? "transparent"
            : m.own
              ? "var(--accent-bg, rgba(76,175,80,0.14))"
              : "var(--surface, rgba(255,255,255,0.04))",
        color: m.err
          ? "#ef5350"
          : m.sys
            ? "var(--text-muted, #999)"
            : "var(--text, #e0e0e0)",
      };
      return {
        id: idBase,
        tag: "div",
        props: { style },
        children: [
          {
            id: idBase + "t",
            tag: "span",
            props: {
              style: { color: "var(--text-muted,#888)", fontSize: "11px" },
              text: `[${time}] `,
            },
            children: [],
          },
          {
            id: idBase + "f",
            tag: "span",
            props: {
              style: m.err
                ? { color: "#ef5350", fontWeight: "700" }
                : m.sys
                  ? { color: "#ffb74d", fontWeight: "700" }
                  : { color: "var(--accent,#4caf50)", fontWeight: "700" },
              text: m.sys || m.err ? `${m.from} ` : `${m.from}: `,
            },
            children: [],
          },
          {
            id: idBase + "b",
            tag: "span",
            props: { style: {}, text: m.text },
            children: [],
          },
        ],
      };
    });
    await form.screen.setContent("history", ...nodes);
    await form.screen.update("history", { scrollTop: 999999 });
  }

  // Serialisasi render daftar room — cegah dua setContent("room-list") yang
  // tumpang tindih (race) yang membuat item ter-duplikasi di browser.
  // Spek §5: hanya #lobby yang menampilkan daftar anggota (dengan indikator
  // presensi Hijau=Online / Merah=Offline); room lain hanya nama room.
  let roomsRenderChain: Promise<void> = Promise.resolve();
  function bulletColor(lastSeen: number): string {
    const age = Math.floor((Date.now() - lastSeen) / 1000);
    return age <= onlineMaxAge ? "#4caf50" : "#f44336"; // hijau / merah
  }
  function safeId(s: string): string {
    return String(s).replace(/[^A-Za-z0-9_-]/g, "-");
  }
  function renderRooms(): Promise<void> {
    roomsRenderChain = roomsRenderChain
      .then(async () => {
        const rows: IDOMNode[] = [];
        for (const room of rooms) {
          const isActive = room === currentRoom;
          const roomId = `room-row-${safeId(room)}`;
          rows.push({
            id: roomId,
            tag: "div",
            props: {
              onClickId: roomId,
              style: {
                padding: "5px 4px",
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: "700",
                color: isActive
                  ? "var(--accent, #4caf50)"
                  : "var(--text, #e0e0e0)",
                background: isActive
                  ? "var(--accent-bg, rgba(76,175,80,0.15))"
                  : "transparent",
                borderRadius: "4px",
              },
              text: `# ${room.replace(/^#/, "")}`,
            },
            children: [],
          });
          // Hanya #lobby yang menampilkan daftar anggota (spek §5)
          if (room === LOBBY) {
            const members = membersByRoom[room] || [];
            members.forEach((m, i) => {
              const memId = `member-${safeId(room)}-${i}`;
              rows.push({
                id: memId,
                tag: "div",
                props: {
                  style: {
                    padding: "2px 4px 2px 18px",
                    fontSize: "11px",
                    color: "var(--text-dim, #aaa)",
                  },
                },
                children: [
                  {
                    id: `bullet-${memId}`,
                    tag: "span",
                    props: {
                      style: {
                        display: "inline-block",
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        background: bulletColor(m.lastSeen),
                        marginRight: "6px",
                        verticalAlign: "middle",
                      },
                      text: "",
                    },
                    children: [],
                  },
                  {
                    id: `name-${memId}`,
                    tag: "span",
                    props: { style: {}, text: m.nick },
                    children: [],
                  },
                ],
              });
            });
          }
        }
        await form.screen.setContent("room-list", ...rows);
        // Bind klik room header (aman: registerHandler REPLACE, bukan stack).
        for (const room of rooms) {
          const roomId = `room-row-${safeId(room)}`;
          form.screen.on(roomId, "click", () => {
            void setRoom(room)
              .then(() => renderRooms())
              .catch(() => {});
          });
        }
        await form.screen.win.flush();
      })
      .catch(() => {});
    return roomsRenderChain;
  }

  function pushMsg(room: string, msg: ChatMsg, persist = true) {
    if (!history[room]) history[room] = [];
    history[room].push(msg);
    if (history[room].length > 500) history[room].shift();
    if (room === currentRoom) void renderHistory();
    if (persist) void saveHistoryDebounced();
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function saveHistoryDebounced() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveHistory(), 800);
  }
  async function saveHistory() {
    try {
      try {
        await fs.mkdir("/etc/telechat");
      } catch (_) {
        /* sudah ada */
      }
      await fs.writeFile(HISTORY_PATH, JSON.stringify(history));
    } catch (_) {
      /* non-fatal: history tetap in-memory */
    }
  }

  async function saveConfig() {
    try {
      try {
        await fs.mkdir("/etc/telechat");
      } catch (_) {
        /* sudah ada */
      }
      const data = {
        server: serverAddr,
        port,
        nickname,
        clientId,
        heartbeatInterval: heartbeatIntervalSec,
        active_status: activeStatus,
        phone_number: cfg.phone_number || "",
        email: cfg.email || "",
      };
      await fs.writeFile(CONFIG_PATH, JSON.stringify(data, null, 2));
    } catch (_) {
      /* non-fatal */
    }
  }

  async function setRoom(room: string) {
    const isSwitch = room !== currentRoom;
    currentRoom = room;
    // Sinkronkan label judul room — bahkan jika room == currentRoom.
    await form.screen.update("lbl-room", {
      text: "# " + room.replace(/^#/, ""),
    });
    await form.screen.win.flush();
    try {
      await form.screen.update("msg-input", {
        placeholder: `Tulis pesan di ${room}… (Enter kirim, / untuk perintah)`,
      });
    } catch (_) {
      /* ignore */
    }
    if (!isSwitch) return;
    await renderHistory();
    if (connected && clientFd >= 0) {
      await clientSend({ t: "switch", room, clientId }).catch(() => {});
    }
  }

  // ──────────────────────────────────────────────────────────
  // NETWORK — CLIENT (send + handshake + recv loop)
  // ──────────────────────────────────────────────────────────
  async function clientSend(obj: any): Promise<void> {
    if (clientFd < 0) return;
    await net.sendto(
      clientFd,
      serverAddr,
      port,
      JSON.stringify(obj),
      FLAG,
      clientLocalPort,
    );
  }

  async function waitForPacket(
    fd: number,
    prefix: string,
    timeoutMs: number,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pkt = await net.recv(fd);
      if (pkt && typeof pkt.data === "string" && pkt.data.startsWith(prefix)) {
        return pkt.data;
      }
    }
    return null;
  }

  async function verifyKnownHost(addr: string, fp: string): Promise<boolean> {
    try {
      const existing = (await fs.readFile(KNOWN_HOSTS_PATH)) || "";
      const line = existing.split("\n").find((l) => l.startsWith(addr + " "));
      if (line) {
        return line.split(" ")[1] === fp;
      }
      const content = existing.trimEnd() ? existing + "\n" : "";
      try {
        await fs.mkdir("/etc/telechat");
      } catch (_) {
        /* sudah ada */
      }
      await fs.writeFile(KNOWN_HOSTS_PATH, content + `${addr} ${fp}\n`);
      return true;
    } catch (_) {
      return true; // tidak bisa tulis known_hosts → tetap terima (graceful)
    }
  }

  async function clientHandshake(): Promise<boolean> {
    const fd = await net.socket();
    if (fd < 0) {
      setStatus("❌ Failed to create socket.");
      return false;
    }
    clientLocalPort = 5000 + Math.floor(Math.random() * 4000);
    const ok = await net.bind(fd, clientLocalPort);
    if (!ok) {
      setStatus("❌ Failed to bind local port.");
      return false;
    }
    clientFd = fd;

    try {
      setStatus("🔑 RSA handshake…");
      await net.sendto(
        fd,
        serverAddr,
        port,
        "__request::key-exchange",
        FLAG,
        clientLocalPort,
      );

      const pubPkt = await waitForPacket(fd, "__pubkey::", 6000);
      if (!pubPkt) {
        setStatus(`❌ No reply from ${serverAddr}:${port}.`);
        return false;
      }
      const parts = pubPkt.split("::");
      const serverPub = parts[1];
      const fp = parts[2];
      if (!serverPub || !fp) {
        setStatus("❌ Server did not send public key/fingerprint.");
        return false;
      }

      // Anti-MITM: verifikasi fingerprint seperti known_hosts SSH
      const trusted = await verifyKnownHost(serverAddr, fp);
      if (!trusted) {
        setStatus(
          `⚠️ Fingerprint ${serverAddr} CHANGED — possible MITM! Rejected.`,
        );
        return false;
      }

      // Negosiasi session key dinamis (chacha20 32-byte), dienkripsi RSA
      const sessionKey = SecurityAgent.generateSessionKey();
      const encKeyHex = SecurityAgent.encryptWithPublicKey(
        serverPub,
        sessionKey,
      );
      await net.sendto(
        fd,
        serverAddr,
        port,
        `__secretkey::${encKeyHex}`,
        FLAG,
        clientLocalPort,
      );

      const donePkt = await waitForPacket(fd, "__status::done", 6000);
      if (!donePkt) {
        setStatus("❌ Handshake incomplete (server rejected key).");
        return false;
      }

      // Aktifkan enkripsi di sisi driver untuk port lokal — semua I/O sesudahnya
      // otomatis dienkripsi (TX) & didekripsi (RX) dengan session key ini.
      await net.ioctl(fd, 0x1001, { port: clientLocalPort, sessionKey });
      await new Promise((r) => setTimeout(r, 200));

      setStatus(`✅ Connected · 🔒 E2E chacha20 · fp ${fp.slice(0, 12)}…`);
      await std.log(
        `[telechat] ✅ Handshake OK dengan ${serverAddr}:${port} (fp ${fp.slice(0, 12)}…)`,
        "telechat",
      );
      return true;
    } catch (e: any) {
      setStatus(`❌ Handshake error: ${e?.message || e}`);
      return false;
    }
  }

  async function clientJoin() {
    if (clientFd < 0) return;
    await clientSend({
      t: "join",
      clientId,
      nickname,
      active_status: activeStatus,
      phone: cfg.phone_number || "",
      email: cfg.email || "",
    }).catch(() => {});
  }

  /** Push notifikasi desktop via Asteracea — toast di pojok layar. */
  async function pushDesktopNotif(title: string, message: string) {
    try {
      await shell.send(AST_IDENTITY, { type: "DESKTOP_NOTIF", title, message });
    } catch (_) {
      /* WM tidak tersedia — abaikan */
    }
  }

  async function handleNickTaken(message: string) {
    const ans = await TDialogs.input(
      form.screen,
      "Nickname in use",
      `${message}\nEnter another nickname:`,
      nickname,
    );
    if (!ans || !ans.trim()) {
      setStatus("⚠️ Nickname rejected — connection cancelled.");
      return;
    }
    nickname = ans.trim();
    void saveConfig();
    try {
      await form.screen.update("lbl-nick", { text: `🧑 ${nickname}` });
    } catch (_) {
      /* ignore */
    }
    await clientJoin();
  }

  function handleServerMsg(msg: any) {
    try {
      const room = String(msg.room || LOBBY);

      if (msg.t === "self") {
        // Profil sendiri berubah (nickname / role / active_status)
        if (msg.nickname) nickname = String(msg.nickname);
        if (msg.role) role = String(msg.role);
        if (msg.active_status !== undefined)
          activeStatus = clampInt(msg.active_status, 0, 2, activeStatus);
        try {
          form.screen.update("lbl-nick", { text: `🧑 ${nickname}` });
          form.screen.update("lbl-role", {
            text: role === "admin" ? "🛡 admin" : "👤 guest",
            style:
              role === "admin"
                ? {
                    padding: "2px 8px",
                    borderRadius: "10px",
                    fontSize: "11px",
                    fontWeight: "700",
                    color: "#ffb74d",
                    background: "rgba(255,183,77,0.12)",
                  }
                : {
                    padding: "2px 8px",
                    borderRadius: "10px",
                    fontSize: "11px",
                    fontWeight: "700",
                    color: "var(--text-dim,#aaa)",
                    background: "transparent",
                  },
          });
          form.screen.update("btn-newroom2", {
            style: { display: role === "admin" ? "block" : "none" },
          });
        } catch (_) {
          /* ignore */
        }
        if (msg.active_status !== undefined) {
          pushMsg(
            LOBBY,
            {
              from: "★",
              text: `Your presence status: ${statusName(activeStatus)}`,
              ts: Date.now(),
              sys: true,
              own: true,
            },
            true,
          );
        }
      } else if (msg.t === "chat") {
        if (!rooms.includes(room)) {
          rooms.push(room);
          void renderRooms();
        }
        pushMsg(
          room,
          {
            from: msg.from,
            text: String(msg.text || ""),
            ts: msg.ts || Date.now(),
          },
          true,
        );
        // Notifikasi desktop — hanya pesan dari orang lain (bukan nickname sendiri)
        if (String(msg.from) && String(msg.from) !== nickname) {
          void pushDesktopNotif(
            `💬 ${msg.from} · #${room.replace(/^#/, "")}`,
            String(msg.text || ""),
          );
        }
      } else if (msg.t === "sys") {
        if (!rooms.includes(room)) {
          rooms.push(room);
          void renderRooms();
        }
        pushMsg(
          room,
          {
            from: "★",
            text: String(msg.text || ""),
            ts: msg.ts || Date.now(),
            sys: true,
          },
          true,
        );
      } else if (msg.t === "rooms") {
        if (Array.isArray(msg.list)) {
          for (const r of msg.list) {
            if (typeof r === "string" && !rooms.includes(r)) rooms.push(r);
          }
          if (!rooms.includes(LOBBY)) rooms.unshift(LOBBY);
          void renderRooms();
        }
      } else if (msg.t === "presence") {
        // Keanggotaan room + umur signal alive → indikator hijau/merah
        if (msg.onlineMaxAge)
          onlineMaxAge = parseInt(msg.onlineMaxAge) || onlineMaxAge;
        const serverTime = msg.serverTime || Date.now();
        const offset = Date.now() - serverTime;
        if (msg.rooms && typeof msg.rooms === "object") {
          for (const k of Object.keys(membersByRoom)) delete membersByRoom[k];
          for (const k of Object.keys(msg.rooms)) {
            if (Array.isArray(msg.rooms[k])) {
              membersByRoom[k] = msg.rooms[k]
                .filter((m: any) => m && m.nick)
                .map((m: any) => ({
                  nick: String(m.nick),
                  lastSeen: (Number(m.lastSeen) || 0) + offset,
                }));
              if (!rooms.includes(k)) rooms.push(k);
            }
          }
        }
        void renderRooms();
      } else if (msg.t === "error") {
        const code = String(msg.code || "");
        pushMsg(
          room,
          {
            from: "⚠",
            text: String(msg.message || code),
            ts: Date.now(),
            err: true,
          },
          true,
        );
        if (code === "NICK_TAKEN") {
          void handleNickTaken(String(msg.message || ""));
        } else if (code === "BANNED") {
          banned = true;
          setStatus("🚫 You are banned from this server.");
          void disconnect();
        } else if (code === "ROOM_DENIED") {
          // Tetap di room saat ini (server menolak pindah)
          void setRoom(currentRoom);
        }
      } else if (msg.t === "kicked") {
        pushMsg(
          room,
          {
            from: "⚠",
            text: String(msg.message || "You were kicked."),
            ts: Date.now(),
            err: true,
          },
          true,
        );
        if (currentRoom === room) {
          // Pindah paksa kembali ke #lobby
          pushMsg(
            LOBBY,
            {
              from: "★",
              text: `You were moved back to ${LOBBY}.`,
              ts: Date.now(),
              sys: true,
              own: true,
            },
            true,
          );
          void setRoom(LOBBY);
        }
      } else if (msg.t === "banned") {
        pushMsg(
          LOBBY,
          {
            from: "⚠",
            text: String(msg.message || "You were banned."),
            ts: Date.now(),
            err: true,
          },
          true,
        );
        banned = true;
        setStatus("🚫 Banned by admin — connection disconnected.");
        void disconnect();
      }
    } catch (_) {
      /* ignore */
    }
  }

  function statusName(s: number): string {
    if (s === 0) return "Inactive (0)";
    if (s === 2) return "Invisible (2)";
    return "Visible (1)";
  }

  function startRecvLoop() {
    (async () => {
      while (running && connected) {
        try {
          const pkt = await net.recv(clientFd);
          if (!pkt) continue;
          const data = typeof pkt.data === "string" ? pkt.data : "";
          let msg: any;
          try {
            msg = JSON.parse(data);
          } catch (_) {
            continue;
          }
          handleServerMsg(msg);
        } catch (e) {
          break;
        }
      }
      // Loop berhenti → koneksi putus
      if (running && connected) {
        connected = false;
        setStatus("🔌 Connection lost — click Connect to reconnect.");
        try {
          btnConnect.caption = "Connect";
        } catch (_) {
          /* ignore */
        }
        pingTimer.enabled = false;
        presenceTimer.enabled = true; // warna tetap update walau offline
      }
    })();
  }

  async function toggleConnect() {
    if (connecting) return;
    if (connected) {
      await disconnect();
      return;
    }
    if (banned) {
      await TDialogs.alert(
        form.screen,
        "🚫 Banned",
        "Your account is banned by an admin. Cannot connect.",
      );
      return;
    }
    await connect();
  }

  async function connect() {
    // Ambil alamat server dari toolbar bila belum ada
    const rawInput = serverInputText.trim() || (serverInput.text || "").trim();
    if (rawInput) {
      // Format: host:port
      const ci = rawInput.lastIndexOf(":");
      if (ci > 0 && /^\d+$/.test(rawInput.slice(ci + 1))) {
        serverAddr = rawInput.slice(0, ci);
        port = parseInt(rawInput.slice(ci + 1));
      } else {
        serverAddr = rawInput;
      }
    }
    if (!serverAddr) {
      const ans = await TDialogs.input(
        form.screen,
        "Server",
        "MQTNL node address running telechatd (NOT IP).\nExample: tsix, tsix-node-2.\n\nServer address:",
        cfg.server || "",
      );
      if (!ans || !ans.trim()) {
        setStatus("❌ No server address — closing application.");
        return;
      }
      serverAddr = ans.trim();
    }

    connecting = true;
    try {
      btnConnect.caption = "⏳…";
    } catch (_) {
      /* ignore */
    }
    setStatus(`🔌 Connecting to ${serverAddr}:${port}…`);
    void saveConfig();

    const ok = await clientHandshake();
    if (!ok) {
      connecting = false;
      try {
        btnConnect.caption = "Connect";
      } catch (_) {
        /* ignore */
      }
      return;
    }

    connected = true;
    connecting = false;
    try {
      btnConnect.caption = "Disconnect";
    } catch (_) {
      /* ignore */
    }
    statusBar.text = `📡 ${serverAddr}:${port} · 🔒 E2E chacha20 (RSA handshake)`;

    // Mulai recv loop + heartbeat
    startRecvLoop();
    pingTimer.enabled = true;
    presenceTimer.enabled = true;

    // Kirim join (identitas: clientId + nickname) — server akan validasi.
    await clientJoin();
  }

  async function disconnect() {
    connected = false;
    connecting = false;
    pingTimer.enabled = false;
    if (clientFd >= 0) {
      try {
        await clientSend({ t: "leave", room: currentRoom, clientId });
      } catch (_) {
        /* socket sudah mati */
      }
      try {
        await net.close(clientFd);
      } catch (_) {
        /* ignore */
      }
    }
    clientFd = -1;
    try {
      btnConnect.caption = "Connect";
    } catch (_) {
      /* ignore */
    }
    setStatus("🔌 Disconnected.");
  }

  // ──────────────────────────────────────────────────────────
  // KIRIM PESAN (client → server)
  // ──────────────────────────────────────────────────────────
  async function sendMessage() {
    const text = inputText.trim();
    if (!text) return;
    inputText = "";
    await form.screen.update("msg-input", { value: "" });

    // Perintah lokal client (TIDAK dikirim ke server)
    if (text === "/help" || text.startsWith("/help ")) {
      pushMsg(
        currentRoom,
        {
          from: "★",
          text:
            "💬 TeleChat Commands:\n" +
            "  /nickname <nama>     — change nickname\n" +
            "  /status <0|1|2>      — 0 Inactive · 1 Visible · 2 Invisible\n" +
            "  /kick <nama>         — (admin) kick from current room\n" +
            "  /ban <nama>          — (admin) permanent ban + disconnect\n" +
            "  /role <nama> <r>     — (admin) set admin|guest\n" +
            "  /rooms               — room list\n" +
            "  /who                 — current room members\n" +
            "  /clear               — clear chat history (local)\n" +
            "  /help                — this help",
          ts: Date.now(),
          sys: true,
          own: true,
        },
        true,
      );
      return;
    }
    if (text === "/clear") {
      history[currentRoom] = [];
      await renderHistory();
      return;
    }

    // Perintah server (parser di telechatd) — kirim sebagai t:"cmd"
    if (text.startsWith("/")) {
      if (!connected) {
        setStatus("⏳ Not connected to server — command not sent.");
        return;
      }
      await clientSend({ t: "cmd", room: currentRoom, text, clientId }).catch(
        () => {
          setStatus("⚠️ Failed to send (server not responding).");
        },
      );
      return;
    }

    if (!connected) {
      setStatus("⏳ Not connected to server — message not sent.");
      return;
    }

    const ts = Date.now();
    pushMsg(currentRoom, { from: nickname, text, ts, own: true }, true);
    await clientSend({ t: "msg", room: currentRoom, text, ts }).catch(() => {
      setStatus("⚠️ Failed to send (server not responding).");
    });
  }

  async function createRoom() {
    const raw = await TDialogs.input(
      form.screen,
      "＋ New Room",
      "Room name (without '#'):",
      "",
    );
    if (!raw) return;
    const room = raw
      .trim()
      .replace(/^#/, "")
      .replace(/\s+/g, "-")
      .toLowerCase();
    if (!room) return;
    if (!connected) {
      setStatus("⏳ Not connected — cannot create room.");
      return;
    }
    // Server yang memvalidasi hak admin (ADMIN_ONLY) & keunikan nama.
    await clientSend({ t: "create", room: "#" + room, clientId }).catch(() => {
      setStatus("⚠️ Failed to send (server not responding).");
    });
    // Optimis: tambah ke daftar & pindah — bila ditolak server, room akan
    // hilang dari daftar saat broadcast rooms berikutnya.
    if (!rooms.includes("#" + room)) rooms.push("#" + room);
    await setRoom("#" + room);
    await renderRooms();
  }

  // ──────────────────────────────────────────────────────────
  // EVENT BINDING (onSetup — setelah mount & auto-bind)
  // ──────────────────────────────────────────────────────────
  form.onSetup = async () => {
    // Prompt nickname HANYA jika belum ada (argumen & config kosong).
    if (!nicknameProvided) {
      const ans = await TDialogs.input(
        form.screen,
        "Nickname",
        "No nickname in config.\nEnter your name:",
        nickname,
      );
      if (ans && ans.trim()) nickname = ans.trim();
      nicknameProvided = true;
      void saveConfig();
      await form.screen.update("lbl-nick", { text: `🧑 ${nickname}` });
    }

    // clientId baru → simpan ke config agar STABIL lintas sesi
    if (!cfg.clientId) void saveConfig();

    await renderRooms();
    await renderHistory();

    // Refresh warna indikator presensi secara berkala
    presenceTimer.enabled = true;

    // Keydown (Enter) — TEdit cashew tidak punya onKeyDown native, jadi pakai
    // screen.on langsung (meng-set onKeydownId pada elemen input).
    form.screen.on("msg-input", "keydown", (ev: any) => {
      if (ev?.value === "Enter") void sendMessage();
    });

    // Auto-connect bila alamat server sudah ada di config
    if (serverAddr) void connect();
  };

  form.onClose = async () => {
    running = false;
    connected = false;
    pingTimer.enabled = false;
    presenceTimer.enabled = false;
    void saveHistory();
    if (clientFd >= 0) {
      try {
        await clientSend({ t: "leave", room: currentRoom, clientId });
      } catch (_) {
        /* socket sudah mati */
      }
      try {
        await net.close(clientFd);
      } catch (_) {
        /* ignore */
      }
    }
    void std.log("[telechat] Application closed.", "telechat");
  };

  await form.run();
  return;
});
