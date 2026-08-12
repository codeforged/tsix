---
module: 14
title: Userland: init, login, shell, app
part: V
partTitle: Interaksi Manusia
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Userland: init, login, shell, app

**RFC-TSIX-EDU-002** | Modul keempat belas kurikulum TSIX. Memahami lapisan aplikasi: PID 1 (init), login, shell, dan dua gaya penulisan aplikasi TSIX.

> Semua userland berjalan di Worker Thread (Ring 4) — termasuk PID 1. Tidak ada inittab: logika init **hardcoded** di `init.ts`.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan peran init (PID 1) tanpa inittab
- [ ] Menjelaskan alur login: passwd+shadow(bcrypt) → setgroups→setgid→setuid
- [ ] Menjelaskan dua gaya aplikasi: `IProgram` vs `Program()` wrapper
- [ ] Menjelaskan konsep "error = window" (`std.error`)
- [ ] Menjelaskan peran `monitorProcess` (respawn login)

---

## Konsep Inti

### Init (PID 1)

Tidak ada `/etc/inittab` — seluruh keputusan init di-hardcode di `src/mirror/bin/init.ts` (class `Init`). Urutan eksekusi:

1. **Enforce setuid** — `chmod("/bin/passwd.js", 2541)` dan `chmod("/bin/sudo.js", 2541)`. Nilai `2541` (desimal) sama dengan `0o4755` (setuid root + rwxr-xr-x). Targetnya `.js`, bukan `.ts`, karena runtime mengeksekusi sidecar `.js`.
2. **RSA identity** — cek `/etc/keys/rsa/id_rsa.pub`. Jika tidak ada, `SecurityAgent.generateKeyPair()` membuat kunci baru (RSA 2048-bit) lalu disimpan ke `/etc/keys/rsa/`. Jika sudah ada, kunci diverifikasi. Fingerprint SHA256 diambil via `shell.getFingerprint()`, dan bar warna identitas (`SecurityAgent.generateVisualIdentity`) dikirim ke TTY via `std.ioctl(1, 33, colorBar)` — ioctl 33 = `SET_VISUAL_IDENTITY`.
3. **Exec `rc.local`** — jalankan `/etc/rc.local.js` lalu `waitpid`. Exit code `0` = startup berhasil; selain itu dicatat sebagai peringatan.
4. **Spawn login TTY2–6** — `for (let i = 2; i <= 6; i++) spawnLogin(i)`. Setiap proses login di-*monitor* oleh `monitorProcess` (respawn + delay 1s anti-crash-loop).
5. **Spawn login TTY1** (foreground) — dilakukan setelah banner dan fingerprint.
6. **Loop selamanya** — `while (true) { await new Promise(r => setTimeout(r, 10000)); }`. Init tidak boleh exit; jika PID 1 mati, kernel melakukan `process.exit(exitCode)` (keepAlive, `1` = reboot).

### Login

`src/mirror/bin/login.ts` — satu proses login per TTY, di-spawn oleh init. Alur inti:

1. Baca `/etc/passwd` → cari entri user → ambil `uid` (field 3), `gid` (field 4), `home` (field 6), `shell` (field 7).
2. Baca `/etc/shadow` → ambil hash bcrypt (field 2) → `bcrypt.compareSync(password, hash)`.
3. Baca `/etc/group` → kumpulkan *supplementary groups* (grup yang memuat username, selain gid primer).
4. `setgroups` → `setgid` → `setuid` — **urutan POSIX wajib**. GID harus diganti sebelum UID; setelah UID menjadi non-root, proses kehilangan privilege untuk mengubah GID.
5. Set env `USER`/`HOME`, `chdir(home)`, lalu `exec` shell — shell diambil dari `/etc/passwd` field 7 (umumnya `tsh`).

### Login WM (Asteracea) — mode GUI

TTY login (`login.ts`) di-spawn ulang sebagai proses root per TTY, jadi selalu bisa baca `/etc/shadow` & `setuid`. Berbeda dengan itu, **WM (Asteracea) adalah SATU proses yang merangkap login manager + desktop session**:

- WM start sebagai root (di-spawn init), lalu setelah login pertama **drop privilege permanen** ke user yang login.
- Akibatnya saat logout → login ulang (mis. sebagai root), WM sudah non-root → **dua masalah**:
  1. Tidak bisa baca `/etc/shadow` (0640 root) → verifikasi password gagal.
  2. Kernel menolak `setgroups`/`setgid`/`setuid` untuk non-root → tidak bisa ganti user.
