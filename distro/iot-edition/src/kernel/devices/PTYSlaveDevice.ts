import { IDevice } from "./IDevice";

/**
 * PTY SLAVE DEVICE (/dev/pts/N)
 *
 * Sisi "slave" dari pasangan pseudo-terminal. Ini yang dipakai proses
 * (login/shell) sebagai stdin/stdout/stderr. Berbeda dari TTYDevice (konsol
 * virtual), PTY slave TIDAK merender ke layar host — output hanya ditampung
 * di buffer untuk dibaca sisi master (daemon tsshd/airtermd/pixelterm).
 *
 * RAM-friendly: tidak mengalokasikan charBuffer layar penuh (height×width)
 * seperti TTY konsol. Cukup line-based line buffer + output stream buffer.
 */
export class PTYSlaveDevice implements IDevice {
    public name: string;
    public uid: number = 0;
    public gid: number = 0;
    public mode: number = 0o600; // Slave hanya diakses via kernel routing / proses yang ditunjuk

    private id: number;

    // Line discipline (cooked mode)
    private lineBuffer: string = "";
    private inputLines: string[] = [];   // Baris selesai (Enter) — dibaca proses
    private rawMode: boolean = false;
    private rawInputBuffer: string[] = [];
    private outputBuffer: string = "";   // Output proses — dibaca master

    public onInterrupt: (() => void) | null = null; // Ctrl+C dari remote

    constructor(id: number) {
        this.id = id;
        this.name = `pts/${id}`;
    }

    public getPtyId(): number {
        return this.id;
    }

    /** read(): Dibaca oleh proses (shell) sebagai stdin. */
    public read(): any {
        if (this.rawMode) {
            if (this.rawInputBuffer.length === 0) return null;
            return this.rawInputBuffer.shift() || null;
        }
        if (this.inputLines.length === 0) return null;
        return this.inputLines.shift() || null;
    }

    /** setRawMode(): Set line discipline raw/cooked (kontrak TTY cmd 10). */
    public setRawMode(enabled: boolean): void {
        this.rawMode = !!enabled;
        if (this.rawMode) this.lineBuffer = "";
    }

    /** clearLineBuffer(): Kosongkan baris yang belum selesai (saat switch raw). */
    public clearLineBuffer(): void {
        this.lineBuffer = "";
    }

    /** write(): Output proses → ditampung (dibaca master via getOutput/ioctl 0x2002). */
    public write(data: any): boolean {
        const str = data?.toString?.() ?? String(data ?? "");
        if (!str) return true;
        this.outputBuffer += str;
        return true;
    }

    /** injectInput(): Dari master (remote keyboard) → line discipline slave. */
    public injectInput(data: string): boolean {
        if (!data) return true;
        if (this.rawMode) {
            for (const ch of data) {
                if (ch === "\u0003" && this.onInterrupt) this.onInterrupt();
                this.rawInputBuffer.push(ch);
            }
        } else {
            for (const ch of data) {
                const code = ch.charCodeAt(0);
                if (ch === "\u0003") {
                    if (this.onInterrupt) this.onInterrupt();
                    continue;
                }
                if (ch === "\r" || ch === "\n") {
                    this.inputLines.push(this.lineBuffer + "\n");
                    this.lineBuffer = "";
                    // Echo newline ke master (biar remote melihat baris baru)
                    this.write("\n");
                    continue;
                }
                if (code === 127 || code === 8) {
                    if (this.lineBuffer.length > 0) {
                        this.lineBuffer = this.lineBuffer.slice(0, -1);
                        this.write("\b \b");
                    }
                    continue;
                }
                this.lineBuffer += ch;
                // Echo printable chars (cooked) ke master
                const isPrintable = code >= 32 && code <= 126;
                const isAllowedControl = ch === "\t";
                if (isPrintable || isAllowedControl) this.write(ch);
            }
        }
        return true;
    }

    /** getOutput(): Dibaca master untuk mengambil output yang belum terkirim. */
    public getOutput(): string {
        const out = this.outputBuffer;
        this.outputBuffer = "";
        return out;
    }

    public ioctl(cmd: number, arg: any): any {
        switch (cmd) {
            // KONTRAK IOCTL harus SAMA dengan TTYDevice (konsol virtual):
            //   cmd 10 = SET_RAW_MODE  (dipakai lib.std.setRawMode())
            //   cmd 4  = TIOCGWINSZ
            //   cmd 0x2001 = INJECT_INPUT
            //   cmd 0x2002 = READ_OUTPUT
            // (Sebelumnya cmd 10 salah dikira INC_READ_REF → setRawMode tidak
            //  jalan → injectInput selalu cooked → double echo. FIXED.)
            case 10: // 10 = SET_RAW_MODE (kontrak TTY)
                this.setRawMode(!!arg);
                return 0;
            case 3: // TIOCSWINSZ — resize slave (daemon buka /dev/pts/N)
                if (arg && typeof arg === "object") {
                    const { lines, columns } = arg as { lines: number; columns: number };
                    this.height = lines > 0 ? lines : 24;
                    this.width = columns > 0 ? columns : 80;
                }
                return 0;
            case 4: // TIOCGWINSZ
                return { lines: this.height, columns: this.width };
            case 5: // FLUSH_INPUT — buang stale input (konsistensi dgn TTYDevice)
                this.lineBuffer = "";
                this.inputLines = [];
                this.rawInputBuffer = [];
                return 0;
            case 1: // CLEAR_SCREEN — PTY tidak punya layar, no-op
                return 0;
            case 2: // SWITCH_TTY — PTY bukan konsol
                return -1;
            case 0x2001: // INJECT_INPUT (master → slave)
                return this.injectInput(arg as string);
            case 0x2002: // READ_OUTPUT (master baca slave)
                return this.getOutput();
        }
        return -1;
    }

    // Ukuran terminal (default; di-update oleh daemon via TIOCSWINSZ)
    public width: number = 80;
    public height: number = 24;
}
