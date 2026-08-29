/**
 *  PixelTerm, A Terminal Emulator for TSIX Desktop Environment
 *  Version 0.2
 *
 */

import { Program, std, fs, shell } from "@tsix/Application";
import { Screen, div } from "@tsix/emerald";
import { theme } from "@tsix/theme";

export const appMode = "gui";

export const main = Program(async (args: string[]) => {
  await std.log("=== PixelTerm ===");
  const appTitle = "PixelTerm";
  await theme.loadCurrent();
  theme.watch();
  const app = new Screen(appTitle, undefined, false, 680, 430);
  let currentCmd = ""; // untuk deteksi command di title bar
  const termId = "xterm-main";
  const huponexit = args.includes("--huponexit") || args.includes("-hue");
  await std.log(`[pixelterm] huponexit=${huponexit}`, "pixelterm");

  // Ambil command dari argumen pertama yang bukan flag
  const cmdArg = args.find((a: string) => !a.startsWith("-")) || "";

  const lib = (global as any)._tsixLib;

  // Compute xterm theme colors from system theme
  function isLightColor(hex: string): boolean {
    if (!hex || !hex.startsWith("#")) return false;
    let r: number, g: number, b: number;
    const h = hex.slice(1);
    if (h.length === 3) {
      r = parseInt(h[0] + h[0], 16);
      g = parseInt(h[1] + h[1], 16);
      b = parseInt(h[2] + h[2], 16);
    } else if (h.length === 6) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    } else return false;
    return 0.299 * r + 0.587 * g + 0.114 * b > 160;
  }

  function getTermTheme() {
    if (isLightColor(theme.colors.bg)) {
      return {
        background: "#ffffff",
        foreground: "#3a3a3a",
        cursor: theme.colors.accent || "#268bd2",
        cursorAccent: "#ffffff",
        selection: "rgba(204, 202, 202, 0.5)",
        // ANSI colors untuk light theme: warna terang (bright) di-map ke warna GELAP
        // biar teks tetap terbaca di background putih (mis. direktori ls: \x1b[97m)
        brightWhite: "#073642",
        white: "#657b83",
        brightBlack: "#93a1a1",
        black: "#073642",
        red: "#dc322f",
        brightRed: "#cb4b16",
        green: "#859900",
        brightGreen: "#586e75",
        yellow: "#b58900",
        brightYellow: "#657b83",
        blue: "#268bd2",
        brightBlue: "#839496",
        magenta: "#d33682",
        brightMagenta: "#6c71c4",
        cyan: "#2aa198",
        brightCyan: "#93a1a1",
      };
    }
    return {
      background: theme.colors.bg || "#0d1b2a",
      foreground: theme.colors.text || "#e0e0e0",
      cursor: theme.colors.accent || "#4caf50",
      cursorAccent: theme.colors.card || "#000000",
      selection: theme.colors.accentBg || "rgba(76,175,80,0.3)",
      // ANSI colors untuk dark theme
      brightWhite: "#ffffff",
      white: "#e0e0e0",
      brightBlack: "#555555",
      black: "#000000",
      red: "#f44336",
      brightRed: "#ef5350",
      green: "#4caf50",
      brightGreen: "#66bb6a",
      yellow: "#ff9800",
      brightYellow: "#ffb74d",
      blue: "#2196f3",
      brightBlue: "#42a5f5",
      magenta: "#9c27b0",
      brightMagenta: "#ab47bc",
      cyan: "#00bcd4",
      brightCyan: "#26c6da",
    };
  }

  // Pass theme colors langsung sebagai props di node xterm
  const termTheme = getTermTheme();

  await app.mount(
    div(
      { id: "xterm-container", style: { padding: "0", height: "100%" } },
      { id: termId, tag: "xterm" as any, props: { termTheme }, children: [] },
    ),
  );

  const ps = await shell.ps();
  const dome = ps.find((p: any) => p.name.includes("dome"));
  const domePid = dome ? dome.pid : 0;
  async function setWinTitle(title: string) {
    if (domePid)
      await shell.send(domePid, { type: "WINDOW_TITLE", wid: app.wid, title });
  }
  async function termWrite(text: string) {
    if (domePid)
      await shell.send(domePid, {
        type: "TERM_OUTPUT",
        wid: app.wid,
        targetId: termId,
        data: text,
      });
  }

  async function termRefresh() {
    if (domePid)
      await shell.send(domePid, {
        type: "TERM_REFRESH",
        wid: app.wid,
        targetId: termId,
        data: "",
      });
  }

  // Fokuskan textarea xterm di browser — user langsung bisa ngetik tanpa klik
  async function termFocus() {
    if (domePid)
      await shell.send(domePid, {
        type: "TERM_FOCUS",
        wid: app.wid,
        targetId: termId,
      });
  }

  async function applyTermTheme() {
    const colors = getTermTheme();
    if (domePid) {
      await shell
        .send(domePid, {
          type: "TERM_THEME",
          wid: app.wid,
          targetId: termId,
          colors,
        })
        .catch(() => {});
    }
  }

  // Terapkan ukuran ke slave PTY via TIOCSWINSZ (ioctl 3). Kernel yang resize,
  // update env LINES/COLUMNS semua proses di PTY itu, & kirim SIGWINCH.
  // Jalur ini PER-PTY — aman untuk banyak instance pixelterm & tidak bergantung
  // pada forwarding IPC RESIZE ke child (biar atto selalu dapat ukuran benar).
  let warnedTtyPerm = false; // log sekali saja kalau /dev/pts/N ditolak (mis. non-root)
  async function applyTtySize(rows: number, cols: number) {
    try {
      const ptyFd = await fs.open(`/dev/pts/${ptyId}`, "w+");
      if (ptyFd >= 0) {
        await fs.ioctl(ptyFd, 3, { lines: rows, columns: cols }); // TIOCSWINSZ
        await fs.close(ptyFd);
      }
    } catch (e) {
      // Jangan gagal diam-diam: kalau open /dev/pts/N ditolak, TIOCSWINSZ tidak jalan
      // → getScreenInfo() app (mis. atto) stale & tanpa SIGWINCH (hanya IPC fallback).
      if (!warnedTtyPerm) {
        warnedTtyPerm = true;
        try {
          await std.log(
            `[pixelterm] WARN: cannot open /dev/pts/${ptyId} for TIOCSWINSZ — ${(e as any)?.message || e}. ` +
              `Resize falls back to IPC only; getScreenInfo() in apps (e.g. atto) may stay stale.`,
            "pixelterm",
          );
        } catch (_) {}
      }
    }
  }

  // Set default terminal size (akan diupdate pas xterm.js ngirim ukuran asli)
  await shell.setenv("LINES", "24");
  await shell.setenv("COLUMNS", "80");
  await shell.setenv("TERM", "xterm-256color");

  // --- ALLOCATE PTY ON-DEMAND ---
  // Tidak lagi memakai slot TTY konsol (terbatas & pre-alokasi). Setiap instance
  // pixelterm membuat PTY dinamis — hemat RAM & tanpa tabrakan antar instance.
  const pty = await lib.pty.alloc(24, 80);
  const ptyId = pty.id;
  await std.log(
    `[pixelterm] Allocated PTY${ptyId} (pts/${ptyId})`,
    "pixelterm",
  );

  // Tunggu resize dari xterm.js di browser (ukuran real dari container).
  // 400ms: beri waktu cukup buat xterm mengirim term_resize AWAL (sekarang
  // dome-client-term.js selalu kirim setelah konstruksi), biar env LINES/COLUMNS
  // benar sebelum shell & atto dijalankan.
  const initResize = await new Promise<any>((resolve) => {
    const timer = setTimeout(() => resolve(null), 400);
    const check = (msg: any) => {
      const ev = msg?.data || msg;
      if (
        ev?.type === "GUI_EVENT" &&
        ev?.targetId === termId &&
        ev?.eventType === "term_resize"
      ) {
        clearTimeout(timer);
        resolve(JSON.parse(ev.value || "{}"));
      }
    };
    lib.onEvent("ipc_message", check);
  });

  if (initResize && initResize.cols && initResize.rows) {
    await shell.setenv("LINES", String(initResize.rows));
    await shell.setenv("COLUMNS", String(initResize.cols));
    await applyTtySize(initResize.rows, initResize.cols);
  }

  // Apply initial xterm theme
  await applyTermTheme();

  // Spawn tsh.ts on PTY slave — no pipe I/O, uses PTY buffer directly
  const shResult = await shell.exec(
    "/bin/tsh.ts",
    [],
    undefined,
    undefined,
    undefined,
    ptyId,
  );
  if (!shResult) {
    await termWrite("Failed to spawn shell\r\n");
    await app.loopUntilClose();
    return;
  }
  await std.log(
    `[pixelterm] Shell spawned (PID ${shResult.pid}) on PTY${ptyId}`,
    "pixelterm",
  );

  // Fokuskan terminal — user langsung bisa mengetik tanpa klik area terminal.
  // Delay kecil biar xterm sudah dirender & window sudah aktif.
  setTimeout(() => {
    termFocus().catch(() => {});
  }, 250);

  // Jika ada argumen command, kirim ke shell setelah terminal siap
  if (cmdArg) {
    setTimeout(async () => {
      try {
        await new Promise((r) => setTimeout(r, 400));
        await shell.write(shResult.pid, cmdArg + "\n");
        const base = appTitle;
        const cmd = cmdArg.match(/[^\/\s]+\.js/)?.[0];
        const newTitle = cmd ? `${base} [${cmd}]` : base;
        await setWinTitle(newTitle);
        await std.log("[pixelterm] Command sent: " + cmdArg, "pixelterm");
      } catch (e) {
        /* ignore */
      }
    }, 300);
  }

  // Read shell output continuously from isolated TTY → xterm
  (async () => {
    while (app.running) {
      try {
        const chunk = await shell.read(shResult.pid);
        if (chunk && chunk !== "FD NOT FOUND" && chunk !== "") {
          await termWrite(String(chunk));
        }
        await new Promise((r) => setTimeout(r, 5));
      } catch (e) {
        break;
      }
    }
  })();

  // Watch for shell exit → close pixelterm
  (async () => {
    if (shResult?.pid) {
      await shell.waitpid(shResult.pid);
      await termWrite("\r\n[Shell exited]\r\n");
      await new Promise((r) => setTimeout(r, 300));
      try {
        await lib.pty.free(ptyId);
      } catch (_) {}
      await app.close();
    }
  })();

  // xterm events → shell (via TTY injection instead of pipe)
  lib.onEvent("ipc_message", async (msg: any) => {
    const ev = msg?.data || msg;

    // Handle system-wide events
    if (ev?.type === "THEME_CHANGED") {
      // Reload theme dulu sebelum apply (biar gak race condition dengan theme.watch())
      await theme.load(ev.theme, ev.dir || "/opt/asteracea");
      await applyTermTheme();
      return;
    }

    if (ev?.type !== "GUI_EVENT" || ev?.targetId !== termId) return;

    if (ev?.eventType === "term_input") {
      const data = String(ev.value || "");

      // Command detection: track input buat update title bar
      if (data === "\r" || data === "\n") {
        const base = appTitle;
        const cmd = currentCmd;
        const newTitle = cmd ? `${base} [${cmd}]` : base;
        await setWinTitle(newTitle);
        currentCmd = "";
      } else if (data === "\x7f" || data === "\b") {
        if (currentCmd.length > 0) currentCmd = currentCmd.slice(0, -1);
      } else if (data.length === 1) {
        const cc = data.charCodeAt(0);
        if (cc >= 32 && cc <= 126) {
          currentCmd += data;
        }
      } else if (data === "\x03") {
        currentCmd = "";
        await setWinTitle(appTitle);
      }

      // Ctrl+C: inject \x03 ke TTY shell via shell.write (biar TTY interrupt handler yang urus SIGINT, bukan manual kill)
      // Ini mencegah duplikasi sinyal karena TTY juga punya onInterrupt callback di kernel.
      // CATATAN: JANGAN tulis "^C" di sini — app-lah yang mencetaknya sendiri di handler
      // SIGINT (ping.ts → "\n^C\n", sleep.ts → "\n^C\nInterrupted!", tsh.ts → "^C\n").
      // Kalau pixelterm ikut menulis "^C", hasilnya dobel (lihat bug double-^C di ping).
      // Konsisten dgn console TTY yang tidak pernah echo "\x03".
      if (data === "\x03" || data.includes("\x03")) {
        try {
          await shell.write(shResult.pid, "\x03");
        } catch (e) {}
      } else {
        // Inject input ke TTY shell (via TTY buffer, bukan pipe)
        try {
          await shell.write(shResult.pid, data);
        } catch (e) {}
      }
    } else if (ev?.eventType === "term_resize") {
      const size = JSON.parse(ev.value || "{}");
      const cols = size.cols || 80;
      const rows = size.rows || 24;
      await shell.setenv("LINES", String(rows));
      await shell.setenv("COLUMNS", String(cols));
      // Resize device TTY langsung (TIOCSWINSZ) → kernel kirim SIGWINCH ke
      // shell & atto di TTY ini → getScreenInfo() selalu benar per-instance.
      await applyTtySize(rows, cols);

      // Forward resize ke shell & deepest child via IPC (jalur cadangan)
      if (shResult?.pid) {
        await shell.send(shResult.pid, {
          type: "RESIZE",
          lines: rows,
          columns: cols,
        });
        try {
          const ps = await shell.ps();
          const shellPid = shResult.pid;
          let deepestChild: number | null = null;
          const visited = new Set<number>();
          const queue: number[] = [shellPid];
          while (queue.length > 0) {
            const parentPid = queue.shift()!;
            const children = ps.filter(
              (p: any) =>
                p.ppid === parentPid &&
                p.state !== "EXITED" &&
                !visited.has(p.pid),
            );
            for (const child of children) {
              visited.add(child.pid);
              queue.push(child.pid);
              deepestChild = child.pid;
            }
          }
          if (deepestChild) {
            await shell.send(deepestChild, {
              type: "RESIZE",
              lines: rows,
              columns: cols,
            });
          }
        } catch (_) {
          /* ignore */
        }
      }
    }
  });

  await app.loopUntilClose();

  // Cleanup
  if (huponexit) {
    try {
      const ps = await shell.ps();
      const killQueue = [shResult?.pid];
      const visited = new Set<number>();
      if (shResult?.pid) {
        try {
          await shell.kill(shResult.pid, 1);
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 200));
      }
      while (killQueue.length > 0) {
        const pid = killQueue.shift();
        if (!pid || visited.has(pid)) continue;
        visited.add(pid);
        const children = ps.filter(
          (p: any) => p.ppid === pid && p.state !== "EXITED",
        );
        for (const c of children) {
          if (!visited.has(c.pid)) killQueue.push(c.pid);
          try {
            await shell.kill(c.pid, 9);
          } catch (_) {}
        }
      }
      try {
        await shell.kill(shResult.pid, 9);
      } catch (_) {}
    } catch (_) {}
    await std.log(
      "[pixelterm] huponexit=true — child processes terminated",
      "pixelterm",
    );
  } else {
    await std.log(
      "[pixelterm] huponexit=false — keeping child processes alive, reparent to init",
      "pixelterm",
    );
    try {
      const ps = await shell.ps();
      const shellPid = shResult?.pid;
      if (shellPid) {
        const initProc = ps.find((p: any) => p.pid === 1);
        if (initProc) {
          const children = ps.filter(
            (p: any) => p.ppid === shellPid && p.state !== "EXITED",
          );
          for (const child of children) {
            try {
              await shell.reparent(child.pid, 1);
              await std.log(
                `[pixelterm] Reparent PID ${child.pid} → init (PPID 1)`,
                "pixelterm",
              );
            } catch (_) {}
          }
          try {
            await shell.reparent(shellPid, 1);
            await std.log(
              `[pixelterm] Reparent shell PID ${shellPid} → init (PPID 1)`,
              "pixelterm",
            );
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
});
