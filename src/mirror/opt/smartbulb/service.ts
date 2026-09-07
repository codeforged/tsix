/**
 * smartbulb/service.ts — 💡 JayaLaras Smart Home Service (daemon)
 *
 * Migrasi `jayalarasiot_i2c.js` (NOS, 2020) ke TSIX. Daemon ini yang
 * MEMILIKI hardware (2 chip MCP23017: relay + saklar) dan logika
 * saklar→lampu (multi-state, dusk, mapping lama — dipertahankan apa adanya).
 *
 * UI (`control.ts`) cukup terhubung via IPC (SEND_MSG/ipc_message) ke identity
 * `jayalaras.service`:
 *   - kirim  { type:"REGISTER" }        → subscribe (biar dapat push state)
 *   - kirim  { type:"UNREGISTER" }      → berhenti subscribe
 *   - kirim  { type:"GET" }             → minta state sekarang
 *   - kirim  { type:"SET", port, on }   → set satu port (logika lampu 0..15)
 *   - kirim  { type:"SETALL", on }      → set semua port
 *   - terima { type:"SMARTBULB_STATE", ports[], switches[], manual }
 *
 * Device (didaftarkan di kernel, lihat wiki/mcp23017-registration.md):
 *   relay  → /dev/mcp-bulb
 *   saklar → /dev/mcp-sw
 *
 * Cara jalan (di dalam TSIX, root):
 *   /opt/smartbulb/service.js [--hw]
 *   (tanpa --hw: bila chip tidak ketemu → jalan "simulasi" di memori,
 *    state tetap bisa diatur & dipush via IPC — enak buat tes GUI dulu)
 *
 * ⚠️ Mapping port = konfigurasi NOS 2020. Periksa ulang wiring sebelum
 *    mengandalkan mode hardware sungguhan.
 *
 * (c) 2026 TSIX Project
 */

import { UserLib } from "@tsix/UserLib";

// ── IOCTL MCP23017 (cocok dgn MCP23017Device.ts) ──
const IOCTL_SET_PIN_MODE = 0x3001;
const IOCTL_DIGITAL_WRITE = 0x3002;
const IOCTL_READ_ALL = 0x3004;
const MODE_OUTPUT = 0;
const MODE_INPUT_PULLUP = 2;

/** Device MCP23017 relay & saklar — coba urut sampai ketemu. */
const RELAY_DEV_CANDIDATES = ["/dev/mcp-bulb"];
const SWITCH_DEV_CANDIDATES = ["/dev/mcp-sw"];

/** Identity IPC yang dipakai GUI untuk terhubung ke service ini. */
const SERVICE_ID = "jayalaras.service";
/** Interval poll saklar (NOS pakai 500ms). */
const POLL_MS = 300;

/** Port logika NOS → pin fisik relay (genap → bank A, ganjil → bank B). */
function portToPin(port: number): number {
  if (port < 0 || port > 15) return 0;
  return port % 2 === 0 ? port / 2 : Math.floor(port / 2) + 8;
}

/** Jam desimal utk logika dusk (sama dgn NOS: hr += mn/59). */
function getHrMn(): { hr: number; mn: number } {
  const dt = new Date();
  let hr = dt.getHours();
  const mn = dt.getMinutes();
  hr += mn / 59;
  return { hr, mn };
}

