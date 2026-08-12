#!/usr/bin/env node
/**
 * course-server.ts — Serve TSIX Course docs as HTML pages
 *
 * Khusus untuk dokumen kurikulum di wiki/course/ (seragam & i18n-ready).
 * Berbeda dari wiki-server.js yang melayani seluruh wiki (campur aduk).
 *
 * Usage:
 *   npm run course:serve                        # http://localhost:3100
 *   npm run course:serve -- 8080                # custom port
 *   node -r esbuild-register wiki/course/course-server.ts 3200
 *
 * Fitur:
 * - Render markdown → HTML (self-contained, tanpa dependency eksternal → mudah dibrowserfiy)
 * - Frontmatter parser (module, title, status, part, lang) — seragam per dokumen
 * - Sidebar navigasi dibangun dari frontmatter & nama file (NN-nama.md), dikelompokkan per Part
 * - Status badge (✅ done / 🔶 partial / ⬜ todo) dari frontmatter
 * - Callout: > [!NOTE] > [!TIP] > [!WARNING] > [!IMPORTANT] > [!DANGER]
 * - Checklist: - [ ] / - [x]
 * - i18n-ready: UI strings (LOC dict), query `?lang=en`, file terjemahan `NN-nama.en.md`
 * - Anti path traversal
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";

const PORT = parseInt(process.argv[2] || "3100");
const COURSE_DIR = path.resolve(__dirname);

// ────────────────────────────────────────────────────────────────
// i18n — kamus UI. Tambah bahasa baru = tambah kunci di sini.
// Terjemahan dokumen: buat file `NN-nama.en.md` (fallback ke `id`).
// ────────────────────────────────────────────────────────────────
type Lang = "id" | "en";
const LOC: Record<Lang, Record<string, string>> = {
  id: {
    siteTitle: "TSIX Course",
    tagline: "Kurikulum TSIX — Kernel → Desktop",
    toc: "Daftar Isi",
    modules: "Modul",
    status: "Status",
    statusDone: "Selesai",
    statusPartial: "Sebagian",
    statusTodo: "Belum",
    partLabel: "Bagian",
    home: "Beranda",
    roadmap: "Roadmap",
    prev: "← Sebelumnya",
    next: "Berikutnya →",
    footer: "TSIX Course — dibangun dari Markdown seragam, siap diterjemahkan.",
    notFound: "Halaman tidak ditemukan",
    backHome: "Kembali ke Roadmap",
    language: "Bahasa",
  },
  en: {
    siteTitle: "TSIX Course",
    tagline: "TSIX Curriculum — Kernel → Desktop",
    toc: "Table of Contents",
    modules: "Modules",
    status: "Status",
    statusDone: "Done",
    statusPartial: "Partial",
    statusTodo: "Planned",
    partLabel: "Part",
    home: "Home",
    roadmap: "Roadmap",
    prev: "← Previous",
    next: "Next →",
    footer: "TSIX Course — built from uniform Markdown, translation-ready.",
    notFound: "Page not found",
    backHome: "Back to Roadmap",
    language: "Language",
  },
};

// ─── Frontmatter & metadata dokumen ───
interface DocMeta {
  module: string;        // "01", "02", ...
  title: string;
  part?: string;         // "I", "II", ... untuk grup sidebar
  partTitle?: string;
  status?: "done" | "partial" | "todo";
  lang?: Lang;
  rfc?: string;
  audience?: string;
}

function parseFrontmatter(md: string): { meta: Partial<DocMeta>; body: string } {
  const meta: Partial<DocMeta> = {};
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return { meta, body: md };

  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    (meta as any)[key] = val;
  }
  return { meta, body: md.slice(match[0].length) };
}

const STATUS_BADGE: Record<string, { icon: string; label: string }> = {
  done: { icon: "✅", label: "done" },
  partial: { icon: "🔶", label: "partial" },
  todo: { icon: "⬜", label: "todo" },
};

// ─── Escaping & inline renderer ───
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(text: string): string {
  let r = escapeHtml(text);
  r = r.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="c-img">');
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, url) =>
    `<a href="${url}" target="${url.startsWith("http") ? "_blank" : ""}" class="c-link">${t}</a>`);
  r = r.replace(/`([^`]+)`/g, '<code class="c-code">$1</code>');
  r = r.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  r = r.replace(/__(.+?)__/g, "<strong>$1</strong>");
  r = r.replace(/\*(.+?)\*/g, "<em>$1</em>");
  r = r.replace(/_(.+?)_/g, "<em>$1</em>");
  r = r.replace(/~~(.+?)~~/g, "<del>$1</del>");
  return r;
}