- Solusinya (lihat Snippet):
  1. **Verifikasi via helper SetUID root** — `login.js --verify <user> <pass> <file>` (login.js sudah SetUID root) → hasil ditulis ke file temp (`OK`/`FAIL:...`), dibaca WM. Kanal file dipakai karena *exit code* anak tidak andal (WorkerEntry selalu menuntaskan dengan `exit(0)`).
  2. **Saved UID (kernel)** — `pcb.suid`. Saat WM drop dari root, kernel menyimpan `suid=0`; saat re-login, WM boleh `setuid(0)` untuk **restore** ke root, lalu drop ke user target. Ini mekanisme Saved UID ala Unix (`seteuid`/`setresuid`).
  3. **Urutan set identitas di WM** — jika WM belum root → `setuid(0)` dulu (restore), baru `setgroups` → `setgid` → `setuid(user target)` (urutan POSIX untuk drop).

> [!NOTE] **Keamanan Saved UID** — `suid` default di `createProcess` = UID proses itu sendiri, jadi **app biasa tidak mewarisi saved root** dan tidak bisa escalate. Hanya proses yang turun dari root (yaitu WM) yang punya "tiket kembali ke root".

### Shell (tsh)

`src/mirror/bin/tsh.ts` — shell interaktif, ditulis dengan gaya `IProgram` (`export class main implements IProgram`). Fitur utama:

- Prompt `user@hostname:cwd#/$` yang bisa dikustomisasi via env `PROMPT_FORMAT` (`&username`, `&hostname`, `&cwd`, `&usertype`).
- Line editor: raw mode, riwayat (panah atas/bawah), Tab completion, Ctrl+U, Home/End.
- Sebelum menjalankan perintah, shell beralih ke cooked mode agar perintah foreground dapat menerima SIGINT.
- `tsh <username>` — delegasi ke `/bin/login.js` (login adalah SetUID root, sehingga bisa autentikasi & ganti user).
- Resize (SIGWINCH / event `RESIZE`) memperbarui env `LINES`/`COLUMNS` tanpa menimpa layar aplikasi foreground.

### Dua gaya aplikasi

Ada dua gaya menulis aplikasi TSIX:

**1. Class `IProgram` (legacy mayoritas)** — export class `main` yang mengimplementasikan `IProgram`, dengan method `execute(lib, args)`. Semua API diakses lewat parameter `lib`:

```ts
export class main implements IProgram {
    async execute(lib: OSContext, args: string[]) {
        // ...
    }
}
```

Contoh: `ls`, `cat`, `ps`, `kill`, `tsh`.

**2. `Program()` wrapper + proxy singletons (baru)** — import singleton `std`, `fs`, `shell`, `net`, `db` dari `@tsix/Application`, lalu bungkus fungsi utama dengan `Program(fn)`:

```ts
import { Program, std, fs, shell, net } from "@tsix/Application";

export default Program(async (args) => {
    // ...
});
```

Contoh: `esp-send`, `dome`, `iot-dashboard`.

> [!NOTE] **Cara kerja `Program()`** — `Program(fn)` mengembalikan class anonim yang `implements IProgram`. Method `execute` menyimpan `OSContext` ke `global._tsixOsc`, memanggil `fn(args)`, dan jika `fn` melempar error, memanggil `std.error(error.stack, appName)` lalu me-re-throw. Singleton `std`/`fs`/`shell`/`net`/`db` adalah `Proxy` yang meneruskan akses ke `_tsixLib` pada thread saat ini. `os.pid` dan `os.rand` juga tersedia.

**Perbandingan kedua gaya:**

| Aspek | Class `IProgram` (legacy) | `Program()` wrapper (baru) |
|---|---|---|
| Bentuk | Class `main` + method `execute()` | Fungsi anonim dibungkus `Program(fn)` |
| Signature | `execute(lib: OSContext, args: string[])` | `fn(args: string[])` |
| Akses API | Lewat parameter `lib` (`lib.std`, `lib.fs`, ...) | Import proxy singleton (`std`, `fs`, `shell`, `net`, `db`) |
| Argumen | Parameter kedua | Parameter tunggal fungsi |
| Error handling | Manual (try/catch sendiri) | Otomatis → `std.error()` lalu re-throw |
| Implementasi | `implements IProgram` langsung | `Program()` mengembalikan class `implements IProgram` |
| Contoh | `ls`, `cat`, `ps`, `kill`, `tsh` | `esp-send`, `dome`, `iot-dashboard` |

### Error = "Window"

`std.error()` melakukan 4 hal:

1. Tulis ke `/var/log/syslog`.
2. Cari `fileHint` dari stack trace (melewati `UserLib`, `Application`, `emerald`).
3. Broadcast ke parent via IPC — pesan `{ type: "GUI_WINDOW_ERROR", wid, pid, file, error, context, timestamp }`.
4. Print ke TTY dengan warna merah `[ERROR]`.

Jadi ketika aplikasi crash, **window error muncul di desktop** — bukan hanya teks di terminal.

## Alur / Cara Kerja

### Boot: Kernel → init (PID 1)

```
Kernel (main.ts) — kernel.runInit()
  resolve /bin/init.js
  createProcess("init", fds:[tty1×3])   → PID 1
  setForegroundProcess(1, 1)

[init.ts — Worker Thread, Ring 4]
  1. Enforce setuid
       chmod /bin/passwd.js  2541   (0o4755)
       chmod /bin/sudo.js    2541
  2. RSA identity
       cek /etc/keys/rsa/id_rsa.pub
         ada       → verify + fingerprint
         tidak ada → generateKeyPair() → simpan id_rsa + id_rsa.pub
       fingerprint + color bar → ioctl(1, 33, colorBar)  (SET_VISUAL_IDENTITY)
  3. Exec /etc/rc.local.js + waitpid
  4. for (i = 2; i <= 6; i++) spawnLogin(i)
       exec /bin/login.js (ttyId=i)
       monitorProcess → respawn saat login mati (delay 1s anti-crash-loop)
  5. Banner ASCII + fingerprint color bar
  6. spawnLogin(1)   ← foreground TTY1
  7. while (true) { sleep 10s }   ← init tidak boleh exit
```

### Login: TTY → shell

```
login.ts (satu proses per TTY)
  1. username = args[0] || readLine("Username: ")
  2. password = readPassword("Password:🔑")   ← masked, raw mode
  3. /etc/passwd → uid(3), gid(4), home(6), shell(7)
  4. /etc/shadow → hash bcrypt (field 2)
  5. bcrypt.compareSync(password, hash)
       gagal → "Login: Invalid username or password" → ulangi dari langkah 1
  6. MOTD: /etc/motd + frasa acak /etc/motd.json
  7. /etc/group → supplementary gids (grup yang memuat username)
  8. setgroups(gids) → setgid(gid) → setuid(uid)   ← urutan POSIX
  9. setenv USER / HOME → chdir(home)
  10. exec(shell dari /etc/passwd) → waitpid → break (satu sesi)
```

### Login WM: GUI → desktop

```
asteracea.ts (satu proses = login manager + desktop)
  1. WM start sebagai root (di-spawn init)
  2. Tampil login screen (GUI)
  3. Verifikasi: spawn /bin/login.js --verify <user> <pass> <file>  ← SetUID root
       baca hasil file: "OK" / "FAIL:..."
  4. /etc/passwd → uid(3), gid(4), home(6)   ← world-readable, baca langsung
  5. /etc/group → supplementary gids
  6. Kalau WM belum root (sudah pernah login non-root) → setuid(0)  ← restore via Saved UID
  7. setgroups(gids) → setgid(gid) → setuid(uid)   ← urutan POSIX (drop)
  8. setenv USER / HOME → chdir(home)
  9. Tampil desktop — WM JADI user tsb (taskbar, launcher, wallpaper)
  10. Logout → kembali ke langkah 2 (WM tetap hidup; identitas di-reset via Saved UID)
```

## Kode Sumber

| File | Peran |
|---|---|
| `src/mirror/bin/init.ts` | PID 1 — init hardcoded (setuid, RSA, rc.local, spawn login) |
| `src/mirror/bin/login.ts` | Autentikasi passwd+shadow (bcrypt) → setgroups/setgid/setuid → exec shell |
| `src/mirror/bin/tsh.ts` | Shell interaktif (gaya `IProgram`) |
| `src/mirror/opt/asteracea/asteracea.ts` | WM + login manager GUI — verifikasi via `login.js --verify`, re-elevate via Saved UID |
| `src/mirror/lib/UserLib.ts` | Framework: `std`, `fs`, `shell`, `net`, `db` (sub-library) |
| `src/mirror/lib/Application.ts` | `Program()` wrapper + proxy singleton |
| `src/mirror/lib/IProgram.ts` | Interface `IProgram` & `OSContext` |

---

## Snippet (level kode)

Semua snippet di bawah disalin dari sumber — *kode adalah kebenaran*.

### Init — enforce setuid

