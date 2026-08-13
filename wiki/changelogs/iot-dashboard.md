# Changelog IoT Dashboard

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-13

### Crash saat app ditutup — `[Worker Fatal] Unhandled Rejection: Window has been destroyed`
- **File:** `src/mirror/opt/iot-dashboard/iot-dashboard.ts`
- **Masalah:** Saat window iot-dashboard ditutup (klik X), `app.running` tidak pernah di-set `false` (app memakai while-loop manual, bukan `Screen.loopUntilClose()`). Handler `lib.onEvent("ipc_message")` dan `log()` terus aktif: pesan `SENSOR_DATA` berikutnya memanggil `app.update()` pada window yang sudah destroyed → `Window.ensureAlive()` melempar `@tsix/gui: Window '...' has been destroyed` → karena `log()` dipanggil tanpa `await`/`.catch`, jadilah **unhandled rejection** → `WorkerEntry` mematikannya sebagai **Worker Fatal**.
- **Perubahan:**
  - Daftarkan `app.win.onClose(() => { app.running = false; })` — saat window ditutup, `running` jadi `false` → while-loop berhenti (sama seperti perilaku `loopUntilClose()`).
  - `log()`: guard `if (!app.running) return;` + seluruh `app.update()` dibungkus try/catch (tidak pernah melempar).
  - `updateUI()`: guard `if (!app.running) return;` di awal.
  - Handler `ipc_message`: guard `if (!app.running) return;` di awal (tidak proses lagi setelah tutup).
  - Handler slider `input`: guard `if (!app.running) return;`.
- **Dampak:** Menutup iot-dashboard tidak lagi menghasilkan unhandled rejection / Worker Fatal. Catatan deploy: sync app ke VFS yang berjalan (`npm run vfs:bootstrap` / `install`) agar perbaikan dipakai runtime.
- **Oleh:** Copilot · **Laporan/reproduksi:** kakang
