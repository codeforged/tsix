/**
 * craving-tracker.ts — Craving Tracker 0-3 (TSIX GUI · Cashew Framework)
 *
 * Port dari `docs/stop-smoking.html` (localStorage browser) ke TSIX-GUI:
 * data disimpan sebagai file JSON di VFS, bukan localStorage.
 *
 * Fitur:
 *  - TComboBox skala hasrat 0-3 → TImage menampilkan foto anak sesuai skala
 *    (/opt/craving-tracker/level0.jpg … level3.jpg, atau sidecar .b64)
 *  - TEdit konteks koding / kendala bug
 *  - Submit → append ke /opt/craving-tracker/craving-logs.json
 *  - Panel kanan: Matriks Per-Entri (satu sel per entri, warna = state 0-3:
 *    hijau muda → hijau tua, merah = jebol) + Craving Activity (contribution graph
 *    per hari ala github.com) di bawahnya
 *  - Statistik (jumlah per state + hari tanpa jebol) di baris kaki matriks
 *
 * Jalankan: craving-tracker          (PATH /bin)
 *           /opt/craving-tracker/craving-tracker.js
 * Ketergantungan: DOME running (launcher Asteracea → "Craving Tracker").
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, fs } from "@tsix/Application";
import {
    TForm,
    TPanel,
    TLabel,
    TEdit,
    TButton,
    TComboBox,
    TImage,
    TStatusBar,
    TGroupBox,
    TScrollBox,
    HStack,
} from "@tsix/cashew";
import { IDOMNode } from "@common/GUITypes";
import { isLightColor } from "@tsix/emerald";

export const appMode = "gui";

// ================================================================
// KONFIGURASI
// ================================================================

const APP_DIR = "/opt/craving-tracker";
const DATA_FILE = APP_DIR + "/craving-logs.json";

/** Batas sel matriks yang dirender (jaga payload DOM). */
const CELL_LIMIT = 240;

/** Label skala (sama dengan <option> di stop-smoking.html). */
const STATE_LABELS = [
    "0 - Tidak ada hasrat / Lupa",
    "1 - Ada rasa ingin, langsung hilang",
    "2 - Ingin banget (hampir bakar kalau ada di meja)",
    "3 - Jebol (bela-belain beli lalu dibakar)",
];

/** Judul pendek per state (badge + header foto). */
const STATE_TITLES = ["Tidak ada hasrat / Lupa", "Ada rasa ingin, langsung hilang", "Ingin banget", "Jebol"];

const BADGE_TEXT = ["State 0", "State 1", "State 2", "State 3"];

/**
 * Palet state — hijau muda → hijau sedang → hijau tua, lalu MERAH khusus
 * level 3 (jebol). Makin tua hijaunya = makin kuat keinginan rokok hari itu.
 * Dipakai di matriks per-entri, header, tren, & Craving Activity.
 */
const STATE_HEX = ["#9be9a8", "#56d364", "#1a7f37", "#ff2d2d"];

/** Warna merah khusus untuk pendar level 3. */
const RED_RGB = [255, 45, 45];

/** Background kartu header per state (soft, senada palet di atas). */
const HEAD_BG = ["rgba(155,233,168,0.14)", "rgba(86,211,100,0.16)", "rgba(26,127,55,0.28)", "rgba(255,45,45,0.21)"];

// --- Craving Activity (contribution graph ala github.com) ---
// Sel = SATU HARI (bukan satu entri). Warna sel murni menyatakan KEKUATAN
// hasrat hari itu (state tertinggi): hijau muda → hijau tua, dan merah bila
// hari itu ada jebol. Tidak ada overlay "makin banyak log makin terang" —
// supaya warna tidak bisa disalahartikan sebagai kekuatan hasrat.
// KHUSUS level 3 (jebol): sel memancarkan pendar merah yang makin luas
// (luber ke kotak sekelilingnya) seiring banyaknya jebol hari itu.
const GH_EMPTY = "#15181d";
const CELL_PX = 10;
const GAP_PX = 3;
/** Rentang kalender: 6 bulan terakhir (± 182 hari → 26-27 kolom minggu). */
const WINDOW_DAYS = 182;
/** Label rentang untuk ringkasan di atas grafik. */
const WINDOW_LABEL = "6 bulan terakhir";
const WEEKDAY_SHORT = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

/** rgba() dari triplet [r,g,b]. */
function rgba(rgb: number[], a: number): string {
    return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + a + ")";
}

// ================================================================
// MODEL DATA
// ================================================================

interface LogEntry {
    /** Skala hasrat 0-3 */
    state: number;
    /** Konteks koding / kendala bug */
    context: string;
    /** Waktu tampil (mis. "16 Sep 2026 14:05") */
    time: string;
    /** Epoch ms — dipakai untuk urut & statistik */
    ts: number;
}

// ================================================================
// UTIL WAKTU (manual — hindari ketergantungan ICU/locale di worker)
// ================================================================

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

function pad2(n: number): string {
    return n < 10 ? "0" + n : String(n);
}

function fmtTime(ts: number): string {
    const d = new Date(ts);
    return (
        pad2(d.getDate()) +
        " " +
        MONTHS[d.getMonth()] +
        " " +
        d.getFullYear() +
        " " +
        pad2(d.getHours()) +
        ":" +
        pad2(d.getMinutes())
    );
}