```ts
// Runtime mengeksekusi sidecar .js (bukan source .ts),
// jadi chmod harus di .js. Nilai 2541 = 0o4755 (setuid root).
await lib.fs.chmod("/bin/passwd.js", 2541);
await lib.std.print(`${ok} [INIT] SetUID bit applied to: /bin/passwd.js\n`);
await lib.fs.chmod("/bin/sudo.js", 2541);
await lib.std.print(`${ok} [INIT] SetUID bit applied to: /bin/sudo.js\n`);
```

> `ok` adalah prefix berwarna hijau `[  OK  ]` yang didefinisikan di awal `execute()` di `init.ts`.

### Init — spawnLogin (TTY2-6)

```ts
const spawnLogin = async (ttyId: number) => {
    try {
        if (ttyId > 1)
            await lib.std.print(`${ok} Initializing session on TTY${ttyId}...\n`);
        const result = await lib.shell.exec("/bin/login.js", [], undefined, undefined, ttyId);
        if (result && result.pid) {
            terminals.set(ttyId, result.pid);
            await lib.std.log(`Login service spawned on TTY${ttyId} (PID ${result.pid})`, "init");
            // Kita nungguin di background (thread terpisah di Worker)
            this.monitorProcess(lib, ttyId, result.pid, spawnLogin);
        }
    } catch (e: any) {
        await lib.std.print(`Init: Error spawning login on TTY${ttyId}: ${e.message}\n`);
    }
};

// Start login on all TTYs (TTY2-6)
for (let i = 2; i <= 6; i++) {
    await spawnLogin(i);
}
```

### Init — monitorProcess (respawn anti-crash-loop)

```ts
private async monitorProcess(
    lib: UserLib, ttyId: number, pid: number,
    respawn: (tty: number) => Promise<void>,
) {
    const exitCode = await lib.shell.waitpid(pid);
    await lib.std.print(
        `Init: Process on TTY${ttyId} (PID ${pid}) exited with code ${exitCode}. Respawning...\n`,
    );
    // Delay sedikit biar nggak spam kalau crash loop
    await new Promise(r => setTimeout(r, 1000));
    await respawn(ttyId);
}
```

### Login — verifikasi bcrypt

```ts
// 1. Cari user di /etc/passwd → uid, gid, home, shell
const parts = userEntry.split(":");
const uid = parseInt(parts[2]);
const gid = parseInt(parts[3]);
const home = parts[5];
const userShell = parts[6];   // shell dari /etc/passwd field 7

// 2. Ambil hash dari /etc/shadow → bcrypt.compareSync
const hash = shadowEntry.split(":")[1];
const match = bcrypt.compareSync(password, hash);
if (!match) {
    await lib.std.print("Login: Invalid username or password\n");
    continue;   // kembali ke loop → prompt ulang
}
```

### Login — setgroups → setgid → setuid (urutan POSIX)

```ts
// 3.5. Resolve Supplementary Groups dari /etc/group
const supplementaryGids: number[] = [gid]; // dimulai dari primary gid
try {
    const groupContent = await lib.fs.readFile("/etc/group") || "";
    const groupLines = groupContent.split("\n")
        .map(l => l.trim()).filter(l => l.length > 0);
    for (const gLine of groupLines) {
        const gParts = gLine.split(":");
        const groupGid = parseInt(gParts[2]);
        const groupUsers = gParts[3] ? gParts[3].split(",") : [];
        if (groupUsers.includes(username.trim()) && groupGid !== gid) {
            supplementaryGids.push(groupGid);
        }
    }
} catch (e) {
    // Ignore group errors
}

// Set Identity — GID harus SEBELUM UID.
// Setelah UID menjadi non-root, proses kehilangan privilege untuk mengubah GID.
await lib.shell.setgroups(supplementaryGids);
await lib.shell.setgid(gid);
await lib.shell.setuid(uid);

// Set Env + exec shell
await lib.shell.setenv("USER", username.trim());
await lib.shell.setenv("HOME", home);
await lib.shell.chdir(home);
const result = await lib.shell.exec(userShell);   // shell dari /etc/passwd
if (result && result.pid) {
    await lib.shell.waitpid(result.pid);
}
```

### Login WM — verifikasi via login.js --verify (kanal file)

