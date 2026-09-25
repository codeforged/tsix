/**
 *  RetroTerm — Terminal Emulator CRT untuk TSIX
 *  Version 0.3
 *
 *  Saudara dari PixelTerm: fungsinya sama (terminal emulator penuh di atas PTY),
 *  tapi tampilannya dibuat menyerupai monitor CRT jadul:
 *    - scanlines horizontal
 *    - vignette (tabung gelap di tepi)
 *    - tint fosfor (hijau / amber) atau warna asli
 *    - efek cembung (ilusi kaca tabung: inset shadow + kilau)
 *    - flicker sangat halus
 *    - font bitmap era 80-an (opt-in, lihat FONT_FILES)
 *
 *  ── PROFIL WARNA ──
 *    retroterm green     → fosfor hijau P1 (default)
 *    retroterm amber     → fosfor amber P3 (monitor monokrom tahun 80-an)
 *    retroterm color     → CRT berwarna (palet ANSI normal, tanpa tint fosfor)
 *
 *  Nama profil boleh ditulis sebagai argumen biasa (posisi bebas), atau
 *  eksplisit: `--profile amber` / `--theme amber` / `-p amber`.
 *  Profil TIDAK ikut tema sistem — supaya nuansa tabung tetap konsisten.
 *
 *  Console mengisi SELURUH form (tanpa frame gambar) — resize window langsung
 *  mengubah COLUMNS/LINES, sama seperti PixelTerm.
 *
 *  Efek visual dikerjakan di sisi browser oleh dome-client-term.js
 *  (`applyCrtFx`) — opt-in lewat prop `crtTheme` pada node xterm. App ini hanya
 *  mengirim deskripsi efeknya, jadi tidak ada biaya render di worker.
 */

import { Program, std, fs, shell } from "@tsix/Application";
import { Screen, div } from "@tsix/emerald";
import { theme } from "@tsix/theme";
import { ASTERACEA_THEME_DIR } from "@common/AsteraceaPaths";

export const appMode = "gui";

/** Ukuran window awal. Console mengisi penuh, jadi ini hanya ukuran default. */
const WIN_W = 720;
const WIN_H = 560;

/**
 * FONT BITMAP (opsional).
 *
 * Font diletakkan di `/opt/retroterm/fonts/`. Daftar ini di-probe satu per satu
 * dan yang PERTAMA ketemu dipakai — jadi cukup taruh satu file, tidak perlu
 * ubah kode. Nama diambil dari rilis font bitmap DOS/Web437, mis.
 * `Web437_Tandy1K-II_225L.woff2` (Tandy 1000 / IBM PCjr, 225 lines).
 *
 * Format didukung: .woff2 / .woff / .ttf / .otf
 * Jika tidak ada yang ketemu, app jalan dengan font monospace sistem.
 */
const FONT_FILES = [
    "Web437_Tandy1K-II_225L.woff2",
    "Web437_Tandy1K-II_225L.woff",
    "Web437_Tandy1K-II_225L.ttf",
    "Web437_Tandy1K-II_225L.otf",
    "Web437_Tandy1K-II_225L-2y.woff2",
    "Web437_Tandy1K-II_225L-2y.woff",
    "Web437_Tandy1K-II_225L-2y.ttf",
    "Web437_Tandy1K-II_225L-2y.otf",
    "Web437Tandy1K-II225L-2y.woff2",
    "Web437Tandy1K-II225L-2y.woff",
    "Web437Tandy1K-II225L-2y.ttf",
    "tandy.woff2",
    "tandy.ttf",
];

/** Nama family CSS yang dipakai; bebas, karena di-inject via @font-face. */
const FONT_FAMILY = "TSIXRetroMono";

/** Ukuran font konsol (px). Bitmap Tandy ~8x16, jadi 16px = kelipatan pas. */
const FONT_SIZE = 16;

