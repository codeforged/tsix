# Changelog Craving Tracker

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-16

### Aplikasi baru: Craving Tracker (GUI Cashew) — log hasrat harian + foto anak per skala

- **File:** `src/mirror/opt/craving-tracker/craving-tracker.ts` (baru), `src/mirror/opt/craving-tracker/README.md` (baru), `src/mirror/opt/asteracea/menu/craving-tracker.menu` (baru)
- **Latar:** Port dari `docs/stop-smoking.html` (localStorage browser) ke TSIX-GUI. Data dipindah ke file JSON di VFS agar persisten & bisa dibaca app lain, bukan localStorage.
- **Fitur:**
  - **Log skala hasrat 0–3** (`TComboBox`) + `TEdit` konteks koding, `TButton` Submit/Muat Ulang. Entri di-append ke `/opt/craving-tracker/craving-logs.json` (`{app, version, updatedAt, total, entries:[{state, context, time, ts}]}`).
  - **Foto per skala** — `level0..level3` di `/opt/craving-tracker/` (`.jpg/.jpeg/.png/.webp/.gif` atau sidecar `.b64`). Kandidat dicek berurutan dan **divalidasi magic bytes** (bukan ekstensi). Foto level 0 dimuat **sebelum mount** supaya tampilan pertama sudah benar.
  - **Matriks Per-Entri** — satu sel per entri, warna = state, klik sel → detail di status bar.
  - **Craving Activity** — contribution graph ala github.com: satu sel = satu hari, **6 bulan terakhir** (`WINDOW_DAYS = 182`), label bulan di kolom yang memuat tanggal 1, label hari Sen/Rab/Jum, legenda palet, sel hari ini di-outline.
  - **Tren Hasrat (maju/stagnan)** — bandingkan paruh pertama vs paruh kedua jendela: `avg` state maksimum per hari **yang ber-log**, `% hari tenang` (maks ≤1), jumlah jebol. Verdict `⬇️ MAJU` / `➡️ STAGNAN` / `⬆️ NAIK LAGI` (ambang 0.2 poin, minimum 4 hari ber-log per periode). Grafik batang per minggu; minggu berjebol ikut berpendar.
  - **Kata penyemangat** di samping judul — ditentukan dari aktivitas **hari ini** (belum log / ada jebol / maks 2 / maks 1 / maks 0), 3 varian kalimat per kondisi dipilih deterministik per tanggal. Tier khusus: jebol ≥3 = tegas, **≥6 = keras**.
- **Palet warna (hasil iterasi bersama user):** hijau muda `#9be9a8` → hijau sedang `#56d364` → hijau tua `#1a7f37` → **merah `#ff2d2d` khusus jebol**; hari tanpa log = abu `#15181d`. Warna sel sengaja **tanpa overlay brightness** supaya murni menyatakan kekuatan hasrat (bukan jumlah log). Sel jebol berpendar (`boxShadow` membesar seiring jumlah jebol) dan digambar di atas sel tetangga (`position: relative` + `zIndex`) sehingga pendarnya "luber".
- **Dampak:** App jalan dari launcher (grup Kesehatan, pinned) atau `craving-tracker` di shell. Deploy: `npm run install` (binary-safe, untuk foto) atau sync `.ts` saja bila foto sudah ada di VFS.
- **Oleh:** Copilot · **Laporan/reproduksi:** kakang

### `ReferenceError: background is not defined` — `onSetup` mati, kalender & semua render sesudahnya tidak jalan

- **File:** `src/mirror/opt/craving-tracker/craving-tracker.ts`
- **Masalah:** Saat menghapus overlay brightness di `buildCalendarNode`, referensi variabel `background` ikut hilang (diganti `base`) dan `position: "relative"` terhapus. Efeknya bukan cuma error: `renderCalendar` melempar → `refreshAll` berhenti di tengah → grid/tren/statistik/penyemangat tidak pernah dirender. Di DOM terlihat `img-child` terisi, tapi label-label lain kosong.
- **Gejala di log:** `[ERROR] [app] ReferenceError: background is not defined at buildCalendarNode ... at refreshAll ... at async TForm.form.onSetup` di `/var/log/syslog` (timestamp syslog = UTC, host +07:00).
- **Perubahan:** `background: base`, dan `position: "relative"` dikembalikan (wajib berpasangan dengan `zIndex`, kalau tidak pendar jebol ketutup sel tetangga).
- **Dampak:** Kalender + seluruh render pasca-mount hidup lagi.
- **Oleh:** Copilot

### Label dinamis stagnan di caption awal ("Menghitung…") — update batched hilang di ekor rentetan `refreshAll`

- **File:** `src/mirror/opt/craving-tracker/craving-tracker.ts` (workaround app-side). Analisis & saran fix library: `wiki/changelogs/emerald.md` (2026-09-16).
- **Masalah:** Ringkasan aktivitas, verdict tren, statistik, dan teks status bar tetap berisi caption awal (`Menghitung…` / teks constructor) walau `refreshAll` jelas berjalan (kalender & bar tren ikut ter-render ulang). Update `label.caption` / `screen.update()` memakai jalur **batched** (`dirtyProps` → `scheduleFlush` → `flushNow`), dan update yang di-set di **ekor rentetan panjang** tidak pernah terpakai.
- **Diagnosis (dipakai lagi kalau ada gejala serupa):**
  1. Inspeksi DOM live lewat browser DOME: elemen `lbl-encourage`/`lbl-stats`/`lbl-activity` **ada** tapi `textContent` kosong / masih caption awal → masalahnya di update, bukan di layout.
  2. Bandingkan mekanisme: node hasil **`setContent()` (sendImmediate)** selalu tampil (grid, kalender, bar tren, legenda), sedangkan `screen.update()` (batched) hilang sebagian → jalur batched yang dicurigai.
  3. Pasang **perekam WebSocket** (`page.addInitScript` + bungkus `window.WebSocket`) lalu reload: DOME menerima 8.245 `UPDATE_PROPS` (termasuk `img-child` 240 KB) sehingga pesan **sampai**, tapi update teks yang di-set di ekor rentetan tidak ikut terpakai.
