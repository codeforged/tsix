---
module: 24
title: Best Practices & Penulisan App
part: VIII
partTitle: Pengembangan
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Best Practices & Penulisan App

**RFC-TSIX-EDU-002** | Modul kedua puluh empat kurikulum TSIX. Menutup kurikulum dengan praktik terbaik: dua gaya app, error = window, tema, batching UPDATE_PROPS, dan Piagam Antigonon.

> Kurikulum selesai di sini. Modul ini adalah "kitab praktik" — kumpulan aturan yang menjaga aplikasi TSIX tetap konsisten, aman, dan mudah dipelihara.

---

## Tujuan Pembelajaran

- [ ] Membedakan dua gaya app (`IProgram` vs `Program()`)
- [ ] Menjelaskan "error = window" (std.error 4 langkah)
- [ ] Menjelaskan batching `UPDATE_PROPS`
- [ ] Menjelaskan Piagam Antigonon (4 aturan GUI)
- [ ] Menerapkan praktik terbaik pada app baru

---

## Konsep Inti

### Dua gaya aplikasi

**1. Class `main implements IProgram`** (gaya klasik, mayoritas di `/bin`):

Kontrak ada di `src/mirror/lib/IProgram.ts`:

```ts
export interface OSContext {
    std: StdLib;
    fs: FsLib;
    shell: ShellLib;
    aux: AuxLib;
}

export interface IProgram {
    execute(os: OSContext, args: string[]): Promise<string | void>;
}
```

Contoh minimal (pola `cat.ts` / `echo.ts`):

```ts
import { IProgram, OSContext } from "../lib/IProgram";

export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<string | void> {
        const { std } = os;
        await std.print("Hello from TSIX!\n");
        // void → WorkerEntry memanggil shell.exit(0)
    }
}
```

**2. `Program()` wrapper + proxy singletons** (baru, disarankan untuk app baru & GUI):

```ts
import { Program, std } from "@tsix/Application";

export const main = Program(async (args: string[]) => {
    await std.print("Hello from TSIX!\n");
});
```

> Keuntungan alias: **path independence** — import tetap sama di mana pun file diletakkan (`/bin/`, `/root/test/`, dst). Menghilangkan error "Module not found" saat pindah folder.

**Perbandingan dua gaya:**

| Aspek | `main implements IProgram` | `Program()` wrapper |
|---|---|---|
| Import | `import { IProgram, OSContext } from "../lib/IProgram"` | `import { Program, std, fs, shell, net, db } from "@tsix/Application"` |
| Entry point | `async execute(os: OSContext, args)` | fungsi callback `async (args) => ...` |
| Akses library | `os.std`, `os.fs`, `os.shell`, `os.aux` | proxy singleton `std`, `fs`, `shell`, `net`, `db` |
| Path | import relatif ke lokasi file | import absolut `@tsix/*` — path independent |
| Error handling | manual (WorkerEntry menangkap error lain → `realExit(1)`) | otomatis: wrapper tangkap error → `std.error()` → rethrow |
| Cocok untuk | utilitas CLI di `/bin` | app baru, GUI (Emerald), daemon |

**Cara kerja wrapper** (`src/mirror/lib/Application.ts`): `Program(fn)` mengembalikan class yang `implements IProgram`. Saat `execute` dipanggil, ia menyimpan `OSContext` ke `global._tsixOsc` lalu memanggil `fn(args)`. Jika `fn` melempar error, wrapper mengirim error itu ke parent via `std.error()` (menjadi window error di desktop), lalu melempar ulang agar WorkerEntry turut menangani. Proxy `std`/`fs`/`shell`/`net`/`db` membaca `UserLib` dari `global._tsixLib` secara lazy — itulah kenapa import-nya path-independent.

### Error = "Window"

Jangan biarkan app crash diam-diam. `std.error(message, context?, wid?)` menampilkan error sebagai **window popup di desktop** (diproses WM/Asteracea). Alur 4 langkah (lihat `StdLib.error()` di `src/mirror/lib/UserLib.ts`):

1. **Log ke syslog** — tulis baris `[ERROR]` + timestamp ke `/var/log/syslog`.
2. **Ekstrak `fileHint`** — baca stack trace, cari file sumber pertama yang bukan library internal (`UserLib`, `Application`, `emerald`).
3. **Broadcast ke parent (WM)** — kirim IPC `GUI_WINDOW_ERROR` berisi `{ wid, pid, file, error, context, timestamp }` ke parent process; Asteracea menampilkannya sebagai popup.
4. **Print TTY merah** — cetak `\x1b[31m[ERROR]\x1b[0m <message>` ke terminal (stderr style).

