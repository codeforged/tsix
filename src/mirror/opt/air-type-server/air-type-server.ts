/**
 * air-type-server.ts — ✈️ Air-Type: Server Chat E2E (headless, tanpa GUI)
 *
 * Hub/relay chat antar node TSIX. Headless daemon — TIDAK ada GUI; yang punya
 * GUI hanya client (air-type). Pola seperti airtermd.
 *
 * Keamanan (sama seperti client):
 *   - Handshake RSA (client minta public key → kirim session key terenkripsi
 *     RSA) → tiap koneksi punya session key ChaCha20-Poly1305 yang DINAMIS.
 *   - Server dekripsi paket per-koneksi HANYA untuk routing protokol (room),
 *     lalu meneruskan (relay) terenkripsi ke anggota room lain.
 *
 * Jalankan (daemon):
 *   air-type-server [port]
 * (default port 2500)
 *
 * Client (GUI):
 *   air-type <serverAddr> [port] [nick]
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, shell, net, fs } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";
import { PacketFlags } from "@common/PacketFlags";

const DEFAULT_PORT = 2500;
const RSA_DIR = "/etc/keys/rsa";
const PRESENCE_CONFIG_PATH = "/etc/air-type-server/config.json";
const FLAG = PacketFlags.FLAG_DATA;
const CLEANUP_INTERVAL = 30000;

interface Peer {
  addr: string; // alamat MQTNL client (pkt.src)
  port: number; // port sumber client (pkt.port / localPort client)
  agent: SecurityAgent; // session key dinamis per-koneksi
  nick: string;
  room: string;
  lastSeen: number; 
}

export const main = Program(async (args: string[]) => {
  const port = parseInt(args[0] || "") || DEFAULT_PORT;

  // --- Identitas RSA node (sama seperti airtermd) ---
  let pubKey = "";
  let privateKey = "";
  try {
    pubKey = (await fs.readFile(`${RSA_DIR}/id_rsa.pub`)) || "";
    privateKey = (await fs.readFile(`${RSA_DIR}/id_rsa`)) || "";
  } catch (_) { /* kosong */ }

  if (!pubKey || !privateKey) {
    await std.print(`❌ Identitas RSA tidak ditemukan di ${RSA_DIR}. Jalankan 'init' dulu.\n`);
    return;
  }
  const fingerprint = SecurityAgent.getFingerprint(pubKey);

  // --- State hub ---
  const clients = new Map<string, Peer>();
  const roomMembers = new Map<string, Set<string>>();
  const rooms: string[] = ["general"];

  // --- Konfigurasi presence (umur signal alive → warna bullet) ---
  // Hijau 0..greenMax dtk · Kuning greenMax+1..yellowMax dtk · Merah >= redMin dtk.
  // Default: hijau 0..10, kuning 11..299, merah >=300. Bisa diubah via
  // /etc/air-type-server/config.json, misal:
  //   {"greenMax":15,"yellowMax":240,"redMin":300,"staleMs":300000,"presenceInterval":5000}
  let presenceCfg = {
    greenMax: 10,
    yellowMax: 299,
    redMin: 300,
    staleMs: 300000,        // cleanup: buang client idle > staleMs (default = redMin)
    presenceInterval: 5000, // broadcast presence periodik (ms)
  };
  try {
    const raw = await fs.readFile(PRESENCE_CONFIG_PATH);
    if (raw) {
      presenceCfg = { ...presenceCfg, ...(JSON.parse(raw) || {}) };
    } else {
      await fs.writeFile(PRESENCE_CONFIG_PATH, JSON.stringify(presenceCfg, null, 2));
    }
  } catch (_) {
    // file belum ada → tulis default supaya mudah diedit user
    try { await fs.mkdir("/etc/air-type-server"); } catch (_2) { /* sudah ada */ }
    try { await fs.writeFile(PRESENCE_CONFIG_PATH, JSON.stringify(presenceCfg, null, 2)); } catch (_3) { /* non-fatal */ }
  }

  const socket = await net.socket();
  if (socket < 0) {
    await std.print("❌ Gagal membuat socket server.\n");
    return;
  }
  const ok = await net.bind(socket, port);
  if (!ok) {
    await std.print(`❌ Port ${port} sudah dipakai.\n`);
    return;
  }

  await std.print(
    `\t  Air-Type Server aktif di MQTNL port ${port} · 🔒 ${fingerprint.slice(0, 12)}…\n`,
  );
  await std.log(
    `[air-type-server] Server chat aktif di port ${port} (fingerprint ${fingerprint.slice(0, 12)}…).`,
    "air-type-server",
  );

  // --- DAEMONIZE (jalan di background, seperti airtermd/otad) ---
  try {
    const daemonOk = await shell.daemonize("Air-Type Server");
    if (daemonOk) {
      await std.log("[air-type-server] Daemonized — berjalan di background.", "air-type-server");
    } else {
      await std.log("[air-type-server] daemonize gagal — tetap jalan di foreground.", "air-type-server");
    }
  } catch (e: any) {
    await std.log(`[air-type-server] daemonize error: ${e?.message || e}`, "air-type-server");
  }

  // --- Relay helpers ---
  async function sendToPeer(peer: Peer, obj: any) {
    const enc = peer.agent.securePacketOut(JSON.stringify(obj));
    await net.sendto(socket, peer.addr, peer.port, enc, FLAG, port);
  }

  async function relayToRoom(room: string, obj: any, exceptSid: string = "") {
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

  function broadcastRooms() {
    const payload = { t: "rooms", list: rooms };
    for (const peer of clients.values()) {
      void sendToPeer(peer, payload).catch(() => {});
    }
  }

  /** Broadcast daftar anggota per-room + threshold warna bullet ke semua client. */
  function broadcastPresence() {
    const roomsData: Record<string, { nick: string; lastSeen: number }[]> = {};
    for (const [room, members] of roomMembers.entries()) {
      const list: { nick: string; lastSeen: number }[] = [];
      for (const sid of members) {
        const p = clients.get(sid);
        if (p) list.push({ nick: p.nick || sid, lastSeen: p.lastSeen });
      }
      roomsData[room] = list;
    }
    const payload = {
      t: "presence",
      thresholds: {
        greenMax: presenceCfg.greenMax,
        yellowMax: presenceCfg.yellowMax,
        redMin: presenceCfg.redMin,
      },
      rooms: roomsData,
    };
    for (const peer of clients.values()) {
      void sendToPeer(peer, payload).catch(() => {});
    }
  }

  async function serverSys(room: string, text: string) {
    await relayToRoom(room, { t: "sys", room, text, ts: Date.now() });
  }

  // --- Protokol chat ---
  async function handleChat(client: Peer, msg: any) {
    const sid = `${client.addr}:${client.port}`;
    const t = msg.t;

    if (t === "ping") return;

    if (t === "join" || t === "create") {
      let room = String(msg.room || "general").replace(/^#/, "").trim() || "general";
      client.nick = msg.nick || client.nick || client.addr;

      if (client.room && client.room !== room) {
        roomMembers.get(client.room)?.delete(sid);
      }
      client.room = room;

      if (!rooms.includes(room)) {
        rooms.push(room);
        broadcastRooms();
      }
      if (!roomMembers.has(room)) roomMembers.set(room, new Set());
      roomMembers.get(room)!.add(sid);

      await sendToPeer(client, { t: "rooms", list: rooms }).catch(() => {});
      await serverSys(room, `${client.nick} bergabung ke #${room}`);
      await std.log(`[air-type-server] ${client.nick} join #${room}`, "air-type-server");
      broadcastPresence();
      return;
    }

    if (t === "msg") {
      const room = String(msg.room || client.room || "general");
      const chat = {
        from: client.nick || client.addr,
        text: String(msg.text || ""),
        ts: msg.ts || Date.now(),
      };
      // Relay ke anggota room lain (sender tidak menerima ulang).
      // Catatan: server TIDAK mencatat isi chat (jaga semangat E2E).
      await relayToRoom(room, { t: "chat", room, from: chat.from, text: chat.text, ts: chat.ts }, sid);
      await std.log(`[air-type-server] [${room}] pesan dari <${chat.from}> (relay)`, "air-type-server");
      return;
    }

    if (t === "nick") {
      const oldNick = client.nick || client.addr;
      const newNick = String(msg.nick || oldNick).trim() || oldNick;
      if (newNick !== oldNick) {
        client.nick = newNick;
        await serverSys(client.room || "general", `${oldNick} kini dikenal sebagai ${newNick}`);
        broadcastPresence();
      }
      return;
    }

    if (t === "leave") {
      const room = String(msg.room || client.room || "");
      if (room) {
        roomMembers.get(room)?.delete(sid);
        if (client.room === room) client.room = "";
        await serverSys(room, `${client.nick || client.addr} meninggalkan #${room}`);
        broadcastPresence();
      }
      return;
    }
  }

  // --- Paket masuk ---
  async function handlePacket(pkt: any) {
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
        clients.set(sid, {
          addr: pkt.src,
          port: pkt.port,
          agent,
          nick: "",
          room: "",
          lastSeen: Date.now(),
        });
        await net.sendto(socket, pkt.src, pkt.port, "__status::done", FLAG, port);
        await std.log(`[air-type-server] 🔐 Client ${sid} handshake OK — E2E session aktif.`, "air-type-server");
      } catch (e: any) {
        await std.log(`[air-type-server] Handshake GAGAL dari ${sid}: ${e?.message || e}`, "air-type-server");
      }
      return;
    }

    // Chat (terenkripsi) — dekripsi manual per-koneksi untuk routing protokol
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
    await handleChat(client, msg);
  }

  // --- Loop utama + cleanup + presence periodik ---
  let lastCleanup = Date.now();
  let lastPresence = Date.now();
  while (true) {
    try {
      const pkt = await net.recv(socket);
      if (pkt) await handlePacket(pkt);

      const now = Date.now();
      // Cleanup client yang diam (dianggap keluar)
      if (now - lastCleanup > CLEANUP_INTERVAL) {
        lastCleanup = now;
        let changed = false;
        for (const [sid, peer] of clients.entries()) {
          if (now - peer.lastSeen > presenceCfg.staleMs) {
            if (peer.room) roomMembers.get(peer.room)?.delete(sid);
            clients.delete(sid);
            changed = true;
            await std.log(`[air-type-server] Client ${sid} dianggap keluar (idle).`, "air-type-server");
          }
        }
        if (changed) broadcastPresence();
      }
      // Refresh presence periodik — jaga lastSeen member tetap segar di semua client
      if (now - lastPresence > presenceCfg.presenceInterval) {
        lastPresence = now;
        broadcastPresence();
      }
    } catch (e) {
      break;
    }
  }
});
