import { Logger } from "../../common/Logger";

/**
 * TTY (Teletype / Virtual Console)
 * 
 * Mengelola buffer layar, kursor, dan parsing ANSI dasar untuk satu konsol virtual.
 */
export class TTY {
    public width: number = 80;
    public height: number = 24;

    // Buffer Map: [y][x]
    private charBuffer: string[][];
    private attrBuffer: string[][]; // Menyimpan ANSI Style (misal: "31;1")

    private cursorX: number = 0;
    private cursorY: number = 0;
    private savedCursorX?: number;
    private savedCursorY?: number;
    private currentAttr: string = "0"; // Default: Reset
    private inputBuffer: string[] = []; // Penampung input mentah/raw
    private lineBuffer: string = "";    // Penampung baris yang sedang diketik (Cooked)
    private inputLines: string[] = [];  // Antrian baris yang sudah selesai (Enter ditekan)
    private rawMode: boolean = false;   // Default: Cooked
    private outputBuffer: string = "";   // Added: Capture what was printed (for remote terminal)

    private logger: Logger;
    private id: number;
    public onWrite: ((data: string) => void) | null = null;
    public onInterrupt: (() => void) | null = null; // Callback for Ctrl+C

    constructor(id: number, width: number = 80, height: number = 24) {
        this.id = id;
        this.width = width;
        this.height = height;
        this.logger = new Logger(`TTY${id}`);

        this.charBuffer = Array.from({ length: height }, () => Array(width).fill(" "));
        this.attrBuffer = Array.from({ length: height }, () => Array(width).fill("0"));
        this.cookedEchoState = "NORMAL";
    }

    /**
     * write(data): Memproses string masuk (termasuk ANSI codes).
     */
    public write(data: string) {
        this.outputBuffer += data; // RECORD OUTPUT
        this.onWrite?.(data);
        for (let i = 0; i < data.length; i++) {
            const char = data[i];

            // Dasar-dasar Control Characters
            if (char === "\n") {
                this.newLine();
                continue;
            }
            if (char === "\r") {
                this.cursorX = 0;
                continue;
            }
            if (char === "\b") {
                if (this.cursorX > 0) this.cursorX--;
                continue;
            }

            // ANSI Escape Sequence (Sederhana)
            if (char === "\x1b" && data[i + 1] === "[") {
                // Cari ujung sequence (biasanya huruf)
                let j = i + 2;
                while (j < data.length && (data[j] >= "0" && data[j] <= "?") || (data[j] >= " " && data[j] <= "/")) {
                    j++;
                }

                const sequence = data.substring(i + 2, j);
                const command = data[j];
                this.handleANSI(sequence, command);

                i = j; // Skip sequence yang sudah diproses
                continue;
            }

            // Regular Character
            this.putChar(char);
        }
    }

    private putChar(char: string) {
        if (this.cursorX >= this.width) {
            this.newLine();
        }

        if (this.cursorY >= this.height) {
            this.scroll();
            this.cursorY = this.height - 1;
        }

        this.charBuffer[this.cursorY][this.cursorX] = char;
        this.attrBuffer[this.cursorY][this.cursorX] = this.currentAttr;
        this.cursorX++;
    }

    private newLine() {
        this.cursorX = 0;
        this.cursorY++;
        if (this.cursorY >= this.height) {
            this.scroll();
            this.cursorY = this.height - 1;
        }
    }

    private scroll() {
        // Pindahkan semua baris ke atas
        for (let y = 0; y < this.height - 1; y++) {
            this.charBuffer[y] = [...this.charBuffer[y + 1]];
            this.attrBuffer[y] = [...this.attrBuffer[y + 1]];
        }
        // Bersihkan baris terakhir
        this.charBuffer[this.height - 1] = Array(this.width).fill(" ");
        this.attrBuffer[this.height - 1] = Array(this.width).fill("0");
    }

