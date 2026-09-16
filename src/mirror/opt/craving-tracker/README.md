# Craving Tracker 0-3 — (TSIX GUI · Cashew)

Port dari `docs/stop-smoking.html` (localStorage) ke TSIX-GUI. Data log disimpan
sebagai **file JSON di VFS**, bukan localStorage.

| Item | Nilai |
|---|---|
| App | `/opt/craving-tracker/craving-tracker.ts` (+ sidecar `.js`) |
| Data | `/opt/craving-tracker/craving-logs.json` |
| Foto | `/opt/craving-tracker/level0.jpg` … `level3.jpg` |
| Launcher | Asteracea → **Kesehatan → 🚭 Craving Tracker** |
| Terminal | `craving-tracker` (PATH `/bin`) atau `/opt/craving-tracker/craving-tracker.js` |

## Foto per skala

Satu foto anak per skala hasrat:

| Skala | File |
|---|---|
| 0 — Tidak ada hasrat / lupa | `level0.jpg` |
| 1 — Ada rasa ingin, langsung hilang | `level1.jpg` |
| 2 — Ingin banget | `level2.jpg` |
| 3 — Jebol | `level3.jpg` |

Ekstensi yang dikenali: `.jpg` `.jpeg` `.png` `.webp` `.gif`, atau sidecar base64
`level<N>.b64` / `level<N>.jpg.b64` (teks ASCII — aman lewat sync apa pun).

### Cara menaruh foto (penting: binary-safe!)

1. Taruh foto di host: `src/mirror/opt/craving-tracker/level0.jpg` … `level3.jpg`
2. Jalankan `npm run install` (di root repo tsix) — skrip ini membaca `.jpg`
   sebagai **latin1 (1 byte = 1 char)**, persis yang dibaca `TImage`
   (`Buffer.from(raw, "latin1")`).

> ⚠️ **Jangan** pakai `scripts/sync-vfs.ts` untuk gambar raster — skrip itu
> membaca utf8 sehingga byte JPEG rusak. App akan mendeteksi ini (magic-byte
> check) dan menampilkan pesan "Gambar rusak (byte korup) → kirim ulang via
> `npm run install`".

Alternatif tanpa jalur host: konversi ke base64 di dalam TSIX lalu salin —

```
img2b64 /mnt/shared/anak.jpg /opt/craving-tracker/level0.b64
```

## Palet warna (hijau muda → hijau tua, merah = jebol)

Warna **selalu** berarti kekuatan hasrat hari itu (state tertinggi hari itu):

| State | Arti | Warna | Hex |
|---|---|---|---|
| 0 | tidak ada hasrat / lupa | hijau muda | `#9be9a8` |
| 1 | ingin, langsung hilang | hijau sedang | `#56d364` |
| 2 | ingin banget | hijau tua | `#1a7f37` |
| 3 | jebol | merah + pendar | `#ff2d2d` |

Hari **tanpa log** = abu-abu gelap (`#15181d`), sengaja dibedakan dari state 0 —
tidak mengisi log bukan berarti hari itu bebas hasrat.

## Kata penyemangat (di samping judul)

Label kecil di kanan judul, diisi `renderEncourage()` dari **aktivitas hari ini
saja** (bukan total), lalu diberi warna senada palet:

| Kondisi hari ini | Isi pesan |
|---|---|
| belum ada log | ajakan mencatat (dan pengingat bahwa satu entri cukup) |
| ada jebol (state 3) | tidak menghakimi — "jebol itu data, bukan vonis", ajak mulai dari 0 |
| state maks 2 | apresiasi menahan diri (hasrat kuat tapi tidak jadi beli) |
| state maks 1 | apresiasi membiarkan keinginan lewat |
| state maks 0 | apresiasi hari tenang + pengingat tetap mencatat |
| hari tanpa jebol | ditambahi `· 🧒 N hari tanpa jebol` |

Tiap kondisi punya 3 varian kalimat; yang dipakai dipilih **deterministik per
tanggal** (stabil sepanjang hari, berganti tiap hari) supaya tidak terasa
diulang-ulang. Pesannya ikut berubah begitu kamu Submit.

## Alur pakai

