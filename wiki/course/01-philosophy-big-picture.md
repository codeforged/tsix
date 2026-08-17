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

# Filosofi & Gambaran Besar

**RFC-TSIX-EDU-002** | Modul pertama kurikulum TSIX. Membangun peta mental: apa itu TSIX, mengapa dirancang begini, dan lima prinsip inti yang menjadi fondasi seluruh sistem.

> Sebelum menulis kode, pahami dulu **filosofinya**. TSIX bukan sekadar "emulator OS" — ia adalah **abstraksi OS yang dibangun di atas runtime Node.js yang sudah ada**. Modul ini menjelaskan *kenapa* ia dirancang demikian, dan lima prinsip yang konsisten di semua subsistem.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan apa itu TSIX dan apa bedanya dengan VM/emulator
- [ ] Menyebutkan lima prinsip inti arsitektur TSIX
- [ ] Menjelaskan alasan kernel, driver, dan FS disatukan dalam satu thread
- [ ] Mengenali lapisan Ring 0–4 dan isinya secara garis besar
- [ ] Menjelaskan mengapa kernel tidak pernah menjalankan aplikasi

---

## Konsep Inti

### Apa itu TSIX?

TSIX adalah **sistem operasi simulasi berbasis Node.js + TypeScript**. Ia bukan VM yang mengemulasi CPU. Ia membangun **abstraksi OS di atas runtime Node.js yang sudah ada** — memakai `Worker Thread` sebagai batas proses, `postMessage` sebagai IPC, dan `SQLite` sebagai filesystem.

```
┌──────────────────────────────────────────────────────────────────┐
│ HOST — Linux + Node.js + V8                                      │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ MAIN THREAD = KERNEL (Ring 1-2)                            │  │
│  │  • Boot subsistem • Syscall dispatcher • Scheduler         │  │
│  │  • VFS (SQLite) • HAL devices • GUI registry               │  │
│  └───────────────────────────────┬────────────────────────────┘  │
│                                  │ new Worker() + postMessage    │
│  ┌───────────────────────────────┼────────────────────────────┐  │
│  │ WORKER THREAD #1 (Ring 4)     │  WORKER THREAD #N (Ring 4) │  │
│  │  /bin/init.js  (PID 1)        │  /bin/ls.js, /bin/dome.ts, │  │
│  │  /bin/login, /bin/tsh         │  aplikasi user...          │  │
│  └───────────────────────────────┴────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

Dengan pendekatan ini, TSIX mengadopsi **konsep arsitektur UNIX** — process isolation, permission UID/GID, filesystem POSIX, signal handling, device abstraction (HAL), syscall communication — diekspresikan dalam TypeScript di atas Node.js.

### Kenapa bukan microkernel?

Salah satu keputusan arsitektural paling fundamental: **kernel, driver, dan filesystem disatukan dalam satu thread utama**, bukan dipisah ke thread masing-masing seperti microkernel murni (Minix, QNX, seL4).

| Alasan | Penjelasan |
|---|---|
| **Overhead IPC** | Microkernel murni = 3–4x `postMessage` per operasi (Apl → Kernel → FS → Kernel → Apl). Satu thread = 1x (Apl → Kernel). Setiap `postMessage` melakukan structured clone (serialize → deserialize). |
| **Keterbatasan Worker** | Worker Thread Node.js **tidak bisa shared memory**. Setiap transfer = alokasi baru + copy data. Makin besar data, makin besar overhead. |
| **Target embedded** | TSIX untuk IoT dengan CPU terbatas dan RAM kecil. Setiap Worker tambahan = ~4–8MB heap. |
| **Isolasi sudah ada** | Aplikasi (Ring 4) sudah di worker terpisah → 90% manfaat isolasi dengan 10% biaya. |

**Hasilnya:** yang paling sering crash adalah aplikasi user — dan itu sudah terisolasi. Kernel + driver + FS jarang crash, dan kalaupun crash, sistem mati (tapi jarang).

---

## Lima Prinsip Inti

### 1. "Everything is a File"

File dan device sama-sama `IDevice`; `read/write` polimorfik.

- Buka file biasa → `FileSystemDevice`
- Buka `/dev/tty1` → `TTYDevice`
- Buka `/dev/smqtnl0` → `SimpleMQTNLDriver`

Bahkan pipe, socket, dan display adalah device. Satu kontrak, banyak implementasi.

### 2. "Distributed by Design"

IPC bawaan via syscall `SEND_MSG` + identity-based messaging. Proses berkomunikasi lewat identitas (UUID), bukan alamat memori — sesuai sifat terdistribusi platform.

### 3. "Small, Sharp Tools"

80+ utilitas yang saling terhubung lewat pipe & redirection — tradisi Unix: satu alat mengerjakan satu hal dengan baik, lalu dikombinasikan.

### 4. "Security via Simplicity"

Model permission UID/GID, isolasi proses (Worker Thread), dan privilege root yang sederhana namun tegas — keamanan lahir dari desain yang jelas, bukan dari kerumitan.

### 5. "Unix Fidelity dulu, pragmatis belakangan"

TSIX meniru perilaku & arsitektur Unix/Linux sedekat mungkin — semantik syscall, permission UID/GID, kredensial (saved UID), format file (`/etc/shadow`, `passwd`), hierarchy filesystem — sebagai **north star** desain. Bukan karena "harus persis", tapi karena perilaku yang **teramati** harus konsisten: non-root tidak bisa baca `/etc/shadow`, proses non-root tidak bisa `setuid` sembarangan, dan seterusnya.

Penyimpangan dari Unix **boleh**, tapi hanya jika runtime Node.js/V8 memang tidak mampu — bukan karena alasan "lebih gampang". Setiap penyimpangan **wajib dicatat** (di changelog dan/atau komentar kode) dengan alasan teknis yang jelas, supaya tidak disalahartikan sebagai bug.

> [!NOTE] **Semantik > Mekanisme** — kita tidak perlu mengemulasi bare-metal (hardware interrupt, MMU, dll). Yang penting perilaku yang teramati dari userland sama dengan Unix. Contoh: `setuid` disimulasikan dengan saved UID (`pcb.suid`) di kernel, bukan dengan register CPU — tapi efeknya sama.

---

## Kode Sumber

| File | Peran |
|---|---|
| `src/main.ts` | Entry point host + keep-alive |
| `src/kernel/Kernel.ts` | Orkestrator boot semua subsistem |
| `src/kernel/Syscalls.ts` | Dispatcher syscall |
| `src/kernel/Scheduler.ts` | Manajemen proses |
| `src/userland/WorkerEntry.ts` | Bootloader worker + sandbox |
| `src/common/IPCTypes.ts` | Kontrak IPC |

---

## Latihan / Praktik

1. Baca `src/main.ts` — temukan di mana keep-alive 100ms berada. Apa yang terjadi jika PID 1 exit dengan code 1?
2. Baca `src/kernel/Kernel.ts` — daftar urutan `initializeSubsystems()`. Cocokkan dengan diagram boot di Modul 03.
3. Jalankan TSIX (`npm start` / sesuai `README.md`) dan amati log boot.

---

## Referensi

- `wiki/Arsitektur-Sistem.md` — diagram lapisan dan analisis microkernel
- `wiki/course/00-overview.md` §1 — peta mental global
- `src/main.ts`, `src/kernel/Kernel.ts`

---

*Modul 01 — selesai. Lanjut ke [Modul 02 — Model Ring & Batas Privilege](02-ring-model-privilege.md).*
