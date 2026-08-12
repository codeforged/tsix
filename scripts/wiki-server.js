#!/usr/bin/env node
/**
 * wiki-server.js — Serve TSIX Wiki as HTML pages
 *
 * Usage:
 *   node scripts/wiki-server.js          # http://localhost:3000
 *   node scripts/wiki-server.js 8080     # Custom port
 *
 * Fitur:
 * - Render .md ke HTML (simple markdown-to-HTML)
 * - Navigasi sidebar seperti Wikipedia
 * - Auto-link antar wiki files
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.argv[2] || "3000");
const WIKI_DIR = path.resolve(__dirname, "..", "wiki");

// ─── Simple Markdown → HTML renderer ───
function mdToHtml(md, filename) {
    let html = "";
    const lines = md.split("\n");
    let inCodeBlock = false;
    let codeBuf = [];
    let codeLang = "";
    let inTable = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Code block
        if (trimmed.startsWith("```")) {
            if (inCodeBlock) {
                html += `<pre><code class="language-${codeLang}">${escapeHtml(codeBuf.join("\n"))}</code></pre>\n`;
                codeBuf = [];
                codeLang = "";
                inCodeBlock = false;
            } else {
                inCodeBlock = true;
                codeLang = trimmed.slice(3).trim();
            }
            continue;
        }
        if (inCodeBlock) {
            codeBuf.push(line);
            continue;
        }

        // Empty line
        if (!trimmed) {
            if (inTable) { html += "</tbody></table>\n"; inTable = false; }
            html += "\n";
            continue;
        }

        // Table
        if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
            const cells = trimmed.split("|").filter(c => c.trim());
            if (cells.some(c => c.trim() === "---" || c.trim() === ":---" || c.trim() === "---:" || c.trim() === ":---:")) continue; // skip header separator
            if (!inTable) { html += '<table class="wiki-table"><thead><tr>'; } else { html += "<tr>"; }
            for (const cell of cells) {
                const tag = inTable ? "td" : "th";
                html += `<${tag}>${renderInline(cell.trim())}</${tag}>`;
            }
            html += "</tr>\n";
            if (!inTable) { html += "</thead><tbody>\n"; inTable = true; }
            continue;
        }

        // Headings
        if (trimmed.startsWith("######")) { html += `<h6>${renderInline(trimmed.slice(6))}</h6>\n`; continue; }
        if (trimmed.startsWith("#####")) { html += `<h5>${renderInline(trimmed.slice(5))}</h5>\n`; continue; }
        if (trimmed.startsWith("####")) { html += `<h4>${renderInline(trimmed.slice(4))}</h4>\n`; continue; }
        if (trimmed.startsWith("###")) { html += `<h3>${renderInline(trimmed.slice(3))}</h3>\n`; continue; }
        if (trimmed.startsWith("##")) { html += `<h2>${renderInline(trimmed.slice(2))}</h2>\n`; continue; }
        if (trimmed.startsWith("#")) { html += `<h1>${renderInline(trimmed.slice(1))}</h1>\n`; continue; }

        // Horizontal rule
        if (/^[-*_]{3,}$/.test(trimmed)) { html += "<hr>\n"; continue; }

        // List item
        if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
            html += `<li>${renderInline(trimmed.replace(/^[-*+]\s/, "").replace(/^\d+\.\s/, ""))}</li>\n`;
            continue;
        }

        // Blockquote
        if (trimmed.startsWith(">")) {
            html += `<blockquote>${renderInline(trimmed.slice(1).trim())}</blockquote>\n`;
            continue;
        }

        // Image
        const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (imgMatch) {
            html += `<img src="${relativePath(imgMatch[2], filename)}" alt="${escapeHtml(imgMatch[1])}" class="wiki-img">\n`;
            continue;
        }

        // Regular paragraph
        html += `<p>${renderInline(trimmed)}</p>\n`;
    }

    if (inCodeBlock) {
        html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>\n`;
    }
    if (inTable) { html += "</tbody></table>\n"; }

    return html;
}

// ─── Inline renderer (bold, italic, code, links, images) ───
function renderInline(text) {
    let r = escapeHtml(text);

    // Image: ![alt](path)
    r = r.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="wiki-inline-img">');

    // Link: [text](path)
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
        const href = url.startsWith("http") ? url : url;
        return `<a href="${href}" target="${url.startsWith("http") ? '_blank' : ''}" class="wiki-link">${text}</a>`;
    });

    // Inline code: `code`
    r = r.replace(/`([^`]+)`/g, '<code class="wiki-inline-code">$1</code>');

    // Bold: **text** or __text__
    r = r.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    r = r.replace(/__(.+?)__/g, "<strong>$1</strong>");

    // Italic: *text* or _text_
    r = r.replace(/\*(.+?)\*/g, "<em>$1</em>");
    r = r.replace(/_(.+?)_/g, "<em>$1</em>");

    // Strikethrough: ~~text~~
    r = r.replace(/~~(.+?)~~/g, "<del>$1</del>");

    // Line break
    r = r.replace(/  \n/g, "<br>\n");

    return r;
}

