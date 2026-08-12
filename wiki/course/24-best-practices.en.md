---
module: 24
title: Best Practices & Writing Apps
part: VIII
partTitle: Development
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Best Practices & Writing Apps

**RFC-TSIX-EDU-002** | Module twenty-four of the TSIX curriculum. Closes the curriculum with best practices: two app styles, error = window, themes, UPDATE_PROPS batching, and the Piagam Antigonon.

> The curriculum is complete here. This module is the "practice book" — a collection of rules that keep TSIX applications consistent, secure, and easy to maintain.

---

## Learning Objectives

- [ ] Distinguish the two app styles (`IProgram` vs `Program()`)
- [ ] Explain "error = window" (the 4-step `std.error`)
- [ ] Explain `UPDATE_PROPS` batching
- [ ] Explain the Piagam Antigonon (4 GUI rules)
- [ ] Apply best practices to new apps

---

## Core Concepts

### Two application styles

**1. Class `main implements IProgram`** (classic style, the majority in `/bin`):

The contract is in `src/mirror/lib/IProgram.ts`:

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

Minimal example (the `cat.ts` / `echo.ts` pattern):

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

**2. `Program()` wrapper + proxy singletons** (new, recommended for new apps & GUI):

```ts
import { Program, std } from "@tsix/Application";

export const main = Program(async (args: string[]) => {
    await std.print("Hello from TSIX!\n");
});
```

> Alias advantage: **path independence** — the import stays the same no matter where the file is placed (`/bin/`, `/root/test/`, etc.). It eliminates "Module not found" errors when moving folders.

**Comparison of the two styles:**

| Aspect | `main implements IProgram` | `Program()` wrapper |
|---|---|---|
| Import | `import { IProgram, OSContext } from "../lib/IProgram"` | `import { Program, std, fs, shell, net, db } from "@tsix/Application"` |
| Entry point | `async execute(os: OSContext, args)` | callback function `async (args) => ...` |
| Library access | `os.std`, `os.fs`, `os.shell`, `os.aux` | proxy singletons `std`, `fs`, `shell`, `net`, `db` |
| Path | relative import to the file location | absolute import `@tsix/*` — path independent |
| Error handling | manual (WorkerEntry catches other errors → `realExit(1)`) | automatic: the wrapper catches errors → `std.error()` → rethrow |
| Suitable for | CLI utilities in `/bin` | new apps, GUI (Emerald), daemons |

**How the wrapper works** (`src/mirror/lib/Application.ts`): `Program(fn)` returns a class that `implements IProgram`. When `execute` is called, it stores the `OSContext` into `global._tsixOsc` and then calls `fn(args)`. If `fn` throws an error, the wrapper sends that error to the parent via `std.error()` (it becomes a desktop error window), then rethrows so that WorkerEntry also handles it. The `std`/`fs`/`shell`/`net`/`db` proxies read `UserLib` from `global._tsixLib` lazily — that is why the imports are path-independent.

### Error = "Window"

Don't let an app crash silently. `std.error(message, context?, wid?)` displays the error as a **desktop window popup** (processed by WM/Asteracea). The 4-step flow (see `StdLib.error()` in `src/mirror/lib/UserLib.ts`):

1. **Log to syslog** — write a `[ERROR]` line + timestamp to `/var/log/syslog`.
2. **Extract `fileHint`** — read the stack trace, find the first source file that is not an internal library (`UserLib`, `Application`, `emerald`).
3. **Broadcast to the parent (WM)** — send an IPC `GUI_WINDOW_ERROR` containing `{ wid, pid, file, error, context, timestamp }` to the parent process; Asteracea displays it as a popup.
4. **Print red TTY** — print `\x1b[31m[ERROR]\x1b[0m <message>` to the terminal (stderr style).

Each step is non-fatal — if one fails (e.g., syslog not yet present), the other steps still run.

### Batching UPDATE_PROPS

Don't send one `UPDATE_PROPS` per property change. **Batch** several changes and send them together — this reduces the IPC count and render latency. In Emerald (`src/mirror/lib/emerald.ts`, class `Window`) the mechanism is already automatic:

- `updateProps(targetId, props)` does not send immediately — the changes are merged into `dirtyProps` (a Map), then `scheduleFlush()` is scheduled.
- `scheduleFlush()` uses `setTimeout(..., 0)`: all changes within one async tick are collected first, then flushed at the end of the tick. If a flush is already scheduled, there is no double scheduling.
- `flushNow()` sends all pending `UPDATE_PROPS` at once.
- `Screen.update()` / `setText()` / `setVisible()` / `setStyle()` all use this batch path.
- `setContent()` is deliberately **not** batched (sent directly via `sendImmediate`) — one atomic `innerHTML=""` operation followed by `MOUNT_NODE` per child.
- `Screen.on()` calls `flush()` automatically after binding — ensuring the listener is attached in the browser.

Best practice: don't write a loop `for (...) await app.update(id, props)` expecting each item to be sent individually — Emerald already batches it for you.

### Piagam Antigonon (4 GUI rules)

The Piagam Antigonon is a strict rule set for AI agents & developers who write TSIX GUIs (source: `wiki/PIXELSPACE_DEVELOPER_GUIDE.md`):