- **Perubahan:** Semua teks dinamis dialihkan ke jalur **immediate** via helper `writeText(host, text, style, screen)` → `screen.setContent(host.id, { tag: "span", props: { text } })`, dan `writeStatus(screen, "left"|"right", text)` untuk span internal `TStatusBar`. Label `TLabel` untuk teks dinamis diganti host `TPanel` (`state-title-host`, `stats-host`, `activity-host`, `trend-head-host`, `trend-prev-host`, `trend-cur-host`). Pre-mount, `writeText` cukup set `caption` (ikut payload `MOUNT_NODE` pertama) sehingga tampilan awal tidak pernah menampilkan placeholder.
- **Dampak:** Terverifikasi di DOM instance baru: `📊 10 log 6 bulan terakhir · 1 hari aktif · 🔥 10 jebol · streak terpanjang 1 hari`, verdict tren, `Σ 10 entri · …`, dan teks status bar semuanya terisi. Update tunggal (mis. ganti skala → foto `level3.png`) memang sudah aman sejak awal; yang hilang hanya ekor rentetan.
- **Oleh:** Copilot

### Karakter rusak `U+FFFD` di string emoji `renderCalendar`

- **File:** `src/mirror/opt/craving-tracker/craving-tracker.ts`
- **Masalah:** Satu emoji di dalam `lblActivity.caption` berubah menjadi `�` (`U+FFFD`) sehingga baris itu tidak bisa dicocokkan oleh tool edit (replacement gagal berulang) dan berpotensi tampil rusak di UI.
- **Perubahan:** Baris tersebut diganti utuh (blok 6 baris) dengan versi `writeText`; file diverifikasi bersih dari `U+FFFD`. Ingat pola serupa di `wiki/changelogs/image-viewer.md` (mojibake emoji) — **selalu cek `U+FFFD` setelah menyunting file yang banyak emoji**.
- **Oleh:** Copilot

### Foto rusak bila disuntik lewat `scripts/sync-vfs.ts` (utf8) — app mendeteksi magic bytes

- **File:** `src/mirror/opt/craving-tracker/craving-tracker.ts`, `src/mirror/opt/craving-tracker/README.md`
- **Masalah:** `sync-vfs.ts` membaca file sebagai **utf8** sehingga byte raster (`.jpg/.png`) rusak bila dipakai untuk gambar. Sebaliknya `cp` di dalam TSIX (mis. dari `/mnt/shared` ke `/opt/...`) **aman** (terverifikasi: 4 PNG utuh, header `89 50 4e 47`).
- **Perubahan:** Loader gambar `loadLevelImage()` memvalidasi **magic bytes** dan membedakan tiga kondisi di UI: gambar OK (`🖼 <path> (<size>)`), file ada tapi byte korup (`⚠️ … rusak (byte korup) — kirim ulang via npm run install`), dan file belum ada (placeholder SVG). Jalur aman untuk gambar: `npm run install` / `scripts/vfs-bootstrap.ts` (latin1, 1 byte = 1 char) atau `img2b64` untuk sidecar `.b64`.
- **Oleh:** Copilot

### App tidak muncul di launcher Asteracea — menu dibaca sekali saat boot

- **File:** `src/mirror/opt/asteracea/menu/craving-tracker.menu` (baru)
- **Masalah:** `_menu` file baru tidak muncul di launcher/`pinned_launcher` karena `APPS` dimuat `loadMenuFromFiles()` sekali saat Asteracea start. App tetap bisa dijalankan dari shell (`craving-tracker`) dan terdaftar sebagai *foreign app* (terlihat di `/var/log/syslog`), jadi gejalanya membingungkan.
- **Solusi:** klik kanan desktop → **Refresh** (DCM memanggil `refreshMenus()` → `loadMenuFromFiles()` lagi) → entri 🚭 langsung muncul di launcher/taskbar. Perlu restart Asteracea bila ingin otomatis.
- **Oleh:** Copilot

### Catatan pengembangan lanjut (belum dikerjakan)

- **Race di `emerald.ts` (`flushNow`)**: hapus `dirtyProps` **per-target setelah terkirim** + selalu reset `batchPromise`/`batchTimer` (termasuk saat `dirtyProps` kosong atau `sendImmediate` gagal) — supaya update batched tidak hilang di app mana pun. Detail + saran patch: `wiki/changelogs/emerald.md` (2026-09-16).
- **Baseline tren**: saat ini membandingkan 3 bulan terakhir vs 3 bulan sebelumnya. Bila program berhenti baru mulai, baseline yang lebih masuk akal adalah **2 minggu pertama program** (diusulkan user, belum diimplementasikan).
- **Penanda milestone**: garis/marker target 3 bulan di grafik aktivitas (usulan, belum dikerjakan).
- Konstanta yang mungkin ingin disetel user: `WINDOW_DAYS` (182), ambang verdict (`0.2`), `MIN_DAYS` (4), tier pesan penyemangat (≥3 tegas, ≥6 keras).
