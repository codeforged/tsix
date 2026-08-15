/**
 * air-type.ts — ✈️ Air-Type: Secure E2E Chat antar Node TSIX
 *
 * Chat room antar node TSIX dengan keamanan ala airtermd:
 *   - Handshake RSA (public key server + fingerprint) → negosiasi session key
 *     ChaCha20-Poly1305 32-byte yang DINAMIS per koneksi (bukan key statis).
 *   - Setelah handshake, semua payload chat dienkripsi end-to-end per link.
 *   - Server (hub) meneruskan pesan room ke semua anggota room yang lain.
 *
 * Dua peran dalam satu binary:
 *   air-type --serve [port]              → server/hub (punya UI juga)
 *   air-type <serverAddr> [port] [nick]  → client
 *
 * Konfigurasi & history disimpan di /etc/air-type/:
 *   /etc/air-type/config.json    — { server, port, nickname } (default)
 *   /etc/air-type/history.json   — riwayat chat per-room (ditulis saat runtime)
 *   /etc/air-type/known_hosts    — fingerprint server (anti MITM, seperti SSH)
 *
 * Identitas RSA node diambil dari /etc/keys/rsa (sama seperti airtermd) — key
 * diregenerasi otomatis oleh init.ts saat boot bila belum ada.
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
  TListBox,
  TStatusBar,
  TSplitHorizontal,
  HStack,
  TDialogs,
  TScrollBox,
} from "@tsix/cashew";

export const appMode = "gui";

// ────────────────────────────────────────────────────────────
// KONSTANTA
// ────────────────────────────────────────────────────────────
const DEFAULT_PORT = 2500;              // port chat default (server)
const RSA_DIR = "/etc/keys/rsa";        // identitas RSA node (id_rsa / id_rsa.pub)
const CONFIG_PATH = "/etc/air-type/config.json";
const HISTORY_PATH = "/etc/air-type/history.json";
const KNOWN_HOSTS_PATH = "/etc/air-type/known_hosts";
const FLAG = PacketFlags.FLAG_DATA;
const PING_INTERVAL = 25000;            // client keepalive (ms)
const STALE_MS = 90000;                 // server: buang client yang diam > 90s
const CLEANUP_INTERVAL = 30000;

interface ChatMsg {
  from: string;
  text: string;
  ts: number;
  own?: boolean;
  sys?: boolean;
}

interface Peer {
  addr: string;          // alamat MQTNL client (pkt.src)
  port: number;          // port sumber client (pkt.port / localPort client)
  agent: SecurityAgent;  // session key dinamis per-koneksi
  nick: string;
  room: string;
  lastSeen: number;
}

export const main = Program(async (args: string[]) => {
  // ──────────────────────────────────────────────────────────
  // ARGS & PERAN
  // ──────────────────────────────────────────────────────────
  const isServer = args.includes("--serve") || args.includes("-s");
  const pos = args.filter((a) => !a.startsWith("-"));

  let cfg: any = { server: "", port: DEFAULT_PORT, nickname: "" };
  try {
    cfg = { ...cfg, ...(JSON.parse((await fs.readFile(CONFIG_PATH)) || "{}")) };
  } catch (_) { /* config optional */ }

  const defaultNick = (await shell.getenv("HOSTNAME")) || "node";
  let port = DEFAULT_PORT;
  let serverAddr = "";
  let nickname = cfg.nickname || defaultNick;
  // Apakah nickname sudah pasti (dari argumen/config)? Kalau belum, minta user
  // mengisi via dialog setelah window mount (di onSetup), lalu simpan ke config.
  let nicknameProvided = !!cfg.nickname;

  if (isServer) {
    if (pos[0]) port = parseInt(pos[0]) || DEFAULT_PORT;
    if (pos[1]) {
      nickname = pos[1];
      nicknameProvided = true;
    }
  } else {
    serverAddr = pos[0] || cfg.server || "";
    if (pos[1]) port = parseInt(pos[1]) || cfg.port || DEFAULT_PORT;
    if (pos[2]) {
      nickname = pos[2];
      nicknameProvided = true;
    }
  }

  await std.log(
    `[air-type] Mode: ${isServer ? "SERVER" : "CLIENT"} | nick=${nickname} | port=${port}`,
    "air-type",
  );

  // ──────────────────────────────────────────────────────────
  // STATE APLIKASI
  // ──────────────────────────────────────────────────────────
  let running = true;
  let connected = false;
  let currentRoom = "general";
  const rooms: string[] = ["general"];
  const history: Record<string, ChatMsg[]> = {};
  let inputText = "";
  let clientFd = -1;
  let clientLocalPort = 0;
  let serverSocket = -1;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  // Keadaan server (hub)
  const clients = new Map<string, Peer>();
  const roomMembers = new Map<string, Set<string>>();
  let pubKey = "";
  let privateKey = "";
  let fingerprint = "";

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
  } catch (_) { /* belum ada history */ }

  // ──────────────────────────────────────────────────────────
  // UI (Cashew)
  // ──────────────────────────────────────────────────────────
  const form = new TForm({ title: "✈️ Air-Type", width: 820, height: 560 });

  // Header
  const lblTitle = new TLabel("lbl-title", {
    color: "var(--accent, #4caf50)",
    fontWeight: "700",
    fontSize: "15px",
  });
  lblTitle.caption = "✈️ Air-Type";

  const lblRole = new TLabel("lbl-role", {
    padding: "2px 8px",
    borderRadius: "10px",
    fontSize: "11px",
    fontWeight: "700",
  });
  lblRole.caption = isServer ? "🖥 SERVER" : "📡 CLIENT";

  const lblNick = new TLabel("lbl-nick", { fontSize: "12px" });
  lblNick.caption = `👤 ${nickname}`;

  const btnNewRoom = new TButton("btn-newroom", {
    height: "28px",
    padding: "0 10px",
    background: "rgba(33,150,243,0.15)",
    color: "#2196f3",
    border: "1px solid #2196f3",
  });
  btnNewRoom.caption = "＋ Room Baru";
  btnNewRoom.onClick = () => void createRoom();

  const lblStatusTop = new TLabel("lbl-status", {
    color: "var(--text-muted, #888)",
    fontSize: "11px",
  });
  lblStatusTop.caption = "⏳ menyiapkan…";

  form.add(
    HStack({ padding: "2px 0 8px 0", gap: "10px" }, lblTitle, lblRole, lblNick, lblStatusTop),
  );

  // Panel kiri — daftar room
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
  lblRooms.caption = "📁 ROOMS";
  leftPanel.add(lblRooms);

  const roomList = new TListBox("room-list");
  roomList.items = rooms;
  leftPanel.add(roomList);

  const btnNewRoom2 = new TButton("btn-newroom2", {
    height: "28px",
    padding: "0 8px",
    fontSize: "12px",
    background: "rgba(33,150,243,0.12)",
    color: "#2196f3",
    border: "1px solid rgba(33,150,243,0.4)",
  });
  btnNewRoom2.caption = "＋ Buat Room";
  btnNewRoom2.onClick = () => void createRoom();
  leftPanel.add(btnNewRoom2);

  // Panel kanan — room + history + input
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
  lblRoom.caption = "# general";
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
  input.placeholder = "Tulis pesan… (Enter untuk kirim)";
  input.props.autofocus = true;
  // PENTING: set onInput SEBELUM form.run() — cashew auto-bind event saat run(),
  // jadi handler yang baru di-set di onSetup (setelah run) TIDAK akan terdaftar.
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
  btnSend.caption = "➤ Kirim";
  btnSend.onClick = () => void sendMessage();

  rightPanel.add(HStack({ padding: "0" }, input, btnSend));

  form.add(TSplitHorizontal(leftPanel, rightPanel, "0 0 210px"));

  // Status bar bawah
  const statusBar = new TStatusBar("status");
  statusBar.text = isServer
    ? `🖥 Server :${port} · 🔒 E2E chacha20 (RSA handshake)`
    : `📡 ${serverAddr || "?"}:${port} · 🔒 E2E chacha20 (RSA handshake)`;
  form.add(statusBar);

  // ──────────────────────────────────────────────────────────
  // FUNGSI RENDER UI
  // ──────────────────────────────────────────────────────────
  function setStatus(text: string) {
    try {
      statusBar.text = text;
      lblStatusTop.caption = text;
    } catch (_) { /* ignore */ }
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
        background: m.sys
          ? "transparent"
          : m.own
            ? "var(--accent-bg, rgba(76,175,80,0.14))"
            : "var(--surface, rgba(255,255,255,0.04))",
        color: m.sys ? "var(--text-muted, #999)" : "var(--text, #e0e0e0)",
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
              style: m.sys
                ? { color: "#ffb74d", fontWeight: "700" }
                : { color: "var(--accent,#4caf50)", fontWeight: "700" },
              text: m.sys ? `${m.from} ` : `${m.from}: `,
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

  async function renderRooms() {
    roomList.items = rooms;
    roomList.selectedIndex = Math.max(0, rooms.indexOf(currentRoom));
    await roomList.refresh(form.screen);
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
      try { await fs.mkdir("/etc/air-type"); } catch (_) { /* sudah ada */ }
      await fs.writeFile(HISTORY_PATH, JSON.stringify(history));
    } catch (_) { /* non-fatal: history tetap in-memory */ }
  }

  async function saveConfig() {
    try {
      try { await fs.mkdir("/etc/air-type"); } catch (_) { /* sudah ada */ }
      const data = { server: serverAddr || cfg.server || "", port, nickname };
      await fs.writeFile(CONFIG_PATH, JSON.stringify(data, null, 2));
    } catch (_) { /* non-fatal */ }
  }

  async function setRoom(room: string) {
    if (room === currentRoom) return;
    currentRoom = room;
    await form.screen.update("lbl-room", { text: "# " + room });
    await renderRooms();
    await renderHistory();
    if (!isServer && clientFd >= 0) {
      await clientSend({ t: "join", room, nick: nickname }).catch(() => {});
    }
  }

  // ──────────────────────────────────────────────────────────
  // NETWORK — CLIENT (send + handshake + recv loop)
  // ──────────────────────────────────────────────────────────
  async function clientSend(obj: any): Promise<void> {
    if (clientFd < 0) return;
    await net.sendto(clientFd, serverAddr, port, JSON.stringify(obj), FLAG, clientLocalPort);
  }

  async function waitForPacket(fd: number, prefix: string, timeoutMs: number): Promise<string | null> {
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
        await fs.mkdir("/etc/air-type");
      } catch (_) { /* sudah ada */ }
      await fs.writeFile(KNOWN_HOSTS_PATH, content + `${addr} ${fp}\n`);
      return true;
    } catch (_) {
      return true; // tidak bisa tulis known_hosts → tetap terima (graceful)
    }
  }

  async function clientHandshake(): Promise<boolean> {
    const fd = await net.socket();
    if (fd < 0) {
      setStatus("❌ Gagal membuat socket.");
      return false;
    }
    clientLocalPort = 4000 + Math.floor(Math.random() * 1000);
    const ok = await net.bind(fd, clientLocalPort);
    if (!ok) {
      setStatus("❌ Gagal bind port lokal.");
      return false;
    }
    clientFd = fd;

    try {
      setStatus("🔑 RSA handshake…");
      await net.sendto(fd, serverAddr, port, "__request::key-exchange", FLAG, clientLocalPort);

      const pubPkt = await waitForPacket(fd, "__pubkey::", 6000);
      if (!pubPkt) {
        setStatus(`❌ Tidak ada balasan dari ${serverAddr}:${port}.`);
        return false;
      }
      const parts = pubPkt.split("::");
      const serverPub = parts[1];
      const fp = parts[2];
      if (!serverPub || !fp) {
        setStatus("❌ Server tidak mengirim public key/fingerprint.");
        return false;
      }

      // Anti-MITM: verifikasi fingerprint seperti known_hosts SSH
      const trusted = await verifyKnownHost(serverAddr, fp);
      if (!trusted) {
        setStatus(`⚠️ Fingerprint ${serverAddr} BERUBAH — kemungkinan MITM! Ditolak.`);
        return false;
      }

      // Negosiasi session key dinamis (chacha20 32-byte), dienkripsi RSA
      const sessionKey = SecurityAgent.generateSessionKey();
      const encKeyHex = SecurityAgent.encryptWithPublicKey(serverPub, sessionKey);
      await net.sendto(fd, serverAddr, port, `__secretkey::${encKeyHex}`, FLAG, clientLocalPort);

      const donePkt = await waitForPacket(fd, "__status::done", 6000);
      if (!donePkt) {
        setStatus("❌ Handshake tidak selesai (server menolak key).");
        return false;
      }

      // Aktifkan enkripsi di sisi driver untuk port lokal — semua I/O sesudahnya
      // otomatis dienkripsi (TX) & didekripsi (RX) dengan session key ini.
      await net.ioctl(fd, 0x1001, { port: clientLocalPort, sessionKey });
      await new Promise((r) => setTimeout(r, 200));

      // Gabung room "general" (default) — server akan membalas daftar room.
      await clientSend({ t: "join", room: "general", nick: nickname });
      connected = true;

      setStatus(`✅ Terhubung · 🔒 E2E chacha20 · fp ${fp.slice(0, 12)}…`);
      await std.log(`[air-type] ✅ Handshake OK dengan ${serverAddr}:${port} (fp ${fp.slice(0, 12)}…)`, "air-type");
      return true;
    } catch (e: any) {
      setStatus(`❌ Handshake error: ${e?.message || e}`);
      return false;
    }
  }

  function handleServerMsg(msg: any) {
    try {
      if (msg.t === "chat") {
        const room = String(msg.room || "general");
        if (!rooms.includes(room)) {
          rooms.push(room);
          void renderRooms();
        }
        pushMsg(room, { from: msg.from, text: msg.text, ts: msg.ts || Date.now() }, true);
      } else if (msg.t === "sys") {
        const room = String(msg.room || "general");
        if (!rooms.includes(room)) {
          rooms.push(room);
          void renderRooms();
        }
        pushMsg(room, { from: "★", text: msg.text, ts: msg.ts || Date.now(), sys: true }, true);
      } else if (msg.t === "rooms") {
        if (Array.isArray(msg.list)) {
          for (const r of msg.list) {
            if (typeof r === "string" && !rooms.includes(r)) rooms.push(r);
          }
          void renderRooms();
        }
      }
    } catch (_) { /* ignore */ }
  }

  async function clientSetup() {
    const ok = await clientHandshake();
    if (!ok) return;

    // Recv loop (setelah handshake — data sudah didekripsi driver)
    (async () => {
      while (running) {
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
    })();

    // Keepalive agar server tidak menganggap client mati
    pingTimer = setInterval(() => {
      if (running && clientFd >= 0) void clientSend({ t: "ping" }).catch(() => {});
    }, PING_INTERVAL);
  }

  // ──────────────────────────────────────────────────────────
  // NETWORK — SERVER (hub + relay)
  // ──────────────────────────────────────────────────────────
  async function serverSendToPeer(socket: number, peer: Peer, obj: any) {
    const enc = peer.agent.securePacketOut(JSON.stringify(obj));
    await net.sendto(socket, peer.addr, peer.port, enc, FLAG, port);
  }

  async function relayToRoom(socket: number, room: string, obj: any, exceptSid: string = "") {
    const members = roomMembers.get(room);
    if (!members) return;
    const payload = JSON.stringify(obj);
    for (const sid of members) {
      if (sid === exceptSid) continue;
      const peer = clients.get(sid);
      if (!peer) continue;
      try {
        const enc = peer.agent.securePacketOut(payload);
        await net.sendto(socket, peer.addr, peer.port, enc, FLAG, port);
      } catch (_) { /* skip */ }
    }
  }

  function broadcastRooms(socket: number) {
    const payload = { t: "rooms", list: rooms };
    for (const peer of clients.values()) {
      void serverSendToPeer(socket, peer, payload).catch(() => {});
    }
  }

  async function serverSys(socket: number, room: string, text: string) {
    const ts = Date.now();
    pushMsg(room, { from: "★", text, ts, sys: true }, true);
    await relayToRoom(socket, room, { t: "sys", room, text, ts });
  }

  async function serverHandleChat(socket: number, client: Peer, msg: any) {
    const sid = `${client.addr}:${client.port}`;
    const t = msg.t;

    if (t === "ping") return;

    if (t === "join" || t === "create") {
      let room = String(msg.room || "general").replace(/^#/, "").trim() || "general";
      client.nick = msg.nick || client.nick || client.addr;

      // Tinggalkan room lama
      if (client.room && client.room !== room) {
        roomMembers.get(client.room)?.delete(sid);
      }
      client.room = room;

      if (!rooms.includes(room)) {
        rooms.push(room);
        void renderRooms();
        broadcastRooms(socket);
      }
      if (!roomMembers.has(room)) roomMembers.set(room, new Set());
      roomMembers.get(room)!.add(sid);

      // Kirim daftar room ke client baru
      await serverSendToPeer(socket, client, { t: "rooms", list: rooms }).catch(() => {});
      await serverSys(socket, room, `${client.nick} bergabung ke #${room}`);
      return;
    }

    if (t === "msg") {
      const room = String(msg.room || client.room || "general");
      const chat = {
        from: client.nick || client.addr,
        text: String(msg.text || ""),
        ts: msg.ts || Date.now(),
      };
      // UI server: tampilkan lokal (jika sedang di room tsb)
      pushMsg(room, chat, true);
      // Relay ke anggota room lain (sender tidak menerima ulang)
      await relayToRoom(socket, room, { t: "chat", room, from: chat.from, text: chat.text, ts: chat.ts }, sid);
      return;
    }

    if (t === "nick") {
      const oldNick = client.nick || client.addr;
      const newNick = String(msg.nick || oldNick).trim() || oldNick;
      if (newNick !== oldNick) {
        client.nick = newNick;
        await serverSys(socket, client.room || "general", `${oldNick} kini dikenal sebagai ${newNick}`);
      }
      return;
    }

    if (t === "leave") {
      const room = String(msg.room || client.room || "");
      if (room) {
        roomMembers.get(room)?.delete(sid);
        if (client.room === room) client.room = "";
        await serverSys(socket, room, `${client.nick || client.addr} meninggalkan #${room}`);
      }
      return;
    }
  }

  async function serverHandlePacket(socket: number, pkt: any) {
    const sid = `${pkt.src}:${pkt.port}`;
    const raw =
      typeof pkt.data === "string"
        ? pkt.data
        : Buffer.isBuffer(pkt.data)
          ? pkt.data.toString("utf8")
          : "";

    // Langkah 1: minta public key
    if (raw === "__request::key-exchange") {
      await net.sendto(socket, pkt.src, pkt.port, `__pubkey::${pubKey}::${fingerprint}`, FLAG, port);
      return;
    }

    // Langkah 3: terima session key (dienkripsi RSA) → simpan agent per-koneksi
    if (typeof raw === "string" && raw.startsWith("__secretkey::")) {
      try {
        const sessionKey = SecurityAgent.decryptWithPrivateKey(
          privateKey,
          raw.slice("__secretkey::".length),
        );
        const agent = new SecurityAgent();
        agent.setSessionKey(sessionKey);
        clients.set(sid, { addr: pkt.src, port: pkt.port, agent, nick: "", room: "", lastSeen: Date.now() });
        await net.sendto(socket, pkt.src, pkt.port, "__status::done", FLAG, port);
        await std.log(`[air-type] 🔐 Client ${sid} handshake OK — E2E session aktif.`, "air-type");
      } catch (e: any) {
        await std.log(`[air-type] Handshake GAGAL dari ${sid}: ${e?.message || e}`, "air-type");
      }
      return;
    }

    // Chat (terenkripsi) — dekripsi manual per-koneksi
    const client = clients.get(sid);
    if (!client) return;
    client.lastSeen = Date.now();

    const decrypted = client.agent.securePacketIn(typeof raw === "string" ? raw : "");
    if (!decrypted) return;
    let msg: any;
    try {
      msg = JSON.parse(decrypted);
    } catch (_) {
      return;
    }
    await serverHandleChat(socket, client, msg);
  }

  async function serverLoop(socket: number) {
    let lastCleanup = Date.now();
    while (running) {
      try {
        const pkt = await net.recv(socket);
        if (pkt) {
          await serverHandlePacket(socket, pkt);
        }
        // Cleanup client yang diam (dianggap keluar)
        if (Date.now() - lastCleanup > CLEANUP_INTERVAL) {
          lastCleanup = Date.now();
          const now = Date.now();
          for (const [sid, peer] of clients.entries()) {
            if (now - peer.lastSeen > STALE_MS) {
              if (peer.room) roomMembers.get(peer.room)?.delete(sid);
              clients.delete(sid);
              await std.log(`[air-type] Client ${sid} dianggap keluar (idle).`, "air-type");
            }
          }
        }
      } catch (e) {
        break;
      }
    }
  }

  async function serverSetup() {
    try {
      pubKey = (await fs.readFile(`${RSA_DIR}/id_rsa.pub`)) || "";
      privateKey = (await fs.readFile(`${RSA_DIR}/id_rsa`)) || "";
    } catch (_) { /* kosong */ }

    if (!pubKey || !privateKey) {
      setStatus(`❌ Identitas RSA tidak ditemukan di ${RSA_DIR}. Jalankan 'init' dulu.`);
      await std.log(`[air-type] CRITICAL: RSA keys tidak ada di ${RSA_DIR}.`, "air-type");
      return;
    }

    fingerprint = SecurityAgent.getFingerprint(pubKey);

    const socket = await net.socket();
    if (socket < 0) {
      setStatus("❌ Gagal membuat socket server.");
      return;
    }
    const ok = await net.bind(socket, port);
    if (!ok) {
      setStatus(`❌ Port ${port} sudah dipakai.`);
      return;
    }
    serverSocket = socket;

    setStatus(`🖥 Server aktif :${port} · 🔒 ${fingerprint.slice(0, 12)}…`);
    await std.log(
      `[air-type] 🖥 Server chat aktif di MQTNL port ${port} (fingerprint ${fingerprint.slice(0, 12)}…).`,
      "air-type",
    );
    await serverLoop(socket);
  }

  async function setupNetwork() {
    if (isServer) {
      await serverSetup();
    } else {
      if (!serverAddr) {
        const ans = await TDialogs.input(
          form.screen,
          "Server",
          "Alamat MQTNL node yang menjalankan 'air-type --serve' (BUKAN IP).\nContoh: tsix, tsix-node-2 (lihat sysconfig network.interfaces[].address).\n\nAlamat server:",
          cfg.server || "",
        );
        if (!ans || !ans.trim()) {
          setStatus("❌ Tidak ada alamat server — tutup aplikasi.");
          return;
        }
        serverAddr = ans.trim();
        statusBar.text = `📡 ${serverAddr}:${port} · 🔒 E2E chacha20 (RSA handshake)`;
      }
      await clientSetup();
    }
  }

  // ──────────────────────────────────────────────────────────
  // KIRIM PESAN (shared server/client)
  // ──────────────────────────────────────────────────────────
  async function sendMessage() {
    const text = inputText.trim();
    if (!text) return;
    inputText = "";
    await form.screen.update("msg-input", { value: "" });

    // Perintah /nickname <nama> — ganti nickname (TIDAK dikirim sebagai chat)
    if (text.startsWith("/nickname ")) {
      const newNick = text.slice("/nickname ".length).trim();
      if (newNick) {
        const oldNick = nickname;
        nickname = newNick;
        await form.screen.update("lbl-nick", { text: `👤 ${nickname}` });
        void saveConfig();
        pushMsg(currentRoom, {
          from: "★",
          text: `Kamu kini dikenal sebagai ${nickname}`,
          ts: Date.now(),
          sys: true,
          own: true,
        }, true);
        if (!isServer && clientFd >= 0 && connected) {
          await clientSend({ t: "nick", nick: newNick }).catch(() => {});
        } else if (isServer) {
          await relayToRoom(serverSocket, currentRoom, {
            t: "sys",
            room: currentRoom,
            text: `${oldNick} kini dikenal sebagai ${nickname}`,
            ts: Date.now(),
          }).catch(() => {});
        }
      }
      return;
    }

    if (!isServer && !connected) {
      setStatus("⏳ Belum terhubung ke server — pesan tidak terkirim.");
      return;
    }

    const ts = Date.now();
    if (isServer) {
      pushMsg(currentRoom, { from: nickname, text, ts, own: true }, true);
      await relayToRoom(serverSocket, currentRoom, {
        t: "chat",
        room: currentRoom,
        from: nickname,
        text,
        ts,
      });
    } else {
      pushMsg(currentRoom, { from: nickname, text, ts, own: true }, true);
      await clientSend({ t: "msg", room: currentRoom, text, ts }).catch(() => {
        setStatus("⚠️ Gagal mengirim (server tidak merespons).");
      });
    }
  }

  async function createRoom() {
    const raw = await TDialogs.input(form.screen, "＋ Room Baru", "Nama room (tanpa '#'):", "");
    if (!raw) return;
    const room = raw.trim().replace(/^#/, "").replace(/\s+/g, "-").toLowerCase();
    if (!room) return;
    if (!rooms.includes(room)) {
      rooms.push(room);
      await renderRooms();
    }
    await setRoom(room);
    if (isServer) {
      broadcastRooms(serverSocket);
      await serverSys(serverSocket, room, `${nickname} membuat #${room}`);
    } else {
      await clientSend({ t: "create", room, nick: nickname }).catch(() => {});
    }
  }

  // ──────────────────────────────────────────────────────────
  // EVENT BINDING (onSetup — setelah mount & auto-bind)
  // ──────────────────────────────────────────────────────────
  form.onSetup = async () => {
    // Prompt nickname HANYA jika belum ada (argumen & config kosong).
    // Setelah diisi, langsung disimpan ke config → launch berikutnya tidak prompt lagi.
    if (!nicknameProvided) {
      const ans = await TDialogs.input(
        form.screen,
        "Nickname",
        "Belum ada nickname di config.\nMasukkan nama kamu:",
        defaultNick,
      );
      if (ans && ans.trim()) nickname = ans.trim();
      nicknameProvided = true;
      void saveConfig();
      await form.screen.update("lbl-nick", { text: `👤 ${nickname}` });
    }

    roomList.onClick = (idx, item) => {
      void setRoom(item);
    };
    await renderRooms();
    await renderHistory();

    // Keydown (Enter) — TEdit cashew tidak punya onKeyDown native, jadi pakai
    // screen.on langsung (meng-set onKeydownId pada elemen input).
    form.screen.on("msg-input", "keydown", (ev: any) => {
      if (ev?.value === "Enter") void sendMessage();
    });

    // Mulai networking di background (UI tetap render duluan)
    void setupNetwork();
  };

  form.onClose = () => {
    running = false;
    connected = false;
    if (pingTimer) clearInterval(pingTimer);
    void saveHistory();
    if (clientFd >= 0) void net.close(clientFd).catch(() => {});
    if (serverSocket >= 0) void net.close(serverSocket).catch(() => {});
    void std.log("[air-type] Aplikasi ditutup.", "air-type");
  };

  await form.run();
  return;
});