1. **NO DOM in Userland** — `@tsix/emerald` MUST NOT touch `document.*` or `window.*`. All rendering goes through the PixelSpace protocol (Worker → Kernel → DOME → Browser).
2. **State-Sync** — Don't send `UPDATE_PROPS` in a tight loop; use batching.
3. **Memory Cleanup** — Every unmounted node must have its event listeners cleaned up (prevent memory leaks).
4. **Type Safety** — All payloads must conform to `IGUIPayload`; malformed payload → `SIGKILL`.

> [!TIP]
> Two related practices are equally important: attach **mount-time** listeners (`onClickId`/`onInputId` in props at build time, not `app.on()` after mount) to avoid the `cloneNode` bug (Modules 19 & 20), and keep the UI safe for **state replay** after F5 (Module 22).

---

## Flow / How It Works

Steps to write a correct TSIX app (the `Program()` style):

1. **Choose the style** — short CLI utilities: `main implements IProgram`. New apps & GUI: `Program()`.
2. **Write the entry point** — `export const main = Program(async (args) => {...})` (or `export class main implements IProgram`).
3. **Declare GUI mode** (if the app shows a window) — `export const appMode = "gui";` so WorkerEntry handles the GUI.
4. **Access libraries via proxy** — `std`, `fs`, `shell`, `net`, `db` — import once from `@tsix/Application`.
5. **GUI: use Emerald** — `new Screen({...})`, `app.mount(...)`, `app.on(...)`, `app.loopUntilClose()`.
6. **Error = window** — call `await std.error(msg, context)` on failure; don't let it crash silently.
7. **Theme** — `await theme.loadCurrent()` + `theme.watch()` so colors follow Asteracea preferences.
8. **Batch updates** — leave batching to Emerald; don't send `UPDATE_PROPS` per item.
9. **Follow the Piagam Antigonon** — no direct DOM, no tight loops, clean up listeners, payloads conform to `IGUIPayload`.

## Source Code

| File | Contents |
|---|---|
| `src/mirror/lib/IProgram.ts` | `IProgram` & `OSContext` contract |
| `src/mirror/lib/Application.ts` | `Program()` wrapper + proxy singletons (`std`, `fs`, `shell`, `net`, `db`) |
| `src/mirror/lib/UserLib.ts` | `StdLib` (`print`, `log`, `error`), `FsLib` |
| `src/mirror/lib/emerald.ts` | `Window`/`Screen`, `UPDATE_PROPS` batching, `bindHandler` |
| `src/mirror/lib/theme.ts` | `ThemeProvider` — `loadCurrent`, `watch`, `switchTo`, `applyToDome` |
| `src/mirror/bin/cat.ts`, `echo.ts` | `IProgram` style examples |
| `src/mirror/root/ps-sample2.ts`, `ps-sample3.ts` | `Program()` + Emerald examples |
| `src/mirror/opt/set-theme/set-theme.ts` | Theme example (dark/light switch) |
| `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` | Piagam Antigonon |

---

## Snippet (code level)

### App CLI — `IProgram` style (readfile)

`execute(os, args)` uses `os.std` / `os.fs` (the `OSContext` contract). The returned string is printed by WorkerEntry; `void` → `shell.exit(0)`:

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
> To read a file in one shot, `FsLib` already provides `readFile(path)`, which wraps `open` → `read` → `close`.

### App CLI — `Program()` style (hello)

```ts
import { Program, std } from "@tsix/Application";

export const main = Program(async (args: string[]) => {
    await std.print(`Hello, ${args[0] ?? "world"}!\n`);
});
```

### `std.error` — error becomes a window

```ts
// Log syslog → ekstrak fileHint → broadcast GUI_WINDOW_ERROR → TTY merah
await std.error("Disk full", "myapp");
await std.error("Connection timeout", "net", app.wid); // wid opsional
```

When the app calls this, WM/Asteracea shows an error popup on the desktop — not a console crash.

### Theme — import & apply

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

Theme files are located in `/opt/asteracea/theme-*.json` (`theme-dark.json`, `theme-light.json`). Full example: `src/mirror/opt/set-theme/set-theme.ts`.

---

## Exercises / Practice

1. Write a "Hello" app in both styles — compare the structure & imports.
2. Add `std.error()` to an app that deliberately crashes — observe the error window on the desktop.
3. Refactor a GUI app to batch UPDATE_PROPS — measure the difference in responsiveness.
4. Read `wiki/DEVELOPER_GUIDE_SCRIPTING-V2.md` — work through the v2.1 script examples.

---

## References

- `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` — Piagam Antigonon & PixelSpace guide
- `wiki/DEVELOPER_GUIDE_SCRIPTING-V2.md`, `wiki/Panduan-Developer.md`
- `wiki/course/00-overview.md` §9
- `src/mirror/lib/IProgram.ts`, `src/mirror/lib/Application.ts`, `src/mirror/lib/UserLib.ts`
- `src/mirror/lib/emerald.ts`, `src/mirror/lib/theme.ts`
- `src/mirror/root/ps-sample2.ts`, `src/mirror/root/ps-sample3.ts`
- `src/mirror/opt/set-theme/set-theme.ts`, `src/mirror/opt/test/gui-demo.ts`, `src/mirror/opt/file-cruiser/file-cruiser.ts`
- `src/mirror/bin/cat.ts`, `src/mirror/bin/echo.ts`

---

*Module 24 — complete. The TSIX curriculum is complete! 🎉*
*Keep writing? Update `toc.md` and create the `.en.md` translation (FORMAT §5).*
