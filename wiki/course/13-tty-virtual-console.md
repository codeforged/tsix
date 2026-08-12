---
module: 13
title: TTY & Virtual Console
part: V
partTitle: Interaksi Manusia
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# TTY & Virtual Console

**RFC-TSIX-EDU-002** | Modul ketiga belas kurikulum TSIX. Memahami TTY sebagai emulasi PTY lengkap: buffer layar, ANSI subset, raw/cooked mode, dan master-side ioctl.

> TTY TSIX bukan sekadar "console teks" — ia adalah **emulasi PTY lengkap**. Aplikasi remote (mis. `pixelterm`) bisa mengendalikan TTY dari sisi master melalui ioctl `0x2001`/`0x2002` (inject input / read output).

---

## Tujuan Pembelajaran

- [ ] Menjelaskan peran TTYManager dan alokasi konsol 1–32
- [ ] Menjelaskan komponen TTY (buffer, kursor, parser ANSI)
- [ ] Menjelaskan ioctl penting TTYDevice (clear, raw, 0x2001, 0x2002, winsize)
- [ ] Menjelaskan alokasi TTY ke proses via `ttyId` di EXEC
- [ ] Menjelaskan perilaku keyboard (Ctrl+C, Alt+F1-6)

---

## Konsep Inti

### Komponen

| Komponen | File | Peran |
|---|---|---|
| **TTYManager** | `src/kernel/tty/TTYManager.ts` | Kelola 32 konsol virtual (`Map<number, TTY>`), `activeId`, switch TTY, callback onSwitch/onInterrupt |
| **TTY** | `src/kernel/tty/TTY.ts` | Buffer `char[y][x]`, kursor, parser ANSI subset, raw/cooked mode, render ulang |
| **TTYDevice** | `src/kernel/devices/TTYDevice.ts` | `/dev/ttyN` — bungkus TTY jadi `IDevice` (read/write/ioctl) |

TTY dipakai sebagai tiga device sekaligus untuk proses yang "menempel" di konsol: FD 0 (stdin), FD 1 (stdout), FD 2 (stderr) semuanya menunjuk ke `TTYDevice` yang sama. `init` (PID 1) dibuat dengan `fds: [tty1, tty1, tty1]` dan `ttyId: 1`.

### Buffer & Mode

- **Buffer layar**: `charBuffer: string[][]` berisi karakter, `attrBuffer: string[][]` berisi gaya ANSI (mis. `"31;1"`). Keduanya diindeks `[y][x]` (baris dulu, kolom kedua). Ukuran default 80×24, tapi saat boot `TTYManager` memakai ukuran terminal host (`process.stdout.rows`/`columns`).
- **Cooked mode** (default): input di-line-buffer. Echo dilakukan oleh TTY, `Enter` memindahkan baris ke `inputLines[]`, `Backspace` menghapus karakter terakhir, dan Ctrl+C menghasilkan sinyal (tidak masuk buffer).
- **Raw mode** (`setRawMode(true)`): tiap karakter langsung masuk `inputBuffer[]` tanpa echo dan tanpa line editing. Cocok untuk line editor / shell.
- **Output buffer**: setiap `write()` juga merekam data ke `outputBuffer` — inilah yang dibaca master lewat ioctl `0x2002` (`getOutput()` sekaligus mengosongkannya).

### ioctl TTYDevice

| cmd | Nama | Makna | Implementasi |
|---|---|---|---|
| `1` | `CLEAR_SCREEN` | bersihkan layar TTY | `tty.clear()`; jika aktif, reset stdout host (`\x1bc`) |
| `2` | `SWITCH_TTY` | pindah konsol | return `-1` — ditangani di `Syscalls.ts` via `Kernel.ttyManager.switch()` |
| `10` | `SET_RAW_MODE` | set mode raw/cooked | `tty.setRawMode(!!arg)` |
| `0x2001` | `INJECT_INPUT` | master mengetik ke stdin slave | `tty.pushInput(arg)` |
| `0x2002` | `READ_OUTPUT` | master membaca stdout slave | `tty.getOutput()` (dan kosongkan buffer) |
| `4` | `TIOCGWINSZ` | ukuran window | `{ lines: tty.height, columns: tty.width }` |

> [!NOTE] Kode `0x2001`/`0x2002` juga dipakai `MySQLDevice` (`MYSQL_IOCTL_CONNECT`/`DISCONNECT`). Makna ioctl bergantung pada driver — di `TTYDevice` keduanya adalah injeksi input / baca output PTY.

### Subset ANSI yang Ditangani

Parser ANSI TSIX sederhana: urutan `ESC [ ... ` di-parse sampai ditemukan huruf perintah (`cmd`), lalu argumen dipisah dengan `;`. Berikut subset yang diimplementasikan di `TTY.handleANSI()`:

| Urutan | Nama | Perilaku |
|---|---|---|
| `ESC[nA` | Cursor Up | kursor naik `n` baris (clamp 0) |
| `ESC[nB` | Cursor Down | kursor turun `n` baris (clamp `height-1`) |
| `ESC[nC` | Cursor Forward | kursor maju `n` kolom (clamp `width-1`) |
| `ESC[nD` | Cursor Backward | kursor mundur `n` kolom (clamp 0) |
| `ESC[r;cH` / `ESC[r;cf` | Cursor Position | pindah kursor absolut (1-based) |
| `ESC[...m` | SGR (warna/atribut) | simpan ke `currentAttr` (default `"0"`) |
| `ESC[2J` | Erase Display | `clear()` seluruh layar |
| `ESC[0J` | Erase Display (partial) | hapus dari kursor ke bawah |
| `ESC[K` | Erase Line | hapus dari kursor ke akhir baris |
| `ESC[nS` | Scroll Up (SU) | geser baris ke atas `n` baris |
| `ESC[nT` | Scroll Down (SD) | geser baris ke bawah `n` baris |
| `ESC[nL` | Insert Line (IL) | sisip `n` baris kosong di baris kursor |
| `ESC[nM` | Delete Line (DL) | hapus `n` baris di baris kursor |
| `ESC[s` | Save Cursor (DECSC) | simpan posisi kursor |
| `ESC[u` | Restore Cursor (DECRC) | pulihkan posisi kursor |

