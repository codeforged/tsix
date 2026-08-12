---
module: 06
title: Permission & Security
part: II
partTitle: Boot & Kernel Runtime
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Permission & Security

**RFC-TSIX-EDU-002** | Modul keenam kurikulum TSIX. Memahami model izin rwx, setuid bit, root bypass, dan kelemahan yang diketahui pada sistem permission TSIX.

> PermissionManager adalah "satpam" kernel. Semua akses file melewati cek berlapis: root bypass → owner → group → others. Ditambah setuid bit untuk binary istimewa seperti `login` dan `sudo`.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan urutan cek izin (root → owner → group → others)
- [ ] Menjelaskan bit permission `r=4, w=2, x=1`
- [ ] Membaca matriks izin dan mode contoh (`600`, `644`, `755`, `4755`) beserta nilai decimalnya
- [ ] Menjelaskan setuid bit (`0o4000` = 2048) dan penanganannya saat `EXEC`
- [ ] Menjelaskan mengapa `parseMode("4755")` bernilai 2541 (decimal)
- [ ] Menjelaskan aturan `CHMOD` (owner atau root) vs `CHOWN` (root saja)
- [ ] Menjelaskan kelemahan privilege berbasis nama app dan mitigasinya

---

## Konsep Inti

### Cek rwx berlapis

```
check(pcb, node, requested):
  1. root (uid 0)        → true (God Mode)
  2. owner (uid == node.uid) → bit owner   ((mode >> 6) & 0x7)
  3. group (gid match)        → bit group   ((mode >> 3) & 0x7)
  4. others                   → bit others  (mode & 0x7)
```

![Alur cek izin PermissionManager (root → owner → group → others)](/wiki/diagram/Keamanan-dan-Sandboxing-3.png)
*Sumber: [`wiki/diagram/Keamanan-dan-Sandboxing-3.mmd`](/wiki/diagram/Keamanan-dan-Sandboxing-3.mmd)*

### Matriks izin rwx

Satu mode = **3 digit octal**, masing-masing untuk kelas owner, group, dan others. `check()` menggeser bit sesuai kelas:

| Kelas | Perhitungan di `check()` | Bit | Contoh `644` (decimal 420) |
|---|---|---|---|
| **owner** (user) | `(mode >> 6) & 0x7` | r=4, w=2, x=1 | digit `6` → `rw-` |
| **group** | `(mode >> 3) & 0x7` | r=4, w=2, x=1 | digit `4` → `r--` |
| **others** | `mode & 0x7` | r=4, w=2, x=1 | digit `4` → `r--` |

### Encode permission

| Bit | Nilai | Makna |
|---|---|---|
| r (read) | 4 | Membaca konten |
| w (write) | 2 | Menulis / mengubah |
| x (execute) | 1 | Mengeksekusi |

Kombinasi bit per digit octal (dipakai dalam tabel mode di bawah):

| Digit | Biner | rwx | Arti |
|---|---|---|---|
| `0` | 000 | `---` | tanpa akses |
| `1` | 001 | `--x` | execute |
| `2` | 010 | `-w-` | write |
| `3` | 011 | `-wx` | write + execute |
| `4` | 100 | `r--` | read |
| `5` | 101 | `r-x` | read + execute |
| `6` | 110 | `rw-` | read + write |
| `7` | 111 | `rwx` | read + write + execute |

### Mode umum & nilai decimal

Mode disimpan sebagai **decimal di SQLite** (bukan string octal). `parseMode("4755")` = `parseInt("4755", 8)` = **2541** (decimal) — inilah nilai yang dipakai `init.ts` saat `chmod("/bin/passwd.js", 2541)`.

| Mode | Octal | Decimal | owner | group | others | Contoh penggunaan |
|---|---|---|---|---|---|---|
| `600` | `0o600` | 384 | `rw-` | `---` | `---` | file pribadi: `/etc/shadow`, kunci SSH |
| `644` | `0o644` | 420 | `rw-` | `r--` | `r--` | file teks biasa (mode default `touch` di syscall `OPEN`) |
| `755` | `0o755` | 493 | `rwx` | `r-x` | `r-x` | direktori & binary (mode default `mkdir`) |
| `4755` | `0o4755` | 2541 | `rws` | `r-x` | `r-x` | binary setuid: `/bin/passwd.js`, `/bin/sudo.js` |

> `s` pada posisi owner = **setuid bit aktif** (`0o4000` = 2048), bukan `x` biasa.
> Nilai decimal dikonfirmasi test `A5.10` (`644` → 420, `755` → 493) dan `A5.13` (`4755 & 0o4000`).

### SetUID bit (`0o4000`)

SetUID = eksekusi sebagai **pemilik file**, bukan pemanggil. Contoh:

- `/bin/passwd.js` → `chmod 2541` (0o4755): user biasa menjalankan passwd, proses berjalan sebagai root agar bisa mengubah `/etc/shadow`.
- `/bin/sudo.js` → sama.

