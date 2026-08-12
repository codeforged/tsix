---
module: 13
title: TTY & Virtual Console
part: V
partTitle: Human Interaction
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# TTY & Virtual Console

**RFC-TSIX-EDU-002** | Thirteenth module of the TSIX curriculum. Understand the TTY as a full PTY emulation: screen buffer, ANSI subset, raw/cooked mode, and master-side ioctl.

> The TSIX TTY is not just a "text console" — it is a **full PTY emulation**. A remote application (e.g. `pixelterm`) can control the TTY from the master side through ioctl `0x2001`/`0x2002` (inject input / read output).

---

## Learning Objectives

- [ ] Explain the role of TTYManager and the allocation of consoles 1–32
- [ ] Explain the TTY components (buffer, cursor, ANSI parser)
- [ ] Explain the important TTYDevice ioctls (clear, raw, 0x2001, 0x2002, winsize)
- [ ] Explain TTY allocation to processes via `ttyId` in EXEC
- [ ] Explain keyboard behavior (Ctrl+C, Alt+F1-6)

---

## Core Concepts

### Components

| Component | File | Role |
|---|---|---|
| **TTYManager** | `src/kernel/tty/TTYManager.ts` | Manages 32 virtual consoles (`Map<number, TTY>`), `activeId`, TTY switching, onSwitch/onInterrupt callbacks |
| **TTY** | `src/kernel/tty/TTY.ts` | Buffer `char[y][x]`, cursor, ANSI subset parser, raw/cooked mode, re-rendering |
| **TTYDevice** | `src/kernel/devices/TTYDevice.ts` | `/dev/ttyN` — wraps a TTY into an `IDevice` (read/write/ioctl) |

A TTY is used as three devices at once for a process "attached" to a console: FD 0 (stdin), FD 1 (stdout), and FD 2 (stderr) all point to the same `TTYDevice`. `init` (PID 1) is created with `fds: [tty1, tty1, tty1]` and `ttyId: 1`.

### Buffer & Modes

- **Screen buffer**: `charBuffer: string[][]` holds the characters, `attrBuffer: string[][]` holds the ANSI styles (e.g. `"31;1"`). Both are indexed `[y][x]` (row first, then column). Default size is 80×24, but at boot `TTYManager` uses the host terminal size (`process.stdout.rows`/`columns`).
- **Cooked mode** (default): input is line-buffered. The TTY performs echo, `Enter` moves the line into `inputLines[]`, `Backspace` deletes the last character, and Ctrl+C produces a signal (it does not enter the buffer).
- **Raw mode** (`setRawMode(true)`): each character goes straight into `inputBuffer[]` without echo and without line editing. Suitable for line editors / shells.
- **Output buffer**: every `write()` also records data into `outputBuffer` — this is what the master reads via ioctl `0x2002` (`getOutput()` also empties it).

### TTYDevice ioctl

| cmd | Name | Meaning | Implementation |
|---|---|---|---|
| `1` | `CLEAR_SCREEN` | clear the TTY screen | `tty.clear()`; if active, reset the host stdout (`\x1bc`) |
| `2` | `SWITCH_TTY` | switch console | return `-1` — handled in `Syscalls.ts` via `Kernel.ttyManager.switch()` |
| `10` | `SET_RAW_MODE` | set raw/cooked mode | `tty.setRawMode(!!arg)` |
| `0x2001` | `INJECT_INPUT` | master types into the slave stdin | `tty.pushInput(arg)` |
| `0x2002` | `READ_OUTPUT` | master reads the slave stdout | `tty.getOutput()` (and empty the buffer) |
| `4` | `TIOCGWINSZ` | window size | `{ lines: tty.height, columns: tty.width }` |

> [!NOTE] The codes `0x2001`/`0x2002` are also used by `MySQLDevice` (`MYSQL_IOCTL_CONNECT`/`DISCONNECT`). The meaning of an ioctl depends on the driver — in `TTYDevice` both are PTY input injection / output reading.

### ANSI Subset Handled

The TSIX ANSI parser is simple: a sequence `ESC [ ... ` is parsed until a command letter (`cmd`) is found, then the arguments are split by `;`. The following subset is implemented in `TTY.handleANSI()`:

| Sequence | Name | Behavior |
|---|---|---|
| `ESC[nA` | Cursor Up | move cursor up `n` rows (clamp 0) |
| `ESC[nB` | Cursor Down | move cursor down `n` rows (clamp `height-1`) |
| `ESC[nC` | Cursor Forward | move cursor forward `n` columns (clamp `width-1`) |
| `ESC[nD` | Cursor Backward | move cursor backward `n` columns (clamp 0) |
| `ESC[r;cH` / `ESC[r;cf` | Cursor Position | move cursor to absolute position (1-based) |
| `ESC[...m` | SGR (color/attribute) | store into `currentAttr` (default `"0"`) |
| `ESC[2J` | Erase Display | `clear()` the whole screen |
| `ESC[0J` | Erase Display (partial) | erase from cursor to bottom |
| `ESC[K` | Erase Line | erase from cursor to end of line |
| `ESC[nS` | Scroll Up (SU) | shift rows up by `n` rows |
| `ESC[nT` | Scroll Down (SD) | shift rows down by `n` rows |
| `ESC[nL` | Insert Line (IL) | insert `n` blank lines at the cursor row |
| `ESC[nM` | Delete Line (DL) | delete `n` lines at the cursor row |
| `ESC[s` | Save Cursor (DECSC) | save cursor position |
| `ESC[u` | Restore Cursor (DECRC) | restore cursor position |

In addition, `write()` handles basic character controls: `\n` (new line), `\r` (`cursorX = 0`), `\b` (one column back). `render()` redraws the whole screen using absolute cursor positioning per row (`ESC[r;cH` + `ESC[2K`) so that it is not corrupted by host terminal wrapping.

### TTY Allocation to Processes

Unlike PortManager (networking), TTY allocation to processes is done **via `ttyId` in the `EXEC` syscall** — the kernel overrides FD 0/1/2 to `tty{n}`:

- The `ttyId` argument is valid only for the range **1–12**.
- If valid, `stdin`/`stdout`/`stderr` are set to the device `tty{ttyId}`.
- If `ttyId` is not given, the process **inherits** `ttyId` from its parent (`pcb.ttyId`).
- `createProcess()` stores `ttyId` in the PCB; `runInit()` creates PID 1 with `ttyId: 1`, then calls `setForegroundProcess(pid, 1)`.

The scheduler maintains the mapping `ttyForegroundPids: Map<ttyId, pid>` — one foreground process per TTY. When a process **detaches** (daemonizes) or **exits**, it is removed from the foreground mapping and its `ttyId` is cleared. Example usage in userland: `init` (PID 1) on `tty1`, then `login` is spawned for other TTYs with a target `ttyId`.

### Keyboard

- **Hotkey** Alt+F1–F6 → `TTYManager.switch` (also Alt+1–6 for macOS).
- **Ctrl+C** → `SIGINT` to the foreground process of the active TTY.
- **Console switch** → `SIGWINCH` to the foreground process of the newly active TTY.
- **Host window resize** → update `LINES`/`COLUMNS` in the env of all processes + `SIGWINCH` broadcast + `TTYManager.handleResize()`.

---

## Flow / How It Works

### Input: keystroke → foreground process

```
Host keyboard (process.stdin)
        │  data mentah (utf8)
        ▼
KeyboardDevice (data handler kernel)
        │  hotkey? (Alt+F1..6) ──► TTYManager.switch(...) → STOP
        ▼
Kernel: ttyManager.getActiveTTY().pushInput(data)
        │
        ▼
TTY.pushInput(data)
   ├─ cooked : echo + lineBuffer → Enter → inputLines[]
   └─ raw    : tiap char → inputBuffer[]
        │
        ▼
Proses foreground → syscall READ(fd 0) → TTYDevice.read()
        │  raw   → tty.read() → inputBuffer.shift()
        └  cooked → tty.read() → inputLines.shift()
```

### Output: application → TTY → render

```
Aplikasi → syscall WRITE/PRINT(fd 1) → TTYDevice.write(data)
        │
        ▼
TTY.write(data)
   1. outputBuffer += data          (untuk master ioctl 0x2002)
   2. onWrite(data)                 (master remote ikut menerima)
   3. parse char: \n \r \b, ESC[... (subset ANSI), karakter biasa
        │  karakter biasa → putChar() → charBuffer[y][x] + attrBuffer[y][x]
        ▼
TTY aktif? → tty.onWrite → process.stdout.write(data)   (layar host)
Master?    → syscall READ(pid) → ioctl 0x2002 → getOutput() (pixelterm)
```

### Boot wiring (Kernel.boot)

