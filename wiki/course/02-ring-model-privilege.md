---
module: 02
title: Model Ring & Batas Privilege
part: I
partTitle: Fondasi
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Model Ring & Batas Privilege

**RFC-TSIX-EDU-002** | Modul kedua kurikulum TSIX. Memahami konsep "Ring" sebagai batas privilege, dan di mana batas keamanan *sebenarnya* berada di TSIX.

> Penting: **Ring di TSIX adalah konsep (dokumentasi), bukan mekanisme isolasi hardware.** TSIX berjalan di atas V8, bukan bare metal. Batas nyata ada di dua lapisan: **sandbox WorkerEntry** dan **PermissionManager (kernel)**.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan isi tiap Ring 0–4 dan file utamanya
- [ ] Membedakan Ring sebagai konsep vs mekanisme isolasi nyata
- [ ] Menjelaskan dua lapisan batas privilege nyata: WorkerEntry sandbox & PermissionManager
- [ ] Menjelaskan apa itu setuid bit dan contoh penggunaannya
- [ ] Mengetahui kelemahan privilege berbasis nama app

---

## Konsep Inti

### Peta Ring

| Ring | Isi | File utama |
|------|-----|------------|
| **0** | Host: Linux + Node/V8 | — (reserved) |
| **1** | Kernel core: Scheduler, Syscall, Permission | `src/kernel/*`, `src/common/*` |
| **2** | Driver & FS: HAL devices, VFS backends, MountManager | `src/kernel/devices/*`, `src/vfs/*` |
| **3** | Library framework: UserLib, Application | `src/mirror/lib/*` |
| **4** | Aplikasi: `/bin/*`, `init`, `tsh`, daemon | `src/mirror/bin/*` |

![Ring 1 & 2 — kernel internals (dispatcher, scheduler, stack FS/Net/HAL)](/wiki/diagram/Arsitektur-Sistem-2.png)
*Sumber: [`wiki/diagram/Arsitektur-Sistem-2.mmd`](/wiki/diagram/Arsitektur-Sistem-2.mmd)*

Ring adalah **peta tanggung jawab** — bukan isolasi yang ditegakkan oleh V8. Dua file yang berbeda ring boleh saja saling memanggil; yang menjaga keamanan adalah aturan di bawah.

### Perbandingan dengan Linux

| Fitur | Linux Equivalent | TSIX Ring |
|---|---|---|
| Core OS Logic | Ring 0 (Kernel Mode) | **Ring 1** |
| Drivers & FS | Ring 0 (Kernel Mode) | **Ring 2** |
| Standard Library | Ring 3 (glibc) | **Ring 3** |
| User Apps | Ring 3 (User Mode) | **Ring 4** |

> [!NOTE] **Ring 0 adalah domain host.** Karena TSIX bukan bare metal, "Ring 0" berarti Linux/Windows + V8. TSIX memulai penomoran dari Ring 1.

---

## Dua Lapisan Batas Privilege Nyata

### Lapisan 1 — WorkerEntry Sandbox (sisi worker)

`src/userland/WorkerEntry.ts` adalah **bootloader** setiap worker. Ia mengunci pintu sebelum aplikasi berjalan:

- App hanya boleh `require` framework `@tsix/*` / `@common/*` — sisanya diblokir.
- `process.exit` / `process.kill` disabotase (di-throw).
- App **privileged** (nama mengandung `server`, `daemon`, `dome`, `tbuild`, `vfs`) mendapat akses **allow-list** modul host: `http`, `ws`, `path`, `fs`, `url`, `esbuild`, `crypto`, `os`, `bcryptjs`.

### Lapisan 2 — PermissionManager (sisi kernel)

`src/kernel/PermissionManager.ts` adalah "satpam" di kernel. Ia melakukan cek rwx berlapis:

```
check(pid, path, mode):
  root (uid 0) → bypass
  owner        → cek bit owner
  group        → cek bit group
  others       → cek bit others
```

**SetUID bit** (`0o4000`) didukung: proses dieksekusi dengan hak milik file. Contoh: `/bin/login` memiliki mode `0o4755` — siapa pun yang menjalankan login, prosesnya berjalan sebagai root (untuk melakukan setuid/setgid ke user target).

---

## Kode Sumber

| File | Peran |
|---|---|
| `src/userland/WorkerEntry.ts` | Sandbox sisi worker (restrictHostAPI) |
| `src/kernel/PermissionManager.ts` | Cek rwx + setuid |
| `src/kernel/Syscalls.ts` | Panggil permission check sebelum aksi |
| `src/mirror/bin/login.ts` | Contoh penggunaan setuid (`0o4755`) |

---

## Snippet (level kode)

```ts
// src/kernel/PermissionManager.ts — inti cek izin (ringkas)
check(pid: number, path: string, mode: number): boolean {
  const { uid, gid } = this.scheduler.getProcess(pid);
  const stat = this.getStat(path);
  if (uid === 0) return true;            // root bypass
  if (uid === stat.uid) return !!(stat.mode & mode);        // owner
  if (gid === stat.gid) return !!(stat.mode & (mode >> 3)); // group
  return !!(stat.mode & (mode >> 6));                       // others
}
```

> [!WARNING] **Kelemahan yang diketahui.** Status privileged berbasis **substring nama app** — heuristik rapuh. Siapa pun yang menamai app-nya `my-daemon` otomatis privileged. Idealnya diganti dengan *capability-based*.

---

## Latihan / Praktik

1. Baca `src/userland/WorkerEntry.ts` — temukan daftar allow-list modul host.
2. Baca `src/kernel/PermissionManager.ts` — uji logika cek rwx dengan beberapa kombinasi uid/gid/mode.
3. Jalankan app non-privileged yang mencoba `require("fs")` — amati error yang muncul.

---

## Referensi

- `wiki/ARCHITECTURE_RINGS.md` — definisi resmi ring
- `wiki/Keamanan-dan-Sandboxing.md` — detail sandbox
- `wiki/course/00-overview.md` §2

---

*Modul 02 — selesai. Lanjut ke [Modul 03 — Boot Sequence](03-boot-sequence.md).*
