# FORMAT — Standar Dokumen Course TSIX

**RFC-TSIX-EDU-003** | Konvensi format & gaya untuk semua dokumen di `wiki/course/`.

> Tujuan: dokumen **seragam** (beda dari `wiki/` yang campur aduk), **i18n-ready** (siap terjemah ke Inggris & bahasa lain), dan **browserfiyable** (render rapi di browser via `course-server.ts`).

---

## 1. Aturan Emas

1. **Satu format, satu gaya** — semua modul memakai struktur di bawah ini.
2. **Kode adalah kebenaran** — jika wiki dan kode beda, kode yang benar; tulis ulang wiki.
3. **Bahasa netral & terstruktur** — hindari frasa "gak jelas", gunakan kalimat yang mudah diterjemahkan (kalimat pendek, istilah teknis konsisten).
4. **Bisa di-render browser** — jangan pakai sintaks markdown eksotis yang tidak didukung `course-server.ts` (lihat §4).
5. **Audience-aware** — tulis untuk pembaca umum: kontributor, hobbyst, edukator, profesional. Jelaskan istilah saat pertama muncul.

---

## 2. Frontmatter (Wajib)

Setiap file modul **harus** diawali frontmatter:

```markdown
---
module: 01
title: Filosofi & Gambaran Besar
part: I
partTitle: Fondasi
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---
```

| Field | Nilai | Keterangan |
|---|---|---|
| `module` | `01`-`99` | Nomor modul (2 digit) |
| `title` | string | Judul singkat (dipakai sidebar) |
| `part` | `I`-`VIII` | Grup bagian (dipakai sidebar) |
| `partTitle` | string | Nama bagian (opsional) |
| `status` | `done` / `partial` / `todo` | Penanda progres (render jadi badge ✅🔶⬜) |
| `lang` | `id` / `en` | Bahasa dokumen |
| `rfc` | string | Nomor RFC (opsional) |
| `audience` | `all` / `contributor` / ... | Target (opsional) |

---

## 3. Struktur Konten (Seragam)

Urutan wajib dalam setiap modul:

```markdown
# Judul Modul (dari frontmatter)

> **RFC-X** | Ringkasan 1-2 kalimat apa yang dipelajari modul ini.

## Tujuan Pembelajaran
- [ ] Memahami ...
- [ ] Mampu menjelaskan ...

## Konsep Inti
<!-- penjelasan + diagram -->

## Alur / Cara Kerja
<!-- langkah-langkah -->

## Kode Sumber
<!-- file yang relevan, dengan link ke path -->

## Snippet (level kode)
<!-- potongan kode kunci dengan penjelasan -->

## Latihan / Praktik
<!-- hands-on -->

## Referensi
<!-- wiki lain, file kode -->
```

> Checklist (`- [ ]`) di "Tujuan Pembelajaran" dipakai untuk menandai progres belajar per modul.

---

## 4. Markdown yang Didukung (Browserfiy)

Demi konsistensi render di `course-server.ts`, gunakan subset markdown berikut:

| Fitur | Sintaks | Render |
|---|---|---|
| Heading | `#`-`######` | ✅ |
| Bold / Italic / Strike | `**x**` `*x*` `~~x~~` | ✅ |
| Inline code | `` `x` `` | ✅ |
| Code block | ```` ```ts ```` | ✅ |
| Link | `[teks](path)` | ✅ |
| Image | `![alt](path)` | ✅ |
| Table | `\| a \| b \|` | ✅ |
| List (ul/ol) | `- x` / `1. x` | ✅ |
| HR | `---` | ✅ |
| Blockquote | `> teks` | ✅ |
| **Callout** | `> [!NOTE]` dll | ✅ (warna khusus) |
| **Checklist** | `- [ ]` / `- [x]` | ✅ |
| Emoji | native emoji | ✅ |

**Callout yang didukung:**

```
> [!NOTE]       — info umum
> [!TIP]        — saran praktis
> [!IMPORTANT]  — hal wajib dipahami
> [!WARNING]    — hati-hati / gotcha
> [!DANGER]     — berbahaya / jangan dilakukan
```

> ⚠️ **Tidak didukung** (jangan pakai): mermaid inline (render sebagai code), nested list dalam, HTML mentah, footnote.

---

## 5. i18n — Strategi Terjemahan

### 5.1 File Terjemahan

- Dokumen asli (Indonesia): `NN-nama.md`
- Terjemahan (Inggris): `NN-nama.en.md`
- Server otomatis memilih: `?lang=en` → cari `*.en.md` → fallback ke `*.md`

```
wiki/course/
├── 00-overview.md
├── 00-overview.en.md      ← terjemahan (nanti)
├── 01-philosophy.md
└── 01-philosophy.en.md
```

### 5.2 Aturan Penulisan agar Mudah Diterjemahkan

1. **Satu ide per kalimat** — kalimat pendek.
2. **Terminologi konsisten** — buat glosarium istilah yang dipertahankan apa adanya: *syscall*, *worker*, *scheduler*, *mount*, *VFS*, *DOME*, *widget*.
3. **Jangan campur bahasa dalam kalimat** — hindari "kita pakai syscall buat baca file ya" → tulis "Setiap akses resource melewati **syscall**.".
4. **Frontmatter `lang`** diisi bahasa file.
5. **UI string** (sidebar, tombol, footer) ada di `course-server.ts` kamus `LOC` — bukan di dokumen.

### 5.3 Glosarium (term yang dipertahankan)

| Term | Tetap |
|---|---|
| Syscall | tetap `syscall` |
| Worker / Worker Thread | tetap |
| Scheduler, PCB | tetap |
| Mount / MountPoint | tetap |
| VFS, BKFS, RamFS, HostVFS | tetap |
| DOME, PixelSpace, Emerald, Asteracea | tetap |
| Window, Widget, Toolkit | tetap |
| `wid`, `pid`, `fd` | tetap |

---

## 6. Penamaan File

| Jenis | Pola |
|---|---|
| Modul | `NN-nama-singkat.md` (contoh: `03-boot-sequence.md`) |
| Terjemahan | `NN-nama-singkat.en.md` |
| Khusus (non-modul) | `toc.md`, `format.md`, `00-overview.md`, `course-server.ts` |

> `00-overview.md` dan `toc.md` bebas dari penamaan modul, tapi **tetap** memakai frontmatter & gaya yang sama.

---

## 7. Checklist Kualitas sebelum commit

- [ ] Frontmatter lengkap (`module`, `title`, `part`, `status`, `lang`)
- [ ] Struktur §3 diikuti
- [ ] Hanya markdown yang didukung §4 yang dipakai
- [ ] Kalimat pendek & siap diterjemahkan (§5.2)
- [ ] `course-server.ts` men-render tanpa error (coba buka di browser)
- [ ] Status di `toc.md` sinkron dengan frontmatter modul

---

*FORMAT v1.0 — berlaku untuk semua dokumen course TSIX.*
*"Seragam hari ini, mudah diterjemahkan besok, rapi di browser selamanya."*