// ─── Markdown → HTML (seragam, subset cukup untuk format dokumen) ───
function mdToHtml(md: string): string {
  const { body } = parseFrontmatter(md);
  let html = "";
  const lines = body.split("\n");
  let inCode = false, codeBuf: string[] = [], codeLang = "";
  let inTable = false;
  let listStack: ("ul" | "ol")[] = [];

  // Tutup semua list yang masih terbuka (dipanggil sebelum konten non-list)
  const closeLists = () => {
    while (listStack.length) html += `</${listStack.pop()}>\n`;
  };

  const CALL_OUTS: Record<string, string> = {
    note: "💡 NOTE",
    tip: "🛠️ TIP",
    warning: "⚠️ WARNING",
    important: "⭐ IMPORTANT",
    danger: "🚨 DANGER",
  };

  for (const line of lines) {
    const t = line.trim();

    if (t.startsWith("```")) {
      if (inCode) {
        closeLists();
        html += `<pre class="c-pre"><code class="language-${codeLang}">${escapeHtml(codeBuf.join("\n"))}</code></pre>\n`;
        codeBuf = []; codeLang = ""; inCode = false;
      } else { inCode = true; codeLang = t.slice(3).trim(); }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    if (!t) {
      if (inTable) { html += "</tbody></table>\n"; inTable = false; }
      closeLists();
      continue;
    }

    // Table
    if (t.startsWith("|") && t.endsWith("|")) {
      closeLists();
      const cells = t.split("|").filter(c => c.trim());
      if (cells.some(c => /^:?-{2,}:?$/.test(c.trim()))) continue;
      if (!inTable) html += '<table class="c-table"><thead><tr>';
      else html += "<tr>";
      for (const c of cells) html += `<${inTable ? "td" : "th"}>${renderInline(c.trim())}</${inTable ? "td" : "th"}>`;
      html += "</tr>\n";
      if (!inTable) { html += "</thead><tbody>\n"; inTable = true; }
      continue;
    }

    // Headings
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      const level = h[1].length;
      const anchor = h[2].toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
      html += `<h${level} id="${anchor}">${renderInline(h[2])}</h${level}>\n`;
      continue;
    }

    // HR
    if (/^[-*_]{3,}$/.test(t)) { closeLists(); html += "<hr>\n"; continue; }

    // Callout blockquote
    const callout = t.match(/^>\s*\[!(\w+)\]\s*(.*)$/);
    if (callout) {
      closeLists();
      const kind = callout[1].toLowerCase();
      const label = CALL_OUTS[kind] || callout[1];
      const emoji = CALL_OUTS[kind] ? CALL_OUTS[kind].split(" ")[0] : "💬";
      html += `<div class="c-callout c-callout-${kind}"><div class="c-callout-title">${emoji} ${escapeHtml(label)}</div><div class="c-callout-body">${renderInline(callout[2])}</div></div>\n`;
      continue;
    }
    if (t.startsWith(">")) {
      // blockquote multi-line
      if (/^>\s*$/.test(t)) { continue; }
      closeLists();
      html += `<p class="c-bq">${renderInline(t.slice(1).trim())}</p>\n`;
      continue;
    }

    // Checklist — bukan list, tapi item terpisah
    const chk = t.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (chk) {
      closeLists();
      const checked = chk[1] !== " " && chk[1] !== "";
      html += `<div class="c-check ${checked ? "checked" : ""}">${checked ? "☑" : "☐"} ${renderInline(chk[2])}</div>\n`;
      continue;
    }

    // List — stateful: hanya buka satu <ul>/<ol> per blok
    if (/^[-*+]\s/.test(t) || /^\d+\.\s/.test(t)) {
      const ordered = /^\d+\.\s/.test(t);
      const content = t.replace(/^[-*+]\s/, "").replace(/^\d+\.\s/, "");
      const tag = ordered ? "ol" : "ul";
      const top = listStack[listStack.length - 1];
      if (top === undefined) {
        html += `<${tag} class="c-list">\n`;
        listStack.push(tag);
      } else if (top !== tag) {
        html += `</${listStack.pop()}>\n`;
        html += `<${tag} class="c-list">\n`;
        listStack.push(tag);
      }
      html += `<li>${renderInline(content)}</li>\n`;
      continue;
    }

    // Paragraph
    closeLists();
    html += `<p>${renderInline(t)}</p>\n`;
  }

  // Tutup sisa yang belum ditutup
  if (inCode) html += `<pre class="c-pre"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>\n`;
  if (inTable) html += "</tbody></table>\n";
  closeLists();

  return html;
}