    /**
     * handleANSI: Implementasi subset kecil ANSI escape codes.
     */
    private handleANSI(seq: string, cmd: string) {
        const args = seq.split(";").map(a => parseInt(a) || 0);

        switch (cmd) {
            case "m": // Graphic Rendition (Colors)
                if (seq === "" || seq === "0") {
                    this.currentAttr = "0";
                } else {
                    this.currentAttr = seq;
                }
                break;
            case "A": // Cursor Up
                this.cursorY = Math.max(0, this.cursorY - (args[0] || 1));
                break;
            case "B": // Cursor Down
                this.cursorY = Math.min(this.height - 1, this.cursorY + (args[0] || 1));
                break;
            case "C": // Cursor Forward
                this.cursorX = Math.min(this.width - 1, this.cursorX + (args[0] || 1));
                break;
            case "D": // Cursor Backward
                this.cursorX = Math.max(0, this.cursorX - (args[0] || 1));
                break;
            case "H": // Move Cursor (Absolute)
            case "f":
                const r = Math.max(0, Math.min(this.height - 1, (args[0] || 1) - 1));
                const c = Math.max(0, Math.min(this.width - 1, (args[1] || 1) - 1));
                this.cursorY = r;
                this.cursorX = c;
                break;
            case "J": // Erase Screen
                if (args[0] === 2) { // Clear entire screen
                    this.clear();
                } else if (args[0] === 0 || isNaN(args[0])) { // Clear from cursor down
                    // Simplified: Clear current line from cursor
                    for (let x = this.cursorX; x < this.width; x++) {
                        this.charBuffer[this.cursorY][x] = " ";
                    }
                    // Clear all lines below
                    for (let y = this.cursorY + 1; y < this.height; y++) {
                        this.charBuffer[y].fill(" ");
                        this.attrBuffer[y].fill("0");
                    }
                }
                break;
            case "K": // Erase in Line
                if (args[0] === 0 || isNaN(args[0])) { // Clear from cursor to end
                    for (let x = this.cursorX; x < this.width; x++) {
                        this.charBuffer[this.cursorY][x] = " ";
                        this.attrBuffer[this.cursorY][x] = "0";
                    }
                }
                break;
            case "S": // Scroll Up (SU)
                {
                    const lines = args[0] || 1;
                    for (let i = 0; i < lines; i++) {
                        this.charBuffer.shift();
                        this.attrBuffer.shift();
                        this.charBuffer.push(Array(this.width).fill(" "));
                        this.attrBuffer.push(Array(this.width).fill("0"));
                    }
                }
                break;
            case "T": // Scroll Down (SD)
                {
                    const lines = args[0] || 1;
                    for (let i = 0; i < lines; i++) {
                        this.charBuffer.pop();
                        this.attrBuffer.pop();
                        this.charBuffer.unshift(Array(this.width).fill(" "));
                        this.attrBuffer.unshift(Array(this.width).fill("0"));
                    }
                }
                break;
            case "L": // Insert Line (IL)
                {
                    const lines = args[0] || 1;
                    for (let i = 0; i < lines; i++) {
                        this.charBuffer.splice(this.cursorY, 0, Array(this.width).fill(" "));
                        this.attrBuffer.splice(this.cursorY, 0, Array(this.width).fill("0"));
                        if (this.charBuffer.length > this.height) {
                            this.charBuffer.pop();
                            this.attrBuffer.pop();
                        }
                    }
                }
                break;
            case "M": // Delete Line (DL)
                {
                    const lines = args[0] || 1;
                    for (let i = 0; i < lines; i++) {
                        this.charBuffer.splice(this.cursorY, 1);
                        this.attrBuffer.splice(this.cursorY, 1);
                        this.charBuffer.push(Array(this.width).fill(" "));
                        this.attrBuffer.push(Array(this.width).fill("0"));
                    }
                }
                break;
            case "s": // Save Cursor Position (DECSC)
                this.savedCursorX = this.cursorX;
                this.savedCursorY = this.cursorY;
                break;
            case "u": // Restore Cursor Position (DECRC)
                if (this.savedCursorX !== undefined && this.savedCursorY !== undefined) {
                    this.cursorX = this.savedCursorX;
                    this.cursorY = this.savedCursorY;
                }
                break;
        }
    }

    public clear() {
        for (let y = 0; y < this.height; y++) {
            this.charBuffer[y].fill(" ");
            this.attrBuffer[y].fill("0");
        }
        this.cursorX = 0;
        this.cursorY = 0;
    }

    /**
     * resize(w, h): Mengubah ukuran buffer tanpa menghapus isinya (crop/expand).
     */
    public resize(newWidth: number, newHeight: number) {
        const newCharBuffer = Array.from({ length: newHeight }, () => Array(newWidth).fill(" "));
        const newAttrBuffer = Array.from({ length: newHeight }, () => Array(newWidth).fill("0"));

        // Copy old content (crop if smaller, expand if larger)
        const minHeight = Math.min(this.height, newHeight);
        const minWidth = Math.min(this.width, newWidth);

        for (let y = 0; y < minHeight; y++) {
            for (let x = 0; x < minWidth; x++) {
                newCharBuffer[y][x] = this.charBuffer[y][x];
                newAttrBuffer[y][x] = this.attrBuffer[y][x];
            }
        }

        this.charBuffer = newCharBuffer;
        this.attrBuffer = newAttrBuffer;
        this.width = newWidth;
        this.height = newHeight;

        // Clamp kursor agar tidak di luar angkasa
        this.cursorX = Math.min(this.cursorX, this.width - 1);
        this.cursorY = Math.min(this.cursorY, this.height - 1);
        if (this.cursorX < 0) this.cursorX = 0;
        if (this.cursorY < 0) this.cursorY = 0;
    }