1. Pilih skala hasrat 0-3 → judul + **foto anak** berubah sesuai skala.
2. Isi konteks koding / kendala bug (opsional).
3. **Submit Log Aktivitas** → entri di-`append` ke `craving-logs.json`.
4. Panel kanan (kolom lebih lebar):
   - **📈 Matriks Per-Entri** — satu sel per entri, warna = state (klik sel
     untuk melihat `[jam] State N — konteks` di status bar). Sel state 3
     berpendar merah. Baris kakinya: statistik jumlah per state + hari tanpa
     jebol, dan tombol **🗑 Bersihkan Data**.
   - **📊 Craving Activity** (langsung di bawah matriks) — contribution graph
     ala github.com: satu sel = **satu hari**, ± 6 bulan terakhir (26-27 kolom
     minggu; `WINDOW_DAYS = 182` di source).
     - Warna sel = **state tertinggi hari itu** (hijau muda → hijau tua, atau
       merah bila ada jebol). **Tanpa overlay "makin banyak log makin terang"**
       supaya warna tidak bisa disalahartikan sebagai kekuatan hasrat.
     - **Pendar merah khusus level 3**: makin banyak jebol dalam sehari, makin
       tebal & makin luas pendar merahnya — sampai luber ke sel sekelilingnya
       (halo kedua muncul mulai 2× jebol/hari; sel jebol digambar di atas
       tetangganya pakai `z-index`).
     - Label bulan di atas, label hari (Sen/Rab/Jum) di kiri, legenda palet di
       kanan, sel hari ini diberi outline. Hover → tooltip `N log · <tanggal> ·
       level maks X · 🔥 jebol N`. Kalau window sempit, grafiknya bisa di-scroll
       ke samping.
     - Ringkasan di atas grafik: total log 6 bulan terakhir, hari aktif, jumlah jebol,
       dan streak terpanjang.
   - Bagian **tren (maju / stagnan)** di dalam grup Craving Activity, tepat di
     atas kalender — lihat bagian berikut.

## Cara membaca tren (maju / stagnan)

Alat ukur: **apakah hasrat menurun atau datar** selama program berhenti.
Metrik dihitung dari **state maksimum per hari** (kalau sehari ada beberapa log,
yang dipakai yang tertinggi):

| Metrik | Arti |
|---|---|
| `avg` | rata-rata state maksimum per hari **yang ada log** |
| `tenang` | % hari ber-log dengan state maks ≤ 1 (0 lupa / 1 reda) |
| `jebol` | jumlah entri state 3 |

Pembanding: **3 bulan terakhir** (paruh kedua jendela) vs **3 bulan sebelumnya**
(paruh pertama). Verdict: turun ≥ 0.2 poin = `⬇️ MAJU`, naik ≥ 0.2 = `⬆️ NAIK LAGI`,
selain itu `➡️ STAGNAN`. Butuh ≥ 4 hari ber-log di masing-masing periode; kalau
belum, panel menampilkan "belum bisa dinilai" daripada memberi angka menyesatkan.

> ⚠️ Hari yang **tidak di-log tidak dihitung** sebagai hari tenang — tidak
> membuka app bukan berarti tidak ada hasrat. Jadi `avg` sengaja dibagi jumlah
> hari ber-log, bukan jumlah hari kalender.

Grafik batang di atas ringkasan = **satu batang per minggu** (27 minggu):
tingginya = `avg` minggu itu (warna mengikuti palet state), dan minggu yang ada
jebol ikut **berpendar merah** seperti sel kalender. Hover batang → detail
(`N hari ber-log · avg X · tenang Y% · 🔥 jebol N`).
5. **🔄 Muat Ulang** untuk membaca ulang JSON & foto (mis. setelah menaruh foto baru).
6. **🗑 Bersihkan Data** menghapus semua log (dengan dialog konfirmasi).

> Panel **Riwayat Commit Data** sudah dihapus — informasinya terwakili oleh
> Matriks Per-Entri (warna per entri) + tooltip/klik sel untuk melihat konteks.

## Format JSON

```json
{
  "app": "craving-tracker",
  "version": 1,
  "updatedAt": "2026-09-16T07:20:00.000Z",
  "total": 2,
  "entries": [
    { "state": 0, "context": "Refactoring tsix", "time": "16 Sep 2026 14:05", "ts": 1790000000000 },
    { "state": 3, "context": "Async loop bikin frustrasi", "time": "16 Sep 2026 15:10", "ts": 1790003900000 }
  ]
}
```

Loader juga menerima bentuk lama (array polos, atau `{state, context, time}`
hasil ekspor localStorage dari versi HTML).