/**
 * PROFIL WARNA TABUNG.
 *
 * Tiga nuansa CRT yang bisa dipilih dari argumen (lihat resolveProfileArg):
 *   green → fosfor hijau P1 (default, perilaku lama)
 *   amber → fosfor amber P3 (monitor monokrom amber era 80-an)
 *   color → CRT berwarna (palet ANSI normal, tint fosfor dimatikan)
 *
 * Nama properti di `term` sengaja SAMA dengan opsi xterm, jadi getTermTheme()
 * cukup menyalinnya tanpa pemetaan.
 */
type ProfileName = "green" | "amber" | "color";

interface CrtProfile {
    /** Latar tabung — dipakai juga sebagai `cursorAccent` xterm. */
    screenBg: string;
    /** Tint fosfor tipis di overlay CRT ("" = tanpa tint → warna asli). */
    tint: string;
    /** Warna highlight seleksi teks. */
    selection: string;
    /**
     * Warna kilau kaca cembung: "r,g,b" untuk layer kiri-atas & kanan-bawah.
     * Dibaca applyCrtFx() di dome-client-term.js (default hijau bila kosong).
     */
    specular: { top: string; bottom: string };
    /** Palet xterm (nama properti = nama opsi xterm). */
    term: {
        foreground: string;
        cursor: string;
        white: string;
        brightWhite: string;
        black: string;
        brightBlack: string;
        red: string;
        brightRed: string;
        green: string;
        brightGreen: string;
        yellow: string;
        brightYellow: string;
        blue: string;
        brightBlue: string;
        magenta: string;
        brightMagenta: string;
        cyan: string;
        brightCyan: string;
    };
}

const PROFILES: Record<ProfileName, CrtProfile> = {
    // ── Fosfor hijau P1 (default) ── perilaku lama, nilainya jangan diubah ──
    green: {
        screenBg: "#03130a",
        tint: "rgba(0,255,120,0.045)",
        selection: "rgba(51,255,102,0.28)",
        specular: { top: "190,255,210", bottom: "120,255,170" },
        term: {
            foreground: "#33ff66",
            cursor: "#ccffdd",
            white: "#33ff66",
            brightWhite: "#ccffdd",
            black: "#0a2a15",
            brightBlack: "#1f6b3a",
            red: "#4dff88",
            brightRed: "#7dffb0",
            green: "#33ff66",
            brightGreen: "#ccffdd",
            yellow: "#8fff9f",
            brightYellow: "#c8ffd4",
            blue: "#2fd97a",
            brightBlue: "#5cf0a0",
            magenta: "#43e58a",
            brightMagenta: "#77f5ae",
            cyan: "#39f090",
            brightCyan: "#6dffb8",
        },
    },

    // ── Fosfor amber P3 ── monokrom hangat, kontras tinggi di tabung gelap ──
    amber: {
        screenBg: "#170d02",
        tint: "rgba(255,170,0,0.05)",
        selection: "rgba(255,176,0,0.30)",
        specular: { top: "255,224,168", bottom: "255,178,88" },
        term: {
            foreground: "#ffb000",
            cursor: "#ffe0a0",
            white: "#ffb000",
            brightWhite: "#ffe8b8",
            black: "#2a1a05",
            brightBlack: "#6b4a12",
            red: "#d98f00",
            brightRed: "#f5ae3d",
            green: "#ffb000",
            brightGreen: "#ffd98a",
            yellow: "#ffc233",
            brightYellow: "#ffe6b3",
            blue: "#c48000",
            brightBlue: "#e8a53d",
            magenta: "#b8760a",
            brightMagenta: "#dd9a2e",
            cyan: "#e0a01a",
            brightCyan: "#ffcf70",
        },
    },

    // ── CRT berwarna ── palet ANSI normal; tint dimatikan agar warna asli ──
    color: {
        screenBg: "#04070c",
        tint: "",
        selection: "rgba(255,255,255,0.25)",
        specular: { top: "255,255,255", bottom: "190,215,255" },
        term: {
            foreground: "#cccccc",
            cursor: "#ffffff",
            white: "#cccccc",
            brightWhite: "#f2f2f2",
            black: "#0c0c0c",
            brightBlack: "#767676",
            red: "#c50f1f",
            brightRed: "#e74856",
            green: "#13a10e",
            brightGreen: "#16c60c",
            yellow: "#c19c00",
            brightYellow: "#f9f1a5",
            blue: "#0037da",
            brightBlue: "#3b78ff",
            magenta: "#881798",
            brightMagenta: "#b4009e",
            cyan: "#3a96dd",
            brightCyan: "#61d6d6",
        },
    },
};

