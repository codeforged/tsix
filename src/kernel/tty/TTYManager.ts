import { TTY } from "./TTY";
import { Logger } from "../../common/Logger";

/**
 * TTY MANAGER
 * 
 * Mengelola siklus hidup banyak TTY dan perpindahan antar konsol.
 */
export class TTYManager {
    private ttys: Map<number, TTY> = new Map();
    private activeId: number = 1;
    private logger: Logger;
    private onSwitchCallback?: (ttyId: number) => void;
    private onInterruptCallback?: (ttyId: number) => void;
    private visualIdentity: string = "";

    constructor(count: number = 6) {
        this.logger = new Logger("TTYManager");
        const rows = process.stdout.rows || 24;
        const cols = process.stdout.columns || 80;

        for (let i = 1; i <= count; i++) {
            const tty = new TTY(i, cols, rows);
            tty.onWrite = (data) => {
                if (this.activeId === i) {
                    process.stdout.write(data);
                }
            };
            tty.onInterrupt = () => {
                if (this.onInterruptCallback) {
                    this.onInterruptCallback(i);
                }
            };
            this.ttys.set(i, tty);
        }
        this.logger.info(`Initialized ${count} Virtual Consoles.`);
    }

    /**
     * setVisualIdentity(): Store the system color bar for transitions.
     */
    public setVisualIdentity(ident: string) {
        this.visualIdentity = ident;
        this.logger.info("Visual Identity established for TTY transitions.");
    }

    /**
     * setOnInterruptCallback(): Register callback for Ctrl+C events.
     */
    public setOnInterruptCallback(callback: (ttyId: number) => void) {
        this.onInterruptCallback = callback;
    }

    public getTTY(id: number): TTY | undefined {
        return this.ttys.get(id);
    }

    public getActiveTTY(): TTY {
        return this.ttys.get(this.activeId)!;
    }

    public getActiveId(): number {
        return this.activeId;
    }

    /**
     * setOnSwitchCallback(): Register callback to notify when TTY switches.
     */
    public setOnSwitchCallback(callback: (ttyId: number) => void) {
        this.onSwitchCallback = callback;
    }

    /**
     * switch(id): Berpindah ke TTY lain dan menggambar ulang layar.
     */
    public async switch(id: number, forceRedraw: boolean = false) {
        if (!this.ttys.has(id)) return;
        if (id === this.activeId && !forceRedraw) return;

        this.logger.info(`Switching from TTY${this.activeId} to TTY${id}`);
        this.activeId = id;

        // Render ulang seluruh layar dari buffer TTY baru
        // Kita gunakan \x1bc (RIS) untuk reset total terminal host agar tidak ada sisa kotoran dari TTY lama
        process.stdout.write("\x1bc\x1b[3J");

        // Polish: Visual Switch Banner (Centered)
        if (this.visualIdentity && !forceRedraw) {
            const rows = process.stdout.rows || 24;
            const cols = process.stdout.columns || 80;

            const text = `TSIX VIRTUAL CONSOLE [ TTY ${id} ]`;
            const barLines = this.visualIdentity.split("\n");

            // Text width is ~32, Bar width is also 32 (8 blocks * 4 spaces)
            const bannerWidth = 32;
            const bannerHeight = 1 + barLines.length; // Title + bars

            const startRow = Math.max(1, Math.floor((rows - bannerHeight) / 2));
            const startCol = Math.max(1, Math.floor((cols - bannerWidth) / 2));

            // Hide cursor and clear for banner
            process.stdout.write("\x1b[?25l");

            // Move to start position and draw
            process.stdout.write(`\x1b[${startRow};${startCol}H\x1b[97m  ${text}\x1b[0m`);
            barLines.forEach((line, index) => {
                process.stdout.write(`\x1b[${startRow + 1 + index};${startCol}H${line}`);
            });

            // Tunggu sebentar biar usernya bisa liat "Visual Identity"-nya
            await new Promise(resolve => setTimeout(resolve, 500));

            // Clean up: Reset terminal and SHOW cursor
            process.stdout.write("\x1bc\x1b[3J\x1b[?25h");
        }

        const content = this.getActiveTTY().render();
        process.stdout.write(content);

        // Notify foreground process in the newly activated TTY
        if (this.onSwitchCallback) {
            this.onSwitchCallback(id);
        }
    }

    /**
     * handleResize(): Update dimensi semua TTY saat jendela host berubah.
     */
    public handleResize(cols: number, rows: number) {
        for (const [id, tty] of this.ttys.entries()) {
            this.handleTTYResize(id, cols, rows);
        }
    }

    /**
     * handleTTYResize(): Update dimensi TTY spesifik (e.g. dari remote resize).
     */
    public handleTTYResize(ttyId: number, cols: number, rows: number) {
        const tty = this.ttys.get(ttyId);
        if (!tty) return;

        tty.resize(cols, rows);

        // Jika TTY ini sedang aktif di layar host, paksakan redraw
        if (this.activeId === ttyId) {
            this.switch(this.activeId, true);
        }
    }
}