function fmtClock(ts: number): string {
    const d = new Date(ts);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function fmtKb(bytes: number): string {
    return (bytes / 1024).toFixed(1) + " KB";
}

/** Hari sejak entri state-3 terakhir ("hari tanpa jebol"). */
function cleanStreakDays(entries: LogEntry[]): number {
    const DAY = 86400000;
    const bad = entries.filter((e) => e.state === 3).map((e) => e.ts);
    const since = bad.length ? Math.max(...bad) : entries.length ? entries[0].ts : Date.now();
    return Math.max(0, Math.floor((Date.now() - since) / DAY));
}

function clampState(v: any): number {
    const n = parseInt(String(v), 10);
    if (isNaN(n)) return 0;
    return n < 0 ? 0 : n > 3 ? 3 : n;
}

/** Kunci hari lokal "YYYY-MM-DD" (bukan UTC — hari mengikuti waktu setempat). */
function dayKey(d: Date): string {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function fmtDateLong(d: Date): string {
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
}

// ================================================================
// GAMBAR — level0..level3 di /opt/craving-tracker/
// ================================================================
//
// Ekspektasi user: 4 foto anak, satu per skala (level0 → hasrat 0 dst).
// Boleh berupa gambar raster mentah (jpg/jpeg/png/webp/gif) ATAU sidecar
// base64 (`level0.b64` / `level0.jpg.b64`) — pola yang sama dengan
// wallpaper Asteracea. Gambar raster dibaca sebagai latin1 (1 byte = 1 char),
// jadi HARUS masuk VFS lewat jalur binary-safe (`npm run install`,
// `scripts/vfs-bootstrap.ts`) — `scripts/sync-vfs.ts` membaca utf8 dan
// merusak byte JPEG (kasus ini dideteksi & dilaporkan di UI).

const IMG_EXTS: { ext: string; mime: string }[] = [
    { ext: "jpg", mime: "image/jpeg" },
    { ext: "jpeg", mime: "image/jpeg" },
    { ext: "png", mime: "image/png" },
    { ext: "webp", mime: "image/webp" },
    { ext: "gif", mime: "image/gif" },
];

interface ImageResult {
    b64: string;
    mime: string;
    file: string;
    bytes: number;
}

/** Deteksi tipe gambar dari magic bytes (bukan dari ekstensi). */
function sniffMime(buf: Buffer): string | null {
    if (buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
    if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
    if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") {
        return "image/webp";
    }
    return null;
}

/** SVG placeholder (data URI) saat foto belum tersedia. */
function placeholderB64(level: number): string {
    const file = "level" + level + ".jpg";
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="260" viewBox="0 0 480 260">' +
        '<rect width="480" height="260" fill="#0a1220"/>' +
        '<rect x="8" y="8" width="464" height="244" rx="12" fill="none" stroke="#22314a" stroke-width="2" stroke-dasharray="9 7"/>' +
        '<text x="240" y="112" fill="#7c8aa5" font-family="Segoe UI, Arial, sans-serif" font-size="21" text-anchor="middle">Foto belum tersedia</text>' +
        '<text x="240" y="146" fill="#4e5d78" font-family="Consolas, monospace" font-size="13" text-anchor="middle">' +
        file +
        " &#8594; /opt/craving-tracker/</text>" +
        '<text x="240" y="176" fill="#3d4a61" font-family="Consolas, monospace" font-size="11" text-anchor="middle">level0 … level3 (jpg / jpeg / png)</text>' +
        "</svg>";
    return Buffer.from(svg, "utf8").toString("base64");
}

/** SVG placeholder (data URI) saat file ada tapi byte-nya korup. */
function brokenB64(file: string): string {
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="260" viewBox="0 0 480 260">' +
        '<rect width="480" height="260" fill="#1a0f12"/>' +
        '<rect x="8" y="8" width="464" height="244" rx="12" fill="none" stroke="#5a2a2a" stroke-width="2" stroke-dasharray="9 7"/>' +
        '<text x="240" y="112" fill="#e08585" font-family="Segoe UI, Arial, sans-serif" font-size="21" text-anchor="middle">Gambar rusak (byte korup)</text>' +
        '<text x="240" y="146" fill="#a06a6a" font-family="Consolas, monospace" font-size="13" text-anchor="middle">' +
        file +
        "</text>" +
        '<text x="240" y="176" fill="#7a5a5a" font-family="Consolas, monospace" font-size="11" text-anchor="middle">kirim ulang via: npm run install</text>' +
        "</svg>";
    return Buffer.from(svg, "utf8").toString("base64");
}

/**
 * Cari gambar untuk satu level. Urutan kandidat:
 *   levelN.jpg/.jpeg/.png/.webp/.gif  → gambar raster (latin1)
 *   levelN.b64, levelN.jpg.b64        → sidecar base64 (teks ASCII)
 */
async function loadLevelImage(level: number): Promise<{ img: ImageResult | null; corrupt: string | null }> {
    const base = APP_DIR + "/level" + level;
    const candidates: string[] = IMG_EXTS.map((e) => base + "." + e.ext);
    candidates.push(base + ".b64", base + ".jpg.b64");

    let corrupt: string | null = null;

    for (const path of candidates) {
        let raw: string | null = null;
        try {
            raw = await fs.readFile(path);
        } catch (_) {
            raw = null;
        }
        if (!raw) continue;

        if (path.endsWith(".b64")) {
            // Sidecar base64 — teks murni ASCII, aman lewat sync-vfs (utf8).
            const clean = String(raw)
                .replace(/^data:[^,]*,/, "")
                .replace(/\s+/g, "");
            if (clean.length < 64 || !/^[A-Za-z0-9+/=]+$/.test(clean)) continue;
            const buf = Buffer.from(clean, "base64");
            const mime = sniffMime(buf);
            if (!mime) {
                corrupt = path;
                continue;
            }
            return { img: { b64: clean, mime, file: path, bytes: buf.length }, corrupt };
        }

        // Gambar raster: VFS menyimpan 1 byte = 1 char (latin1).
        const buf = Buffer.from(String(raw), "latin1");
        const mime = sniffMime(buf);
        if (!mime) {
            // Ada file, tapi bukan gambar valid → kemungkinan byte dirusak utf8.
            corrupt = path;
            continue;
        }
        return { img: { b64: buf.toString("base64"), mime, file: path, bytes: buf.length }, corrupt };
    }

    return { img: null, corrupt };
}

// ================================================================
// PERSISTENSI JSON
// ================================================================

/** Normalisasi 1 entri dari file JSON (toleran terhadap bentuk lama). */
function normalizeEntry(raw: any): LogEntry | null {
    if (!raw || typeof raw !== "object") return null;
    const state = clampState(raw.state);
    const context = String(raw.context ?? raw.note ?? "").trim();
    let ts = Number(raw.ts ?? raw.timestamp ?? 0);
    if (!ts || isNaN(ts)) {
        const parsed = Date.parse(String(raw.iso ?? raw.time ?? ""));
        ts = isNaN(parsed) ? Date.now() : parsed;
    }
    return {
        state,
        context: context || "(tanpa konteks)",
        time: String(raw.time || "") || fmtTime(ts),
        ts,
    };
}

async function loadEntries(): Promise<LogEntry[]> {
    try {
        const raw = await fs.readFile(DATA_FILE);
        if (!raw) return [];
        const parsed = JSON.parse(String(raw));
        const arr: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : [];
        return arr
            .map(normalizeEntry)
            .filter((e): e is LogEntry => !!e)
            .sort((a, b) => a.ts - b.ts);
    } catch (e: any) {
        await std.log("[craving] gagal baca " + DATA_FILE + ": " + e.message);
        return [];
    }
}

async function saveEntries(entries: LogEntry[]): Promise<boolean> {
    try {
        try {
            await fs.mkdir(APP_DIR);
        } catch (_) {
            /* sudah ada */
        }
        const payload = JSON.stringify(
            {
                app: "craving-tracker",
                version: 1,
                updatedAt: new Date().toISOString(),
                total: entries.length,
                entries,
            },
            null,
            2,
        );
        return !!(await fs.writeFile(DATA_FILE, payload));
    } catch (e: any) {
        await std.log("[craving] gagal tulis " + DATA_FILE + ": " + e.message);
        return false;
    }
}

// ================================================================
// MAIN
// ================================================================

export const main = Program(async (_args: string[]) => {
    await std.log("=== Craving Tracker 0-3 (Cashew GUI) ===");

    let entries: LogEntry[] = await loadEntries();
    let level = 0;

    // ================================================================
    // FORM
    // ================================================================
    const form = new TForm({
        title: "Craving Tracker",
        icon: "🚭",
        // Lebar 1020 cukup untuk grafik 6 bulan (± 27 kolom) + kolom form foto.
        width: 1020,
        height: 680,
        resizable: true,
        maximizable: true,
    });
    form.style = { ...form.style, gap: "8px" };
    form.onClose = () => std.log("[craving] window closed");

    // ================================================================
    // HEADER
    // ================================================================
    const lblTitle = new TLabel("lbl-title", {
        caption: "🚭 Craving Tracker (0-3)",
        style: { fontSize: "18px", fontWeight: "700", color: "#4caf50" },
    });
    // Kata penyemangat — diisi renderEncourage() dari aktivitas HARI INI.
    const lblEncourage = new TLabel("lbl-encourage", {
        caption: "",
        style: {
            fontSize: "13px",
            color: "var(--text-muted)",
            flex: "1",
            textAlign: "right",
            marginLeft: "10px",
            lineHeight: "1.35",
        },
    });
    const lblSub = new TLabel("lbl-sub", {
        caption: "Log aktivitas & hasrat koding tanpa rokok demi si bungsu.",
        style: { fontSize: "11px", color: "var(--text-muted)" },
    });
    const headerRow = HStack({ gap: "8px", width: "100%", alignItems: "baseline" }, lblTitle, lblEncourage);
    form.add(headerRow);
    form.add(lblSub);

    // ================================================================
    // AREA 2 KOLOM
    // ================================================================
    const columns = new TPanel("columns", {
        display: "grid",
        gridTemplateColumns: "minmax(340px, 430px) 1fr",
        gap: "10px",
        flex: "1",
        minHeight: "0",
        background: "transparent",
        border: "0",
        padding: "0",
    });
    form.add(columns);

    // ---------------- KOLOM KIRI — INPUT ----------------
    const leftCol = TScrollBox("left-col", {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        minHeight: "0",
        background: "transparent",
        border: "0",
        padding: "0",
    });
    leftCol.style = { ...leftCol.style, overflowY: "auto" };

    const grpInput = TGroupBox("grp-input", "📝 Log Aktivitas", {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        flexShrink: "0",
    });

    const lblScale = new TLabel("lbl-scale", {
        caption: "Skala Hasrat (State)",
        style: { fontWeight: "600", fontSize: "12px" },
    });
    const cbLevel = new TComboBox("cb-level", {
        items: STATE_LABELS,
        selectedIndex: 0,
    });

    // Kartu header state (judul + foto anak)
    const headCard = new TPanel("head-card", {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        background: HEAD_BG[0],
        border: "1px solid var(--border)",
        borderRadius: "8px",
        padding: "8px",
        transition: "background 160ms ease",
    });
    // Host teks judul state — diisi writeText() (jalur immediate), bukan caption
    // post-mount, supaya tidak bisa hilang karena race flush batched.
    const stateTitleHost = new TPanel("state-title-host", {
        caption: "Level 0 — " + STATE_TITLES[0],
        background: "transparent",
        border: "0",
        padding: "0",
        fontSize: "12px",
        fontWeight: "700",
        color: "var(--text)",
    });

    const imgChild = new TImage("img-child", {
        alt: "Foto anak",
        fit: "contain",
        width: "100%",
        height: 190,
        style: {
            background: "#0a1220",
            borderRadius: "6px",
            border: "1px solid var(--border)",
        },
    });
    // Placeholder dipasang SEBELUM mount (build() memakai _src saat mount).
    imgChild.setBase64(placeholderB64(0), "image/svg+xml");

    const lblImgInfo = new TLabel("lbl-img-info", {
        caption: "",
        style: {
            fontSize: "10px",
            color: "var(--text-muted)",
            fontFamily: "monospace",
            wordBreak: "break-all",
        },
    });

    headCard.add(stateTitleHost);
    headCard.add(imgChild);
    headCard.add(lblImgInfo);

    const lblCtx = new TLabel("lbl-ctx", {
        caption: "Konteks Koding / Kendala Bug",
        style: { fontWeight: "600", fontSize: "12px", marginTop: "2px" },
    });
    const edContext = new TEdit("ed-context", {
        placeholder: "Misal: debugging async loop, refactoring tsix, dll.",
    });

    const btnSubmit = new TButton("btn-submit", {
        caption: "✅ Submit Log Aktivitas",
        style: {
            background: "#238636",
            color: "#ffffff",
            border: "1px solid rgba(240,246,252,0.1)",
            flex: "1",
            padding: "8px 14px",
        },
    });
    const btnReload = new TButton("btn-reload", {
        caption: "🔄 Muat Ulang",
        style: { background: "var(--button-bg)", color: "var(--text-dim)", flexShrink: "0" },
    });
    const btnRow = HStack({ gap: "8px", width: "100%" }, btnSubmit, btnReload);

    grpInput.add(lblScale);
    grpInput.add(cbLevel);
    grpInput.add(headCard);
    grpInput.add(lblCtx);
    grpInput.add(edContext);
    grpInput.add(btnRow);
    leftCol.add(grpInput);

    columns.add(leftCol);

    // ---------------- KOLOM KANAN — VISUALISASI ----------------
    const rightCol = new TPanel("right-col", {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        minHeight: "0",
        background: "transparent",
        border: "0",
        padding: "0",
    });

    // Matriks per-entri (warna = state, sesuai stop-smoking.html)
    const grpGrid = TGroupBox("grp-grid", "📈 Matriks Per-Entri (warna = state)", {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        flex: "1",
        minHeight: "0",
    });

    const legend = new TLabel("legend", {
        caption: "0 ▮ hijau muda  1 ▮ hijau  2 ▮ hijau tua  3 ▮ merah · klik sel = detail",
        style: {
            fontSize: "10px",
            color: "var(--text-muted)",
            fontFamily: "monospace",
        },
    });

    const gridHost = new TPanel("grid-host", {
        background: "transparent",
        border: "0",
        // Padding = ruang buat pendar merah sel jebol (state 3).
        padding: "4px",
        flex: "1",
        minHeight: "0",
        overflowY: "auto",
    });

    // Host statistik — diisi writeText() (immediate).
    const statsHost = new TPanel("stats-host", {
        background: "transparent",
        border: "0",
        padding: "0",
        flex: "1",
    });

    // Bersihkan Data — dulu di panel Riwayat, kini di baris statistik.
    const btnClear = new TButton("btn-clear", {
        caption: "🗑 Bersihkan Data",
        style: {
            background: "rgba(244,67,54,0.12)",
            color: "#f44336",
            border: "1px solid rgba(244,67,54,0.35)",
            fontSize: "11px",
            padding: "3px 10px",
            flexShrink: "0",
        },
    });

    const statsRow = HStack({ gap: "8px", width: "100%", alignItems: "center" }, statsHost, btnClear);

    grpGrid.add(legend);
    grpGrid.add(gridHost);
    grpGrid.add(statsRow);
    rightCol.add(grpGrid);

    // ---------------- CRAVING ACTIVITY (contribution graph github.com) ----------------
    // Di bawah Matriks Per-Entri — menggantikan panel Riwayat Commit Data.
    // Berisi juga bagian TREN (alat ukur maju/stagnan) supaya tidak ada panel
    // tambahan di window setinggi ini.
    const grpActivity = TGroupBox("grp-activity", "📊 Craving Activity & Tren Hasrat", {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        flexShrink: "0",
    });

    // Host ringkasan aktivitas — diisi writeText() (immediate).
    const activityHost = new TPanel("activity-host", {
        background: "transparent",
        border: "0",
        padding: "0",
        fontSize: "11px",
        color: "var(--text-dim)",
    });
    // Membandingkan 3 bulan terakhir vs 3 bulan sebelumnya, memakai metrik
    // harian (state maksimum per hari). Hari yang TIDAK di-log tidak dihitung
    // sebagai "tenang" — tidak di-log bukan berarti tidak ada hasrat, jadi
    // rata-rata & % hari tenang hanya dari hari yang benar-benar ber-log.
    const trendHost = new TPanel("trend-host", {
        background: "transparent",
        border: "0",
        padding: "2px 2px 0 2px",
        width: "100%",
    });
    // Host verdict tren + dua baris pembanding — diisi writeText() (immediate).
    const trendHeadHost = new TPanel("trend-head-host", {
        background: "transparent",
        border: "0",
        padding: "0",
        fontSize: "12px",
        fontWeight: "700",
        color: "var(--text)",
    });
    const trendPrevHost = new TPanel("trend-prev-host", {
        background: "transparent",
        border: "0",
        padding: "0",
        fontSize: "10px",
        fontFamily: "monospace",
        color: "var(--text-muted)",
    });
    const trendCurHost = new TPanel("trend-cur-host", {
        background: "transparent",
        border: "0",
        padding: "0",
        fontSize: "10px",
        fontFamily: "monospace",
        color: "var(--text-dim)",
    });

    const ghHost = new TPanel("gh-host", {
        background: "transparent",
        border: "0",
        padding: "2px 0 0 0",
        width: "100%",
    });

    grpActivity.add(activityHost);
    grpActivity.add(trendHeadHost);
    grpActivity.add(trendHost);
    grpActivity.add(trendPrevHost);
    grpActivity.add(trendCurHost);
    grpActivity.add(ghHost);
    rightCol.add(grpActivity);
    columns.add(rightCol);

    // ---------------- STATUS BAR ----------------
    const status = new TStatusBar("status", {
        leftText: "📄 " + DATA_FILE,
        rightText: "0 entri",
    });
    form.add(status);

    // ================================================================
    // TULIS TEKS — JALUR IMMEDIATE
    // ================================================================
    //
    // KENAPA bukan label.caption / screen.update()? Update batched (dirtyProps →
    // flushNow) TERBUKTI bisa hilang di app ini: kalau ada update baru masuk saat
    // flush lain sedang berjalan, dirtyProps.clear() di akhir flushNow menghapusnya
    // dan scheduleFlush() menolak menjadwalkan ulang selama batchPromise hidup.
    // Gejalanya: label teks tetap berisi caption awal ("Menghitung…") walau
    // render-nya sudah jalan. setContent() memakai sendImmediate → selalu sampai.
    // (Temuan dari inspeksi DOM + rekaman WebSocket: 8245 UPDATE_PROPS sampai,
    // tapi update teks yang di-set di ekor rentetan refreshAll tidak terpakai.)

    /** Tulis teks ke sebuah host. Pre-mount: cukup set props (ikut payload mount). */
    async function writeText(
        host: TPanel | TLabel,
        text: string,
        style: Record<string, any> = {},
        screen?: any,
    ): Promise<void> {
        if (!screen) {
            host.caption = text;
            if (Object.keys(style).length > 0) {
                host.style = { ...host.style, ...style };
            }
            return;
        }
        await screen.setContent(host.id, {
            id: host.id + "_t",
            tag: "span",
            props: {
                text,
                style: { display: "block", ...style },
            },
            children: [],
        });
    }

    /** Tulis teks status bar (span internal TStatusBar: status_left/status_right). */
    async function writeStatus(screen: any, side: "left" | "right", text: string): Promise<void> {
        if (!screen) return;
        const id = "status_" + side;
        await screen.setContent(id, {
            id: id + "_t",
            tag: "span",
            props: { text },
            children: [],
        });
    }

    // ================================================================
    // RENDER — MATRIKS
    // ================================================================
    function cellStyle(state: number, empty: boolean): Record<string, any> {
        // Teks dibalik otomatis di sel hijau muda/sedang — pakai isLightColor.
        const light = !empty && isLightColor(STATE_HEX[state]);
        return {
            aspectRatio: "1",
            minWidth: "20px",
            borderRadius: "3px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "10px",
            fontWeight: "700",
            color: empty ? "rgba(255,255,255,0.14)" : light ? "#15171a" : "#ffffff",
            cursor: empty ? "default" : "pointer",
            background: empty ? "rgba(255,255,255,0.04)" : STATE_HEX[state],
            border: empty ? "1px solid var(--border)" : "1px solid rgba(255,255,255,0.16)",
            // Jebol (state 3) juga berpendar di matriks per-entri.
            boxShadow: !empty && state === 3 ? "0 0 8px 1px " + rgba(RED_RGB, 0.75) : "none",
            position: "relative",
            zIndex: state === 3 ? 2 : 1,
        };
    }

    async function renderGrid(screen: any): Promise<void> {
        // Sel dibungkus SATU wrapper node → mount hanya 1 payload IPC.
        const cells: IDOMNode[] = [];
        const shown = entries.length === 0 ? [] : entries.slice(-CELL_LIMIT);

        if (shown.length === 0) {
            // Placeholder 12 sel kosong (seperti versi HTML)
            for (let i = 0; i < 12; i++) {
                cells.push({
                    id: "cell_empty_" + i,
                    tag: "div",
                    props: { style: cellStyle(0, true) },
                    children: [],
                });
            }
        } else {
            shown.forEach((e, i) => {
                cells.push({
                    id: "cell_" + i,
                    tag: "div",
                    props: {
                        text: String(e.state),
                        title: fmtTime(e.ts) + " · " + BADGE_TEXT[e.state] + " · " + e.context,
                        style: cellStyle(e.state, false),
                    },
                    children: [],
                });
            });
        }

        const wrapper: IDOMNode = {
            id: "grid-wrap",
            tag: "div",
            props: {
                style: {
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(24px, 1fr))",
                    gap: "4px",
                },
            },
            children: cells,
        };

        await screen.setContent("grid-host", wrapper);

        // Klik sel → detail di status bar (tooltip tetap muncul saat hover).
        if (shown.length > 0) {
            shown.forEach((e, i) => {
                screen.on("cell_" + i, "click", async () => {
                    await writeStatus(
                        screen,
                        "right",
                        "[" + fmtClock(e.ts) + "] " + BADGE_TEXT[e.state] + " — " + e.context,
                    );
                });
            });
        }
    }

    // ================================================================
    // RENTANG WAKTU — dipakai bersama kalender & panel tren
    // ================================================================
    //
    // Semua perhitungan memakai hari LOKAL (bukan UTC) supaya batas hari
    // cocok dengan jam dinding user.

    /** Awal hari (00:00 lokal). */
    function dayStartOf(d: Date): Date {
        const x = new Date(d);
        x.setHours(0, 0, 0, 0);
        return x;
    }

    /** Hari ini, 00:00 lokal. */
    function todayStart(): Date {
        return dayStartOf(new Date());
    }

    /** Awal jendela: 6 bulan lalu, dimundurkan ke hari Minggu (= awal kolom minggu). */
    function calendarStart(): Date {
        const s = todayStart();
        s.setDate(s.getDate() - WINDOW_DAYS);
        s.setDate(s.getDate() - s.getDay());
        return s;
    }

    /** Batas data: entri lebih tua dari ini diabaikan (6 bulan lalu, tanpa align Minggu). */
    function windowCutoff(): Date {
        const s = todayStart();
        s.setDate(s.getDate() - WINDOW_DAYS);
        return s;
    }

    interface DayRec {
        d: Date;
        /** State maksimum hari itu; null = tidak ada log sama sekali. */
        max: number | null;
        logs: number;
        jebol: number;
    }

    /** Rekap per hari (jumlah log, state maksimum, jumlah jebol) dari `from` s/d `to`. */
    function dayRecords(from: Date, to: Date): DayRec[] {
        const byKey = new Map<string, { logs: number; max: number; jebol: number }>();
        for (const e of entries) {
            const k = dayKey(new Date(e.ts));
            const r = byKey.get(k);
            if (r) {
                r.logs++;
                if (e.state > r.max) r.max = e.state;
                if (e.state === 3) r.jebol++;
            } else {
                byKey.set(k, {
                    logs: 1,
                    max: e.state,
                    jebol: e.state === 3 ? 1 : 0,
                });
            }
        }

        const recs: DayRec[] = [];
        const d = new Date(from);
        while (d.getTime() <= to.getTime()) {
            const r = byKey.get(dayKey(d));
            recs.push({
                d: new Date(d),
                max: r ? r.max : null,
                logs: r ? r.logs : 0,
                jebol: r ? r.jebol : 0,
            });
            d.setDate(d.getDate() + 1);
        }
        return recs;
    }

    // ================================================================
    // RENDER — CRAVING ACTIVITY (per hari, 6 bulan, gaya github.com)
    // ================================================================
    //
    // Struktur node (semua dalam SATU payload MOUNT_NODE):
    //   gh-wrap
    //    ├─ row: [ kolom label hari (Sen/Rab/Jum) | gh-scroll ]
    //    │         gh-scroll: [ gh-months (baris label bulan)
    //    │                       gh-weeks  (grid 7 baris × N kolom minggu) ]
    //    └─ gh-legend  (Sedikit ▢▢▢▢▢ Banyak)

    function buildCalendarNode(): {
        node: IDOMNode;
        total: number;
        activeDays: number;
        longest: number;
        jebol: number;
    } {
        const today = todayStart();

        // Mulai 6 bulan lalu, lalu mundur ke hari Minggu (kolom = 1 minggu).
        const start = calendarStart();

        const totalDays = Math.round((today.getTime() - start.getTime()) / 86400000) + 1;
        const weeks = Math.ceil(totalDays / 7);
        const windowStart = windowCutoff();

        // Kelompokkan entri per hari lokal.
        const byDay = new Map<string, LogEntry[]>();
        let total = 0;
        for (const e of entries) {
            if (e.ts < windowStart.getTime()) continue;
            total++;
            const k = dayKey(new Date(e.ts));
            const arr = byDay.get(k);
            if (arr) arr.push(e);
            else byDay.set(k, [e]);
        }

        const cells: IDOMNode[] = [];
        const monthRuns: { label: string; col: number; span: number }[] = [];
        let activeDays = 0;
        let longest = 0;
        let run = 0;
        /** Total entri level 3 (jebol) dalam rentang kalender. */
        let jebolTotal = 0;

        for (let col = 0; col < weeks; col++) {
            const colFirst = new Date(start);
            colFirst.setDate(colFirst.getDate() + col * 7);

            // Label bulan ala GitHub: kolom yang memuat tanggal 1 jadi awal bulan
            // baru; kolom lain ikut bulan hari pertamanya (Minggu).
            let label = MONTHS[colFirst.getMonth()];
            for (let k = 1; k < 7; k++) {
                const probe = new Date(colFirst);
                probe.setDate(probe.getDate() + k);
                if (probe.getDate() === 1) {
                    label = MONTHS[probe.getMonth()];
                    break;
                }
            }
            const lastRun = monthRuns[monthRuns.length - 1];
            if (lastRun && lastRun.label === label) lastRun.span++;
            else monthRuns.push({ label, col, span: 1 });

            for (let row = 0; row < 7; row++) {
                const d = new Date(start);
                d.setDate(d.getDate() + col * 7 + row);
                const id = "gh_" + col + "_" + row;

                // Hari di masa depan — sel transparan (tanpa tooltip).
                if (d.getTime() > today.getTime()) {
                    cells.push({
                        id,
                        tag: "div",
                        props: {
                            style: {
                                width: CELL_PX + "px",
                                height: CELL_PX + "px",
                                background: "transparent",
                            },
                        },
                        children: [],
                    });
                    continue;
                }

                const list = byDay.get(dayKey(d)) || [];
                const count = list.length;
                if (count > 0) {
                    activeDays++;
                    run++;
                    if (run > longest) longest = run;
                } else {
                    run = 0;
                }

                const maxState = count
                    ? Math.max.apply(
                          null,
                          list.map((x) => x.state),
                      )
                    : -1;
                const jebol = list.filter((x) => x.state === 3).length; // level 3 hari ini
                jebolTotal += jebol;

                let tip =
                    count === 0
                        ? "Tidak ada log · " + fmtDateLong(d)
                        : count +
                          " log · " +
                          fmtDateLong(d) +
                          " · level maks " +
                          maxState +
                          (jebol ? " · 🔥 jebol " + jebol : "");
                if (d.getTime() === today.getTime()) tip += " (hari ini)";

                // Warna sel = kekuatan hasrat hari itu (state tertinggi).
                const base = count === 0 ? GH_EMPTY : STATE_HEX[maxState < 0 ? 0 : maxState];

                // Pendar merah level 3 — radius & kepekatan naik seiring jumlah jebol,
                // jadi kalau sehari jebol berkali-kali cahayanya luber ke sel tetangga.
                const shadows: string[] = [];
                if (jebol > 0) {
                    shadows.push(
                        "0 0 " +
                            Math.min(4 + jebol * 4, 18) +
                            "px " +
                            Math.min(1 + jebol, 4) +
                            "px " +
                            rgba(RED_RGB, Math.min(0.5 + jebol * 0.16, 1)),
                    );
                    if (jebol >= 2) {
                        // Halo kedua (luber lebih jauh) untuk jebol beruntun.
                        shadows.push(
                            "0 0 " +
                                Math.min(10 + jebol * 5, 34) +
                                "px " +
                                Math.min(2 + jebol, 7) +
                                "px " +
                                rgba(RED_RGB, 0.38),
                        );
                    }
                }
                // Sel jebol digambar di atas tetangganya agar pendarnya terlihat.
                const hot = jebol > 0;

                cells.push({
                    id,
                    tag: "div",
                    props: {
                        title: tip,
                        style: {
                            width: CELL_PX + "px",
                            height: CELL_PX + "px",
                            borderRadius: "2px",
                            background: base,
                            border: "1px solid " + (count === 0 ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.2)"),
                            boxSizing: "border-box",
                            // position + zIndex wajib berpasangan supaya box-shadow sel jebol
                            // menimpa sel tetangga (efek "luber").
                            position: "relative",
                            zIndex: hot ? 3 : 1,
                            boxShadow: shadows.length ? shadows.join(", ") : "none",
                            // Hari ini ditandai outline (tidak menggeser layout).
                            outline: d.getTime() === today.getTime() ? "1px solid var(--accent)" : "none",
                        },
                    },
                    children: [],
                });
            }
        }

        const monthsRow: IDOMNode = {
            id: "gh-months",
            tag: "div",
            props: {
                style: {
                    display: "grid",
                    gridTemplateColumns: "repeat(" + weeks + ", " + CELL_PX + "px)",
                    gap: GAP_PX + "px",
                    height: "12px",
                    fontSize: "9px",
                    lineHeight: "12px",
                    color: "var(--text-muted)",
                },
            },
            children: monthRuns.map((m) => ({
                id: "ghm_" + m.col,
                tag: "div",
                props: {
                    text: m.label,
                    style: {
                        gridColumn: m.col + 1 + " / span " + m.span,
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                    },
                },
                children: [],
            })),
        };

        const weeksGrid: IDOMNode = {
            id: "gh-weeks",
            tag: "div",
            props: {
                style: {
                    display: "grid",
                    gridAutoFlow: "column",
                    gridTemplateRows: "repeat(7, " + CELL_PX + "px)",
                    gridTemplateColumns: "repeat(" + weeks + ", " + CELL_PX + "px)",
                    gap: GAP_PX + "px",
                    width: "max-content",
                },
            },
            children: cells,
        };

        const weekdaysCol: IDOMNode = {
            id: "gh-weekdays",
            tag: "div",
            props: {
                style: {
                    display: "grid",
                    gridTemplateRows: "repeat(7, " + CELL_PX + "px)",
                    gap: GAP_PX + "px",
                    width: "26px",
                    marginTop: "20px", // sejajar grid minggu (padding 4px + baris bulan 12px + gap 4px)
                    fontSize: "9px",
                    color: "var(--text-muted)",
                    textAlign: "right",
                },
            },
            children: [0, 1, 2, 3, 4, 5, 6].map((i) => ({
                id: "ghwd_" + i,
                tag: "span",
                props: {
                    text: i === 1 || i === 3 || i === 5 ? WEEKDAY_SHORT[i] : "",
                    style: { lineHeight: CELL_PX + "px" },
                },
                children: [],
            })),
        };

        const swatch = (bg: string, id: string): IDOMNode => ({
            id,
            tag: "div",
            props: {
                style: {
                    width: CELL_PX + "px",
                    height: CELL_PX + "px",
                    borderRadius: "2px",
                    background: bg,
                    border: "1px solid rgba(255,255,255,0.04)",
                    boxSizing: "border-box",
                },
            },
            children: [],
        });

        const legendRow: IDOMNode = {
            id: "gh-legend",
            tag: "div",
            props: {
                style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    gap: "4px",
                    marginTop: "6px",
                    fontSize: "9px",
                    color: "var(--text-muted)",
                },
            },
            children: [
                { id: "gh-leg-less", tag: "span", props: { text: "warna:" }, children: [] },
                swatch(GH_EMPTY, "gh-leg-e"),
                { id: "gh-leg-0t", tag: "span", props: { text: "0" }, children: [] },
                swatch(STATE_HEX[1], "gh-leg-1"),
                { id: "gh-leg-1t", tag: "span", props: { text: "1" }, children: [] },
                swatch(STATE_HEX[2], "gh-leg-2"),
                { id: "gh-leg-2t", tag: "span", props: { text: "2" }, children: [] },
                {
                    id: "gh-leg-3",
                    tag: "div",
                    props: {
                        style: {
                            width: CELL_PX + "px",
                            height: CELL_PX + "px",
                            borderRadius: "2px",
                            background: STATE_HEX[3],
                            border: "1px solid rgba(255,255,255,0.2)",
                            boxSizing: "border-box",
                            boxShadow: "0 0 8px 2px " + rgba(RED_RGB, 0.8),
                        },
                    },
                    children: [],
                },
                { id: "gh-leg-3t", tag: "span", props: { text: "3" }, children: [] },
                {
                    id: "gh-leg-more",
                    tag: "span",
                    props: { text: "· merah makin berpendar = makin banyak jebol" },
                    children: [],
                },
            ],
        };

        const node: IDOMNode = {
            id: "gh-wrap",
            tag: "div",
            props: {
                style: { display: "flex", flexDirection: "column", width: "100%" },
            },
            children: [
                {
                    id: "gh-row",
                    tag: "div",
                    props: {
                        style: { display: "flex", gap: "6px", alignItems: "flex-start" },
                    },
                    children: [
                        weekdaysCol,
                        {
                            id: "gh-scroll",
                            tag: "div",
                            props: {
                                style: {
                                    flex: "1",
                                    minWidth: "0",
                                    overflowX: "auto",
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: "4px",
                                    // Padding = ruang untuk pendar merah yang luber keluar sel
                                    // (kalau tidak, glow kena clip oleh overflow-x:auto).
                                    padding: "4px 8px 10px 0",
                                },
                            },
                            children: [monthsRow, weeksGrid],
                        },
                    ],
                },
                legendRow,
            ],
        };

        return { node, total, activeDays, longest, jebol: jebolTotal };
    }

    async function renderCalendar(screen: any): Promise<void> {
        const cal = buildCalendarNode();
        await writeText(
            activityHost,
            "📊 " +
                cal.total +
                " log " +
                WINDOW_LABEL +
                "   ·   " +
                cal.activeDays +
                " hari aktif   ·   🔥 " +
                cal.jebol +
                " jebol   ·   streak terpanjang " +
                cal.longest +
                " hari",
            {},
            screen,
        );
        await screen.setContent("gh-host", cal.node);
    }

    // ================================================================
    // RENDER — TREN HASRAT (maju / stagnan / naik lagi)
    // ================================================================
    //
    // Alat ukur: apakah hasrat selama program berhenti menurun atau datar.
    // Metrik harian (state maksimum per hari):
    //   avg    = rata-rata state maksimum per hari YANG ADA LOG
    //   tenang = % hari ber-log dengan state maks ≤ 1 (0 lupa / 1 reda)
    //   jebol  = jumlah entri state 3
    // Dibandingkan: paruh kedua jendela (3 bulan terakhir) vs paruh pertama.
    // Turun ≥ 0.2 poin = MAJU · naik ≥ 0.2 = NAIK LAGI · selain itu STAGNAN.

    interface TrendAgg {
        days: number;
        sum: number;
        calm: number;
        jebol: number;
        logs: number;
    }

    function aggTrend(recs: DayRec[]): TrendAgg {
        let days = 0;
        let sum = 0;
        let calm = 0;
        let jebol = 0;
        let logs = 0;
        for (const r of recs) {
            if (r.max !== null) {
                days++;
                sum += r.max;
                if (r.max <= 1) calm++;
            }
            jebol += r.jebol;
            logs += r.logs;
        }
        return { days, sum, calm, jebol, logs };
    }

    function avgOf(a: TrendAgg): number {
        return a.days > 0 ? a.sum / a.days : 0;
    }

    function calmPct(a: TrendAgg): number {
        return a.days > 0 ? Math.round((a.calm / a.days) * 100) : 0;
    }

    async function renderTrend(screen: any): Promise<void> {
        const recs = dayRecords(calendarStart(), todayStart());
        const mid = Math.floor(recs.length / 2);
        const prev = aggTrend(recs.slice(0, mid)); // 3 bulan sebelumnya
        const cur = aggTrend(recs.slice(mid)); // 3 bulan terakhir

        const MIN_DAYS = 4;
        const H = 44;

        // ---- Bar per minggu: tinggi = avg level, pendar = jebol ----
        const bars: IDOMNode[] = [];
        for (let i = 0; i < recs.length; i += 7) {
            const wk = recs.slice(i, i + 7);
            const a = aggTrend(wk);
            const avg = avgOf(a);
            const tip =
                "Minggu " +
                fmtDateLong(wk[0].d) +
                ": " +
                (a.days === 0
                    ? "belum ada log"
                    : a.days +
                      " hari ber-log · avg " +
                      avg.toFixed(2) +
                      " · tenang " +
                      calmPct(a) +
                      "%" +
                      (a.jebol ? " · 🔥 jebol " + a.jebol : ""));

            const shadows: string[] = [];
            if (a.jebol > 0) {
                shadows.push(
                    "0 0 " +
                        Math.min(4 + a.jebol * 4, 16) +
                        "px " +
                        Math.min(1 + a.jebol, 3) +
                        "px " +
                        rgba(RED_RGB, Math.min(0.45 + a.jebol * 0.15, 1)),
                );
            }

            bars.push({
                id: "trendbar_" + i / 7,
                tag: "div",
                props: {
                    title: tip,
                    style: {
                        flex: "1",
                        minWidth: "3px",
                        height: (a.days === 0 ? 3 : Math.round(8 + (avg / 3) * (H - 8))) + "px",
                        borderRadius: "2px",
                        background: a.days === 0 ? "rgba(255,255,255,0.07)" : STATE_HEX[Math.min(3, Math.round(avg))],
                        border: "1px solid rgba(255,255,255,0.08)",
                        boxSizing: "border-box",
                        position: "relative",
                        zIndex: a.jebol > 0 ? 2 : 1,
                        boxShadow: shadows.length ? shadows.join(", ") : "none",
                    },
                },
                children: [],
            });
        }

        const wrap: IDOMNode = {
            id: "trend-wrap",
            tag: "div",
            props: {
                style: {
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                    width: "100%",
                },
            },
            children: [
                {
                    id: "trend-bars",
                    tag: "div",
                    props: {
                        style: {
                            display: "flex",
                            alignItems: "flex-end",
                            gap: "2px",
                            height: H + "px",
                            width: "100%",
                        },
                    },
                    children: bars,
                },
                {
                    id: "trend-caps",
                    tag: "div",
                    props: {
                        style: {
                            display: "flex",
                            justifyContent: "space-between",
                            gap: "6px",
                            fontSize: "9px",
                            color: "var(--text-muted)",
                        },
                    },
                    children: [
                        {
                            id: "trend-cap-l",
                            tag: "span",
                            props: { text: "← 6 bulan lalu" },
                            children: [],
                        },
                        {
                            id: "trend-cap-m",
                            tag: "span",
                            props: { text: "tinggi = avg hasrat · avg dari hari ber-log" },
                            children: [],
                        },
                        {
                            id: "trend-cap-r",
                            tag: "span",
                            props: { text: "sekarang →" },
                            children: [],
                        },
                    ],
                },
            ],
        };

        await screen.setContent("trend-host", wrap);

        // ---- Verdict + ringkasan dua periode ----
        if (prev.days < MIN_DAYS || cur.days < MIN_DAYS) {
            await writeText(
                trendHeadHost,
                "❔ Belum bisa dinilai — butuh ≥" + MIN_DAYS + " hari ber-log di tiap periode",
                { color: "var(--text-muted)" },
                screen,
            );
            await writeText(trendPrevHost, "3 bln lalu: " + prev.days + " hari ber-log", {}, screen);
            await writeText(trendCurHost, "3 bln kini: " + cur.days + " hari ber-log", {}, screen);
            return;
        }

        const dAvg = avgOf(cur) - avgOf(prev);
        const dCalm = calmPct(cur) - calmPct(prev);
        let verdict: string;
        let color: string;
        if (dAvg <= -0.2) {
            verdict = "⬇️ MAJU";
            color = "#4caf50";
        } else if (dAvg >= 0.2) {
            verdict = "⬆️ NAIK LAGI";
            color = "#ff2d2d";
        } else {
            verdict = "➡️ STAGNAN";
            color = "#ffa000";
        }

        await writeText(
            trendHeadHost,
            verdict +
                " — avg hasrat " +
                avgOf(cur).toFixed(2) +
                " (" +
                (dAvg <= 0 ? "turun " : "naik ") +
                Math.abs(dAvg).toFixed(2) +
                " poin dari 3 bln sebelumnya)",
            { color },
            screen,
        );
        await writeText(
            trendPrevHost,
            "3 bln lalu: avg " +
                avgOf(prev).toFixed(2) +
                " · tenang " +
                calmPct(prev) +
                "% · " +
                prev.jebol +
                " jebol" +
                "  (" +
                prev.days +
                " hari)",
            {},
            screen,
        );
        await writeText(
            trendCurHost,
            "3 bln kini: avg " +
                avgOf(cur).toFixed(2) +
                " · tenang " +
                calmPct(cur) +
                "% · " +
                cur.jebol +
                " jebol" +
                "  (" +
                cur.days +
                " hari, " +
                (dCalm >= 0 ? "+" : "") +
                dCalm +
                " poin)",
            {},
            screen,
        );
    }

    // ================================================================
    // RENDER — KATA PENYEMANGAT (berdasar aktivitas HARI INI)
    // ================================================================
    //
    // Dipasang di samping judul. Isinya ditentukan dari log HARI INI saja
    // (bukan total): belum ada log → ajakan mencatat · ada jebol → tidak
    // menghakimi · maks 2 → apresiasi menahan diri · maks 1 → apresiasi
    // membiarkan keinginan lewat · maks 0 → apresiasi hari tenang.
    // Varian kalimat dipilih deterministik per tanggal: stabil sepanjang hari,
    // tapi berganti tiap hari supaya tidak terasa diulang-ulang.

    /** Indeks varian kalimat (0 .. n-1), berganti tiap hari. */
    function variantIndex(n: number): number {
        const hari = Math.floor(todayStart().getTime() / 86400000);
        return Math.abs(hari) % Math.max(1, n);
    }

    async function renderEncourage(screen?: any): Promise<void> {
        const tk = dayKey(todayStart());
        const todayLogs = entries.filter((e) => dayKey(new Date(e.ts)) === tk);
        const streak = entries.length > 0 ? cleanStreakDays(entries) : 0;

        let msg: string;
        let color: string;

        if (todayLogs.length === 0) {
            const v = [
                "📝 Belum ada catatan hari ini — pilih skala lalu Submit.",
                "📝 Hari ini belum di-log. Satu entri saja sudah cukup.",
                "📝 Yuk catat hari ini, biar grafiknya tetap jujur.",
            ];
            msg = v[variantIndex(v.length)];
            color = "var(--text-muted)";
        } else {
            const maxState = Math.max.apply(
                null,
                todayLogs.map((e) => e.state),
            );
            const jebol = todayLogs.filter((e) => e.state === 3).length;

            if (jebol > 0) {
                if (jebol >= 10) {
                    // Keras: sudah bukan slip, sudah pola sehari penuh.
                    const v = [
                        "🛑 " +
                            jebol +
                            "× jebol hari ini. Niat saja tidak cukup — ganti pemicunya (kopi, duduk lama, koding tengah malam).",
                        "🛑 " + jebol + "× jebol hari ini. Berhenti total butuh strategi baru, bukan cuma tekad.",
                        "🛑 " +
                            jebol +
                            "× jebol dalam sehari. Ini sinyal kuat: minta bantuan orang terdekat / layanan berhenti merokok.",
                    ];
                    msg = v[variantIndex(v.length)];
                    color = STATE_HEX[3];
                } else if (jebol >= 6) {
                    // Tegas: sudah berulang di hari yang sama.
                    const v = [
                        "⚠️ " + jebol + "× jebol hari ini — ini sudah pola, bukan kecelakaan.",
                        "⚠️ " + jebol + "× jebol hari ini. Catat pemicunya, jangan cuma ditahan.",
                        "⚠️ " + jebol + "× jebol hari ini. Hari berat — besok mulai dari 0 lagi.",
                    ];
                    msg = v[variantIndex(v.length)];
                    color = STATE_HEX[3];
                } else {
                    const v = [
                        "🔥 Jebol itu data, bukan vonis — catat, lalu mulai lagi dari 0.",
                        "🔥 Sudah tercatat. Besok hitungannya mulai dari nol, bukan dari gagal.",
                        "🔥 Hari berat, tapi kamu tetap mencatatnya. Itu tetap kemajuan.",
                    ];
                    msg = v[variantIndex(v.length)];
                    color = STATE_HEX[3];
                }
            } else if (maxState === 2) {
                const v = [
                    "💪 Hasrat kuat hari ini, tapi tidak jadi beli — itu kemenangan.",
                    "💪 Keinginan paling kuat hari ini berhasil ditahan. Bagus.",
                    "💪 Hijau tua hari ini, tapi tetap tidak jebol. Lanjut besok.",
                ];
                msg = v[variantIndex(v.length)];
                color = STATE_HEX[2];
            } else if (maxState === 1) {
                const v = [
                    "🌱 Keinginan datang, kamu biarkan lewat. Itu latihan yang benar.",
                    "🌱 Cuma mampir sebentar, tidak sampai menggoda. Stabil.",
                    "🌱 Hijau sedang — terkendali. Pertahankan ritmenya.",
                ];
                msg = v[variantIndex(v.length)];
                color = STATE_HEX[1];
            } else {
                const v = [
                    "🌿 Hari tenang. Mencatatnya tetap penting — itu data, bukan kebetulan.",
                    "🌿 Nol hasrat hari ini. Simpan jejaknya di grafik.",
                    "🌿 Hari ringan. Bagus, dan jangan lupa tetap dicatat.",
                ];
                msg = v[variantIndex(v.length)];
                color = STATE_HEX[0];
            }

            if (jebol === 0 && streak > 0) {
                msg += "  ·  🧒 " + streak + " hari tanpa jebol";
            }
        }

        await writeText(lblEncourage, msg, { color }, screen);
    }

    // ================================================================
    // RENDER — STATISTIK
    // ================================================================
    async function renderStats(screen: any): Promise<void> {
        const total = entries.length;
        const counts = [0, 0, 0, 0];
        for (const e of entries) counts[e.state]++;
        const streak = total > 0 ? cleanStreakDays(entries) : 0;
        await writeText(
            statsHost,
            "Σ " +
                total +
                " entri   ·   " +
                counts[0] +
                " lupa · " +
                counts[1] +
                " reda · " +
                counts[2] +
                " kuat · " +
                counts[3] +
                " jebol" +
                (total > 0 ? "   ·   🧒 hari tanpa jebol: " + streak : ""),
            {},
            screen,
        );
        await writeStatus(screen, "right", total + " entri tersimpan");
    }

    // ================================================================
    // GAMBAR PER SKALA
    // ================================================================
    /** Pasang hasil pencarian gambar ke TImage + keterangan di bawahnya. */
    function applyLevelImage(lv: number, res: { img: ImageResult | null; corrupt: string | null }): void {
        if (res.img) {
            imgChild.setBase64(res.img.b64, res.img.mime);
            lblImgInfo.caption = "🖼 " + res.img.file + "  (" + fmtKb(res.img.bytes) + ")";
            return;
        }
        if (res.corrupt) {
            imgChild.setBase64(brokenB64(res.corrupt), "image/svg+xml");
            lblImgInfo.caption = "⚠️ " + res.corrupt + " rusak (byte korup) — kirim ulang via `npm run install`";
            return;
        }
        imgChild.setBase64(placeholderB64(lv), "image/svg+xml");
        lblImgInfo.caption = "⚠️ " + APP_DIR + "/level" + lv + ".jpg belum ada — taruh 4 foto di folder itu";
    }

    async function showLevelImage(lv: number): Promise<void> {
        applyLevelImage(lv, await loadLevelImage(lv));
    }

    async function applyLevelHeader(lv: number, screen?: any): Promise<void> {
        await writeText(stateTitleHost, "Level " + lv + " — " + STATE_TITLES[lv], {}, screen);
        headCard.style = { ...headCard.style, background: HEAD_BG[lv] };
    }

    // ================================================================
    // REFRESH TOTAL
    // ================================================================
    async function refreshAll(screen: any): Promise<void> {
        await applyLevelHeader(level, screen);
        // Foto duluan — biar kelihatan segera, grid & kalender menyusul.
        await showLevelImage(level);
        await renderGrid(screen);
        await renderTrend(screen);
        await renderCalendar(screen);
        await renderStats(screen);
        await renderEncourage(screen);
    }

    // ================================================================
    // EVENT HANDLING (setelah mount)
    // ================================================================
    form.onSetup = async (screen) => {
        // Pilihan skala → ganti foto anak + header
        cbLevel.onChange = async (idx: number) => {
            level = clampState(idx);
            await applyLevelHeader(level, screen);
            await showLevelImage(level);
            await writeStatus(screen, "left", "Level " + level + " — " + STATE_LABELS[level]);
        };
        // Form sudah di-mount → bindEventHandler TComboBox aktif di sini.
        await refreshAll(screen);
        await writeStatus(screen, "left", "📄 " + DATA_FILE + "   ·   pilih skala 0-3 untuk melihat foto");
    };

    // Submit — append + simpan JSON
    btnSubmit.onClick = async () => {
        const state = clampState(cbLevel.selectedIndex);
        const ctx = (edContext.text || "").trim() || "Koding santai / Refactoring biasa";
        const ts = Date.now();

        entries.push({ state, context: ctx, time: fmtTime(ts), ts });
        const ok = await saveEntries(entries);

        // Reset input
        edContext.text = "";
        if (form.screen) await form.screen.update("ed-context", { value: "" });

        await renderGrid(form.screen);
        await renderTrend(form.screen);
        await renderCalendar(form.screen);
        await renderStats(form.screen);
        await renderEncourage(form.screen);

        await writeStatus(form.screen, "left", ok ? "✅ Tersimpan → " + DATA_FILE : "❌ Gagal menulis " + DATA_FILE);
        if (state === 3) {
            await writeStatus(form.screen, "right", "Jebol tercatat — besok mulai lagi dari 0 💪");
        }
    };

    // Muat ulang data + gambar (mis. setelah menaruh foto baru)
    btnReload.onClick = async () => {
        entries = await loadEntries();
        await refreshAll(form.screen);
        await writeStatus(form.screen, "left", "🔄 Dimuat ulang dari " + DATA_FILE);
    };

    // Bersihkan data
    btnClear.onClick = async () => {
        const ans = await form.confirm(
            "🗑 Bersihkan Data",
            "Hapus SEMUA log craving tracker? Tindakan ini tidak bisa dibatalkan.",
            ["Hapus", "Batal"],
        );
        if (ans !== "Hapus") return;
        entries = [];
        const ok = await saveEntries(entries);
        await refreshAll(form.screen);
        await writeStatus(
            form.screen,
            "left",
            ok ? "🗑 Data dibersihkan → " + DATA_FILE : "❌ Gagal menulis " + DATA_FILE,
        );
    };

    // ================================================================
    // RUN
    // ================================================================
    // Foto awal: pilihan default combo = level 0, jadi level0.png dimuat SEKARANG
    // (sebelum mount) — tampilan pertama langsung fotonya, bukan placeholder.
    applyLevelImage(0, await loadLevelImage(0));

    // Kata penyemangat juga diisi SEBELUM mount supaya ikut di payload MOUNT_NODE
    // pertama (tidak bergantung pada update setelah mount).
    await renderEncourage();

    await form.run();
});