/** Profil default = perilaku lama (fosfor hijau). */
const DEFAULT_PROFILE: ProfileName = "green";

/** Validasi nama profil (dipakai parser argumen). */
function isProfileName(v: string): v is ProfileName {
    return Object.prototype.hasOwnProperty.call(PROFILES, v);
}

/**
 * Tentukan profil dari argumen:
 *   1. eksplisit — `--profile amber`, `--theme amber`, `-p amber` (juga `=amber`)
 *   2. bare argumen — `retroterm amber` (posisi bebas)
 *   3. fallback — DEFAULT_PROFILE
 * `invalid` diisi bila user menulis `--profile X` dengan X tidak dikenal, supaya
 * pemanggil bisa memberi peringatan (bukan diam-diam mengabaikan).
 */
function resolveProfileArg(args: string[]): {
    name: ProfileName;
    explicit: boolean;
    invalid?: string;
} {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];

        const eq = /^--(?:profile|theme)=(.+)$/.exec(a);
        if (eq) {
            const v = eq[1].trim().toLowerCase();
            if (isProfileName(v)) return { name: v, explicit: true };
            return { name: DEFAULT_PROFILE, explicit: false, invalid: v };
        }

        if (a === "--profile" || a === "--theme" || a === "-p") {
            const v = (args[i + 1] || "").trim().toLowerCase();
            if (isProfileName(v)) return { name: v, explicit: true };
            return { name: DEFAULT_PROFILE, explicit: false, invalid: v };
        }
    }

    for (const a of args) {
        const v = a.trim().toLowerCase();
        if (!v.startsWith("-") && isProfileName(v)) {
            return { name: v, explicit: true };
        }
    }

    return { name: DEFAULT_PROFILE, explicit: false };
}

const HELP = `RetroTerm — terminal emulator CRT untuk TSIX

Usage: retroterm [profil] [opsi] [command]

Profil warna (default: green):
  green     fosfor hijau P1 (default)
  amber     fosfor amber P3 (monitor monokrom 80-an)
  color     CRT berwarna — palet ANSI normal, tanpa tint fosfor

Profil boleh ditulis langsung sebagai argumen, atau eksplisit:
  --profile NAMA | --theme NAMA | -p NAMA

Opsi:
  -h, --help         tampilkan bantuan ini
  -hue, --huponexit  kirim SIGHUP + bunuh anak proses saat window ditutup
                     (tanpa ini, anak proses di-reparent ke init)

Command (opsional) langsung diketik ke shell setelah terminal siap.

Contoh:
  retroterm                       hijau, shell interaktif
  retroterm amber                 fosfor amber
  retroterm color -hue            berwarna, bunuh anak saat window ditutup
  retroterm --theme amber /opt/test/table-demo.js`;