```
new TTYManager(32)                    → 32× TTY (ukuran host)
  └─ 32× TTYDevice "tty1..tty32"      → /dev/ttyN (isActive = aktifId === N)
devices: stdin=KeyboardDevice, fb0/stdout/stderr → tty1, null, tty1..32
kbd.setDataHandler       → getActiveTTY().pushInput(data)
kbd.setHotkeyHandler     → handleKeyboardHotkey (Alt+F1..6)
kbd.setInterruptHandler  → handleHostInterrupt   (Ctrl+C)
ttyManager.setOnSwitchCallback      → SIGWINCH ke foreground TTY baru
ttyManager.setOnInterruptCallback   → SIGINT ke foreground TTY
runInit() → createProcess("init", fds:[tty1×3], ttyId:1)
          → setForegroundProcess(pid, 1)
```

### Console switch (Alt+F2)

```
Host kirim seq "\x1bOQ" (atau "\x1b[1;3Q")
  → KeyboardDevice.onHotkey → handleKeyboardHotkey(seq) → true (stop)
  → ttyManager.switch(2)
      1. activeId = 2
      2. reset host terminal: "\x1bc\x1b[3J"
      3. banner "TSIX VIRTUAL CONSOLE [ TTY 2 ]" 500ms (jika visualIdentity ada)
      4. render() buffer TTY2 → process.stdout
      5. onSwitchCallback(2) → SIGWINCH ke foreground PID TTY2
```

### Ctrl+C → SIGINT

```
Host/kbd deteksi "\u0003"
  → pushInput: cooked → onInterrupt() (tidak masuk buffer); raw → onInterrupt() + tetap masuk buffer
  → TTYManager.onInterruptCallback(activeId)
  → Kernel → SIGINT ke foreground process TTY aktif
  → Scheduler.sendInterruptSignal(ttyId) → kill(fgPid, 2)
      → event "signal" SIGINT → grace 100ms → worker.terminate() jika tak ditangani
```

---

## Source Code

| File | Role |
|---|---|
| `src/kernel/tty/TTY.ts` | TTY emulation: buffer, cursor, ANSI subset, raw/cooked, render |
| `src/kernel/tty/TTYManager.ts` | 32 console allocation, `activeId`, switch, callbacks |
| `src/kernel/devices/TTYDevice.ts` | Device wrapper `/dev/ttyN` + ioctl |
| `src/kernel/devices/KeyboardDevice.ts` | Keyboard driver + hotkey/interrupt detection |
| `src/kernel/Scheduler.ts` | Foreground per TTY (`ttyForegroundPids`), SIGINT/SIGWINCH |
| `src/kernel/Syscalls.ts` | EXEC `ttyId`, ioctl 0x2001/0x2002, switch/resize |
| `src/kernel/Kernel.ts` | Boot wiring, hotkey handler, resize listener, `runInit` |

---

## Snippet (code level)

### TTY input buffer — push/pop (`src/kernel/tty/TTY.ts`)

```ts
public pushInput(data: string) {
    if (this.rawMode) {
        // RAW MODE: langsung ke inputBuffer (tiap karakter)
        for (const char of data) {
            if (char === "\u0003") {          // Ctrl+C
                if (this.onInterrupt) {
                    this.onInterrupt();
                }
                // Tetap push untuk app yang mau menangani sendiri
                this.inputBuffer.push(char);
            } else {
                this.inputBuffer.push(char);
            }
        }
    } else {
        // COOKED MODE: echo + backspace + line buffering
        for (const char of data) {
            const code = char.charCodeAt(0);
            if (char === "\u0003") {          // Ctrl+C → interrupt, jangan masuk buffer
                if (this.onInterrupt) this.onInterrupt();
                continue;
            }
            if (char === "\r" || char === "\n") {
                this.inputLines.push(this.lineBuffer + "\n");
                this.lineBuffer = "";
                this.write("\n");             // echo newline
                continue;
            }
            if (code === 127 || code === 8) { // Backspace
                if (this.lineBuffer.length > 0) {
                    this.lineBuffer = this.lineBuffer.slice(0, -1);
                    this.write("\b \b");      // echo hapus visual
                }
                continue;
            }
            this.lineBuffer += char;
            // ... filter escape sequence untuk echo (NORMAL/ESC/CSI),
            //     lalu echo hanya char printable (0x20-0x7E) + \n \r \t
        }
    }
}

public read(): string | null {
    if (this.rawMode) {
        if (this.inputBuffer.length === 0) return null;
        return this.inputBuffer.shift() || null;
    } else {
        if (this.inputLines.length === 0) return null;
        return this.inputLines.shift() || null;
    }
}

public setRawMode(enabled: boolean) {
    this.logger.debug(`setRawMode(${enabled}) - previously ${this.rawMode}`);
    this.rawMode = enabled;
    // Apps yang pindah ke raw mode biasanya tidak ingin input cooked tertunda
    if (enabled) {
        this.lineBuffer = "";
    }
}
```