// ─── Scan modul untuk sidebar ───
interface ModuleItem {
  num: number;
  file: string;
  title: string;
  part?: string;
  status?: string;
}

function scanModules(lang: Lang): ModuleItem[] {
  const all: ModuleItem[] = [];
  for (const f of fs.readdirSync(COURSE_DIR)) {
    if (!f.endsWith(".md")) continue;
    if (f === "toc.md" || f === "toc.en.md" || f === "format.md" || f === "format.en.md" || f === "README.md") continue;
    const numMatch = f.match(/^(\d+)-/);
    if (!numMatch) continue;
    const raw = fs.readFileSync(path.join(COURSE_DIR, f), "utf-8");
    const { meta } = parseFrontmatter(raw);
    all.push({
      num: parseInt(numMatch[1]),
      file: f,
      title: meta.title || f.replace(/^\d+-/, "").replace(/\.en\.md$|\.md$/, "").replace(/-/g, " "),
      part: meta.part,
      status: meta.status,
    });
  }
  // Satu entri per modul, sesuai bahasa aktif (lang=en → prefer *.en.md)
  const byNum = new Map<number, ModuleItem>();
  for (const m of all) {
    const mEn = m.file.endsWith(".en.md");
    const cur = byNum.get(m.num);
    if (!cur) { byNum.set(m.num, m); continue; }
    const curEn = cur.file.endsWith(".en.md");
    if (lang === "en" && mEn && !curEn) byNum.set(m.num, m);
    else if (lang === "id" && !mEn && curEn) byNum.set(m.num, m);
  }
  return [...byNum.values()].sort((a, b) => a.num - b.num);
}

function resolveDocFile(baseName: string, lang: Lang): string | null {
  const en = path.join(COURSE_DIR, baseName.replace(/\.md$/, `.en.md`));
  const id = path.join(COURSE_DIR, baseName);
  if (lang === "en" && fs.existsSync(en)) return en;
  if (fs.existsSync(id)) return id;
  if (fs.existsSync(en)) return en;
  return null;
}

// ─── Sidebar navigation ───
function buildNav(current: string, lang: Lang, parts: string[]): string {
  const L = LOC[lang];
  const modules = scanModules(lang);
  const byPart = new Map<string, ModuleItem[]>();
  for (const m of modules) {
    const p = m.part || "?";
    if (!byPart.has(p)) byPart.set(p, []);
    byPart.get(p)!.push(m);
  }

  let html = `<nav class="c-sidebar"><div class="c-brand">📚 ${escapeHtml(L.siteTitle)}</div>`;
  html += `<div class="c-tagline">${escapeHtml(L.tagline)}</div>`;
  html += `<div class="c-lang"><span>🌐 ${escapeHtml(L.language)}:</span> `;
  for (const l of ["id", "en"] as Lang[]) {
    const active = l === lang ? ' class="on"' : "";
    html += `<a href="?lang=${l}"${active}>${l.toUpperCase()}</a> `;
  }
  html += `</div>`;

  // Links
  const tocFile = lang === "en" ? "toc.en.md" : "toc.md";
  html += `<ul class="c-nav"><li><a href="/${tocFile}?lang=${lang}">🗺️ ${escapeHtml(L.roadmap)}</a></li></ul>`;

  // Group per part
  for (const [p, mods] of byPart) {
    const partTitle = mods.find(m => m.part)?.part || "";
    html += `<div class="c-part">${escapeHtml(L.partLabel)} ${escapeHtml(p)}${partTitle ? " · " + escapeHtml(partTitle) : ""}</div><ul>`;
    for (const m of mods) {
      const badge = STATUS_BADGE[m.status || ""]?.icon || "";
      const cls = m.file === current ? ' class="active"' : "";
      html += `<li${cls}><a href="/${m.file}?lang=${lang}"><span class="c-num">${String(m.num).padStart(2, "0")}</span> ${escapeHtml(m.title)} <span class="c-badge">${badge}</span></a></li>`;
    }
    html += "</ul>";
  }

  html += `</nav>`;
  return html;
}

