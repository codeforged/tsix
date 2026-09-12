/**
 *  RetroTerm — Terminal Emulator CRT / Fosfor Hijau untuk TSIX
 *  Version 0.1
 *
 *  Saudara dari PixelTerm: fungsinya sama (terminal emulator penuh di atas PTY),
 *  tapi tampilannya dibuat menyerupai monitor CRT jadul:
 *    - bezel/frame dari /opt/retroterm/retro-crt.jpg
 *    - scanlines horizontal
 *    - vignette (tabung gelap di tepi)
 *    - tint hijau fosfor
 *    - flicker sangat halus
 *
 *  Efek visual dikerjakan di sisi browser oleh dome-client-term.js
 *  (`applyCrtFx`) — opt-in lewat prop `crtTheme` pada node xterm. App ini hanya
 *  mengirim deskripsi efeknya, jadi tidak ada biaya render di worker.
 */

import { Program, std, fs, shell } from "@tsix/Application";
import { Screen, div } from "@tsix/emerald";
import { theme } from "@tsix/theme";

export const appMode = "gui";

/**
 * Bezel/jendela sengaja TIDAK memakai ukuran 4:3 TV jadul penuh, supaya
 * proporsi gambar 655x576 tidak terlalu melar saat stretch ke ukuran window.
 * 720x560 ≈ 1.29 — mendekati aspek frame, dan muat di layar desktop.
 */
const WIN_W = 720;
const WIN_H = 560;

/** Palet fosfor hijau (monokrom amber-ke-hijau ala P1 phosphor). */
const PHOSPHOR = {
    // Latar tabung: hitam kehijauan sangat gelap, bukan hitam murni.
    screenBg: "#03130a",
    // Warna utama teks fosfor.
    fg: "#33ff66",
    // Glow: warna lebih terang untuk highlight/cursor.
    glow: "#ccffdd",
};