### ioctl TTYDevice (`src/kernel/devices/TTYDevice.ts`)

```ts
public ioctl(cmd: number, arg: any): any {
    if (cmd === 1) { // 1 = CLEAR_SCREEN
        this.tty.clear();
        if (this.isActive()) {
            process.stdout.write("\x1bc");
        }
        return 0;
    }
    if (cmd === 2) { // 2 = SWITCH_TTY
        return -1; // Handled in Syscalls.ts via Kernel.ttyManager
    }
    if (cmd === 10) { // 10 = SET_RAW_MODE
        this.tty.setRawMode(!!arg);
        return 0;
    }
    if (cmd === 0x2001) { // INJECT_INPUT (Master typing into slave stdin)
        this.tty.pushInput(arg as string);
        return true;
    }
    if (cmd === 0x2002) { // READ_OUTPUT (Master reading slave stdout)
        return this.tty.getOutput();
    }
    if (cmd === 4) { // 4 = TIOCGWINSZ (Get Window Size)
        return { lines: this.tty.height, columns: this.tty.width };
    }
    return -1;
}
```

### TTYManager.switch (`src/kernel/tty/TTYManager.ts`)

```ts
public async switch(id: number, forceRedraw: boolean = false) {
    if (!this.ttys.has(id)) return;
    if (id === this.activeId && !forceRedraw) return;

    this.logger.info(`Switching from TTY${this.activeId} to TTY${id}`);
    this.activeId = id;

    // Reset total terminal host agar tidak ada sisa dari TTY lama
    process.stdout.write("\x1bc\x1b[3J");

    // Banner visual terpusat (500ms) jika ada visual identity
    if (this.visualIdentity && !forceRedraw) {
        const rows = process.stdout.rows || 24;
        const cols = process.stdout.columns || 80;
        const text = `TSIX VIRTUAL CONSOLE [ TTY ${id} ]`;
        const barLines = this.visualIdentity.split("\n");
        const bannerWidth = 32;
        const bannerHeight = 1 + barLines.length;
        const startRow = Math.max(1, Math.floor((rows - bannerHeight) / 2));
        const startCol = Math.max(1, Math.floor((cols - bannerWidth) / 2));
        process.stdout.write("\x1b[?25l");
        process.stdout.write(`\x1b[${startRow};${startCol}H\x1b[97m  ${text}\x1b[0m`);
        barLines.forEach((line, index) => {
            process.stdout.write(`\x1b[${startRow + 1 + index};${startCol}H${line}`);
        });
        await new Promise(resolve => setTimeout(resolve, 500));
        process.stdout.write("\x1bc\x1b[3J\x1b[?25h");
    }

    const content = this.getActiveTTY().render();
    process.stdout.write(content);

    // Notify foreground process di TTY yang baru aktif
    if (this.onSwitchCallback) {
        this.onSwitchCallback(id);
    }
}
```

### `ttyId` allocation in EXEC (`src/kernel/Syscalls.ts`)

```ts
// --- TTY REDIRECTION SUPPORT ---
// Jika TTY tertentu diminta, override I/O default ke TTY itu
if (ttyId !== undefined && ttyId >= 1 && ttyId <= 12) {
    const targetTtyDevice = this.kernel.devices[`tty${ttyId}`];
    if (targetTtyDevice) {
        stdinDevice = targetTtyDevice;
        stdoutDevice = targetTtyDevice;
        stderrDevice = targetTtyDevice;
    }
} else {
    // Warisan normal jika tidak ada TTY khusus
    if (stdoutFd !== undefined && pcb.fdTable[stdoutFd]) {
        stdoutDevice = pcb.fdTable[stdoutFd]!.device;
    }
    if (stdinFd !== undefined && pcb.fdTable[stdinFd]) {
        stdinDevice = pcb.fdTable[stdinFd]!.device;
    }
}

const newPcb = this.scheduler.createProcess(binaryName, {
    fds: [stdinDevice, stdoutDevice, stderrDevice],
    // ... appName, args, env, uid/gid, dst
    ttyId: ttyId !== undefined ? ttyId : pcb.ttyId, // target TTY atau warisi dari parent
    ppid: pid,
});
```

### Hotkey Alt+F1..6 (`src/kernel/Kernel.ts`)

```ts
private handleKeyboardHotkey(seq: string): boolean {
    const hotkeys: Record<string, number> = {
        // Alt+F1..F6 (Xterm, iTerm2, Terminal.app)
        "\x1b\x1bOP": 1,   "\x1b[1;3P": 1,   "\x1b[11;3~": 1,
        "\x1b\x1bOQ": 2,   "\x1b[1;3Q": 2,   "\x1b[12;3~": 2,
        "\x1b\x1bOR": 3,   "\x1b[1;3R": 3,   "\x1b[13;3~": 3,
        "\x1b\x1bOS": 4,   "\x1b[1;3S": 4,   "\x1b[14;3~": 4,
        "\x1b\x1b[15~": 5, "\x1b[15;3~": 5,  "\x1b[1;3;15~": 5,
        "\x1b\x1b[17~": 6, "\x1b[17;3~": 6,  "\x1b[1;3;17~": 6,
        // Alt+1..6 (macOS saat Option bertindak sebagai Meta)
        "\x1b1": 1, "\x1b2": 2, "\x1b3": 3,
        "\x1b4": 4, "\x1b5": 5, "\x1b6": 6,
    };
    if (hotkeys[seq]) {
        // FIRE AND FORGET: jangan await agar tidak memblokir input keyboard
        this.ttyManager?.switch(hotkeys[seq]);
        return true; // handled
    }
    return false;
}
```

### Callback & foreground wiring (`src/kernel/Kernel.ts` + `src/kernel/Scheduler.ts`)

```ts
// Kernel: daftarkan callback TTY
this.ttyManager.setOnSwitchCallback((ttyId: number) => {
    const fgPid = this.scheduler?.getForegroundProcess(ttyId);
    if (fgPid) {
        this.logger.debug(`Sending SIGWINCH to PID ${fgPid} (TTY${ttyId} activated)`);
        this.scheduler?.sendEvent(fgPid, "signal", "SIGWINCH");
    }
});
this.ttyManager.setOnInterruptCallback((ttyId: number) => {
    const fgPid = this.scheduler?.getForegroundProcess(ttyId);
    if (fgPid) {
        this.logger.info(`Sending SIGINT to PID ${fgPid} (TTY${ttyId} Ctrl+C)`);
        this.scheduler?.sendEvent(fgPid, "signal", "SIGINT");
    }
});

// Scheduler: satu foreground process per TTY
public setForegroundProcess(pid: number | null, ttyId?: number) {
    if (pid !== null && !ttyId) {
        const pcb = this.getProcess(pid);
        ttyId = pcb?.ttyId || 1;
    }
    const targetTty = ttyId || 1;
    if (pid === null) {
        this.ttyForegroundPids.delete(targetTty);
    } else {
        this.ttyForegroundPids.set(targetTty, pid);
    }
}
```

---

## Exercises / Practice

1. Read `src/kernel/tty/TTY.ts` — explain the buffer structure `char[y][x]` + `attr[y][x]` and the ANSI subset in `handleANSI()`.
2. Run `pixelterm` (if available) — observe how it uses ioctl `0x2001` (inject input) and `0x2002` (read output) from the master side.
3. From another TTY, press Alt+F2 — observe the console switch and the visual banner.
4. Read `src/kernel/devices/TTYDevice.ts` — explain each ioctl (`1`, `2`, `10`, `0x2001`, `0x2002`, `4`).
5. Trace the `EXEC` syscall in `src/kernel/Syscalls.ts` — what is different when `ttyId` is set vs not? When does a process inherit the parent's `ttyId`?
6. Press Ctrl+C on a foreground process — explain the signal path from `pushInput` → `onInterrupt` → `SIGINT`.

---

## References

- `wiki/Kernel-dan-Scheduler.md` §TTY
- `wiki/course/00-overview.en.md` §8
- `src/kernel/tty/TTY.ts`, `src/kernel/tty/TTYManager.ts`, `src/kernel/devices/TTYDevice.ts`
- `src/kernel/Scheduler.ts` (§ `ttyForegroundPids`, `setForegroundProcess`, `sendInterruptSignal`)
- `src/kernel/Syscalls.ts` (syscall `EXEC`, `SEND`/`READ` via ioctl `0x2001`/`0x2002`, `SWITCH_TTY`, `WINSIZE`)

---

*Module 13 — complete. Continue to [Module 14 — Userland](14-userland-init-login-shell.en.md).*
