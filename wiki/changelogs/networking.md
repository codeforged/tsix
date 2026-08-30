# Changelog Networking MQTNL

> Changelog untuk stack networking MQTNL: `NetSocket`/`NetworkLib`, custom
> security agent (Jalur A), dan tool `secagent`.
> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-31

### NetSocket — komponen networking high-level ala Cashew
- **File:** `src/mirror/lib/NetworkLib.ts`, `src/mirror/lib/Application.ts`
- **Perubahan:**
  - Tambah class **`NetSocket`** (Cashew-style): `new NetSocket({ port, iface, key, binary, autoCleanup })` → `open()` → events `onData/onError/onClose` → `sendTo()`/`reply()`/`recv()` → `close()` → `waitClosed()`.
  - Security **tidak** auto-upgrade saat `open()` — switch eksplisit lewat `upgradeSecurity(key, { agent })` (mulai plain dulu, secure kapan pun, mis. setelah handshake).
  - Auto-cleanup default: SIGINT/SIGTERM → `close()` (release port + normalisasi agent) lalu exit(130/143).
  - Tanpa magic number ioctl (0x1001/0x1002) — dibungkus `SMQTNL_IOCTL` + opsi `key`/`binary`.
- **Dampak:** aplikasi networking baru cukup instantiate → event → open → close; tidak perlu urus fd & loop recv manual.

### Dua class NetworkLib disatukan jadi satu source of truth
- **File:** `src/mirror/lib/NetworkLib.ts`, `src/mirror/lib/UserLib.ts`, `src/mirror/lib/Application.ts`
- **Perubahan:** Sebelumnya ada DUA `NetworkLib` (satu OSContext-based di `NetworkLib.ts`, satu `dispatch`-based inline di `UserLib.ts`) — kini SATU class di `NetworkLib.ts` yang menerima `dispatch` ATAU `OSContext`; `UserLib` import + re-export; `toBuffer()` static dipertahankan.
- **Dampak:** menghilangkan ambiguitas API; `lantana-listener.ts` tidak lagi import dua path.

### Custom Security Agent (Jalur A) — kontrak + factory registry
- **File:** `src/common/ISecurityAgent.ts`, `src/common/SecurityAgent.ts`, `src/common/AesGcmAgent.ts`, `src/kernel/devices/SimpleMQTNLDriver.ts`
- **Perubahan:**
  - Kontrak **`ISecurityAgent`** (5 method) — `SecurityAgent` (default "chacha20") mengimplementasikannya.
  - Driver pakai `Map<number, ISecurityAgent>` + **factory registry**: `SimpleMQTNLDriver.registerAgent(name, factory)` / `getAgent(name)` / `listAgents()`.
  - ioctl UPGRADE_SECURITY menerima field `agent` (default "chacha20"); agent tak dikenal → fallback chacha20 (backward-compat).
  - Contoh agent kustom built-in: **`AesGcmAgent`** (AES-256-GCM, format wire sama IV+Tag+Cipher).
- **Dampak:** jenis enkripsi baru tinggal buat class `implements ISecurityAgent` → `registerAgent` → pilih via `upgradeSecurity(key, { agent: "nama" })`.

### Tool `secagent` — daftar agent yang terdaftar di kernel
- **File:** `src/mirror/sbin/secagent.ts`, `src/common/SyscallCode.ts`, `src/kernel/Syscalls.ts`, `src/mirror/lib/NetworkLib.ts`
- **Perubahan:** Syscall baru **`SECAGENT_LIST = 39`**; `SimpleMQTNLDriver.listAgents()`; `lib.net.listAgents()`. Tool `/sbin/secagent` (`secagent` / `--list` / `--json`) menampilkan agent terdaftar.
- **Dampak:** audit jenis enkripsi aktif dari shell.

### Kernel version → `0.2.5.20260831.1`
- **Oleh:** Copilot

---
