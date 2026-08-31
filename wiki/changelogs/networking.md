# Changelog Networking MQTNL

> Changelog untuk stack networking MQTNL: `NetSocket`/`NetworkLib`, custom
> security agent (Jalur A), dan tool `secagent`.
> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-01

### Protocol biner TERSANDI — Binfeo (bukan OTA)

- **File:** `src/common/protocols/MQTNLProtocolBinfeo.ts`, `src/common/protocols/MQTNLProtocolBinary.ts`, `src/kernel/devices/SimpleMQTNLDriver.ts`, `src/common/ISecurityAgent.ts`, `src/common/SecurityAgent.ts`, `src/common/AesGcmAgent.ts`, `src/mirror/lib/NetworkLib.ts`
- **Perubahan:**
  - Protocol baru **`Binfeo`** (extend `MQTNLProtocolBinary`): biner yang BISA dienkripsi utk komunikasi normal — magic `0x66` (`'f'`), topic `mqtnl@1.2/` (bukan OTA `0x42`/`mqtnl@1.1/`). Magic & version di `MQTNLProtocolBinary` dibuat `protected` supaya bisa di-override.
  - Driver: **TX Binfeo dienkripsi** via `securePacketOutRaw()` (beda dari OTA yang bypass); **RX dekripsi ke Buffer utuh** via `securePacketInRawBuffer()` (byte ≥ 0x80 tidak rusak; OTA tetap jalur string).
  - Per-port protocol digeneralisasi: `binaryPorts: Set` → `portProtocols: Map<port, nama>`; ioctl `0x1002` terima `{ port, protocol: "Binfeo" }`.
  - `ISecurityAgent` + agent: tambah `securePacketInRawBuffer()` (decrypt → Buffer) & `securePacketOutRaw?` (encrypt → Buffer) — binary-safe.
  - `NetSocket`: opsi baru **`protocol`** (mis. `protocol: "Binfeo"`) — mengalahkan `binary: true`.
  - Sniffer (`bitshark`) melabeli nama protocol asli (mis. `Binfeo`).
- **Contoh:** `netsocket-binfeo-rx.ts` / `netsocket-binfeo-tx.ts`; test `MQTNLProtocolBinfeo.test.ts`.
- **Dampak:** komunikasi biner normal bisa terenkripsi end-to-end tanpa menyalahgunakan protocol OTA (yang bypass security).

### tssh / tsshd pindah ke Binfeo

- **File:** `src/mirror/opt/tssh/tssh.ts`, `src/mirror/opt/tssh/tsshd.ts`
- **Perubahan:** protocol per-port dari OTA Binary → **Binfeo** (`ioctl 0x1002 { port, protocol: "Binfeo" }`). Enkripsi payload tetap di app level (per-session key) karena `tsshd` multiplex banyak session di SATU port — security driver per-port (1 key/port) tidak cukup.
- **Dampak:** shell TSSH tidak lagi memakai protocol OTA (semantiknya "bypass enkripsi"); wire memakai `mqtnl@1.2/` / magic `0x66`.

- **Oleh:** Copilot

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