Selain itu `write()` menangani kontrol karakter dasar: `\n` (baris baru), `\r` (`cursorX = 0`), `\b` (mundur satu kolom). `render()` menggambar ulang seluruh layar memakai kursor absolut per baris (`ESC[r;cH` + `ESC[2K`) agar tidak rusak oleh wrapping terminal host.

### Alokasi TTY ke proses

Berbeda dari PortManager (jaringan), alokasi TTY ke proses dilakukan **via `ttyId` di syscall `EXEC`** — kernel override FD 0/1/2 ke `tty{n}`:

- Argumen `ttyId` valid hanya untuk rentang **1–12**.
- Jika valid, `stdin`/`stdout`/`stderr` di-set ke device `tty{ttyId}`.
- Jika `ttyId` tidak diberikan, proses **mewarisi** `ttyId` dari parent (`pcb.ttyId`).
- `createProcess()` menyimpan `ttyId` di PCB; `runInit()` membuat PID 1 dengan `ttyId: 1` lalu `setForegroundProcess(pid, 1)`.

Scheduler memelihara pemetaan `ttyForegroundPids: Map<ttyId, pid>` — satu foreground process per TTY. Saat proses **detach** (daemonize) atau **EXIT**, ia dilepas dari pemetaan foreground dan `ttyId`-nya dibersihkan. Contoh pemakaian di userland: `init` (PID 1) di `tty1`, lalu `login` di-spawn untuk TTY lain dengan `ttyId` tujuan.

### Keyboard

- **Hotkey** Alt+F1–F6 → `TTYManager.switch` (juga Alt+1–6 untuk macOS).
- **Ctrl+C** → `SIGINT` ke foreground process TTY aktif.
- **Switch konsol** → `SIGWINCH` ke foreground process TTY yang baru aktif.
- **Resize jendela host** → update `LINES`/`COLUMNS` di env semua proses + `SIGWINCH` broadcast + `TTYManager.handleResize()`.

---

## Alur / Cara Kerja

### Input: keystroke → proses foreground

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

### Output: aplikasi → TTY → render

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

### Wiring saat boot (Kernel.boot)

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

### Switch konsol (Alt+F2)

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

## Kode Sumber

| File | Peran |
|---|---|
| `src/kernel/tty/TTY.ts` | Emulasi TTY: buffer, kursor, subset ANSI, raw/cooked, render |
| `src/kernel/tty/TTYManager.ts` | Alokasi 32 konsol, `activeId`, switch, callback |
| `src/kernel/devices/TTYDevice.ts` | Device wrapper `/dev/ttyN` + ioctl |
| `src/kernel/devices/KeyboardDevice.ts` | Driver keyboard + deteksi hotkey/interrupt |
| `src/kernel/Scheduler.ts` | Foreground per TTY (`ttyForegroundPids`), SIGINT/SIGWINCH |
| `src/kernel/Syscalls.ts` | EXEC `ttyId`, ioctl 0x2001/0x2002, switch/resize |
| `src/kernel/Kernel.ts` | Boot wiring, hotkey handler, resize listener, `runInit` |

---

## Snippet (level kode)

### Buffer input TTY — push/pop (`src/kernel/tty/TTY.ts`)

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

### Alokasi `ttyId` di EXEC (`src/kernel/Syscalls.ts`)

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

### Wiring callback & foreground (`src/kernel/Kernel.ts` + `src/kernel/Scheduler.ts`)

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

## Latihan / Praktik

1. Baca `src/kernel/tty/TTY.ts` — jelaskan struktur buffer `char[y][x]` + `attr[y][x]` dan subset ANSI di `handleANSI()`.
2. Jalankan `pixelterm` (jika tersedia) — amati bagaimana ia memakai ioctl `0x2001` (inject input) dan `0x2002` (read output) dari sisi master.
3. Dari TTY lain, tekan Alt+F2 — amati switch konsol dan banner visual.
4. Baca `src/kernel/devices/TTYDevice.ts` — jelaskan tiap ioctl (`1`, `2`, `10`, `0x2001`, `0x2002`, `4`).
5. Telusuri syscall `EXEC` di `src/kernel/Syscalls.ts` — apa bedanya saat `ttyId` diisi vs tidak? Kapan proses mewarisi `ttyId` parent?
6. Tekan Ctrl+C pada proses foreground — jelaskan jalur sinyal dari `pushInput` → `onInterrupt` → `SIGINT`.

---

## Referensi

- `wiki/Kernel-dan-Scheduler.md` §TTY
- `wiki/course/00-overview.md` §8
- `src/kernel/tty/TTY.ts`, `src/kernel/tty/TTYManager.ts`, `src/kernel/devices/TTYDevice.ts`
- `src/kernel/Scheduler.ts` (§ `ttyForegroundPids`, `setForegroundProcess`, `sendInterruptSignal`)
- `src/kernel/Syscalls.ts` (syscall `EXEC`, `SEND`/`READ` via ioctl `0x2001`/`0x2002`, `SWITCH_TTY`, `WINSIZE`)

---

*Modul 13 — selesai. Lanjut ke [Modul 14 — Userland](14-userland-init-login-shell.md).*