function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function relativePath(href, currentFile) {
    if (href.startsWith("http") || href.startsWith("#")) return href;
    return `/${href}`;
}

// ─── Build sidebar navigation ───
function buildNav(currentFile) {
    const files = fs.readdirSync(WIKI_DIR)
        .filter(f => f.endsWith(".md"))
        .sort()
        .map(f => ({
            name: f.replace(".md", ""),
            file: f,
            label: f.replace(".md", "").replace(/-/g, " "),
            isCurrent: f === currentFile,
        }));

    let html = '<nav class="wiki-sidebar"><h3>📖 TSIX Wiki</h3><ul>';
    for (const item of files) {
        const cls = item.isCurrent ? ' class="active"' : "";
        html += `<li${cls}><a href="/${item.file}">${escapeHtml(item.label)}</a></li>`;
    }
    html += "</ul></nav>";
    return html;
}

// ─── Build HTML page ───
function buildPage(fileName, mdContent) {
    const title = fileName.replace(".md", "").replace(/-/g, " ");
    const contentHtml = mdToHtml(mdContent, fileName);
    const navHtml = buildNav(fileName);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)} — TSIX Wiki</title>
    <style>
        :root {
            --bg: #1a1a2e;
            --surface: #16213e;
            --surface2: #0f3460;
            --accent: #4caf50;
            --accent2: #2196f3;
            --text: #e0e0e0;
            --text-dim: #888;
            --text-link: #81c784;
            --border: #333;
            --shadow: 0 4px 16px rgba(0,0,0,0.3);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { height: 100%; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg);
            color: var(--text);
            display: flex;
            line-height: 1.7;
        }
        .wiki-sidebar {
            width: 260px;
            min-width: 260px;
            background: var(--surface);
            border-right: 1px solid var(--border);
            padding: 20px 0;
            overflow-y: auto;
            height: 100vh;
            position: sticky;
            top: 0;
        }
        .wiki-sidebar h3 {
            font-size: 14px;
            color: var(--accent);
            padding: 0 16px 12px;
            border-bottom: 1px solid var(--border);
            margin-bottom: 8px;
        }
        .wiki-sidebar ul { list-style: none; padding: 0; }
        .wiki-sidebar li { padding: 0; }
        .wiki-sidebar li a {
            display: block;
            padding: 6px 16px;
            font-size: 13px;
            color: var(--text-dim);
            text-decoration: none;
            transition: all 0.15s;
            border-left: 3px solid transparent;
        }
        .wiki-sidebar li a:hover {
            color: var(--text);
            background: rgba(76,175,80,0.08);
        }
        .wiki-sidebar li.active a,
        .wiki-sidebar li a.active {
            color: var(--accent);
            background: rgba(76,175,80,0.12);
            border-left-color: var(--accent);
            font-weight: 600;
        }
        .wiki-content {
            flex: 1;
            padding: 40px 48px;
            max-width: 960px;
            overflow-y: auto;
            height: 100vh;
        }
        .wiki-content h1 { color: var(--accent); font-size: 28px; margin: 0 0 16px; }
        .wiki-content h2 { color: var(--accent); font-size: 22px; margin: 28px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
        .wiki-content h3 { color: var(--text); font-size: 18px; margin: 20px 0 8px; }
        .wiki-content h4 { color: var(--text); font-size: 15px; margin: 16px 0 6px; }
        .wiki-content p { margin: 8px 0; font-size: 14px; }
        .wiki-content a { color: var(--text-link); text-decoration: none; }
        .wiki-content a:hover { text-decoration: underline; }
        .wiki-content code {
            background: var(--surface2);
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 13px;
            font-family: 'JetBrains Mono', 'Fira Code', monospace;
        }
        .wiki-content pre {
            background: #0a0a1a;
            padding: 16px;
            border-radius: 8px;
            overflow-x: auto;
            margin: 12px 0;
            border: 1px solid var(--border);
        }
        .wiki-content pre code {
            background: none;
            padding: 0;
            font-size: 13px;
            line-height: 1.5;
        }
        .wiki-content blockquote {
            border-left: 3px solid var(--accent);
            padding: 8px 16px;
            margin: 12px 0;
            background: rgba(76,175,80,0.05);
            border-radius: 0 4px 4px 0;
        }
        .wiki-content table {
            width: 100%;
            border-collapse: collapse;
            margin: 12px 0;
            font-size: 13px;
        }
        .wiki-content th, .wiki-content td {
            border: 1px solid var(--border);
            padding: 8px 12px;
            text-align: left;
        }
        .wiki-content th {
            background: var(--surface2);
            color: var(--accent);
            font-weight: 600;
        }
        .wiki-content td { background: var(--surface); }
        .wiki-content tr:nth-child(even) td { background: rgba(15,52,96,0.3); }
        .wiki-content hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
        .wiki-content img { max-width: 100%; border-radius: 6px; margin: 8px 0; }
        .wiki-content li { font-size: 14px; margin: 4px 0 4px 24px; }
        .wiki-content h1, .wiki-content h2 { margin-top: 0; }
        @media (max-width: 768px) {
            body { flex-direction: column; }
            .wiki-sidebar { width: 100%; min-width: auto; height: auto; position: static; }
            .wiki-content { padding: 24px 16px; }
        }
    </style>
</head>
<body>
    ${navHtml}
    <main class="wiki-content">
        ${contentHtml}
        <footer style="margin-top:48px;padding-top:16px;border-top:1px solid var(--border);font-size:12px;color:var(--text-dim);text-align:center">
            TSIX Wiki — Generated from Markdown
        </footer>
    </main>
</body>
</html>`;
}

// ─── HTTP Server ───
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);

    // Root → Home.md
    if (pathname === "/" || pathname === "/index.html") {
        pathname = "/Home.md";
    }

    // Serve wiki markdown files as HTML
    if (pathname.endsWith(".md")) {
        const safePath = path.normalize(pathname).replace(/^[/\\]+/, "");
        const filePath = path.join(WIKI_DIR, safePath);

        // Security: prevent path traversal
        if (!filePath.startsWith(WIKI_DIR)) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }

        fs.readFile(filePath, "utf-8", (err, content) => {
            if (err) {
                if (err.code === "ENOENT") {
                    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
                    res.end(buildPage("404", "# 404 — Page Not Found\n\nHalaman yang diminta tidak ditemukan.\n\n[⬅️ Kembali ke Home](/Home.md)"));
                } else {
                    res.writeHead(500);
                    res.end("Internal Server Error");
                }
                return;
            }
            const html = buildPage(pathname.split("/").pop() || "Home.md", content);
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
        });
        return;
    }

    // Serve static files from docs/
    const staticDirs = [
        path.resolve(__dirname, "..", ""),
        path.resolve(__dirname, ".."),
    ];
    for (const dir of staticDirs) {
        const filePath = path.join(dir, pathname);
        if (filePath.startsWith(dir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
            fs.createReadStream(filePath).pipe(res);
            return;
        }
    }

    // Redirect unknown paths to Home
    res.writeHead(302, { Location: "/" });
    res.end();
});

server.listen(PORT, () => {
    console.log(`\n  🌿 TSIX Wiki Server`);
    console.log(`  ───────────────────`);
    console.log(`  ➜ http://localhost:${PORT}`);
    console.log(`  ➜ http://localhost:${PORT}/Home.md`);
    console.log(`  ➜ http://localhost:${PORT}/Kernel-dan-Scheduler.md`);
    console.log(`\n  ⚡ Press Ctrl+C to stop\n`);
});