    /**
     * render(): Menghasilkan string ANSI lengkap untuk menggambar ulang seluruh TTY ini.
     * Sangat eksplisit (menggunakan kursor absolut untuk setiap baris) agar tidak terpengaruh
     * oleh wrapping terminal host.
     */
    public render(): string {
        let output = "";
        let lastAttr = "reset";

        for (let y = 0; y < this.height; y++) {
            // Pindah kursor ke awal baris host secara absolut
            output += `\x1b[${y + 1};1H\x1b[2K`; // Go to row Y, col 1 AND Clear Line

            for (let x = 0; x < this.width; x++) {
                const attr = this.attrBuffer[y][x];
                if (attr !== lastAttr) {
                    output += `\x1b[${attr}m`;
                    lastAttr = attr;
                }
                output += this.charBuffer[y][x];
            }
        }

        // Kembalikan kursor ke posisi aslinya
        output += `\x1b[0m\x1b[${this.cursorY + 1};${this.cursorX + 1}H`;
        return output;
    }

    public getCursor() {
        return { x: this.cursorX, y: this.cursorY };
    }

    public pushInput(data: string) {
        if (this.rawMode) {
            // Raw Mode: Push directly to inputBuffer
            for (const char of data) {
                // Detect Ctrl+C even in raw mode
                if (char === "\u0003") {
                    if (this.onInterrupt) {
                        this.onInterrupt();
                    }
                    // Still push to buffer for apps that want to handle it
                    this.inputBuffer.push(char);
                } else {
                    this.inputBuffer.push(char);
                }
            }
        } else {
            // Cooked Mode: Handle Echo, Backspace, and Line Buffering
            for (const char of data) {
                const code = char.charCodeAt(0);

                // Detect Ctrl+C
                if (char === "\u0003") {
                    if (this.onInterrupt) {
                        this.onInterrupt();
                    }
                    // Don't add to buffer in cooked mode
                    continue;
                }

                if (char === "\r" || char === "\n") {
                    this.inputLines.push(this.lineBuffer + "\n");
                    this.lineBuffer = "";
                    this.write("\n"); // Echo newline
                    continue;
                }

                if (code === 127 || code === 8) { // Backspace
                    if (this.lineBuffer.length > 0) {
                        this.lineBuffer = this.lineBuffer.slice(0, -1);
                        this.write("\b \b"); // Echo backspace (visual erase)
                    }
                    continue;
                }

                this.lineBuffer += char;

                // --- ESCAPE SEQUENCE FILTER FOR COOKED ECHO ---
                // We must not echo ANY part of an escape sequence (like Arrows) to the host terminal.
                // Otherwise, printable parts of the sequence (like '[' and 'A') will appear as junk.
                if (char === "\x1b") {
                    this.cookedEchoState = "ESC";
                    continue;
                }

                if (this.cookedEchoState === "ESC") {
                    if (char === "[") {
                        this.cookedEchoState = "CSI";
                    } else {
                        // Not a CSI sequence, probably just a stray ESC or Alt-key
                        this.cookedEchoState = "NORMAL";
                    }
                    continue;
                }

                if (this.cookedEchoState === "CSI") {
                    // CSI sequences typically end with a character in the range 0x40-0x7E (A-Z, a-z, etc.)
                    if (code >= 0x40 && code <= 0x7E) {
                        this.cookedEchoState = "NORMAL";
                    }
                    continue;
                }

                // Echo only printable characters or standard whitespaces
                const isPrintable = (code >= 32 && code <= 126);
                const isAllowedControl = char === "\n" || char === "\r" || char === "\t";

                if (isPrintable || isAllowedControl) {
                    this.write(char);
                }
            }
        }
    }

    private cookedEchoState: "NORMAL" | "ESC" | "CSI" = "NORMAL";

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
        // Optionally flush lineBuffer when switching to raw mode?
        // Typically apps that switch to raw mode don't want pending cooked input.
        if (enabled) {
            this.lineBuffer = "";
        }
    }

    public getOutput(): string {
        const out = this.outputBuffer;
        this.outputBuffer = "";
        return out;
    }
}
