/**
 * air-type.ts — ✈️ Air-Type: Secure E2E Chat antar Node TSIX
 *
 * Chat room antar node TSIX dengan keamanan ala airtermd:
 *   - Handshake RSA (public key server + fingerprint) → negosiasi session key
 *     ChaCha20-Poly1305 32-byte yang DINAMIS per koneksi (bukan key statis).
 *   - Setelah handshake, semua payload chat dienkripsi end-to-end per link.
 *   - Server (hub) meneruskan pesan room ke semua anggota room yang lain.
 *
 * Aplikasi ini HANYA CLIENT (GUI). Server chat headless terpisah di
 * /opt/air-type-server/air-type-server.ts (daemon, tanpa GUI) — jalan otomatis
 * saat boot (rc.local) atau manual: air-type-server [port].
 *
 *   air-type <serverAddr> [port] [nick]  → client (GUI)
 *
 * Kehadiran anggota: daftar room menampilkan anggota yang join (● nick) dengan
 * warna bullet berdasarkan umur signal alive — hijau (segar), kuning (ragu),
 * merah (timeout). Interval alive di config.json client (aliveInterval, default
 * 10 dtk); threshold warna (hijau/kuning/merah) di /etc/air-type-server/config.json.
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

interface ChatMsg {
  from: string;
  text: string;
  ts: number;
  own?: boolean;
  sys?: boolean;
}

/** clientId stabil (persisted di config) — identitas unik pengguna untuk anti-duplikat reconnect. */
function genClientId(): string {
  const r4 = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${r4()}${r4()}-${r4()}-${r4()}-${r4()}${r4()}`;
}

export const main = Program(async (args: string[]) => {
  // ──────────────────────────────────────────────────────────
  // ARGS (client-only — server headless terpisah /opt/air-type-server/)
  // ──────────────────────────────────────────────────────────
  const pos = args.filter((a) => !a.startsWith("-"));

  let cfg: any = { server: "", port: DEFAULT_PORT, nickname: "", aliveInterval: 10 };
  try {
    cfg = { ...cfg, ...(JSON.parse((await fs.readFile(CONFIG_PATH)) || "{}")) };
  } catch (_) { /* config optional */ }

  // Interval signal alive (detik) — dari config client (default 10 dtk).
  // Server memakai lastSeen (dari ping ini) untuk menentukan warna bullet
  // anggota di semua client (hijau/kuning/merah).
  const aliveIntervalSec = Math.max(3, parseInt(cfg.aliveInterval) || 10);
  const pingIntervalMs = aliveIntervalSec * 1000;

  // clientId STABIL — identitas unik pengguna/node (tersimpan di config.json).
  // Server memakai ini saat reconnect (buka-tutup-buka) untuk menggantikan sesi
  // lama → anggota tidak dobel di daftar room.
  let clientId = cfg.clientId || genClientId();

  const defaultNick = (await shell.getenv("HOSTNAME")) || "node";
  let port = DEFAULT_PORT;
  let serverAddr = "";
  let nickname = cfg.nickname || defaultNick;
  // Apakah nickname sudah pasti (dari argumen/config)? Kalau belum, minta user
  // mengisi via dialog setelah window mount (di onSetup), lalu simpan ke config.
  let nicknameProvided = !!cfg.nickname;

  serverAddr = pos[0] || cfg.server || "";
  if (pos[1]) port = parseInt(pos[1]) || cfg.port || DEFAULT_PORT;
  if (pos[2]) {
    nickname = pos[2];
    nicknameProvided = true;
  }

  await std.log(
    `[air-type] Mode: CLIENT | nick=${nickname} | port=${port}`,
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
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let presenceTimer: ReturnType<typeof setInterval> | null = null;

  // Keanggotaan room + umur signal alive (dari broadcast presence server).
  const membersByRoom: Record<string, { nick: string; lastSeen: number }[]> = {};
  // Threshold warna bullet (hijau/kuning/merah) — default, di-override server.
  let presenceThresholds = { greenMax: 10, yellowMax: 299, redMin: 300 };

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
  lblRole.caption = "📡 CLIENT";

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
  statusBar.text = `📡 ${serverAddr || "?"}:${port} · 🔒 E2E chacha20 (RSA handshake)`;
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

  // Serialisasi render daftar room — cegah dua setContent("room-list") yang
  // tumpang tindih (race) yang membuat item ter-duplikasi di browser.
  // Tiap room = baris header (# nama) + baris anggota (● nick) di bawahnya.
  // Warna bullet = umur signal alive anggota: hijau (segar) / kuning (ragu) /
  // merah (timeout). Threshold diambil dari broadcast presence server.
  let roomsRenderChain: Promise<void> = Promise.resolve();
  function bulletColor(lastSeen: number): string {
    const age = Math.floor((Date.now() - lastSeen) / 1000);
    if (age <= presenceThresholds.greenMax) return "#4caf50"; // hijau: alive segar
    if (age < presenceThresholds.redMin) return "#ffc107";     // kuning: mencurigakan
    return "#f44336";                                          // merah: timeout
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
          rows.push({
            id: `room-row-${safeId(room)}`,
            tag: "div",
            props: {
              onClickId: `room-row-${safeId(room)}`,
              style: {
                padding: "5px 4px",
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: "700",
                color: isActive ? "var(--accent, #4caf50)" : "var(--text, #e0e0e0)",
                background: isActive ? "var(--accent-bg, rgba(76,175,80,0.15))" : "transparent",
                borderRadius: "4px",
              },
              text: `# ${room}`,
            },
            children: [],
          });
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
        await form.screen.setContent("room-list", ...rows);
        // Bind klik room header (aman: registerHandler REPLACE, bukan stack).
        for (const room of rooms) {
          form.screen.on(`room-row-${safeId(room)}`, "click", () => {
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
      try { await fs.mkdir("/etc/air-type"); } catch (_) { /* sudah ada */ }
      await fs.writeFile(HISTORY_PATH, JSON.stringify(history));
    } catch (_) { /* non-fatal: history tetap in-memory */ }
  }

  async function saveConfig() {
    try {
      try { await fs.mkdir("/etc/air-type"); } catch (_) { /* sudah ada */ }
      const data = { server: serverAddr || cfg.server || "", port, nickname, aliveInterval: aliveIntervalSec, clientId };
      await fs.writeFile(CONFIG_PATH, JSON.stringify(data, null, 2));
    } catch (_) { /* non-fatal */ }
  }

  async function setRoom(room: string) {
    const isSwitch = room !== currentRoom;
    currentRoom = room;
    // Selalu sinkronkan label judul room — bahkan jika room == currentRoom.
    // Dipanggil dari createRoom (auto-join) maupun klik daftar room.
    await form.screen.update("lbl-room", { text: "# " + room });
    // Flush eksplisit: update lbl-room JANGAN menunggu batch setTimeout — supaya
    // langsung tampil walau setelahnya ada setContent dari renderRooms/renderHistory.
    await form.screen.win.flush();
    if (!isSwitch) return; // sudah di room ini — tidak perlu re-render/join ulang
    // CATATAN: setRoom TIDAK memanggil renderRooms() di sini — klik baris room
    // di renderRooms() sudah memanggil renderRooms() ulang setelah setRoom untuk
    // meng-highlight room aktif. Ini mencegah DUA setContent("room-list") yang
    // tumpang tindih → item ter-duplikasi.
    await renderHistory();
    if (clientFd >= 0) {
      await clientSend({ t: "join", room, nick: nickname, clientId }).catch(() => {});
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
      await clientSend({ t: "join", room: "general", nick: nickname, clientId });
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
      } else if (msg.t === "presence") {
        // Keanggotaan room + umur signal alive → warna bullet.
        if (msg.thresholds) {
          presenceThresholds = {
            greenMax: parseInt(msg.thresholds.greenMax) || presenceThresholds.greenMax,
            yellowMax: parseInt(msg.thresholds.yellowMax) || presenceThresholds.yellowMax,
            redMin: parseInt(msg.thresholds.redMin) || presenceThresholds.redMin,
          };
        }
        if (msg.rooms && typeof msg.rooms === "object") {
          for (const k of Object.keys(membersByRoom)) delete membersByRoom[k];
          for (const k of Object.keys(msg.rooms)) {
            if (Array.isArray(msg.rooms[k])) {
              membersByRoom[k] = msg.rooms[k]
                .filter((m: any) => m && m.nick)
                .map((m: any) => ({ nick: String(m.nick), lastSeen: Number(m.lastSeen) || 0 }));
              if (!rooms.includes(k)) rooms.push(k);
            }
          }
        }
        void renderRooms();
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

    // Keepalive agar server tidak menganggap client mati — interval dari config
    // client (aliveInterval, default 10 dtk) → warna bullet anggota tetap hijau.
    pingTimer = setInterval(() => {
      if (running && clientFd >= 0) void clientSend({ t: "ping" }).catch(() => {});
    }, pingIntervalMs);
  }

  async function setupNetwork() {
    if (!serverAddr) {
      const ans = await TDialogs.input(
        form.screen,
        "Server",
        "Alamat MQTNL node yang menjalankan air-type-server (BUKAN IP).\nContoh: tsix, tsix-node-2 (lihat sysconfig network.interfaces[].address).\n\nAlamat server:",
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

  // ──────────────────────────────────────────────────────────
  // KIRIM PESAN (client → server)
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
        if (clientFd >= 0 && connected) {
          await clientSend({ t: "nick", nick: newNick }).catch(() => {});
        }
      }
      return;
    }

    if (!connected) {
      setStatus("⏳ Belum terhubung ke server — pesan tidak terkirim.");
      return;
    }

    const ts = Date.now();
    pushMsg(currentRoom, { from: nickname, text, ts, own: true }, true);
    await clientSend({ t: "msg", room: currentRoom, text, ts }).catch(() => {
      setStatus("⚠️ Gagal mengirim (server tidak merespons).");
    });
  }

  async function createRoom() {
    const raw = await TDialogs.input(form.screen, "＋ Room Baru", "Nama room (tanpa '#'):", "");
    if (!raw) return;
    const room = raw.trim().replace(/^#/, "").replace(/\s+/g, "-").toLowerCase();
    if (!room) return;
    if (!rooms.includes(room)) {
      rooms.push(room);
    }
    await setRoom(room);
    // Render daftar room SETELAH currentRoom berubah (highlight room baru benar),
    // dan hanya SEKALI — hindari race setContent yang menduplikasi item.
    await renderRooms();
    await clientSend({ t: "create", room, nick: nickname, clientId }).catch(() => {});
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

    await renderRooms();
    await renderHistory();

    // Refresh warna bullet tiap beberapa detik — umur signal alive bertambah
    // walau tanpa broadcast presence baru (hijau → kuning → merah).
    presenceTimer = setInterval(() => {
      if (running) void renderRooms();
    }, 4000);

    // Keydown (Enter) — TEdit cashew tidak punya onKeyDown native, jadi pakai
    // screen.on langsung (meng-set onKeydownId pada elemen input).
    form.screen.on("msg-input", "keydown", (ev: any) => {
      if (ev?.value === "Enter") void sendMessage();
    });

    // Mulai networking di background (UI tetap render duluan)
    void setupNetwork();
  };

  form.onClose = async () => {
    running = false;
    connected = false;
    if (pingTimer) clearInterval(pingTimer);
    if (presenceTimer) clearInterval(presenceTimer);
    void saveHistory();
    if (clientFd >= 0) {
      // Kabari server kita pergi (graceful) — anggota langsung hilang dari
      // daftar room, bukan nunggu timeout. Kalau leave gagal (proses dibunuh),
      // clientId di server tetap membersihkan sesi lama saat reconnect.
      try {
        await clientSend({ t: "leave", room: currentRoom, clientId });
      } catch (_) { /* socket sudah mati */ }
      try { await net.close(clientFd); } catch (_) { /* ignore */ }
    }
    void std.log("[air-type] Aplikasi ditutup.", "air-type");
  };

  await form.run();
  return;
});
