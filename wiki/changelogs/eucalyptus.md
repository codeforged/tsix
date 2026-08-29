# Changelog Eucalyptus (Text Editor)

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

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