**Penanganan saat `EXEC`** (di `Syscalls.ts`): bit `0o4000` = **2048** (decimal). Saat mengeksekusi binary, kernel mengecek `node.mode & 2048`. Jika aktif, `targetUid = node.uid` dan `targetGid = node.gid`; proses baru lahir dengan uid/gid pemilik file, sementara `ruid` (real UID) tetap milik pemanggil. Lihat snippet di bawah.

> Catatan: runtime mengeksekusi sidecar `.js`, jadi SetUID harus dipasang di `/bin/*.js`, bukan source `.ts`-nya. Inilah yang dilakukan `init.ts`: `lib.fs.chmod("/bin/passwd.js", 2541)` dan `lib.fs.chmod("/bin/sudo.js", 2541)`. `rc.local.ts` juga memasang `chmod("/bin/login.js", 0o4755)`.

Urutan POSIX saat login: `setgroups → setgid → setuid` (harus urut ini agar group benar). Terlihat di `login.ts`: `setgroups(supplementaryGids) → setgid(gid) → setuid(uid)`.

---

## Snippet (level kode)

### PermissionManager.check()

```ts
public check(pcb: PCB, node: any, requested: Permission): boolean {
    if (pcb.uid === 0) return true;            // 1. root bypass

    const mode = node.mode;                    // decimal di SQLite

    if (pcb.uid === node.uid) {                // 2. owner
        const userMode = (mode >> 6) & 0x7;
        if ((userMode & requested) === requested) return true;
    }

    if (pcb.gid === node.gid || (pcb.groups && pcb.groups.includes(node.gid))) {
        const groupMode = (mode >> 3) & 0x7;   // 3. group
        if ((groupMode & requested) === requested) return true;
    }

    const otherMode = mode & 0x7;              // 4. others
    if ((otherMode & requested) === requested) return true;

    return false;
}

public static parseMode(octal: string | number): number {
    return parseInt(octal.toString(), 8);      // "4755" → 2541
}
```

### EXEC — penegakan izin & setuid (Syscalls.ts)

```ts
// 1. Cek x bit dulu — tanpa izin eksekusi, langsung ditolak
if (!this.satpam.check(pcb, node, Permission.EXECUTE)) {
  throw new Error(`Permission Denied: Cannot execute ${absoluteExecPath}`);
}

let targetUid = pcb.uid;
let targetGid = pcb.gid;
let targetOwner = pcb.owner;

// 2. SETUID BIT SUPPORT (0o4000 = 2048)
if (node && node.mode & 2048) {
  targetUid = node.uid;        // eksekusi sebagai pemilik file
  targetGid = node.gid;
  if (targetUid === 0) targetOwner = "root";
  this.logger.info(
    `SetUID Execution detected for ${absoluteExecPath}: Running as UID ${targetUid}`,
  );
}

// 3. Proses baru lahir dengan uid/gid target; ruid (real UID) dipertahankan
const newPcb = this.scheduler.createProcess(binaryName, {
  // ...
  uid: targetUid,
  gid: targetGid,
  ruid: pcb.ruid, // Preserve Real UID
  owner: targetOwner,
  // ...
});
```

> Jalur ini adalah kunci keamanan `/bin/login.js`, `/bin/passwd.js`, dan `/bin/sudo.js`: user biasa tidak bisa setuid langsung, tapi mengeksekusi binary setuid root membuat proses berjalan sebagai `uid 0`.

### OPEN — read vs write (Syscalls.ts)

```ts
const requiredPerm =
  flags.includes("w") || flags.includes("+")
    ? Permission.WRITE
    : Permission.READ;

const node = vfs.stat(relativePath);

if (node) {
  // File sudah ada → cek izin file itu sendiri
  if (!this.satpam.check(pcb, node, requiredPerm)) {
    throw new Error(
      `Permission Denied: Cannot open ${absoluteOpenPath} for ${Permission[requiredPerm]}`,
    );
  }
} else if (requiredPerm === Permission.WRITE) {
  // File belum ada → cek WRITE ke direktori parent, lalu buat mode 420 (644)
  // ...
  vfs.touch(relativePath, "", pcb.uid, pcb.gid, 420); // 644 equivalent
}
```

### CHMOD — ubah mode (Syscalls.ts)

```ts
case SyscallCode.CHMOD: {
  const { path: argPath, mode } = args as { path: string; mode: number };
  const absolutePath = PathResolver.resolve(pcb.cwd, argPath);

  if (absolutePath.startsWith("/dev/")) {
    if (!this.isRoot(pcb)) return false;   // chmod /dev/* → root only
    const devName = absolutePath.replace("/dev/", "");
    const device = this.kernel.devices[devName];
    if (!device) return false;
    device.mode = mode;
    return true;
  }

  const { vfs, relativePath } = this.mountManager.resolve(absolutePath);
  const node = vfs.stat(relativePath);
  if (!node) return false;
  if (pcb.uid !== 0 && pcb.uid !== node.uid) return false; // root ATAU owner
  return vfs.chmod(relativePath, mode);
}
```

> Aturan `CHMOD`: file biasa boleh diubah **owner-nya sendiri atau root**. Diverifikasi test `A5.11`.

