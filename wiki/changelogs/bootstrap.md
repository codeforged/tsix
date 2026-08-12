# Changelog Bootstrap TSIX

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-10

### Safe mode flag di bootstrap scripts
- **File:** `bootstrap.sh`, `bootstrap.bat`
- **Perubahan:** Kedua script menerima argumen `--safe-mode` → diteruskan ke `node ... src/main.ts --safe-mode`; banner menampilkan "SAFE MODE (startup scripts disabled)" saat aktif.
- **Dampak:** `./bootstrap.sh --safe-mode` / `bootstrap.bat --safe-mode` boot dalam safe mode (rc.local dimatikan).
- **Oleh:** Copilot
