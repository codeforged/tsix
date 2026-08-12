/**
 * BUILD COURSE PDF
 *
 * Menggabungkan semua modul `wiki/course/` menjadi satu PDF
 * (cover + daftar isi + 25 modul), menggunakan `marked` untuk markdown->HTML
 * dan headless Google Chrome untuk HTML->PDF.
 *
 * Cara pakai:
 *   node scripts/build-course-pdf.mjs          -> versi Inggris (EN)
 *   node scripts/build-course-pdf.mjs id       -> versi Indonesia (ID)
 *
 * Output: docs/TSIX-Course-EN.pdf / docs/TSIX-Course-ID.pdf
 *         (+ file HTML sementara di sampingnya)
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { marked } from "marked";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COURSE_DIR = path.resolve(__dirname, "../wiki/course");
const OUT_DIR = path.resolve(__dirname, "../docs");
// Bahasa: "en" (default) atau "id" -> node scripts/build-course-pdf.mjs id
const LANG = (process.argv[2] || "en").toLowerCase() === "id" ? "id" : "en";
const SUFFIX = LANG === "en" ? "EN" : "ID";
const OUT_PDF = path.join(OUT_DIR, `TSIX-Course-${SUFFIX}.pdf`);
const TMP_HTML = path.join(OUT_DIR, `TSIX-Course-${SUFFIX}.html`);
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";

// Label cover/TOC per bahasa (nilai langsung disisipkan ke HTML)
const LOC = {
  en: {
    courseTitle: "TSIX Course",
    //edition: "English Edition — Antigonon leptopus",
    edition: "English Edition",
    tagline: "Kernel, VFS, Networking, GUI &amp; Desktop, Development",
    contents: "Contents",
    generated: "Generated",
    moduleLabel: "Module",
    credit: "System design &amp; architecture: Andriansah",
  },
  id: {
    courseTitle: "Kursus TSIX",
    //edition: "Edisi Indonesia — Antigonon leptopus",
    edition: "Edisi Indonesia",
    tagline: "Kernel, VFS, Jaringan, GUI &amp; Desktop, Pengembangan",
    contents: "Daftar Isi",
    generated: "Dibuat",
    moduleLabel: "Modul",
    credit: "System design &amp; architecture: Andriansah",
  },
}[LANG];

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseFrontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

// ── 1. Scan modul sesuai bahasa (urut nomor) ──
const isEn = LANG === "en";
const files = readdirSync(COURSE_DIR)
  .filter((f) =>
    isEn
      ? /^\d+-.*\.en\.md$/.test(f)
      : /^\d+-.*\.md$/.test(f) && !f.endsWith(".en.md"),
  )
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

if (files.length === 0) {
  console.error("Tidak ada file *.en.md di", COURSE_DIR);
  process.exit(1);
}

const modules = files.map((f) => {
  const src = readFileSync(path.join(COURSE_DIR, f), "utf8");
  const { meta, body } = parseFrontmatter(src);
  return {
    num: parseInt(f, 10),
    file: f,
    meta,
    body: marked.parse(body, { gfm: true }),
  };
});

// ── 2. Susun HTML ──
const tocItems = modules
  .map(
    (m) =>
      `<li><span class="toc-num">${String(m.num).padStart(2, "0")}</span>` +
      `<span class="toc-title">${escapeHtml(m.meta.title || m.file)}</span>` +
      (m.meta.partTitle ? `<span class="toc-part">${escapeHtml(m.meta.partTitle)}</span>` : "") +
      `</li>`,
  )
  .join("\n");

const moduleSections = modules
  .map(
    (m) => `
<section class="module">
  <div class="module-header">
    <span class="m-num">${LOC.moduleLabel} ${String(m.num).padStart(2, "0")}</span>
    <span class="m-title">${escapeHtml(m.meta.title || m.file)}</span>
    ${m.meta.partTitle ? `<span class="m-part">${escapeHtml(m.meta.partTitle)}</span>` : ""}
  </div>
  <div class="module-body">${m.body}</div>
</section>`,
  )
  .join("\n");

const today = new Date().toISOString().slice(0, 10);
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>TSIX Course — English Edition</title>
<style>
  @page { size: A4; margin: 18mm 16mm 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: "DejaVu Sans", "Segoe UI", Arial, sans-serif; font-size: 10.5pt; line-height: 1.55; color: #1a1a1a; margin: 0; }
  code, pre, kbd { font-family: "DejaVu Sans Mono", Consolas, monospace; }
  code { background: #f3f4f6; padding: 0 3px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #0f172a; color: #e2e8f0; padding: 12px 14px; border-radius: 8px; overflow-wrap: break-word; white-space: pre-wrap; font-size: 8.5pt; line-height: 1.45; }
  pre code { background: none; color: inherit; padding: 0; }
  h1, h2, h3, h4 { color: #0f172a; line-height: 1.25; }
  h1 { font-size: 20pt; border-bottom: 3px solid #2563eb; padding-bottom: 6px; }
  h2 { font-size: 15pt; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin-top: 22px; }
  h3 { font-size: 12.5pt; margin-top: 18px; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 9pt; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #eef2ff; }
  blockquote { border-left: 4px solid #94a3b8; margin: 8px 0; padding: 4px 12px; color: #475569; background: #f8fafc; }
  a { color: #2563eb; text-decoration: none; }
  hr { border: none; border-top: 1px solid #cbd5e1; margin: 18px 0; }

  /* Cover */
  .cover { text-align: center; page-break-after: always; padding-top: 30mm; }
  .cover h1 { border: none; font-size: 34pt; margin: 0 0 6px; }
  .cover .sub { font-size: 14pt; color: #64748b; margin-bottom: 30mm; }
  .cover .box { display: inline-block; border: 1px solid #cbd5e1; border-radius: 10px; padding: 20px 34px; background: #f8fafc; }
  .cover .meta { font-size: 10pt; color: #475569; margin-top: 30mm; line-height: 1.9; }

  /* TOC */
  .toc { page-break-after: always; }
  .toc ul { list-style: none; padding: 0; }
  .toc li { padding: 3px 0; border-bottom: 1px dotted #cbd5e1; }
  .toc-num { display: inline-block; width: 30px; font-weight: bold; color: #2563eb; }
  .toc-part { float: right; color: #94a3b8; font-size: 8.5pt; }

  /* Modules */
  .module { page-break-before: always; }
  .module:first-of-type { page-break-before: auto; }
  .module-header { border: 1px solid #cbd5e1; border-left: 5px solid #2563eb; background: #f8fafc; padding: 8px 12px; margin-bottom: 12px; border-radius: 6px; }
  .m-num { font-weight: bold; color: #2563eb; margin-right: 10px; }
  .m-title { font-size: 14pt; font-weight: bold; }
  .m-part { float: right; color: #94a3b8; font-size: 9pt; margin-top: 3px; }
  .module-body h1 { display: none; } /* title sudah di header */
  .module-body h2:first-of-type { margin-top: 4px; }
</style>
</head>
<body>

<div class="cover">
  <h1>${LOC.courseTitle}</h1>
  <div class="sub">${LOC.edition}</div>
  <div class="box">
    <b>${modules.length} ${LOC.moduleLabel.toLowerCase()}</b><br>
    ${LOC.tagline}
  </div>
  <div class="meta">
    ${LOC.credit}<br>
    ${LOC.generated}: ${today}<br>
    Platform: TSIX (educational OS-like runtime on Node.js/TypeScript)
  </div>
</div>

<div class="toc">
  <h2>${LOC.contents}</h2>
  <ul>
${tocItems}
  </ul>
</div>

${moduleSections}

</body>
</html>
`;

// ── 3. Tulis HTML sementara ──
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(TMP_HTML, html, "utf8");
console.log("HTML sementara: " + TMP_HTML);

// ── 4. Headless Chrome -> PDF ──
const flags = [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--no-pdf-header-footer",
  `--print-to-pdf=${OUT_PDF}`,
  `file://${TMP_HTML}`,
];
try {
  execFileSync(CHROME, flags, { stdio: "inherit" });
  console.log("PDF berhasil dibuat: " + OUT_PDF);
} catch (e) {
  console.error("Gagal menjalankan Chrome:", e.message);
  process.exit(1);
}