Setiap langkah non-fatal — jika salah satu gagal (mis. syslog belum ada), langkah lain tetap jalan.

### Batching UPDATE_PROPS

Jangan kirim satu `UPDATE_PROPS` per perubahan properti. **Batch** beberapa perubahan lalu kirim bersamaan — mengurangi jumlah IPC dan latency render. Di Emerald (`src/mirror/lib/emerald.ts`, class `Window`) mekanismenya sudah otomatis:

- `updateProps(targetId, props)` tidak langsung mengirim — perubahan di-merge ke `dirtyProps` (Map), lalu `scheduleFlush()` dijadwalkan.
- `scheduleFlush()` memakai `setTimeout(..., 0)`: semua perubahan dalam satu async tick dikumpulkan dulu, baru di-flush di akhir tick. Jika sudah ada flush terjadwal, tidak ada jadwal ganda.
- `flushNow()` mengirim semua `UPDATE_PROPS` tertunda sekaligus.
- `Screen.update()` / `setText()` / `setVisible()` / `setStyle()` semuanya memakai jalur batch ini.
- `setContent()` sengaja **tidak** di-batch (kirim langsung via `sendImmediate`) — satu operasi atomik `innerHTML=""` lalu `MOUNT_NODE` per child.
- `Screen.on()` memanggil `flush()` otomatis setelah bind — memastikan listener terpasang di browser.

Praktik terbaik: jangan menulis loop `for (...) await app.update(id, props)` dengan harapan terkirim per item — Emerald sudah menggabungkannya untuk Anda.

### Piagam Antigonon (4 aturan GUI)

Piagam Antigonon adalah aturan strict untuk AI agent & developer yang menulis GUI TSIX (sumber: `wiki/PIXELSPACE_DEVELOPER_GUIDE.md`):

1. **NO DOM di Userland** — `@tsix/emerald` TIDAK boleh menyentuh `document.*` atau `window.*`. Semua rendering lewat protokol PixelSpace (Worker → Kernel → DOME → Browser).
2. **State-Sync** — Jangan kirim `UPDATE_PROPS` dalam tight loop; gunakan batching.
3. **Memory Cleanup** — Setiap node yang di-unmount, bersihkan event listener-nya (cegah kebocoran memori).
4. **Type Safety** — Semua payload harus sesuai `IGUIPayload`; payload cacat → `SIGKILL`.

> [!TIP]
> Dua praktik berdekatan yang tak kalah penting: pasang listener **mount-time** (`onClickId`/`onInputId` di props saat build, bukan `app.on()` setelah mount) untuk menghindari bug `cloneNode` (Modul 19 & 20), serta jaga UI agar **state replay** aman setelah F5 (Modul 22).

---

## Alur / Cara Kerja

Langkah menulis app TSIX yang benar (gaya `Program()`):

1. **Pilih gaya** — utilitas CLI singkat: `main implements IProgram`. App baru & GUI: `Program()`.
2. **Tulis entry point** — `export const main = Program(async (args) => {...})` (atau `export class main implements IProgram`).
3. **Deklarasikan mode GUI** (jika app menampilkan window) — `export const appMode = "gui";` agar WorkerEntry menangani GUI.
4. **Akses library via proxy** — `std`, `fs`, `shell`, `net`, `db` — import sekali dari `@tsix/Application`.
5. **GUI: pakai Emerald** — `new Screen({...})`, `app.mount(...)`, `app.on(...)`, `app.loopUntilClose()`.
6. **Error = window** — panggil `await std.error(msg, context)` saat gagal; jangan biarkan crash diam-diam.
7. **Tema** — `await theme.loadCurrent()` + `theme.watch()` agar warna mengikuti prefs Asteracea.
8. **Batch update** — serahkan batching ke Emerald; jangan kirim `UPDATE_PROPS` per item.
9. **Patuhi Piagam Antigonon** — tanpa DOM langsung, tanpa tight loop, cleanup listener, payload sesuai `IGUIPayload`.

## Kode Sumber

| File | Isi |
|---|---|
| `src/mirror/lib/IProgram.ts` | Kontrak `IProgram` & `OSContext` |
| `src/mirror/lib/Application.ts` | `Program()` wrapper + proxy singletons (`std`, `fs`, `shell`, `net`, `db`) |
| `src/mirror/lib/UserLib.ts` | `StdLib` (`print`, `log`, `error`), `FsLib` |
| `src/mirror/lib/emerald.ts` | `Window`/`Screen`, batching `UPDATE_PROPS`, `bindHandler` |
| `src/mirror/lib/theme.ts` | `ThemeProvider` — `loadCurrent`, `watch`, `switchTo`, `applyToDome` |
| `src/mirror/bin/cat.ts`, `echo.ts` | Contoh gaya `IProgram` |
| `src/mirror/root/ps-sample2.ts`, `ps-sample3.ts` | Contoh `Program()` + Emerald |
| `src/mirror/opt/set-theme/set-theme.ts` | Contoh tema (switch dark/light) |
| `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` | Piagam Antigonon |