export const main = Program(async (args: string[]) => {
    await std.log("=== RetroTerm ===");

    // ── Bantuan ─────────────────────────────────────────────────────────────
    if (args.includes("--help") || args.includes("-h")) {
        await std.println(HELP);
        return;
    }

    // ── Profil warna (green | amber | color) ────────────────────────────────
    // Diparse SEBELUM apa pun karena menentukan judul window & seluruh palet.
    const { name: profileName, explicit: profileExplicit, invalid: profileInvalid } = resolveProfileArg(args);
    const profile = PROFILES[profileName];
    if (profileInvalid !== undefined) {
        const shown = profileInvalid === "" ? "(kosong)" : `'${profileInvalid}'`;
        await std.println(
            `[retroterm] Profil ${shown} tidak dikenal — memakai '${profileName}'. ` +
                `Pilihan: ${Object.keys(PROFILES).join(", ")} (lihat --help).`,
        );
    }

    // Judul menampilkan nama profil HANYA bila diminta eksplisit, supaya window
    // default tetap "RetroTerm" (judul ini juga dipakai deteksi command di title bar).
    const appTitle = profileExplicit ? `RetroTerm [${profileName}]` : "RetroTerm";
    await std.log(`[retroterm] Profil warna: ${profileName}${profileExplicit ? "" : " (default)"}`, "retroterm");

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

    // Ambil command dari argumen pertama yang bukan flag & BUKAN nama profil
    // (kalau tidak, `retroterm amber` akan mengirim "amber" ke shell).
    const cmdArg = args.find((a: string) => !a.startsWith("-") && !isProfileName(a.trim().toLowerCase())) || "";

    const lib = (global as any)._tsixLib;

    // ==========================================================================
    // TAMPILAN: console mengisi SELURUH form (tanpa frame gambar monitor), jadi
    // resize window langsung mengubah COLUMNS/LINES — sama seperti PixelTerm.
    // Yang membedakan hanya EFEK CRT (scanline, vignette, tint fosfor, flicker)
    // yang di-render browser lewat applyCrtFx().
    // ==========================================================================

    // ==========================================================================
    // TEMA TERMINAL: mengikuti PROFIL warna yang dipilih (green/amber/color),
    // TIDAK ikut tema sistem. Tujuannya supaya nuansa CRT tetap konsisten walau
    // user mengganti theme di Asteracea. Untuk profil monokrom (green/amber),
    // nilai ANSI di-map ke gradasi fosfor agar `ls` berwarna tetap terbaca tanpa
    // keluar dari nuansa tabung.
    // ==========================================================================
    function getTermTheme() {
        return {
            ...profile.term,
            background: "rgba(0,0,0,0)", // transparan — warna tabung dari layer CRT
            cursorAccent: profile.screenBg,
            selection: profile.selection,
        };
    }

    const termTheme = getTermTheme();

    // ==========================================================================
    // FONT BITMAP: probe daftar FONT_FILES, pakai yang pertama ketemu.
    // Dibaca sebagai latin1 lalu di-encode base64 → data URI. WAJIB latin1:
    // font itu BINER, sedangkan fs.readFile mengembalikan string per-karakter —
    // konversi utf8 akan merusak byte (lihat pola sama di resbank.ts).
    // Kalau tidak ada, browser pakai font monospace sistem (fallback aman).
    // ==========================================================================
    let fontFaceCss = "";
    for (const fname of FONT_FILES) {
        try {
            const raw = await fs.readFile(`/opt/retroterm/fonts/${fname}`);
            if (!raw) continue;
            const ext = fname.split(".").pop()!.toLowerCase();
            const mime =
                ext === "woff2" ? "font/woff2" : ext === "woff" ? "font/woff" : ext === "otf" ? "font/otf" : "font/ttf";
            const b64 = Buffer.from(raw, "latin1").toString("base64");
            fontFaceCss =
                `@font-face{font-family:'${FONT_FAMILY}';` +
                `src:url(data:${mime};base64,${b64}) format('${ext}');` +
                `font-display:block;}`;
            await std.log(
                `[retroterm] Font dimuat: ${fname} (${raw.length} byte) → family '${FONT_FAMILY}'`,
                "retroterm",
            );
            break;
        } catch (_) {
            /* file tidak ada — coba kandidat berikutnya */
        }
    }
    if (!fontFaceCss) {
        await std.log(
            `[retroterm] Font bitmap tidak ditemukan di /opt/retroterm/fonts/ — ` +
                `memakai font monospace sistem. Taruh mis. ${FONT_FILES[0]} di sana.`,
            "retroterm",
        );
    }

    // Deskripsi efek CRT — dikirim ke browser, dijalankan oleh applyCrtFx().
    // Console mengisi seluruh window; tidak ada frame gambar monitor.
    const crtTheme = {
        enabled: true,
        screenBg: profile.screenBg,
        tint: profile.tint, // tint fosfor tipis ("" pada profil color = warna asli)
        // Warna kilau kaca cembung — dibaca applyCrtFx() di dome-client-term.js.
        // Tanpa ini, kilau tetap hijau walau profilnya amber/berwarna.
        specular: profile.specular,
        vignette: 0.5,
        flicker: true,
        scanline: { period: 3, alpha: 0.3 },
        // Font bitmap (kalau ada). Browser menyuntik @font-face ini lalu memakai
        // family-nya di xterm. Kosong = pakai font monospace sistem.
        fontFaceCss: fontFaceCss,
        fontFamily: fontFaceCss ? `'${FONT_FAMILY}', monospace` : undefined,
        fontSize: FONT_SIZE,
        // Efek cembung khas tabung CRT (ilusi cahaya+bayangan, bukan distorsi
        // geometris). `edge` = kedalaman gelap di tepi, `highlight` = kekuatan
        // kilau kaca di kiri-atas, `radius` = sudut melengkung tabung.
        convex: { radius: 18, edge: 0.75, highlight: 0.075 },
    };

    await app.mount(
        div(
            {
                id: "crt-container",
                style: {
                    // padding 0 + height 100% seperti PixelTerm — console mengisi
                    // penuh form supaya resize mengubah COLUMNS/LINES.
                    padding: "0",
                    height: "100%",
                    background: profile.screenBg,
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
        if (domePid) await shell.send(domePid, { type: "WINDOW_TITLE", wid: app.wid, title });
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
                .catch(() => {});
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
                } catch (_) {}
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
            if (ev?.type === "GUI_EVENT" && ev?.targetId === termId && ev?.eventType === "term_resize") {
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
    const shResult = await shell.exec("/bin/tsh.js", [], undefined, undefined, undefined, ptyId);
    if (!shResult) {
        await termWrite("Failed to spawn shell\r\n");
        await app.loopUntilClose();
        await freePty();
        return;
    }
    await std.log(`[retroterm] Shell spawned (PID ${shResult.pid}) on PTY${ptyId}`, "retroterm");

    // Fokuskan terminal — user langsung bisa mengetik tanpa klik area terminal.
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
            await theme.load(ev.theme, ev.dir || ASTERACEA_THEME_DIR);
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
                } catch (e) {}
            } else {
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
                            (p: any) => p.ppid === parentPid && p.state !== "EXITED" && !visited.has(p.pid),
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
                } catch (_) {}
                await new Promise((r) => setTimeout(r, 200));
            }
            while (killQueue.length > 0) {
                const pid = killQueue.shift();
                if (!pid || visited.has(pid)) continue;
                visited.add(pid);
                const children = ps3.filter((p: any) => p.ppid === pid && p.state !== "EXITED");
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
        await std.log("[retroterm] huponexit=true — child processes terminated", "retroterm");
    } else {
        await std.log("[retroterm] huponexit=false — keeping child processes alive, reparent to init", "retroterm");
        try {
            const ps4 = await shell.ps();
            const shellPid = shResult?.pid;
            if (shellPid) {
                const initProc = ps4.find((p: any) => p.pid === 1);
                if (initProc) {
                    const children = ps4.filter((p: any) => p.ppid === shellPid && p.state !== "EXITED");
                    for (const child of children) {
                        try {
                            await shell.reparent(child.pid, 1);
                            await std.log(`[retroterm] Reparent PID ${child.pid} → init (PPID 1)`, "retroterm");
                        } catch (_) {}
                    }
                    try {
                        await shell.reparent(shellPid, 1);
                        await std.log(`[retroterm] Reparent shell PID ${shellPid} → init (PPID 1)`, "retroterm");
                    } catch (_) {}
                }
            }
        } catch (_) {}
    }
});
