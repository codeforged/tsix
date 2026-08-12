# Changelog Bitshark (Network Sniffer)

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-02

### Traffic WS hemat — incremental append + coalescing
- **File:** `src/mirror/bin/bitshark.ts`
- **Masalah:** Sebelumnya setiap paket masuk → `applyFilter()` → `grid.setData([...filteredRows])` → rebuild **seluruh tbody** dan kirim **semua baris** ke browser via WS. Payload membengkak seiring bertambahnya data ("bedol desa").
- **Perubahan:**
  - Ekstrak predikat `rowMatchesFilter(row)` (dipakai ulang oleh `applyFilter` dan `onSniff`).
  - `onSniff`: paket yang lolos filter → `filteredRows.push` + `scheduleAppend([row])` — **tanpa full render**.
  - Coalescing `scheduleAppend`/`flushAppend`: baris baru dikumpulkan, di-flush sekali tiap ±80ms → jumlah pesan WS turun drastis.
  - Grid dibuat dengan `{ maxRows: 500 }` → tampilan dibatasi, buffer tetap penuh di memory.
  - `btnClear` mereset `pendingAppend` + timer.
- **Dampak:** Satu paket masuk = satu baris kecil dikirim (bukan seluruh tabel). Filter/sort/clear tetap pakai `setData` (aksi eksplisit, jarang).
- **Oleh:** Copilot

### Filter dialog — satu form lengkap (komponen Cashew)
- **File:** `src/mirror/bin/bitshark.ts` — `showFilterDialog()`
- **Perubahan:**
  - Satu dialog overlay berisi semua kriteria filter (bukan wizard berurutan): Arah, Interface, Sumber IP+Port, Tujuan IP+Port, Port (Dst), Proto, Bytes, Flag — masing-masing dengan operator (=, !=, <, >).
  - Pakai komponen Cashew asli: `TLabel`, `TEdit`, `TComboBox`, `TButton`, `TPanel`, `HStack` (bukan raw HTML).
  - Layout: `makeRow()` (label 150px + input flex + operator 90px), section headers, tombol `✅ Apply` / `⚪ No Filter` / `❌ Cancel`.
  - Nilai ditampung di objek `draft` (via `onInput`/`onChange`) — baru di-commit ke `filterCriteria` saat Apply → Cancel tidak merusak filter aktif.
  - Dialog dibangun sebagai overlay di screen utama (`win.mount(overlay.build())` + bind rekusrsif), bukan `TForm.run()` terpisah (yang membuat nested event loop tak tertutup).
- **Dampak:** User bisa review/ubah semua kriteria sekaligus; filter hanya tampilan (buffer tetap utuh).
- **Oleh:** Copilot

### Detail paket — double-click row → alert lengkap
- **File:** `src/mirror/bin/bitshark.ts`
- **Perubahan:**
  - `packetHistory: Map<no, sniff>` menyimpan objek paket penuh (di-`set` di `onSniff`, dibersihkan saat buffer > 500).
  - Deteksi double-click via `grid.onRowClick` (jarak < 400ms pada row yang sama) → `viewPacketDetails(no)`.
  - Tampilkan via `TDialogs.alert`: info terformat + payload plaintext + **raw packet JSON** (dipisah separator).
- **Oleh:** Copilot

### Fix sebelumnya (fondasi): handler ganda & mutasi data
- **File:** `src/mirror/bin/bitshark.ts`
- **Perubahan:** Guard `onSniffRegistered` mencegah registrasi handler `ipc_message` berulang; `grid.setData([...rows])` memakai array salinan (bukan referensi langsung) agar tidak termutasi saat render async.
- **Oleh:** Copilot
