import { UserLib } from "../lib/UserLib";

/**
 * /etc/rc.local.ts - System Startup Script
 *
 * This script is executed by init (PID 1) during boot sequence.
 * Use it to start system daemons and background services.
 *
 * Exit with code 0 for success, non-zero for failure.
 */
export default class RcLocal {
  async execute(lib: UserLib, args: string[]) {
    const green = "\x1b[92m";
    const white = "\x1b[97m";
    const reset = "\x1b[0m";
    const ok = `${green}[  ${green}OK${green}  ]${reset} `;

    await lib.std.print(`${ok} [rc.local] Starting system daemons...\n`);

    // Set SetUID bit on login binary — allows non-root users to switch users
    try {
      await lib.fs.chmod("/bin/login.js", 0o4755);
      await lib.fs.chown("/bin/login.js", 0, 0);
      await lib.std.print(`${ok} [rc.local] SetUID bit set on /bin/login.js\n`);
    } catch (e: any) {
      await lib.std.print(
        `[rc.local] Warning: Failed to set SetUID on login: ${e.message}\n`,
      );
    }

    // Start Airterm Remote Access Daemon
    try {
      const result = await lib.shell.exec(
        "/sbin/airtermd.js",
        [],
        undefined,
        undefined,
        undefined,
      );
      if (result) {
        await lib.std.print(
          `${ok} [rc.local] Airterm daemon started (PID ${result.pid}).\n`,
        );
      }
    } catch (e: any) {
      await lib.std.print(
        `[rc.local] Warning: Failed to start airtermd: ${e.message}\n`,
      );
    }

    // Start TPKG Repository Daemon
    // try {
    //   const result = await lib.shell.exec(
    //     "/sbin/tpkgd.js",
    //     [],
    //     undefined,
    //     undefined,
    //     undefined,
    //   );
    //   if (result) {
    //     await lib.std.print(
    //       `${ok} [rc.local] TPKG Repository Daemon started (PID ${result.pid}).\n`,
    //     );
    //   }
    // } catch (e: any) {
    //   await lib.std.print(
    //     `[rc.local] Warning: Failed to start tpkgd: ${e.message}\n`,
    //   );
    // }

    // Start SCP File Transfer Daemon
    try {
      const result = await lib.shell.exec(
        "/sbin/scpd.js",
        [],
        undefined,
        undefined,
        undefined,
      );
      if (result) {
        await lib.std.print(
          `${ok} [rc.local] SCP Daemon started (PID ${result.pid}).\n`,
        );
      }
    } catch (e: any) {
      await lib.std.print(
        `[rc.local] Warning: Failed to start scpd: ${e.message}\n`,
      );
    }

    // Start OTA Server for ESP update firmware Daemon
    // try {
    //   const result = await lib.shell.exec(
    //     "/sbin/otad.js",
    //     [],
    //     undefined,
    //     undefined,
    //     undefined,
    //   );
    //   if (result) {
    //     await lib.std.print(
    //       `${ok} [rc.local] OTA Server started (PID ${result.pid}).\n`,
    //     );
    //   }
    // } catch (e: any) {
    //   await lib.std.print(
    //     `[rc.local] Warning: Failed to start ota-server: ${e.message}\n`,
    //   );
    // }

    // Start IoT-Listener Daemon (MQTNL)
    // try {
    //   const result = await lib.shell.exec(
    //     "/sbin/iot-listener.js",
    //     [],
    //     undefined,
    //     undefined,
    //     undefined,
    //   );
    //   if (result) {
    //     await lib.std.print(
    //       `${ok} [rc.local] IoT Listener started (PID ${result.pid}).\n`,
    //     );
    //   }
    // } catch (e: any) {
    //   await lib.std.print(
    //     `[rc.local] Warning: Failed to start iot-listener: ${e.message}\n`,
    //   );
    // }

    // Start TeleChat Server Daemon (chat E2E headless — pengganti air-type-server)
    // try {
    //   const result = await lib.shell.exec(
    //     "/opt/telechatd/telechatd.js",
    //     [],
    //     undefined,
    //     undefined,
    //     undefined,
    //   );
    //   if (result) {
    //     await lib.std.print(
    //       `${ok} [rc.local] TeleChat Server started (PID ${result.pid}).\n`,
    //     );
    //   }
    // } catch (e: any) {
    //   await lib.std.print(
    //     `[rc.local] Warning: Failed to start telechatd: ${e.message}\n`,
    //   );
    // }

    // Marker kesiapan DOME — dibersihkan dulu supaya yang ditunggu
    // benar-benar fresh dari DOME yang baru start (VFS persisten lintas boot).
    const DOME_READY_MARKER = "/var/run/dome.ready";
    try {
      await lib.fs.unlink(DOME_READY_MARKER);
    } catch (_) {
      /* tidak ada marker lama */
    }

    // Start PixelSpace DOME Engine (Display Server)
    try {
      const result = await lib.shell.exec(
        "/opt/dome/dome.js",
        [],
        undefined,
        undefined,
        undefined,
      );
      if (result) {
        await lib.std.print(
          `${ok} [rc.local] DOME Engine started (PID ${result.pid}).\n`,
        );
      }
    } catch (e: any) {
      await lib.std.print(
        `[rc.local] Warning: Failed to start dome: ${e.message}\n`,
      );
    }

    // Tunggu DOME benar-benar siap sebelum start Asteracea.
    // DOME menulis /var/run/dome.ready setelah HTTP/WS server-nya
    // listening (artinya sudah daemonize + terdaftar sebagai GUI daemon
    // di Kernel). Polling lebih andal daripada sleep tetap — Asteracea
    // butuh DOME siap, kalau tidak CREATE_WINDOW ditolak kernel
    // ("GUI_REQ: DOME engine is not running") → layar blank.
    const DOME_WAIT_MS = 10000;
    const DOME_POLL_MS = 200;
    let domeReady = false;
    const waitStart = Date.now();
    while (Date.now() - waitStart < DOME_WAIT_MS) {
      try {
        if (await lib.fs.stat(DOME_READY_MARKER)) {
          domeReady = true;
          break;
        }
      } catch (_) {
        /* marker belum ada */
      }
      await new Promise((r) => setTimeout(r, DOME_POLL_MS));
    }
    if (domeReady) {
      await lib.std.print(
        `${ok} [rc.local] DOME ready after ${Date.now() - waitStart}ms.\n`,
      );
    } else {
      await lib.std.print(
        `[rc.local] Warning: DOME not ready within ${DOME_WAIT_MS}ms — starting Asteracea anyway.\n`,
      );
    }

    // Start Asteracea Window Manager
    try {
      const result = await lib.shell.exec(
        "/opt/asteracea/asteracea.js",
        [],
        undefined,
        undefined,
        undefined,
      );
      if (result) {
        await lib.std.print(
          `${ok} [rc.local] 🌸 Asteracea WM started (PID ${result.pid}).\n`,
        );
      }
    } catch (e: any) {
      await lib.std.print(
        `[rc.local] Warning: Failed to start asteracea: ${e.message}\n`,
      );
    }

    // Start Cron daemon (crond)
    try {
      const result = await lib.shell.exec(
        "/sbin/crond.js",
        [],
        undefined,
        undefined,
        undefined,
      );
      if (result) {
        await lib.std.print(
          `${ok} [rc.local] Cron daemon started (PID ${result.pid}).\n`,
        );
      }
    } catch (e: any) {
      await lib.std.print(
        `[rc.local] Warning: Failed to start crond: ${e.message}\n`,
      );
    }

    // Start Mysqld daemon (mysqld)
    try {
      const result = await lib.shell.exec(
        "/opt/mysqld/mysqld.js",
        [],
        undefined,
        undefined,
        undefined,
      );
      if (result) {
        await lib.std.print(
          `${ok} [rc.local] Mysqld daemon started (PID ${result.pid}).\n`,
        );
      }
    } catch (e: any) {
      await lib.std.print(
        `[rc.local] Warning: Failed to start crond: ${e.message}\n`,
      );
    }

    // Start Lantana IoT Stack daemon (listener + device-bank + distributor)
    // Satu proses menjalankan 3 layer (separation of concern per file).
    try {
      const result = await lib.shell.exec(
        "/opt/lantana/lantana.js",
        [],
        undefined,
        undefined,
        undefined,
      );
      if (result) {
        await lib.std.print(
          `${ok} [rc.local] 🌺 Lantana IoT Stack started (PID ${result.pid}).\n`,
        );
      }
    } catch (e: any) {
      await lib.std.print(
        `[rc.local] Warning: Failed to start lantana: ${e.message}\n`,
      );
    }

    await lib.std.print(`${ok} [rc.local] All startup services initialized.\n`);

    // Exit with success code
    await lib.shell.exit(0);
    return "";
  }
}
