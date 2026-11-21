import { IDevice } from "./IDevice";
import * as tty from "tty";
import { Logger } from "../../common/Logger";

/**
 * KEYBOARD DEVICE (TTY Emulator)
 * 
 * Driver untuk membaca input dari keyboard.
 * Mendukung RAW MODE untuk Line Editor (Shell).
 */
export class KeyboardDevice implements IDevice {
    name = "Keyboard";
    private buffer: string = "";
    private lines: string[] = [];
    private rawBuffer: string[] = []; // Buffer untuk Raw Mode
    private logger: Logger;
    private rawMode: boolean = false; // Default: Cooked Mode
    private onInterrupt: (() => void) | null = null;
    private onHotkey: ((seq: string) => boolean) | null = null; // Callback untuk hotkey (e.g. Alt+F1)
    private onData: ((data: string) => void) | null = null; // Callback untuk data mentah keyboard

    constructor() {
        this.logger = new Logger("Keyboard");
        this.logger.info(`Initializing KeyboardDevice (isTTY: ${process.stdin.isTTY})`);

        if (process.stdin.isTTY) {
            try {
                (process.stdin as tty.ReadStream).setRawMode(true);
            } catch (e) {
                this.logger.warn("Failed to set Raw Mode on TTY.");
            }
        }

        process.stdin.resume();
        process.stdin.setEncoding("utf8");

        process.stdin.on("data", (data: string) => {
            // Check for Hotkeys (Alt+F# for TTY switching)
            if (this.onHotkey) {
                if (this.onHotkey(data)) {
                    return;
                }
            }

            // Kirim ke handler data (Kernel routing) jika ada
            if (this.onData) {
                this.onData(data);
                return; // JANGAN lanjut ke local buffer agar tidak rebutan/double
            }

            // Jika Raw Mode aktif, bypass buffer line dan kirim langsung
            if (this.rawMode) {
                for (let i = 0; i < data.length; i++) {
                    const char = data[i];

                    // In Raw Mode, we still want to detect SIGINT if possible, 
                    // or at least give the kernel a chance to handle it.
                    if (char === "\u0003") {
                        if (this.onInterrupt) {
                            this.onInterrupt();
                            // In many raw mode implementations, Ctrl+C is still passed as data 
                            // but the signal is also sent. We follow that.
                        }
                    }

                    this.rawBuffer.push(char);
                }
                return;
            }

            // Cooked Mode (Standard Line Buffered)
            for (let i = 0; i < data.length; i++) {
                const char = data[i];
                const charCode = char.charCodeAt(0);

                if (char === "\u0003") {
                    if (this.onInterrupt) {
                        this.onInterrupt();
                    } else {
                        this.logger.info("Ctrl+C detected, but no handler registered.");
                    }
                    return;
                }

                if (char === "\r" || char === "\n") {
                    this.lines.push(this.buffer + "\n");
                    this.buffer = "";
                    process.stdout.write("\n");
                    continue;
                }

                if (charCode === 127 || charCode === 8) {
                    if (this.buffer.length > 0) {
                        this.buffer = this.buffer.slice(0, -1);
                        process.stdout.write("\b \b");
                    }
                    continue;
                }

                this.buffer += char;
                process.stdout.write(char);
            }
        });

        // Handle stdin stream errors to prevent system crashes
        process.stdin.on('error', (err) => {
            this.logger.error(`Stdin stream error: ${err.message}`);
            // Don't crash the system, just log the error
        });
    }

    public read(): string | null {
        if (this.rawMode) {
            if (this.rawBuffer.length === 0) return null;
            return this.rawBuffer.shift() || "";
        } else {
            if (this.lines.length === 0) return null;
            return this.lines.shift() || "";
        }
    }

    public write(): boolean {
        return false;
    }

    public ioctl(cmd: number, arg: any): any {
        if (cmd === 1) { // 1 = SET_RAW_MODE
            const enable = !!arg;
            this.rawMode = enable;
            this.logger.info(`[IOCTL] Keyboard Mode switched to: ${this.rawMode ? "RAW" : "COOKED"}`);

            // Clear buffers on switch to avoid interference
            if (this.rawMode) {
                this.rawBuffer = [];
            }
            return 0;
        }
        return -1;
    }

    /**
     * setInterruptHandler(): Mendaftarkan fungsi yang dipanggil saat Ctrl+C ditekan.
     */
    public setInterruptHandler(handler: () => void) {
        this.onInterrupt = handler;
    }

    /**
     * setHotkeyHandler(): Mendaftarkan fungsi untuk mendeteksi Alt+F1-F6.
     */
    public setHotkeyHandler(handler: (seq: string) => boolean) {
        this.onHotkey = handler;
    }

    /**
     * setDataHandler(): Mendaftarkan fungsi untuk meneruskan data keyboard mentah.
     */
    public setDataHandler(handler: (data: string) => void) {
        this.onData = handler;
    }

    public isLineReady(): boolean {
        return this.lines.length > 0;
    }

    public reset() {
        this.rawMode = false;
        this.rawBuffer = [];
        this.logger.info("Keyboard Device Reset (Forced Cooked Mode)");
    }
}