### CHOWN — ubah owner/group (Syscalls.ts)

```ts
case SyscallCode.CHOWN: {
  const {
    path: argPath,
    uid: targetUid,
    gid: targetGid,
  } = args as { path: string; uid: number; gid: number };
  const absolutePath = PathResolver.resolve(pcb.cwd, argPath);

  if (absolutePath.startsWith("/dev/")) {
    if (!this.isRoot(pcb)) return false;   // chown /dev/* → root only
    // ...
  }

  if (!this.isRoot(pcb)) return false;     // chown file → ROOT SAJA
  const { vfs, relativePath } = this.mountManager.resolve(absolutePath);
  return vfs.chown(relativePath, targetUid, targetGid);
}
```

> Aturan `CHOWN`: **hanya root** yang boleh mengganti owner file (test `A5.15`). Berbeda dari `CHMOD` yang juga boleh dilakukan oleh owner.

---

## Kelemahan yang Diketahui

> [!WARNING] **Privilege berbasis nama app (rapuh).**
> Di `WorkerEntry.ts`, `restrictHostAPI(appName)` menandai app sebagai "privileged" jika **substring** namanya (setelah `toLowerCase()`) mengandung salah satu dari:
>
> ```ts
> const isPrivileged = appName.toLowerCase().includes("server") ||
>     appName.toLowerCase().includes("daemon") ||
>     appName.toLowerCase().includes("dome") ||
>     appName.toLowerCase().includes("tbuild") ||
>     appName.toLowerCase().includes("vfs") ||
>     appName.toLowerCase().includes("mysqld");
> ```
>
> App privileged mendapat **allow-list modul host**:
>
> ```ts
> const allowedModules = ["http", "ws", "path", "fs", "url", "esbuild", "crypto", "os", "bcryptjs", "mysql2", "mysql2/promise"];
> ```

**Skenario eksploitasi (contoh):**

1. Attacker meng-upload app bernama `evil-daemon` (nama mengandung `daemon`).
2. Saat dieksekusi, `isPrivileged = true` → `global.require = privilegedRequire`.
3. App kini bisa `require("fs")`, `require("crypto")`, `require("http")`, dst. — modul Node.js **host langsung**, bukan syscall TSIX.
4. Dengan `fs`, attacker bisa membaca file di luar sandbox VFS TSIX (mis. `/etc/shadow` host Linux) → **escape sandbox**.

> [!IMPORTANT] **Mitigasi.**
> - **Jangka panjang (arsitektural):** ganti heuristik substring dengan **capability-based** — daftar eksplisit pasangan `appName → capabilities` (atau manifes per-app).
> - **Sekarang (defense-in-depth):** meski app "privileged" di sandbox, kernel tetap punya `PermissionManager` + `validateArgs` + `SETUID` root-only. Nama app hanya membuka pintu modul host — **bukan** akses kernel penuh; setiap syscall tetap diperiksa per-invocation di sisi kernel.

---

## Latihan / Praktik

1. Jalankan `ls -l /bin/passwd.js` — amati bit setuid (`s`) pada mode owner (mode `rwsr-xr-x`).
2. Jalankan `stat /bin/passwd.js` — cek nilai mode decimal (harus `2541` = `0o4755`).
3. Jalankan `chmod 755 /bin/passwd.js` lalu `ls -l` lagi — bit `s` hilang; `init` akan memasangnya kembali (`init.ts`).
4. Sebagai user non-root, coba baca `/etc/shadow` — amati error permission.
5. Sebagai user non-root, jalankan `chown root /tmp/foo` — amati error (hanya root yang boleh chown); lalu `chmod 600 /tmp/foo` — harus berhasil karena owner boleh chmod.
6. Baca `src/kernel/PermissionManager.ts` dan `src/kernel/Syscalls.ts` — temukan semua titik panggil `satpam.check()`.
7. Baca `src/userland/WorkerEntry.ts` → fungsi `restrictHostAPI` — uji: jalankan app bernama `evil-daemon` yang memanggil `require("fs")`, bandingkan dengan app bernama `hitung` biasa.

---

## Referensi

- `wiki/Keamanan-dan-Sandboxing.md` — model keamanan lengkap
- `wiki/course/00-overview.md` §4.3 (model ring & batas privilege)
- `src/kernel/PermissionManager.ts` — implementasi `check()` & `parseMode()`
- `src/kernel/PermissionManager.test.ts` — test A5.1–A5.30 (rwx, chmod, chown, umask, setuid, sudo)
- `src/kernel/Syscalls.ts` — penegakan izin OPEN/EXEC/CHMOD/CHOWN + setuid di EXEC
- `src/userland/WorkerEntry.ts` — sandbox `restrictHostAPI` (privilege berbasis nama)
- `src/mirror/bin/init.ts`, `src/mirror/bin/rc.local.ts` — pemasangan bit setuid
- `src/mirror/bin/login.ts`, `src/mirror/bin/sudo.ts` — alur setgroups/setgid/setuid

---

*Modul 06 — selesai. Lanjut ke [Modul 07 — Mount & Path Resolution](07-mount-path-resolution.md).*