export default class SmartBulbService {
  async execute(lib: UserLib, args: string[]) {
    const { std, fs, shell } = lib;

    if (args.includes("--help") || args.includes("-h")) {
      await std.print("Usage: service [--hw]\nJayaLaras Smart Home Service.\n");
      return;
    }

    if (await shell.daemonize("JayaLaras Smart Home Service")) {
      await std.log("=== JayaLaras Smart Home Service (daemon) ===");
    }

    const requireHw = args.includes("--hw");

    // ── Buka device relay & saklar ──
    let relayFd: number | null = null;
    let swFd: number | null = null;
    let relayDev = "";
    let swDev = "";
    for (const dev of RELAY_DEV_CANDIDATES) {
      try {
        const fd = await fs.open(dev, "w+");
        if (fd !== null) {
          relayFd = fd as number;
          relayDev = dev;
          break;
        }
      } catch (_) {
        /* coba berikutnya */
      }
    }
    for (const dev of SWITCH_DEV_CANDIDATES) {
      try {
        const fd = await fs.open(dev, "w+");
        if (fd !== null) {
          swFd = fd as number;
          swDev = dev;
          break;
        }
      } catch (_) {
        /* coba berikutnya */
      }
    }
    if (relayFd === null && requireHw) {
      if (swFd !== null) await fs.close(swFd).catch(() => {});
      await std.log(
        `[service] ❌ --hw diminta tapi relay MCP23017 tidak ditemukan.`,
      );
      return;
    }
    await std.log(
      `[service] Relay: ${relayFd !== null ? relayDev : "(simulasi)"} | Saklar: ${
        swFd !== null ? swDev : "(tidak ada → tanpa saklar fisik)"
      }`,
    );

    // ── State (sama dgn NOS) ──
    const portStates: number[] = Array(16).fill(0); // status lampu logika 0..15
    const swStates: number[] = Array(16).fill(0); // status saklar (nilai chip)
    const allowMulti: number[] = Array(16).fill(0);
    allowMulti[15] = 3; // ruang utama depan (4 langkah)
    allowMulti[8] = 2; // ruang utama belakang (3 langkah: 0..2)
    // allowMulti[7] = 3; // (dikomentari di NOS — kamar utama bukan multi)
    const multiState: number[] = Array(16).fill(0);
    let manual = 0;
    const subscribers = new Set<number>();
    let pollInFlight = false;

    // ── Inisialisasi output relay: semua OUTPUT & OFF (HIGH = mati) ──
    if (relayFd !== null) {
      for (let p = 0; p < 16; p++) {
        const pin = portToPin(p);
        try {
          await fs.ioctl(relayFd, IOCTL_SET_PIN_MODE, {
            pin,
            mode: MODE_OUTPUT,
          });
        } catch (_) {
          /* ignore */
        }
      }
    }
    // Saklar: INPUT_PULLUP (seperti NOS mcpSw.INPUT_PULLUP)
    if (swFd !== null) {
      for (let p = 0; p < 16; p++) {
        try {
          await fs.ioctl(swFd, IOCTL_SET_PIN_MODE, {
            pin: p,
            mode: MODE_INPUT_PULLUP,
          });
        } catch (_) {
          /* ignore */
        }
      }
    }

    // ── Tulis relay: aktif-low (ON = LOW, OFF = HIGH) ──
    let relayWriteQueue: Promise<void> = Promise.resolve();
    function writeRelayPort(port: number, on: boolean): Promise<void> {
      relayWriteQueue = relayWriteQueue.then(async () => {
        if (relayFd === null) return;
        try {
          const pin = portToPin(port);
          const value = on ? 0 : 1;
          await fs.ioctl(relayFd, IOCTL_DIGITAL_WRITE, { pin, value });
        } catch (_) {
          /* Keep the queue alive after a transient I2C error. */
        }
      });
      return relayWriteQueue;
    }

    function turnOff(io: number) {
      if (io < 0 || io > 15) return;
      portStates[io] = 0;
      void writeRelayPort(io, false);
    }
    function turnOn(io: number) {
      if (io < 0 || io > 15) return;
      portStates[io] = 1;
      void writeRelayPort(io, true);
    }

    /** setPortValue(port, value) — API yg dipakai control/web (NOS: manual=0). */
    function setPortValue(port: number, value: number) {
      if (value) turnOn(port);
      else turnOff(port);
      manual = 0;
    }

    // ── Baca saklar (READ_ALL → 16 bit) ──
    async function readSwitches(): Promise<number | null> {
      if (swFd === null) return null;
      try {
        const raw = (await fs.ioctl(swFd, IOCTL_READ_ALL, {})) as number | null;
        return typeof raw === "number" ? raw : null;
      } catch (_) {
        return null;
      }
    }

    // ── updateSwitchAndLamp() — transliterasi jayalarasiot_i2c.js ──
    async function updateSwitchAndLamp() {
      const raw = await readSwitches();
      if (raw === null) return;
      for (let i = 0; i < 16; i++) {
        let pin = i;
        const switchPin = pin;
        const value = (raw >> pin) & 0x01;
        if (value === swStates[pin]) continue;
        swStates[pin] = value;

        if (allowMulti[pin] > 0) {
          multiState[pin]++;
          if (multiState[pin] > allowMulti[pin]) multiState[pin] = 0;
          const m = multiState[pin];

          if (pin === 7) {
            // kamar utama
            if (m === 0) {
              turnOff(15);
              turnOff(10);
            } else if (m === 1) {
              turnOff(15);
              turnOn(10);
            } else if (m === 2) {
              turnOn(15);
              turnOff(10);
            } else {
              turnOn(15);
              turnOn(10);
            }
          } else if (pin === 8) {
            // ruang utama belakang
            if (m === 0) {
              turnOff(3);
              turnOff(8);
            } else if (m === 1) {
              turnOff(3);
              turnOn(8);
            } else if (m === 2) {
              turnOn(3);
              turnOff(8);
            } else {
              turnOn(3);
              turnOn(8);
            }
          } else if (pin === 15) {
            // ruang utama depan — logika dusk (jam >=18 atau <5)
            const hrmn = getHrMn();
            if (hrmn.hr >= 18 || hrmn.hr < 5) {
              if (m === 0 || m === 2) turnOff(4);
              else turnOn(4);
            } else {
              if (m === 0) {
                turnOff(9);
                turnOff(4);
              } else if (m === 1) {
                turnOff(9);
                turnOn(4);
              } else if (m === 2) {
                turnOn(9);
                turnOff(4);
              } else {
                turnOn(9);
                turnOn(4);
              }
            }
          }
        } else {
          // Mapping saklar → lampu (sama dgn NOS, apa adanya)
          if (pin === 15) pin = 9;
          else if (pin === 9) pin = 11;
          else if (pin === 8) pin = 8;
          else if (pin === 3) pin = 7;
          else if (pin === 7) pin = 15;
          else if (pin === 12) pin = 10;
          else if (pin === 11) {
            pin = 12;
            if (value === 1) turnOff(5);
            else turnOn(5);
          }

          // aktif-low: state 0 = tombol ditekan → lampu ON (kecuali kamar mandi
          // pin 11 pakai sensor gerak → dibalik di cabang pin==11 di atas)
          if (value === 0) {
            turnOn(pin);
          } else {
            if (switchPin === 11) turnOn(pin);
            else turnOff(pin);
          }
        }
        manual = 1;
        pushState();
      }
    }

    // ── Push state ke subscriber (GUI) ──
    function pushState(toPid?: number) {
      const data = {
        type: "SMARTBULB_STATE",
        ports: [...portStates],
        switches: [...swStates],
        manual,
      };
      if (toPid !== undefined) {
        void shell.send(toPid, data).catch(() => {
          subscribers.delete(toPid);
        });
      } else {
        for (const p of subscribers) {
          void shell.send(p, data).catch(() => {
            subscribers.delete(p);
          });
        }
      }
    }

    // ── Identity + listener IPC ──
    try {
      await shell.registerIdentity(SERVICE_ID);
      await std.log(`[service] Identity terdaftar: ${SERVICE_ID}`);
    } catch (e: any) {
      await std.log(`[service] Identity gagal: ${e?.message || e}`);
    }

    lib.onEvent("ipc_message", (msg: any) => {
      const p = msg?.data || msg;
      if (!p || !p.type) return;
      const fromPid =
        typeof msg?.fromPid === "number" ? msg.fromPid : undefined;

      if (p.type === "REGISTER") {
        if (fromPid !== undefined) subscribers.add(fromPid);
        pushState(fromPid);
      } else if (p.type === "UNREGISTER") {
        if (fromPid !== undefined) subscribers.delete(fromPid);
      } else if (p.type === "GET") {
        pushState(fromPid);
      } else if (p.type === "SET") {
        const port = p.port;
        if (typeof port === "number" && port >= 0 && port < 16) {
          setPortValue(port, p.on ? 1 : 0);
          pushState();
        }
      } else if (p.type === "SETALL") {
        const on = p.on ? 1 : 0;
        for (let i = 0; i < 16; i++) setPortValue(i, on);
        pushState();
      } else if (p.type === "PING") {
        pushState(fromPid);
      }
    });

    let shuttingDown = false;
    const cleanup = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (relayFd !== null) await fs.close(relayFd).catch(() => {});
      if (swFd !== null) await fs.close(swFd).catch(() => {});
    };

    lib.onEvent("signal", async (sig: any) => {
      if (sig === "SIGTERM") {
        await cleanup();
        await shell.exit(0);
      }
    });

    // ── Loop utama: poll saklar (NOS: 500ms; di sini 300ms biar responsif) ──
    setInterval(() => {
      if (pollInFlight) return;
      pollInFlight = true;
      void updateSwitchAndLamp()
        .catch(() => {})
        .finally(() => {
          pollInFlight = false;
        });
    }, POLL_MS);

    await std.log(
      `[service] Siap. ${swFd !== null ? "Poll saklar aktif" : "Tanpa saklar fisik (sim)"}. ` +
        `Kirim perintah via IPC ke "${SERVICE_ID}".`,
    );

    // Tetap hidup sebagai daemon.
    await new Promise<never>(() => {});
  }
}
