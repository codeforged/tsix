/**
 * telechatd.ts — 💬 TeleChat Server: hub chat E2E headless (CLI daemon)
 *
 * Server chat real-time antar node TSIX. Headless daemon — TIDAK ada GUI; yang
 * punya GUI hanya client (telechat). Pola seperti air-type-server.
 *
 * Keamanan E2E (ditiru dari air-type):
 *   - Handshake RSA (client minta public key → kirim session key terenkripsi
 *     RSA) → tiap koneksi punya session key ChaCha20-Poly1305 yang DINAMIS.
 *   - Server mendekripsi paket per-koneksi HANYA untuk routing protokol &
 *     pencatatan chat log, lalu meneruskan (relay) terenkripsi ke anggota room
 *     lain. Enkripsi link client↔server, bukan relay antar-client.
 *
 * Identitas 3 lapis (spek §2.1):
 *   - sid        : sid jaringan socket (addr:port) — HANYA untuk routing.
 *   - clientId   : UUID persisten di config client — identitas mutlak pengguna
 *                  (role, is_banned, kicked_rooms, dst) + anti-duplikat reconnect.
 *   - nickname   : label visual unik antar pengguna AKTIF.
 *
 * Data & konfigurasi (/etc/telechatd/):
 *   /etc/telechatd/config.json      — konfigurasi server
 *   /etc/telechatd/users.json       — profil pengguna persisten
 *   /etc/telechatd/rooms.json       — daftar room persisten
 *   /etc/telechatd/logs/chat_YYYY-MM-DD.log — chat log & aktivitas sistem
 *
 * Jalankan (daemon):
 *   telechatd [port]            (default port 2510)
 *   telechatd --fg              (tetap di foreground untuk debug)
 *
 * Client (GUI):
 *   telechat <serverAddr> [port] [nick]
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, shell, net, fs } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";
import { PacketFlags } from "@common/PacketFlags";

const DEFAULT_PORT = 2510;
const RSA_DIR = "/etc/keys/rsa";
const CONFIG_DIR = "/etc/telechatd";
const CONFIG_PATH = `${CONFIG_DIR}/config.json`;
const USERS_PATH = `${CONFIG_DIR}/users.json`;
const ROOMS_PATH = `${CONFIG_DIR}/rooms.json`;
const LOG_DIR = `${CONFIG_DIR}/logs`;
const FLAG = PacketFlags.FLAG_DATA;
const LOBBY = "#lobby";

// ────────────────────────────────────────────────────────────
// MODEL DATA (spek §3)
// ────────────────────────────────────────────────────────────
interface UserEntity {
  client_id: string;
  nickname: string;
  role: "admin" | "guest";
  phone_number?: string;
  email?: string;
  is_banned: boolean;
  kicked_rooms: string[];
  active_status: number; // 0: Inactive · 1: Active Visible · 2: Active Invisible
  last_presence: number;
}

interface RoomEntity {
  room_id: string; // misal: "#lobby"
  room_name: string;
  is_default: boolean;
  created_by: string; // client_id
}

interface Peer {
  addr: string; // alamat MQTNL client (pkt.src)
  port: number; // port sumber client (pkt.port / localPort client)
  agent: SecurityAgent; // session key dinamis per-koneksi
  clientId: string;
  nick: string;
  room: string;
  lastSeen: number;
  activeStatus: number;
  joined: boolean; // false = masih handshake/join validation belum lolos
}

export const main = Program(async (args: string[]) => {
  const foreground = args.includes("--fg");
  const port =
    parseInt(args.find((a) => /^\d+$/.test(a)) || "") || DEFAULT_PORT;

  // --- Identitas RSA node (sama seperti air-type / airtermd) ---
  let pubKey = "";
  let privateKey = "";
  try {
    pubKey = (await fs.readFile(`${RSA_DIR}/id_rsa.pub`)) || "";
    privateKey = (await fs.readFile(`${RSA_DIR}/id_rsa`)) || "";
  } catch (_) {
    /* kosong */
  }

  if (!pubKey || !privateKey) {
    await std.print(
      `❌ Identitas RSA tidak ditemukan di ${RSA_DIR}. Jalankan 'init' dulu.\n`,
    );
    return;
  }
  const fingerprint = SecurityAgent.getFingerprint(pubKey);

  // --- Konfigurasi server ---
  const defaultCfg: any = {
    port,
    defaultRole: "guest", // role otomatis untuk pengguna baru
    adminClientIds: [], // clientId yang otomatis jadi admin
    onlineMaxAge: 60, // sinyal <= 60 dtk → Online (hijau), > 60 → Offline (merah)
    staleMs: 300000, // cleanup: buang sesi idle > staleMs
    presenceInterval: 5000, // broadcast presence periodik (ms)
    cleanupInterval: 30000, // interval loop pembersihan sesi (ms)
    logMessageContent: true, // false = log metadata saja (tanpa isi chat)
  };
  let cfg: any = { ...defaultCfg };
  try {
    const raw = await fs.readFile(CONFIG_PATH);
    if (raw) cfg = { ...defaultCfg, ...(JSON.parse(raw) || {}) };
  } catch (_) {
    try {
      await fs.mkdir(CONFIG_DIR);
      await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    } catch (_2) {
      /* non-fatal */
    }
  }
  cfg.port = cfg.port || port;

  // --- State persisten ---
  const users = new Map<string, UserEntity>(); // clientId → profil pengguna
  const rooms: RoomEntity[] = []; // daftar room (default #lobby)
  const clients = new Map<string, Peer>(); // sid → sesi jaringan
  const roomMembers = new Map<string, Set<string>>(); // roomId → Set<sid>
  const clientIdToSid = new Map<string, string>(); // clientId → sid (dedup reconnect)

  // Load users persisten
  try {
    const raw = await fs.readFile(USERS_PATH);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const u of arr) {
          if (u && u.client_id) users.set(u.client_id, u);
        }
      }
    }
  } catch (_) {
    /* belum ada */
  }

  // Load rooms persisten
  try {
    const raw = await fs.readFile(ROOMS_PATH);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const r of arr) {
          if (r && r.room_id) rooms.push(r);
        }
      }
    }
  } catch (_) {
    /* belum ada */
  }

  // Pastikan #lobby selalu ada sebagai room default
  if (!rooms.some((r) => r.room_id === LOBBY)) {
    rooms.unshift({
      room_id: LOBBY,
      room_name: "Lobby",
      is_default: true,
      created_by: "system",
    });
  }

  async function saveUsers() {
    try {
      await fs.mkdir(CONFIG_DIR);
      await fs.writeFile(
        USERS_PATH,
        JSON.stringify([...users.values()], null, 2),
      );
    } catch (_) {
      /* non-fatal */
    }
  }
  async function saveRooms() {
    try {
      await fs.mkdir(CONFIG_DIR);
      await fs.writeFile(ROOMS_PATH, JSON.stringify(rooms, null, 2));
    } catch (_) {
      /* non-fatal */
    }
  }

  // ────────────────────────────────────────────────────────────
  // CHAT LOGGING (spek §4.5) — append ke chat_YYYY-MM-DD.log
  // ────────────────────────────────────────────────────────────
  function nowStamp(): string {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
  }
  function logDate(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }
  async function appendLog(line: string) {
    try {
      await fs.mkdir(LOG_DIR);
      const path = `${LOG_DIR}/chat_${logDate()}.log`;
      const existing = (await fs.readFile(path)) || "";
      await fs.writeFile(path, existing + line + "\n");
    } catch (_) {
      /* non-fatal */
    }
  }
  /** Catat pesan obrolan (dilewati bila logMessageContent=false). */
  async function logChat(room: string, peer: Peer, text: string) {
    if (!cfg.logMessageContent) return;
    await appendLog(
      `[${nowStamp()}] [chat] [${room}] <${peer.nick} (${peer.clientId})> ${text}`,
    );
  }
  /** Catat aktivitas sistem (join, leave, kick, ban, dll). */
  async function logActivity(text: string) {
    await appendLog(`[${nowStamp()}] [system] ${text}`);
  }

  // ────────────────────────────────────────────────────────────
  // SOCKET SERVER
  // ────────────────────────────────────────────────────────────
  const socket = await net.socket();
  if (socket < 0) {
    await std.print("❌ Gagal membuat socket server.\n");
    return;
  }
  const ok = await net.bind(socket, cfg.port);
  if (!ok) {
    await std.print(`❌ Port ${cfg.port} sudah dipakai.\n`);
    return;
  }

  await std.print(
    `\t  TeleChat Server aktif di MQTNL port ${cfg.port} · 🔒 ${fingerprint.slice(0, 12)}…\n`,
  );
  await std.log(
    `[telechatd] Server chat aktif di port ${cfg.port} (fingerprint ${fingerprint.slice(0, 12)}…).`,
    "telechatd",
  );

  // --- DAEMONIZE (jalan di background, seperti air-type-server) ---
  if (!foreground) {
    try {
      const daemonOk = await shell.daemonize("TeleChat Server");
      if (daemonOk) {
        await std.log(
          "[telechatd] Daemonized — berjalan di background.",
          "telechatd",
        );
      } else {
        await std.log(
          "[telechatd] daemonize gagal — tetap jalan di foreground.",
          "telechatd",
        );
      }
    } catch (e: any) {
      await std.log(
        `[telechatd] daemonize error: ${e?.message || e}`,
        "telechatd",
      );
    }
  }

  // ────────────────────────────────────────────────────────────
  // RELAY HELPERS
  // ────────────────────────────────────────────────────────────
  async function sendToPeer(peer: Peer, obj: any) {
    if (!peer) return;
    const enc = peer.agent.securePacketOut(JSON.stringify(obj));
    await net.sendto(socket, peer.addr, peer.port, enc, FLAG, cfg.port);
  }

  async function relayToRoom(room: string, obj: any, exceptSid: string = "") {
    const members = roomMembers.get(room);
    if (!members) return;
    const payload = JSON.stringify(obj);
    for (const sid of members) {
      if (sid === exceptSid) continue;
      const peer = clients.get(sid);
      if (!peer || !peer.joined) continue;
      try {
        const enc = peer.agent.securePacketOut(payload);
        await net.sendto(socket, peer.addr, peer.port, enc, FLAG, cfg.port);
      } catch (_) {
        /* skip */
      }
    }
  }

  function broadcastRooms() {
    const payload = { t: "rooms", list: rooms.map((r) => r.room_id) };
    for (const peer of clients.values()) {
      if (!peer.joined) continue;
      void sendToPeer(peer, payload).catch(() => {});
    }
  }

  /**
   * Broadcast presence ke seluruh client — daftar anggota per-room.
   * Pengguna dengan active_status 2 (Invisible) & 0 (Inactive) TIDAK ikut
   * ditampilkan (cegah backdoor presensi, spek §3.1).
   */
  function broadcastPresence() {
    const roomsData: Record<string, { nick: string; lastSeen: number }[]> = {};
    for (const [room, members] of roomMembers.entries()) {
      const list: { nick: string; lastSeen: number }[] = [];
      for (const sid of members) {
        const p = clients.get(sid);
        if (!p || !p.joined) continue;
        if (p.activeStatus !== 1) continue; // invisible/inactive → disembunyikan
        list.push({ nick: p.nick, lastSeen: p.lastSeen });
      }
      roomsData[room] = list;
    }
    const payload = {
      t: "presence",
      onlineMaxAge: cfg.onlineMaxAge,
      serverTime: Date.now(),
      rooms: roomsData,
    };
    for (const peer of clients.values()) {
      if (!peer.joined) continue;
      void sendToPeer(peer, payload).catch(() => {});
    }
  }

  /** Notifikasi sistem ke room (TIDAK dikirim untuk pengguna invisible/inactive). */
  async function serverSys(room: string, text: string) {
    await relayToRoom(room, { t: "sys", room, text, ts: Date.now() });
  }

  function sidOf(peer: Peer): string {
    return `${peer.addr}:${peer.port}`;
  }

  // ────────────────────────────────────────────────────────────
  // PROTOKOL CHAT (spek §4)
  // ────────────────────────────────────────────────────────────
  function normalizeRoom(name: string): string {
    let r = String(name || LOBBY).trim();
    if (!r.startsWith("#")) r = "#" + r;
    return r.toLowerCase().replace(/\s+/g, "-");
  }

  async function joinRoom(peer: Peer, room: string): Promise<boolean> {
    const roomId = normalizeRoom(room);
    const sid = sidOf(peer);
    const user = users.get(peer.clientId);

    // Room Access Validation (spek §4.2) — kecuali #lobby (ruang default).
    if (user && roomId !== LOBBY && user.kicked_rooms.includes(roomId)) {
      await sendToPeer(peer, {
        t: "error",
        code: "ROOM_DENIED",
        room: roomId,
        message: `Kamu di-kick dari ${roomId}. Tidak bisa masuk kembali.`,
      });
      return false;
    }
    // Room harus sudah ada (hanya admin yang bisa bikin room baru).
    if (!rooms.some((r) => r.room_id === roomId)) {
      await sendToPeer(peer, {
        t: "error",
        code: "ROOM_NOT_FOUND",
        room: roomId,
        message: `Room ${roomId} tidak ditemukan.`,
      });
      return false;
    }

    if (peer.room && peer.room !== roomId) {
      roomMembers.get(peer.room)?.delete(sid);
    }
    peer.room = roomId;
    if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Set());
    roomMembers.get(roomId)!.add(sid);
    return true;
  }

  async function removePeer(peer: Peer, notify = true) {
    const sid = sidOf(peer);
    const room = peer.room;
    const nick = peer.nick || peer.clientId;
    if (room) roomMembers.get(room)?.delete(sid);
    if (peer.clientId && clientIdToSid.get(peer.clientId) === sid) {
      clientIdToSid.delete(peer.clientId);
    }
    clients.delete(sid);
    // Update last_presence di profil persisten
    const user = users.get(peer.clientId);
    if (user) {
      user.last_presence = Date.now();
      void saveUsers();
    }
    // Notifikasi leave — HANYA untuk pengguna visible (spek §3.1).
    if (notify && peer.joined && peer.activeStatus === 1 && room) {
      await serverSys(room, `${nick} meninggalkan ${room}`);
      await logActivity(`${nick} (${peer.clientId}) meninggalkan ${room}`);
    } else if (peer.joined) {
      await logActivity(
        `${nick} (${peer.clientId}) meninggalkan ${room || "?"} (silent)`,
      );
    }
    broadcastPresence();
  }

  async function handleJoin(peer: Peer, msg: any) {
    const sid = sidOf(peer);
    const clientId = msg.clientId ? String(msg.clientId) : "";

    // Profil persisten — dibuat bila pertama kali
    let user = clientId ? users.get(clientId) : undefined;
    if (!user && clientId) {
      const isFirstUser = users.size === 0;
      const isAdminByCfg = (cfg.adminClientIds || []).includes(clientId);
      user = {
        client_id: clientId,
        nickname: "",
        role: isFirstUser || isAdminByCfg ? "admin" : cfg.defaultRole,
        phone_number: msg.phone ? String(msg.phone) : undefined,
        email: msg.email ? String(msg.email) : undefined,
        is_banned: false,
        kicked_rooms: [],
        active_status: 1,
        last_presence: Date.now(),
      };
      users.set(clientId, user);
      await saveUsers();
      await logActivity(
        `Pengguna baru terdaftar: ${clientId} (role ${user.role})`,
      );
    }
    if (!user) {
      await sendToPeer(peer, {
        t: "error",
        code: "BAD_REQUEST",
        message: "clientId wajib diisi.",
      });
      return;
    }

    // Cek Status Ban (spek §4.1.3) — tolak koneksi
    if (user.is_banned) {
      await sendToPeer(peer, {
        t: "error",
        code: "BANNED",
        message: "Akun kamu telah di-ban dari server ini.",
      });
      await logActivity(`Koneksi ditolak (banned): ${clientId} dari ${sid}`);
      await removePeer(peer, false);
      return;
    }

    // Cek Reconnect (spek §2.2) — buang sesi lama untuk clientId yang sama
    const oldSid = clientIdToSid.get(clientId);
    if (oldSid && oldSid !== sid) {
      const oldPeer = clients.get(oldSid);
      if (oldPeer) {
        const oldRoom = oldPeer.room;
        if (oldRoom) roomMembers.get(oldRoom)?.delete(oldSid);
        clients.delete(oldSid);
        clientIdToSid.delete(clientId);
        await logActivity(
          `Sesi lama ${oldSid} (${oldPeer.nick || "?"}) digantikan reconnect (${clientId}).`,
        );
        if (oldPeer.joined && oldPeer.activeStatus === 1 && oldRoom) {
          await serverSys(
            oldRoom,
            `${oldPeer.nick} meninggalkan ${oldRoom} (reconnect)`,
          );
        }
      }
    }

    // Cek Nickname — wajib unik antar pengguna AKTIF lain (spek §3.1)
    let nick = (msg.nickname ? String(msg.nickname) : "").trim();
    if (!nick) nick = user.nickname || clientId.slice(0, 8);
    for (const [otherSid, p2] of clients.entries()) {
      if (otherSid === sid) continue;
      if (p2.joined && p2.clientId !== clientId && p2.nick === nick) {
        await sendToPeer(peer, {
          t: "error",
          code: "NICK_TAKEN",
          message: `Nickname "${nick}" sedang dipakai pengguna aktif lain.`,
          current: user.nickname || "",
        });
        return; // sesi belum diaktifkan — client boleh coba join lagi dengan nick lain
      }
    }

    // Validasi lolos → aktivasi sesi
    user.nickname = nick;
    user.last_presence = Date.now();
    if (msg.active_status !== undefined) {
      user.active_status = clampInt(msg.active_status, 0, 2, 1);
    }
    if (msg.phone) user.phone_number = String(msg.phone);
    if (msg.email) user.email = String(msg.email);
    await saveUsers();

    peer.clientId = clientId;
    peer.nick = nick;
    peer.activeStatus = user.active_status;
    peer.joined = true;
    clientIdToSid.set(clientId, sid);

    // Masuk otomatis ke ruang default #lobby (spek §4.1.4)
    await joinRoom(peer, LOBBY);

    // Kirim profil sendiri + daftar room
    await sendToPeer(peer, {
      t: "self",
      clientId,
      nickname: nick,
      role: user.role,
      active_status: user.active_status,
      is_banned: user.is_banned,
      kicked_rooms: user.kicked_rooms,
    });
    await sendToPeer(peer, { t: "rooms", list: rooms.map((r) => r.room_id) });
    await sendToPeer(peer, {
      t: "sys",
      room: LOBBY,
      text: `👋 Selamat datang di ${LOBBY}, ${nick}! Ketik /help untuk daftar perintah.`,
      ts: Date.now(),
    });

    // Notifikasi join — TIDAK untuk invisible/inactive (spek §3.1)
    if (user.active_status === 1) {
      await serverSys(LOBBY, `${nick} bergabung ke ${LOBBY}`);
      await logActivity(`${nick} (${clientId}) bergabung ke ${LOBBY}`);
    } else {
      await logActivity(
        `${nick} (${clientId}) bergabung ke ${LOBBY} (silent, status ${user.active_status})`,
      );
    }
    broadcastPresence();
  }

  function clampInt(v: any, min: number, max: number, def: number): number {
    const n = parseInt(v);
    if (isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
  }

  // ────────────────────────────────────────────────────────────
  // PARSER PERINTAH SLASH (spek §4.3) — server yang mengeksekusi
  // ────────────────────────────────────────────────────────────
  async function handleCommand(peer: Peer, msg: any) {
    const text = (msg.text || "").trim();
    const room = String(msg.room || peer.room || LOBBY);
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    const argStr = args.join(" ").trim();
    const user = users.get(peer.clientId);
    const isAdmin = user?.role === "admin";
    const sid = sidOf(peer);

    const findPeerByNick = (nick: string): Peer | null => {
      for (const p of clients.values()) {
        if (p.joined && p.nick === nick) return p;
      }
      return null;
    };

    switch (cmd) {
      case "/nickname": {
        if (!argStr) {
          await sendToPeer(peer, {
            t: "error",
            code: "USAGE",
            message: "Usage: /nickname <nama baru>",
          });
          return;
        }
        for (const [otherSid, p2] of clients.entries()) {
          if (otherSid === sid) continue;
          if (
            p2.joined &&
            p2.clientId !== peer.clientId &&
            p2.nick === argStr
          ) {
            await sendToPeer(peer, {
              t: "error",
              code: "NICK_TAKEN",
              message: `Nickname "${argStr}" sudah dipakai pengguna lain.`,
            });
            return;
          }
        }
        const oldNick = peer.nick;
        peer.nick = argStr;
        if (user) {
          user.nickname = argStr;
          await saveUsers();
        }
        await sendToPeer(peer, {
          t: "self",
          clientId: peer.clientId,
          nickname: argStr,
          role: user?.role,
          active_status: peer.activeStatus,
        });
        // Notifikasi ke room (kecuali invisible/inactive)
        if (peer.activeStatus === 1) {
          await serverSys(room, `${oldNick} kini dikenal sebagai ${argStr}`);
        }
        await logActivity(
          `${oldNick} (${peer.clientId}) ganti nama → ${argStr} di ${room}`,
        );
        broadcastPresence();
        return;
      }

      case "/status": {
        const status = clampInt(args[0], 0, 2, -1);
        if (status < 0) {
          await sendToPeer(peer, {
            t: "error",
            code: "USAGE",
            message:
              "Usage: /status <0|1|2> — 0: Inactive · 1: Visible · 2: Invisible",
          });
          return;
        }
        peer.activeStatus = status;
        if (user) {
          user.active_status = status;
          await saveUsers();
        }
        await sendToPeer(peer, {
          t: "self",
          clientId: peer.clientId,
          nickname: peer.nick,
          role: user?.role,
          active_status: status,
        });
        await logActivity(
          `${peer.nick} (${peer.clientId}) ubah status presensi → ${statusName(status)}`,
        );
        // Tidak ada notifikasi join/leave untuk invisible — hanya refresh presence.
        broadcastPresence();
        return;
      }

      case "/kick": {
        if (!isAdmin) {
          await sendToPeer(peer, {
            t: "error",
            code: "ADMIN_ONLY",
            message: "Hanya admin yang bisa /kick.",
          });
          return;
        }
        if (!argStr) {
          await sendToPeer(peer, {
            t: "error",
            code: "USAGE",
            message: "Usage: /kick <nickname>",
          });
          return;
        }
        const target = findPeerByNick(argStr);
        if (!target) {
          await sendToPeer(peer, {
            t: "error",
            code: "NOT_FOUND",
            message: `Pengguna "${argStr}" tidak ditemukan / offline.`,
          });
          return;
        }
        if (room === LOBBY) {
          await sendToPeer(peer, {
            t: "error",
            code: "USAGE",
            message: "Tidak bisa /kick dari #lobby (ruang default).",
          });
          return;
        }
        const targetUser = users.get(target.clientId);
        if (targetUser && !targetUser.kicked_rooms.includes(room)) {
          targetUser.kicked_rooms.push(room);
          await saveUsers();
        }
        // Pindahkan target secara paksa ke #lobby
        await joinRoom(target, LOBBY);
        await sendToPeer(target, {
          t: "kicked",
          room,
          message: `Kamu di-kick dari ${room} oleh ${peer.nick}.`,
        });
        await serverSys(
          room,
          `${target.nick} di-kick dari ${room} oleh ${peer.nick}`,
        );
        await logActivity(
          `${peer.nick} (${peer.clientId}) kick ${target.nick} (${target.clientId}) dari ${room}`,
        );
        broadcastPresence();
        return;
      }

      case "/ban": {
        if (!isAdmin) {
          await sendToPeer(peer, {
            t: "error",
            code: "ADMIN_ONLY",
            message: "Hanya admin yang bisa /ban.",
          });
          return;
        }
        if (!argStr) {
          await sendToPeer(peer, {
            t: "error",
            code: "USAGE",
            message: "Usage: /ban <nickname>",
          });
          return;
        }
        // Cari target: sesi aktif dulu, lalu profil tersimpan (ban offline)
        let target = findPeerByNick(argStr);
        let targetUser = target ? users.get(target.clientId) : undefined;
        if (!targetUser) {
          for (const u of users.values()) {
            if (u.nickname === argStr) {
              targetUser = u;
              break;
            }
          }
        }
        if (!targetUser) {
          await sendToPeer(peer, {
            t: "error",
            code: "NOT_FOUND",
            message: `Pengguna "${argStr}" tidak ditemukan.`,
          });
          return;
        }
        targetUser.is_banned = true;
        await saveUsers();
        if (target) {
          await sendToPeer(target, {
            t: "banned",
            message: `Kamu di-ban oleh ${peer.nick}.`,
          });
          await removePeer(target, false); // putus koneksi paksa
        }
        await serverSys(room, `${argStr} di-ban oleh ${peer.nick}`);
        await logActivity(
          `${peer.nick} (${peer.clientId}) ban ${argStr} (${targetUser.client_id})`,
        );
        broadcastPresence();
        return;
      }

      case "/role": {
        if (!isAdmin) {
          await sendToPeer(peer, {
            t: "error",
            code: "ADMIN_ONLY",
            message: "Hanya admin yang bisa /role.",
          });
          return;
        }
        const nick = args[0];
        const role = (args[1] || "").toLowerCase();
        if (!nick || (role !== "admin" && role !== "guest")) {
          await sendToPeer(peer, {
            t: "error",
            code: "USAGE",
            message: "Usage: /role <nickname> <admin|guest>",
          });
          return;
        }
        let target = findPeerByNick(nick);
        let targetUser = target ? users.get(target.clientId) : undefined;
        if (!targetUser) {
          for (const u of users.values()) {
            if (u.nickname === nick) {
              targetUser = u;
              break;
            }
          }
        }
        if (!targetUser) {
          await sendToPeer(peer, {
            t: "error",
            code: "NOT_FOUND",
            message: `Pengguna "${nick}" tidak ditemukan.`,
          });
          return;
        }
        targetUser.role = role as "admin" | "guest";
        await saveUsers();
        if (target) {
          await sendToPeer(target, {
            t: "self",
            clientId: target.clientId,
            nickname: target.nick,
            role,
            active_status: target.activeStatus,
          });
        }
        await serverSys(room, `${nick} kini berperan ${role}`);
        await logActivity(
          `${peer.nick} (${peer.clientId}) set role ${nick} → ${role}`,
        );
        return;
      }

      case "/rooms": {
        await sendToPeer(peer, {
          t: "rooms",
          list: rooms.map((r) => r.room_id),
        });
        return;
      }

      case "/who": {
        const members = roomMembers.get(room) || new Set<string>();
        const list: string[] = [];
        for (const m of members) {
          const p = clients.get(m);
          if (p && p.joined && p.activeStatus === 1) list.push(p.nick);
        }
        await sendToPeer(peer, {
          t: "sys",
          room,
          text: `Anggota ${room} (${list.length}): ${list.join(", ") || "—"}`,
          ts: Date.now(),
        });
        return;
      }

      case "/help": {
        await sendToPeer(peer, {
          t: "sys",
          room,
          text:
            "💬 Perintah TeleChat:\n" +
            "  /nickname <nama>     — ganti nickname\n" +
            "  /status <0|1|2>      — 0 Inactive · 1 Visible · 2 Invisible\n" +
            "  /kick <nama>         — (admin) kick dari room saat ini\n" +
            "  /ban <nama>          — (admin) ban permanen + putus koneksi\n" +
            "  /role <nama> <r>     — (admin) set admin|guest\n" +
            "  /rooms               — daftar room\n" +
            "  /who                 — anggota room saat ini\n" +
            "  /help                — bantuan ini\n" +
            "Client-local: /clear (bersihkan history layar)",
          ts: Date.now(),
        });
        return;
      }

      default: {
        await sendToPeer(peer, {
          t: "error",
          code: "UNKNOWN_CMD",
          message: `Perintah tidak dikenal: ${parts[0]} — ketik /help.`,
        });
        return;
      }
    }
  }

  function statusName(s: number): string {
    if (s === 0) return "Inactive";
    if (s === 2) return "Invisible";
    return "Visible";
  }

  // ────────────────────────────────────────────────────────────
  // PENGOLAH PESAN MASUK (protokol chat)
  // ────────────────────────────────────────────────────────────
  async function handleChat(peer: Peer, msg: any) {
    const t = msg.t;

    if (t === "ping") {
      // Heartbeat (spek §4.4) — refresh lastSeen
      peer.lastSeen = Date.now();
      const user = users.get(peer.clientId);
      if (user) {
        user.last_presence = Date.now();
        void saveUsers();
      }
      return;
    }

    if (t === "join") {
      await handleJoin(peer, msg);
      return;
    }

    // Semua tipe di bawah butuh sesi aktif (joined)
    if (!peer.joined) return;

    if (t === "msg") {
      const room = String(msg.room || peer.room || LOBBY);
      const text = String(msg.text || "");
      if (!text.trim()) return;
      // Pengguna status 0 (Inactive) → seluruh aktivitasnya diabaikan server
      if (peer.activeStatus === 0) {
        await logActivity(
          `${peer.nick} (${peer.clientId}) pesan diabaikan (status Inactive)`,
        );
        return;
      }
      const chat = {
        t: "chat",
        room,
        from: peer.nick,
        fromClientId: peer.clientId,
        text,
        ts: msg.ts || Date.now(),
      };
      // Relay ke anggota room lain (sender tidak menerima ulang).
      await relayToRoom(room, chat, sidOf(peer));
      await logChat(room, peer, text);
      return;
    }

    if (t === "cmd") {
      await handleCommand(peer, msg);
      return;
    }

    if (t === "switch" || t === "create") {
      const roomId = normalizeRoom(msg.room || "");
      if (t === "create") {
        // Room Creation Privilege (spek §4.2) — admin only
        const user = users.get(peer.clientId);
        if (user?.role !== "admin") {
          await sendToPeer(peer, {
            t: "error",
            code: "ADMIN_ONLY",
            message: "Hanya admin yang bisa membuat room baru.",
          });
          return;
        }
        if (!roomId || roomId === LOBBY) {
          await sendToPeer(peer, {
            t: "error",
            code: "USAGE",
            message: "Usage: nama room (tanpa '#')",
          });
          return;
        }
        if (rooms.some((r) => r.room_id === roomId)) {
          await sendToPeer(peer, {
            t: "error",
            code: "ROOM_EXISTS",
            message: `Room ${roomId} sudah ada.`,
          });
          return;
        }
        rooms.push({
          room_id: roomId,
          room_name: roomId,
          is_default: false,
          created_by: peer.clientId,
        });
        await saveRooms();
        broadcastRooms();
        await logActivity(
          `${peer.nick} (${peer.clientId}) membuat room ${roomId}`,
        );
      }
      if (!roomId) return;
      const prevRoom = peer.room;
      const okJoin = await joinRoom(peer, roomId);
      if (!okJoin) return;
      if (prevRoom !== roomId && peer.activeStatus === 1) {
        await serverSys(roomId, `${peer.nick} bergabung ke ${roomId}`);
      }
      await logActivity(`${peer.nick} (${peer.clientId}) pindah ke ${roomId}`);
      broadcastPresence();
      return;
    }

    if (t === "leave") {
      await removePeer(peer, true);
      return;
    }
  }

  // ────────────────────────────────────────────────────────────
  // PAKET MASUK (handshake E2E + chat terenkripsi)
  // ────────────────────────────────────────────────────────────
  async function handlePacket(pkt: any) {
    const sid = `${pkt.src}:${pkt.port}`;
    const raw =
      typeof pkt.data === "string"
        ? pkt.data
        : Buffer.isBuffer(pkt.data)
          ? pkt.data.toString("utf8")
          : "";

    // Langkah 1: minta public key (handshake RSA)
    if (raw === "__request::key-exchange") {
      await net.sendto(
        socket,
        pkt.src,
        pkt.port,
        `__pubkey::${pubKey}::${fingerprint}`,
        FLAG,
        cfg.port,
      );
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
        clients.set(sid, {
          addr: pkt.src,
          port: pkt.port,
          agent,
          clientId: "",
          nick: "",
          room: "",
          lastSeen: Date.now(),
          activeStatus: 1,
          joined: false,
        });
        await net.sendto(
          socket,
          pkt.src,
          pkt.port,
          "__status::done",
          FLAG,
          cfg.port,
        );
        await std.log(
          `[telechatd] 🔐 Client ${sid} handshake OK — E2E session aktif.`,
          "telechatd",
        );
      } catch (e: any) {
        await std.log(
          `[telechatd] Handshake GAGAL dari ${sid}: ${e?.message || e}`,
          "telechatd",
        );
      }
      return;
    }

    // Chat (terenkripsi) — dekripsi manual per-koneksi untuk routing protokol
    const client = clients.get(sid);
    if (!client) return;
    client.lastSeen = Date.now();

    const decrypted = client.agent.securePacketIn(
      typeof raw === "string" ? raw : "",
    );
    if (!decrypted) return;
    let msg: any;
    try {
      msg = JSON.parse(decrypted);
    } catch (_) {
      return;
    }
    await handleChat(client, msg);
  }

  // ────────────────────────────────────────────────────────────
  // LOOP UTAMA + CLEANUP + PRESENCE PERIODIK
  // ────────────────────────────────────────────────────────────
  let lastCleanup = Date.now();
  let lastPresence = Date.now();
  while (true) {
    try {
      const pkt = await net.recv(socket);
      if (pkt) await handlePacket(pkt);

      const now = Date.now();
      // Cleanup sesi yang diam (dianggap keluar / offline permanen)
      if (now - lastCleanup > cfg.cleanupInterval) {
        lastCleanup = now;
        let changed = false;
        for (const [sid, peer] of clients.entries()) {
          if (now - peer.lastSeen > cfg.staleMs) {
            await removePeer(peer, true);
            await logActivity(
              `Client ${sid} (${peer.nick || peer.clientId || "?"}) dianggap keluar (idle > ${cfg.staleMs}ms).`,
            );
            changed = true;
          }
        }
        if (changed) broadcastPresence();
      }
      // Broadcast presence periodik — jaga status online/offline tetap segar
      if (now - lastPresence > cfg.presenceInterval) {
        lastPresence = now;
        broadcastPresence();
      }
    } catch (e) {
      break;
    }
  }
});