// ─── Build HTML page ───
function buildPage(fileName: string, mdContent: string, lang: Lang): string {
  const L = LOC[lang];
  const { meta } = parseFrontmatter(mdContent);
  const title = meta.title || fileName.replace(/\.md$/, "").replace(/-/g, " ");
  const body = mdToHtml(mdContent);
  const nav = buildNav(fileName, lang, []);

  // Prev/next navigation
  const modules = scanModules();
  const idx = modules.findIndex(m => m.file === fileName);
  let pager = "";
  if (idx >= 0) {
    const prev = modules[idx - 1], next = modules[idx + 1];
    pager = `<div class="c-pager">`;
    pager += prev ? `<a class="c-pager-prev" href="/${prev.file}?lang=${lang}">${escapeHtml(L.prev)}<br><strong>${String(prev.num).padStart(2, "0")} · ${escapeHtml(prev.title)}</strong></a>` : `<span></span>`;
    pager += next ? `<a class="c-pager-next" href="/${next.file}?lang=${lang}">${escapeHtml(L.next)}<br><strong>${String(next.num).padStart(2, "0")} · ${escapeHtml(next.title)}</strong></a>` : `<span></span>`;
    pager += `</div>`;
  }

  const statusBadge = meta.status ? `<span class="c-status c-status-${meta.status}">${STATUS_BADGE[meta.status].icon} ${escapeHtml(L["status" + (meta.status === "done" ? "Done" : meta.status === "partial" ? "Partial" : "Todo")])}</span>` : "";

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — ${escapeHtml(L.siteTitle)}</title>
<style>
:root{--bg:#0f172a;--surface:#1e293b;--surface2:#334155;--accent:#4caf50;--accent2:#2196f3;--text:#e2e8f0;--dim:#94a3b8;--border:#334155;--warn:#f59e0b;--danger:#ef4444}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);display:flex;line-height:1.75}
.c-sidebar{width:280px;min-width:280px;background:var(--surface);border-right:1px solid var(--border);padding:18px 0;height:100vh;position:sticky;top:0;overflow-y:auto}
.c-brand{font-size:16px;font-weight:700;color:var(--accent);padding:0 18px 4px}
.c-tagline{font-size:11px;color:var(--dim);padding:0 18px 10px;border-bottom:1px solid var(--border)}
.c-lang{font-size:12px;color:var(--dim);padding:8px 18px;border-bottom:1px solid var(--border)}
.c-lang a{color:var(--dim);text-decoration:none;margin-right:6px}
.c-lang a.on{color:var(--accent);font-weight:700}
.c-nav{padding:8px 0;border-bottom:1px solid var(--border)}
.c-nav a{display:block;padding:6px 18px;font-size:13px;color:var(--text);text-decoration:none}
.c-nav a:hover{background:rgba(76,175,80,.08)}
.c-part{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--accent2);padding:12px 18px 4px}
.c-sidebar ul{list-style:none;padding:0}
.c-sidebar li a{display:flex;align-items:center;gap:6px;padding:5px 18px;font-size:13px;color:var(--dim);text-decoration:none;border-left:3px solid transparent}
.c-sidebar li a:hover{color:var(--text);background:rgba(76,175,80,.06)}
.c-sidebar li.active a{color:var(--accent);background:rgba(76,175,80,.12);border-left-color:var(--accent);font-weight:600}
.c-num{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--dim)}
.c-badge{font-size:11px;margin-left:auto}
.c-content{flex:1;padding:40px 52px;max-width:980px;overflow-y:auto;height:100vh}
.c-content h1{color:var(--accent);font-size:30px;margin:0 0 8px}
.c-content h2{color:var(--accent);font-size:22px;margin:32px 0 12px;border-bottom:1px solid var(--border);padding-bottom:6px}
.c-content h3{font-size:18px;margin:22px 0 8px;color:var(--text)}
.c-content h4{font-size:15px;margin:16px 0 6px}
.c-content p{margin:8px 0;font-size:14.5px}
.c-content a{color:#81c784;text-decoration:none}
.c-content a:hover{text-decoration:underline}
.c-code{background:var(--surface2);padding:2px 6px;border-radius:3px;font-family:'JetBrains Mono','Fira Code',monospace;font-size:13px}
.c-pre{background:#0a0f1e;padding:16px;border-radius:8px;overflow-x:auto;margin:12px 0;border:1px solid var(--border)}
.c-pre code{background:none;padding:0;font-size:13px;line-height:1.6}
.c-table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13.5px}
.c-table th,.c-table td{border:1px solid var(--border);padding:8px 12px;text-align:left}
.c-table th{background:var(--surface2);color:var(--accent)}
.c-table td{background:var(--surface)}
.c-table tr:nth-child(even) td{background:#16233b}
.c-callout{border-left:3px solid var(--accent);border-radius:0 6px 6px 0;margin:12px 0;overflow:hidden}
.c-callout-title{font-weight:700;font-size:13px;padding:8px 14px;background:rgba(76,175,80,.15);color:var(--accent)}
.c-callout-body{padding:10px 14px;background:rgba(76,175,80,.06);font-size:13.5px}
.c-callout-warning{border-left-color:var(--warn)}
.c-callout-warning .c-callout-title{background:rgba(245,158,11,.15);color:var(--warn)}
.c-callout-warning .c-callout-body{background:rgba(245,158,11,.06)}
.c-callout-danger{border-left-color:var(--danger)}
.c-callout-danger .c-callout-title{background:rgba(239,68,68,.15);color:var(--danger)}
.c-callout-danger .c-callout-body{background:rgba(239,68,68,.06)}
.c-callout-tip{border-left-color:var(--accent2)}
.c-callout-tip .c-callout-title{background:rgba(33,150,243,.15);color:var(--accent2)}
.c-callout-tip .c-callout-body{background:rgba(33,150,243,.06)}
.c-bq{border-left:2px solid var(--dim);padding:4px 12px;margin:8px 0;color:var(--dim);font-style:italic}
.c-list{margin:8px 0 8px 22px}
.c-check{padding:2px 0;font-size:14px}
.c-check.checked{color:var(--accent)}
.c-status{display:inline-block;font-size:12px;padding:2px 10px;border-radius:20px;margin-left:8px;vertical-align:middle;background:var(--surface2)}
.c-status-done{color:#4caf50}
.c-status-partial{color:#f59e0b}
.c-status-todo{color:#94a3b8}
.c-img{max-width:100%;border-radius:6px;margin:8px 0}
.c-pager{display:flex;justify-content:space-between;gap:16px;margin-top:48px;padding-top:16px;border-top:1px solid var(--border)}
.c-pager a{text-decoration:none;font-size:13px;color:var(--dim)}
.c-pager a strong{color:var(--accent)}
.c-pager-next{text-align:right}
footer{margin-top:16px;font-size:11.5px;color:var(--dim);text-align:center}
@media(max-width:768px){body{flex-direction:column}.c-sidebar{width:100%;min-width:auto;height:auto;position:static}.c-content{padding:24px 16px}}
</style>
</head>
<body>
${nav}
<main class="c-content">
<h1>${escapeHtml(title)} ${statusBadge}</h1>
${body}
${pager}
<footer>${escapeHtml(L.footer)}</footer>
</main>
</body>
</html>`;
}

// ─── HTTP Server ───
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const lang: Lang = url.searchParams.get("lang") === "en" ? "en" : "id";
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/" || pathname === "/index.html") pathname = lang === "en" ? "/toc.en.md" : "/toc.md";

  if (pathname.endsWith(".md")) {
    const safe = path.normalize(pathname).replace(/^[/\\]+/, "");
    const filePath = path.join(COURSE_DIR, safe);
    if (!filePath.startsWith(COURSE_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }

    const base = path.basename(safe);
    const resolved = resolveDocFile(base, lang);
    if (!resolved) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buildPage("404", `# 404 — ${LOC[lang].notFound}\n\n[⬅️ ${LOC[lang].backHome}](/?lang=${lang})`, lang));
      return;
    }
    fs.readFile(resolved, "utf-8", (err, content) => {
      if (err) { res.writeHead(500); res.end("Internal Server Error"); return; }
      const html = buildPage(path.basename(resolved), content, lang);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    return;
  }

  // static dari root repo (gambar diagram dll)
  const rootDir = path.resolve(__dirname, "..", "..");
  const filePath = path.join(rootDir, pathname);
  if (filePath.startsWith(rootDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(302, { Location: "/?lang=" + lang });
  res.end();
});

server.listen(PORT, () => {
  console.log("");
  console.log("  📚 TSIX Course Server");
  console.log("  ─────────────────────");
  console.log(`  ➜ http://localhost:${PORT}            (Roadmap / ToC)`);
  console.log(`  ➜ http://localhost:${PORT}/00-overview.md`);
  console.log(`  ➜ http://localhost:${PORT}/00-overview.md?lang=en`);
  console.log("");
  console.log("  ⚡ Press Ctrl+C to stop");
  console.log("");
});