```ts
// asteracea.ts — verifikasi password lewat helper SetUID root.
// WM non-root tidak bisa baca /etc/shadow (0640 root) → delegasikan ke login.js.
const verifyOut = `/tmp/verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
let authOk = false;
const vp = await shell.exec("/bin/login.js", ["--verify", u, password, verifyOut]);
if (vp && vp.pid) {
    await shell.waitpid(vp.pid);                     // tunggu selesai
    const res = (await fs.readFile(verifyOut)) || "";
    authOk = String(res).trim() === "OK";            // "OK" / "FAIL:..."
}
await fs.unlink(verifyOut);                          // bersihkan temp
```

```ts
// login.ts — sisi helper (dijalankan sebagai SetUID root, jadi bisa baca shadow)
if (args[0] === "--verify") {
    const vUser = (args[1] || "").trim();
    const vPass = args[2] || "";
    const vOut  = args[3] || "/tmp/verify-result.txt";
    let ok = false, errMsg = "";
    try {
        const shadow = (await lib.fs.readFile("/etc/shadow")) || "";
        const entry = shadow.split("\n").map(l => l.trim()).filter(l => l)
            .find(l => l.split(":")[0] === vUser);
        const hash = entry ? entry.split(":")[1] : "";
        ok = !!hash && bcrypt.compareSync(vPass, hash);
        if (!hash) errMsg = "account not found or no password";
    } catch (e) { errMsg = e.message || "verify error"; }
    await lib.fs.writeFile(vOut, ok ? "OK" : "FAIL:" + errMsg);
    return;   // selesai — WorkerEntry yang menuntaskan proses
}
```

### Saved UID (kernel) — setuid boleh restore ke suid

```ts
// Syscalls.ts — SETUID dengan Saved UID (mirip setuid/seteuid Unix)
if (this.isRoot(pcb)) {
    pcb.suid = pcb.uid;   // root bebas ganti UID; simpan hak kembali (0 utk root)
    pcb.uid = newUid;
    pcb.ruid = newUid;
} else if (newUid === pcb.suid) {
    pcb.uid = newUid;     // non-root hanya boleh RESTORE ke Saved UID (mis. balik ke root)
    pcb.ruid = newUid;
} else {
    throw new Error("Permission Denied: Only root or root group members can change UID");
}

// Scheduler.ts — createProcess: suid default = uid proses itu sendiri
suid: options.suid ?? options.uid ?? 0,   // app biasa TIDAK bisa escalate
```

### App — gaya `IProgram` (legacy)

```ts
// greet.ts — gaya klasik: class main implements IProgram
import { IProgram, OSContext } from "@tsix/IProgram";

export class main implements IProgram {
    async execute(lib: OSContext, args: string[]): Promise<string | void> {
        const name = args[0] || "dunia";
        await lib.std.print(`Halo, ${name}!\n`);
        await lib.std.print(`CWD: ${await lib.shell.getcwd()}\n`);
    }
}
```

### App — gaya `Program()` wrapper (baru)

```ts
// halo.ts — gaya baru: Program() wrapper + proxy singleton
import { Program, std, os } from "@tsix/Application";

export default Program(async (args) => {
    const name = args[0] || "dunia";
    await std.print(`Halo, ${name}!\n`);
    await std.print(`PID: ${os.pid}\n`);
    return "Selesai.";
});
```

---

## Latihan / Praktik

1. Login sebagai `root`, lalu jalankan `ps` — identifikasi proses login per TTY (`/bin/login.js`).
2. Dari shell root, jalankan `tsh tamu` — amati delegasi login (setuid root) dan shell baru dengan user berbeda.
3. Baca `src/mirror/bin/login.ts` — trace urutan `setgroups`/`setgid`/`setuid` dan jelaskan kenapa urutan ini wajib.
4. Baca `src/mirror/bin/init.ts` — temukan `monitorProcess`; bunuh proses login di sebuah TTY (`kill <pid>` dari root) lalu amati init me-respawn dalam ±1 detik.
5. Tulis app gaya `IProgram` dan app gaya `Program()` — bandingkan struktur keduanya (lihat Snippet).
6. Buat app yang memanggil `std.error()` — amati munculnya window error di desktop (pesan `GUI_WINDOW_ERROR`).

---

## Referensi

- `wiki/Memulai.md`, `wiki/Perintah-Sistem.md`, `wiki/Panduan-Developer.md`
- `wiki/course/00-overview.md` §9 (Userland: init, shell, aplikasi)
- `src/mirror/bin/init.ts`, `src/mirror/bin/login.ts`, `src/mirror/bin/tsh.ts`
- `src/mirror/lib/UserLib.ts`, `src/mirror/lib/Application.ts`, `src/mirror/lib/IProgram.ts`

---

*Modul 14 — selesai. Bagian V tuntas. Lanjut ke [Modul 15 — Networking MQTNL](15-networking-mqtnl.md).*