export const main = Program(async (args: string[]) => {
    await std.log("=== RetroTerm ===");
    const appTitle = "RetroTerm";
    await theme.loadCurrent();
    theme.watch();

    const app = new Screen({
        title: appTitle,
        icon: "📺",
        width: WIN_W,
        height: WIN_H,
        resizable: true,
        maximizable: true,
    });

    let currentCmd = ""; // untuk deteksi command di title bar
    const termId = "xterm-retro";
    const huponexit = args.includes("--huponexit") || args.includes("-hue");
    await std.log(`[retroterm] huponexit=${huponexit}`, "retroterm");

    // Ambil command dari argumen pertama yang bukan flag
    const cmdArg = args.find((a: string) => !a.startsWith("-")) || "";

    const lib = (global as any)._tsixLib;

    // ==========================================================================
    // BEZEL: gambar CRT dibaca dari VFS → base64 → data URI untuk browser.
    // Dibaca sebagai latin1 (1 byte = 1 char) lalu di-encode base64 — pola yang
    // sama dipakai ResourceBank & TImage, karena fs.readFile mengembalikan string.
    // ==========================================================================
    const BEZEL_PATH = "/opt/retroterm/retro-crt.jpg";
    let bezelUrl = "";
    // Dimensi gambar dipakai browser untuk menjaga ASPEK bezel saat resize.
    // Dibaca dari header JPEG (SOF marker) supaya tetap benar walau file gambar
    // diganti — tidak di-hardcode.
    let imgW = 0;
    let imgH = 0;

    /**
     * Baca lebar/tinggi dari buffer JPEG dengan memindai marker SOF
     * (SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15). Segment SOF berisi
     * 2 byte tinggi lalu 2 byte lebar. Mengembalikan null bila tidak ketemu.
     */
    function readJpegSize(buf: Buffer): { w: number; h: number } | null {
        if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
        let i = 2;
        while (i + 9 < buf.length) {
            if (buf[i] !== 0xff) {
                i++;
                continue;
            }
            const marker = buf[i + 1];
            // SOF markers (mengecualikan DHT=0xC4, JPG=0xC8, DAC=0xCC)
            const isSOF =
                marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            const segLen = buf.readUInt16BE(i + 2);
            if (isSOF) {
                return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
            }
            // Marker tanpa payload
            if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
                i += 2;
            } else {
                i += 2 + segLen;
            }
        }
        return null;
    }

    try {
        const raw = await fs.readFile(BEZEL_PATH);
        if (raw) {
            const buf = Buffer.from(raw, "latin1");
            bezelUrl = "data:image/jpeg;base64," + buf.toString("base64");
            const sz = readJpegSize(buf);
            if (sz) {
                imgW = sz.w;
                imgH = sz.h;
            }
            await std.log(
                `[retroterm] Bezel dimuat dari ${BEZEL_PATH} (${raw.length} byte, ${imgW || "?"}x${imgH || "?"})`,
                "retroterm",
            );
        } else {
            await std.log(
                `[retroterm] WARN: ${BEZEL_PATH} kosong — jalan tanpa bezel.`,
                "retroterm",
            );
        }
    } catch (e: any) {
        // Non-fatal: terminal tetap jalan, hanya kehilangan frame gambar.
        await std.log(
            `[retroterm] WARN: gagal baca ${BEZEL_PATH}: ${e?.message || e}`,
            "retroterm",
        );
    }

    // ==========================================================================
    // TEMA TERMINAL: dipaksa fosfor hijau, TIDAK ikut tema sistem. Tujuannya
    // supaya nuansa CRT tetap konsisten walau user mengganti theme di Asteracea.
    // Nilai ANSI di-map ke gradasi hijau agar `ls` berwarna tetap terbaca tapi
    // tidak keluar dari nuansa monokrom-hijau.
    // ==========================================================================
    function getTermTheme() {
        return {
            background: "rgba(0,0,0,0)", // transparan — warna tabung dari layer CRT
            foreground: PHOSPHOR.fg,
            cursor: PHOSPHOR.glow,
            cursorAccent: "#03130a",
            selection: "rgba(51,255,102,0.28)",
            brightWhite: PHOSPHOR.glow,
            white: PHOSPHOR.fg,
            brightBlack: "#1f6b3a",
            black: "#0a2a15",
            red: "#4dff88",
            brightRed: "#7dffb0",
            green: PHOSPHOR.fg,
            brightGreen: PHOSPHOR.glow,
            yellow: "#8fff9f",
            brightYellow: "#c8ffd4",
            blue: "#2fd97a",
            brightBlue: "#5cf0a0",
            magenta: "#43e58a",
            brightMagenta: "#77f5ae",
            cyan: "#39f090",
            brightCyan: "#6dffb8",
        };
    }

    const termTheme = getTermTheme();

    // Deskripsi efek CRT — dikirim ke browser, dijalankan oleh applyCrtFx().
    //
    // GEOMETRI: `hole` = posisi area layar DI DALAM GAMBAR (fraksi 0..1), DIUKUR
    // dari retro-crt.jpg (scanline kecerahan, cari area gelap = tabung):
    //   kiri 13%  kanan 88%  atas 12%  bawah 78%
    // Browser memakai ini untuk menghitung posisi layar secara PROPORSIONAL
    // terhadap bezel, sehingga tetap presisi & center di ukuran window apa pun.
    const crtTheme = {
        enabled: true,
        screenBg: PHOSPHOR.screenBg,
        tint: "rgba(0,255,120,0.045)", // tint fosfor tipis
        vignette: 0.5,
        flicker: true,
        scanline: { period: 3, alpha: 0.3 },
        bezel: {
            imageUrl: bezelUrl,
            // Dimensi asli gambar → browser menjaga aspek bezel saat resize
            // (tanpa ini, bezel gepeng dan lubang layar tidak lagi sejajar).
            imgW: imgW || 655,
            imgH: imgH || 576,
            // Area layar di dalam gambar (fraksi 0..1) — hasil pengukuran.
            hole: { left: 0.13, right: 0.88, top: 0.12, bottom: 0.78 },
            screenRadius: "14px",
        },
    };

    await app.mount(
        div(
            {
                id: "crt-container",
                style: {
                    padding: "0",
                    height: "100%",
                    background: bezelUrl ? "#000" : PHOSPHOR.screenBg,
                },
            },
            {
                id: termId,
                tag: "xterm" as any,
                props: { termTheme, crtTheme },
                children: [],
            },
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
                    crt: crtTheme,
                })
                .catch(() => { });
        }
    }

    // Terapkan ukuran ke slave PTY via TIOCSWINSZ (ioctl 3). Kernel yang resize,
    // update env LINES/COLUMNS semua proses di PTY itu, & kirim SIGWINCH.
    let warnedTtyPerm = false;
    async function applyTtySize(rows: number, cols: number) {
        try {
            const ptyFd = await fs.open(`/dev/pts/${ptyId}`, "w+");
            if (ptyFd >= 0) {
                await fs.ioctl(ptyFd, 3, { lines: rows, columns: cols }); // TIOCSWINSZ
                await fs.close(ptyFd);
            }
        } catch (e) {
            if (!warnedTtyPerm) {
                warnedTtyPerm = true;
                try {
                    await std.log(
                        `[retroterm] WARN: cannot open /dev/pts/${ptyId} for TIOCSWINSZ — ${(e as any)?.message || e}. ` +
                        `Resize falls back to IPC only.`,
                        "retroterm",
                    );
                } catch (_) { }
            }
        }
    }

    // Set default terminal size (akan diupdate pas xterm.js ngirim ukuran asli)
    await shell.setenv("LINES", "24");
    await shell.setenv("COLUMNS", "80");
    await shell.setenv("TERM", "xterm-256color");

    // --- ALLOCATE PTY ON-DEMAND ---
    // Sama seperti pixelterm: tidak memakai slot TTY konsol (terbatas), tapi PTY
    // dinamis per instance — hemat RAM & tanpa tabrakan antar window.
    const pty = await lib.pty.alloc(24, 80);
    const ptyId = pty.id;
    await std.log(`[retroterm] Allocated PTY${ptyId} (pts/${ptyId})`, "retroterm");

    // Bebaskan PTY — WAJIB di SEMUA jalur tutup (exit command ATAU klik X).
    // Guard idempotent supaya tidak double-free.
    let ptyFreed = false;
    async function freePty() {
        if (ptyFreed) return;
        ptyFreed = true;
        try {
            await lib.pty.free(ptyId);
            await std.log(`[retroterm] PTY${ptyId} freed`, "retroterm");
        } catch (_) {
            /* ignore — PTY mungkin sudah dibebaskan kernel */
        }
    }

    // Tunggu resize dari xterm.js di browser (ukuran real dari container).
    // Area layar RetroTerm lebih kecil dari window (ada bezel), jadi ukuran ini
    // penting supaya shell mendapat COLUMNS/LINES yang benar sejak awal.
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

    // Apply initial xterm theme (termasuk deskripsi efek CRT)
    await applyTermTheme();

    // Spawn shell di PTY slave — sidecar .js (bukan .ts) agar worker tidak
    // memakai preload transpiler (+14.4 MB RSS/worker).
    const shResult = await shell.exec(
        "/bin/tsh.js",
        [],
        undefined,
        undefined,
        undefined,
        ptyId,
    );
    if (!shResult) {
        await termWrite("Failed to spawn shell\r\n");
        await app.loopUntilClose();
        await freePty();
        return;
    }
    await std.log(
        `[retroterm] Shell spawned (PID ${shResult.pid}) on PTY${ptyId}`,
        "retroterm",
    );

    // Fokuskan terminal — user langsung bisa mengetik tanpa klik area terminal.
    setTimeout(() => {
        termFocus().catch(() => { });
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
                await std.log("[retroterm] Command sent: " + cmdArg, "retroterm");
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
                await new Promise((r) => setTimeout(r, 50));
            } catch (e) {
                break;
            }
        }
    })();

    // Watch for shell exit → close retroterm
    (async () => {
        if (shResult?.pid) {
            await shell.waitpid(shResult.pid);
            await termWrite("\r\n[Shell exited]\r\n");
            await new Promise((r) => setTimeout(r, 300));
            await freePty();
            await app.close();
        }
    })();

    // xterm events → shell (via TTY injection instead of pipe)
    lib.onEvent("ipc_message", async (msg: any) => {
        const ev = msg?.data || msg;

        // Ganti tema sistem → tetap pakai palet fosfor hijau RetroTerm, tapi
        // xterm perlu di-recreate (canvas text). Kirim ulang crtTheme supaya
        // efek CRT tidak hilang.
        if (ev?.type === "THEME_CHANGED") {
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

            // Ctrl+C: inject \x03 ke TTY shell (biar TTY interrupt handler yang
            // mengurus SIGINT). App-lah yang mencetak "^C", jadi jangan tulis di sini
            // — kalau tidak hasilnya dobel.
            if (data === "\x03" || data.includes("\x03")) {
                try {
                    await shell.write(shResult.pid, "\x03");
                } catch (e) { }
            } else {
                try {
                    await shell.write(shResult.pid, data);
                } catch (e) { }
            }
        } else if (ev?.eventType === "term_resize") {
            const size = JSON.parse(ev.value || "{}");
            const cols = size.cols || 80;
            const rows = size.rows || 24;
            await shell.setenv("LINES", String(rows));
            await shell.setenv("COLUMNS", String(cols));
            await applyTtySize(rows, cols);

            // Forward resize ke shell & deepest child via IPC (jalur cadangan)
            if (shResult?.pid) {
                await shell.send(shResult.pid, {
                    type: "RESIZE",
                    lines: rows,
                    columns: cols,
                });
                try {
                    const ps2 = await shell.ps();
                    const shellPid = shResult.pid;
                    let deepestChild: number | null = null;
                    const visited = new Set<number>();
                    const queue: number[] = [shellPid];
                    while (queue.length > 0) {
                        const parentPid = queue.shift()!;
                        const children = ps2.filter(
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

    // Window ditutup lewat klik X (title bar) — TANPA shell exit.
    // Jalur tutup ini TIDAK lewat watcher waitpid, jadi PTY harus dibebaskan di
    // sini (sama seperti fix di pixelterm: X → /dev/pts/N menggantung).
    await freePty();

    // Cleanup
    if (huponexit) {
        try {
            const ps3 = await shell.ps();
            const killQueue = [shResult?.pid];
            const visited = new Set<number>();
            if (shResult?.pid) {
                try {
                    await shell.kill(shResult.pid, 1);
                } catch (_) { }
                await new Promise((r) => setTimeout(r, 200));
            }
            while (killQueue.length > 0) {
                const pid = killQueue.shift();
                if (!pid || visited.has(pid)) continue;
                visited.add(pid);
                const children = ps3.filter(
                    (p: any) => p.ppid === pid && p.state !== "EXITED",
                );
                for (const c of children) {
                    if (!visited.has(c.pid)) killQueue.push(c.pid);
                    try {
                        await shell.kill(c.pid, 9);
                    } catch (_) { }
                }
            }
            try {
                await shell.kill(shResult.pid, 9);
            } catch (_) { }
        } catch (_) { }
        await std.log(
            "[retroterm] huponexit=true — child processes terminated",
            "retroterm",
        );
    } else {
        await std.log(
            "[retroterm] huponexit=false — keeping child processes alive, reparent to init",
            "retroterm",
        );
        try {
            const ps4 = await shell.ps();
            const shellPid = shResult?.pid;
            if (shellPid) {
                const initProc = ps4.find((p: any) => p.pid === 1);
                if (initProc) {
                    const children = ps4.filter(
                        (p: any) => p.ppid === shellPid && p.state !== "EXITED",
                    );
                    for (const child of children) {
                        try {
                            await shell.reparent(child.pid, 1);
                            await std.log(
                                `[retroterm] Reparent PID ${child.pid} → init (PPID 1)`,
                                "retroterm",
                            );
                        } catch (_) { }
                    }
                    try {
                        await shell.reparent(shellPid, 1);
                        await std.log(
                            `[retroterm] Reparent shell PID ${shellPid} → init (PPID 1)`,
                            "retroterm",
                        );
                    } catch (_) { }
                }
            }
        } catch (_) { }
    }
});
