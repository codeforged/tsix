# Changelog Smart Bulb (JayaLaras)

> Migrasi smart home "JayaLaras" dari NOS ke TSIX: GUI denah + service saklar/lampu.
> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-04

### `control` — lampu pakai `bulbon/off.png` (TImage klik), label ruangan dihapus

- **File:** `src/mirror/opt/smartbulb/control.ts`
- **Perubahan:**
  - Ikon lampu ON/OFF kini memakai **`bulbon.png` / `bulboff.png`** dari `/opt/smartbulb` (dimuat byte-safe dari VFS → data URI). Tiap lampu = **`TImage` yang bisa diklik** (pakai `TImage.onClick` baru di Cashew): `src` ditukar bulbon ↔ bulboff saat toggle. Fallback tombol emoji otomatis bila PNG tidak tersedia.
  - **Label nama ruangan di bawah lampu dihapus** — denah/background sudah menampilkan nama ruangan (`capStyleAt`/`bulbLabels`/`bulb-cap-*` dibuang).
- **Oleh:** Copilot

### `service` — kandidat device MCP23017 mengikuti nama baru (`mcp-bulb` / `mcp-sw`)

- **File:** `src/mirror/opt/smartbulb/service.ts`
- **Perubahan:** daftar kandidat relay & saklar dirapikan ke nama driver MCP23017 terbaru: relay `/dev/mcp-bulb`; saklar `/dev/mcp-sw` (menggantikan `/dev/relays,/dev/mcp0,/dev/mcp23017` dan `/dev/switches,/dev/mcpSw,/dev/mcp1,...`).
- **Oleh:** kakang

### `control` — GUI Cashew pengontrol lampu (denah rumah)

- **File:** `src/mirror/opt/smartbulb/control.ts`
- **Perubahan:**
  - GUI Cashew (`TForm`/`TPanel`/`TButton`/`TImage`/`TLabel`/`TStatusBar`) dengan denah rumah ala `docs/jayalaras-iot/smartbulb/index.html`: background `layoutrumah.png` (TImage, load VFS) + lampu `💡` yang bisa diklik per ruangan; posisi lampu mengikuti koordinat `index.html`.
  - Ukuran stage otomatis mengikuti dimensi PNG (baca header IHDR); bila gambar tidak ada → fallback kotak ruangan skematik.
  - Mode: **simulasi** (default), **`--hw`** (langsung ke MCP23017 relay, auto-detect), dan **SERVICE** (auto-connect via IPC bila daemon berjalan).
  - Tombol Semua ON/OFF, status bar jumlah lampu, poll relay (bila `--hw`).
- **Oleh:** Copilot

### `service` — daemon JayaLaras (migrasi `jayalarasiot_i2c.js` NOS)

- **File:** `src/mirror/opt/smartbulb/service.ts`
- **Perubahan:**
  - Daemon headless pemilik hardware 2 chip MCP23017 (relay @0x20 + saklar @0x24) dan logika saklar→lampu.
  - Transliterasi `updateSwitchAndLamp()` NOS apa adanya: mapping saklar lama (15→9, 9→11, 8→8, 3→7, 7→15, 12→10, 11→12 kamar mandi invert), **multi-state** (pin 8 & 15), **logika dusk** (jam ≥18 / <5 utk ruang utama depan), relay aktif-low (ON=LOW).
  - IPC (SEND_MSG / `ipc_message`) dengan identity **`jayalaras.service`**:
    - terima `REGISTER`, `UNREGISTER`, `GET`, `SET {port,on}`, `SETALL {on}`
    - push `SMARTBULB_STATE {ports[16], switches[16], manual}` ke subscriber (GUI)
  - Tanpa chip → mode simulasi (state di memori tetap bisa diatur/dipush via IPC — memudahkan tes GUI tanpa hardware).
- **Dampak:** GUI (`control`) bisa menampilkan update saklar fisik real-time; satu sumber kebenaran state/hardware ada di service.
- **Oleh:** Copilot

### Catatan migrasi

- `control.ts` ↔ `service.ts` terhubung via IPC: control otomatis `REGISTER` ke `jayalaras.service` saat start; kalau service belum jalan → kontrol jatuh ke mode lama (simulasi/`--hw`).
- ⚠️ Mapping `port`/saklar masih konfigurasi NOS 2020 — perlu diverifikasi dengan wiring fisik sebelum mengandalkan mode hardware.
- Register chip saklar kedua (`switches` @0x24) di kernel agar logika saklar fisik aktif (lihat `wiki/mcp23017-registration.md`).

---
