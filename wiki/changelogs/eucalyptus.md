# Changelog Eucalyptus (Text Editor)

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-30

### TS syntax & type check — live (tiap ketikan) + tombol "Check TS"

- **File:** `src/mirror/opt/eucalyptus/eucalyptus.ts`, `src/mirror/opt/dome/dome.ts`, `src/mirror/opt/dome/dome-client-codemirror.js`, `src/mirror/opt/dome/dome-client-dom.js`, `src/mirror/opt/dome/dome-client.html`
- **Perubahan:**
  - **Cek ringan (tiap ketikan, debounce ~350ms):** `esbuild.transformSync` → error sintaks pertama → status bar (`⚠️ L12: ...`) + marker di gutter CodeMirror (`✖`). Bersih → `✅ Syntax OK`. Hanya untuk file `.ts/.tsx/.js/.jsx/.mjs/.cjs`.
  - **Tombol "🔍 Check TS" (toolbar):** **syntax + type check** via `ts.createProgram` (bukan cuma `transpileModule`) — jadi menangkap error tipe seperti `let a: string = 123;` ("Type 'number' is not assignable to type 'string'"). Lazy-load `require("typescript")` (berat, hanya saat diklik). Laporan: count error/warning di status bar + dialog daftar error + marker di semua baris.
  - **Tolerant host:** file yang dicek = buffer editor (file virtual via `CompilerHost` override); import eksternal (`@tsix/*`, dll) di-skip (`noResolve: true` → dianggap `any`, tanpa noise "cannot find module"); globals umum (console/require/process/Buffer/dll) di-stub jadi `any`; `skipLibCheck`, `noEmit`.
  - **Marker CodeMirror:** pesan DOME baru `CM_SET_DIAGNOSTICS` → gutter `euc-lint` (`✖` error / `⚠` warning) + background baris error + tooltip pesan.
  - **Fallback:** kalau `typescript` tidak tersedia → tombol pakai esbuild (syntax, error pertama).
- **Dampak:** `let a: string = 123;` kini ditandai oleh tombol Check TS (bukan cuma saat live-check — live-check tetap level sintaks agar ringan per ketikan).
- **Deploy:** `npm run vfs:bootstrap` → restart daemon DOME (atau reboot TSIX) → hard-refresh browser (Cmd+Shift+R).
- **Oleh:** Copilot

## 2026-08-30

### Font JetBrains Mono + enrichment CodeMirror (folding, comment toggle, brackets)

- **File:** `src/mirror/opt/dome/dome-client.html`, `src/mirror/opt/dome/dome-client-dom.js`
- **Perubahan:**
  - **Font editor = JetBrains Mono** — webfont Google Fonts + CSS `.CodeMirror` (`!important` karena rule di `<style>` atas kalah cascade oleh `codemirror.min.css` yang di-load setelahnya).
  - **Comment toggle** — `Ctrl+/` & `Cmd+/`. Catatan: addon `comment.js` **tidak me-register shortcut sendiri** (source berakhir di definisi `uncomment`, tanpa baris keymap) → binding dibuat eksplisit di `extraKeys`.
  - **Code folding** — gutter ikon lipat (klik ▸/▾), `Ctrl+Q` toggle scope, `Ctrl+Shift+[` / `Ctrl+Shift+]` fold/unfold semua. Helper: brace-fold (fungsi/blok JS), comment-fold, indent-fold.
  - **Match brackets** — pasangan kurung tersorot saat cursor di dekatnya (`matchBrackets`).
  - **Auto-close brackets** — `( ) [ ] { } " ' \`` auto tertutup (`autoCloseBrackets`).
  - **Highlight selection matches** — kata yang sama dengan seleksi ikut tersorot (`match-highlighter`).
  - **Active line** — garis aktif disorot (`active-line`).
- **Dampak:** Editor Eucalyptus lebih nyaman & lengkap (ala editor modern). Addon di-load dari CDN cdnjs (perlu internet di klien).
- **Deploy:** `npm run vfs:bootstrap` → restart daemon DOME (atau reboot TSIX) → hard-refresh browser (Cmd+Shift+R).
- **Oleh:** Copilot

---

## 2026-08-08

### Fix race condition — indikator modified (●) langsung muncul saat buka file (macOS)

- **File:** `src/mirror/opt/eucalyptus/eucalyptus.ts`
- **Masalah:** Setiap kali membuka file, indikator "modified" (●) langsung muncul padahal belum ada perubahan — hanya terjadi di macOS (MacBook Air 2017), sedangkan Ubuntu/Windows aman. Penyebab: mekanisme flag sekali-pakai `_suppressNextChange` (menebak "event `cm_change` berikutnya pasti echo dari `cmSetValue`") tidak bisa diandalkan. Di mesin lambat / engine browser berbeda (WebKit vs Chromium), event CodeMirror datang dobel, terlambat, atau urutannya bergeser sehingga satu `cm_change` mendarat saat flag sudah `false` → `modified = true`.
- **Perubahan:**
  - Hapus `_suppressNextChange` (flag sekali-pakai yang rawan race).
  - Ganti dengan perbandingan baseline: setiap `cm_change` mengadopsi nilai aktual editor lalu menghitung ulang `modified` dengan membandingkan ke `savedContent` (isi bersih saat dibuka/disimpan). Echo dari `cmSetValue` otomatis dianggap bersih; perubahan user terdeteksi. Self-correcting meski ada event nyasar.
  - `savedContent` di-update di `openFile`, `saveFile`, `saveFileAs`, dan `closeFile`.
  - Normalisasi line ending (`\r\n`/`\r` → `\n`) saat membandingkan → file CRLF tidak salah ditandai dirty.
  - Bonus: undo sampai isi sama dengan di disk otomatis membersihkan status dirty.
- **Dampak:** Indikator modified hanya muncul saat ada perubahan nyata; deterministik dan bebas race di semua platform.
- **Oleh:** Copilot