---

## Snippet (level kode)

### App CLI — gaya `IProgram` (readfile)

`execute(os, args)` memakai `os.std` / `os.fs` (kontrak `OSContext`). String yang dikembalikan akan dicetak WorkerEntry; `void` → `shell.exit(0)`:

```ts
import { IProgram, OSContext } from "../lib/IProgram";

export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<string | void> {
        const { std, fs } = os;
        if (args.length === 0) {
            return "Usage: readfile <path>"; // string return → dicetak WorkerEntry
        }
        const fd = await fs.open(args[0], "r"); // fd < 0 = gagal buka
        if (fd < 0) {
            await std.print(`Error: Cannot open ${args[0]}\n`);
            return;
        }
        const content = await fs.read(fd);
        await std.print(content ?? "");
        await fs.close(fd);
    }
}
```

> [!TIP]
> Untuk baca file sekali jalan, `FsLib` sudah menyediakan `readFile(path)` yang membungkus `open` → `read` → `close`.

### App CLI — gaya `Program()` (hello)

```ts
import { Program, std } from "@tsix/Application";

export const main = Program(async (args: string[]) => {
    await std.print(`Hello, ${args[0] ?? "world"}!\n`);
});
```

### `std.error` — error menjadi window

```ts
// Log syslog → ekstrak fileHint → broadcast GUI_WINDOW_ERROR → TTY merah
await std.error("Disk full", "myapp");
await std.error("Connection timeout", "net", app.wid); // wid opsional
```

Saat app memanggil ini, WM/Asteracea menampilkan popup error di desktop — bukan crash console.

### Tema — import & apply

```ts
import { theme } from "@tsix/theme";
import { Screen, div } from "@tsix/emerald";

// Muat tema aktif (terang/gelap) sesuai prefs Asteracea
await theme.loadCurrent();
theme.watch(); // ikut perubahan tema saat app berjalan

// Pakai warna terpusat — tanpa hardcode hex
const app = new Screen({ title: "App", width: 400, height: 300 });
await app.mount(
  div({
    id: "root",
    style: { background: theme.colors.bg, color: theme.colors.text },
  }),
);

// Ganti tema global + broadcast THEME_CHANGED ke DOME
await theme.switchTo("theme-light.json");
// Terapkan ke window ini (titlebar, border, shadow)
await theme.applyToDome(domePid, app.wid);
```

File tema berada di `/opt/asteracea/theme-*.json` (`theme-dark.json`, `theme-light.json`). Contoh lengkap: `src/mirror/opt/set-theme/set-theme.ts`.

---

## Latihan / Praktik

1. Tulis app "Hello" dalam dua gaya — bandingkan struktur & import.
2. Tambahkan `std.error()` di app yang sengaja crash — amati window error di desktop.
3. Refactor app GUI agar mem-batch UPDATE_PROPS — ukur perbedaan responsivitas.
4. Baca `wiki/DEVELOPER_GUIDE_SCRIPTING-V2.md` — kerjakan contoh script v2.1.

---

## Referensi

- `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` — Piagam Antigonon & panduan PixelSpace
- `wiki/DEVELOPER_GUIDE_SCRIPTING-V2.md`, `wiki/Panduan-Developer.md`
- `wiki/course/00-overview.md` §9
- `src/mirror/lib/IProgram.ts`, `src/mirror/lib/Application.ts`, `src/mirror/lib/UserLib.ts`
- `src/mirror/lib/emerald.ts`, `src/mirror/lib/theme.ts`
- `src/mirror/root/ps-sample2.ts`, `src/mirror/root/ps-sample3.ts`
- `src/mirror/opt/set-theme/set-theme.ts`, `src/mirror/opt/test/gui-demo.ts`, `src/mirror/opt/file-cruiser/file-cruiser.ts`
- `src/mirror/bin/cat.ts`, `src/mirror/bin/echo.ts`

---

*Modul 24 — selesai. Kurikulum TSIX lengkap! 🎉*
*Lanjut menulis? Perbarui `toc.md` dan buat terjemahan `.en.md` (FORMAT §5).*
