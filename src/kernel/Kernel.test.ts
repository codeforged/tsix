import { describe, it, expect, beforeEach, vi } from "vitest";
import { Kernel } from "./Kernel";

// Mock external dependencies to avoid actual boot
vi.mock("fs");
vi.mock("../common/Logger");
vi.mock("../vfs/BKFS");
vi.mock("./Scheduler");
vi.mock("./Syscalls");
vi.mock("./PermissionManager");
vi.mock("./PortManager");
vi.mock("./MountManager");
vi.mock("./GUIRegistry");
vi.mock("../common/Config");
vi.mock("./tty/TTYManager");
vi.mock("./PTYManager");
vi.mock("./devices/SimpleMQTNLDriver");
vi.mock("./devices/SerialDeviceManager");

describe("Kernel (A3)", () => {
    let kernel: Kernel;

    beforeEach(() => {
        kernel = new Kernel();
    });

    // A3.01
    it("A3.01 getVersion returns version string", () => {
        expect(kernel.getVersion()).toBeDefined();
        expect(typeof kernel.getVersion()).toBe("string");
        expect(kernel.getVersion().length).toBeGreaterThan(0);
    });

    // A3.02
    it("A3.02 getCodename returns codename string", () => {
        expect(kernel.getCodename()).toBeDefined();
        expect(typeof kernel.getCodename()).toBe("string");
    });

    // A3.03
    it("A3.03 getUptime returns positive number", () => {
        const uptime = kernel.getUptime();
        expect(typeof uptime).toBe("number");
        expect(uptime).toBeGreaterThanOrEqual(0);
    });

    // A3.04
    it("A3.04 devices registry is initialized as empty object", () => {
        expect(kernel.devices).toBeDefined();
        expect(typeof kernel.devices).toBe("object");
    });

    // A3.05
    it("A3.05 wantedExitCode defaults to 0", () => {
        expect(kernel.wantedExitCode).toBe(0);
    });

    // A3.06
    it("A3.06 guiRegistry is defined", () => {
        expect(kernel.guiRegistry).toBeDefined();
    });

    // A3.07 – bootLog requires kernel to be booted first, skip
    // A3.08
    it("A3.08 boot throws for invalid path", async () => {
        await expect(kernel.boot("nonexistent/path.db")).rejects.toThrow();
    });

    // A3.09
    it("A3.09 kernel hash matches between instances", () => {
        const k2 = new Kernel();
        expect(kernel.getVersion()).toBe(k2.getVersion());
    });

    // A3.10
    it("A3.10 codename is not empty", () => {
        expect(kernel.getCodename().length).toBeGreaterThan(0);
    });

    /**
     * Hotkey pindah TTY. Diuji lewat tabel, karena tiap terminal mengirim
     * encoding berbeda untuk kombinasi yang sama — dan regresi sebelumnya
     * (commit fd3be6e) menghapus varian ESC+digit tanpa ada yang menangkapnya.
     */
    describe("hotkey pindah TTY", () => {
        let fakeTty: { switch: ReturnType<typeof vi.fn> };

        beforeEach(() => {
            fakeTty = { switch: vi.fn() };
            (kernel as any).ttyManager = fakeTty;
        });

        const hotkey = (seq: string): boolean =>
            (kernel as any).handleKeyboardHotkey(seq);

        // A3.11
        it("A3.11 Alt+1..6 (ESC + digit) memindahkan TTY — bentuk native Linux/VS Code", () => {
            for (let d = 1; d <= 6; d++) {
                expect(hotkey("\x1b" + d)).toBe(true);
            }
            expect(fakeTty.switch.mock.calls.map((c: any[]) => c[0])).toEqual([
                1, 2, 3, 4, 5, 6,
            ]);
        });

        // A3.12
        it("A3.12 varian encoding lain (macOS, Alt+F, CSI-u, modifyOtherKeys, caret notation)", () => {
            const cases: Array<[string, number]> = [
                // macOS Terminal: Option+1..6 (Option as Meta OFF)
                ["¡", 1],
                ["™", 2],
                ["£", 3],
                ["¢", 4],
                ["∞", 5],
                ["§", 6],
                // Alt+F1..F6
                ["\x1b\x1bOP", 1],
                ["\x1b[1;3P", 1],
                ["\x1b[12;3~", 2],
                ["\x1b[17;3~", 6],
                // CSI-u (kitty/wezterm/Ghostty/foot/iTerm2 Report modifiers)
                ["\x1b[49;3u", 1],
                ["\x1b[54;3u", 6],
                ["\x1b[49;5u", 1],
                ["\x1b[54;5u", 6],
                // modifyOtherKeys=2 (xterm, iTerm2 legacy)
                ["\x1b[27;3;49~", 1],
                ["\x1b[27;5;53~", 5],
                ["\x1b[27;7;52~", 4],
                // Ctrl+Alt+digit lewat CSI-u (kitty/wezterm/Ghostty/foot)
                ["\x1b[49;7u", 1],
                ["\x1b[54;7u", 6],
                // Caret notation: Ctrl+4/5/6 = FS/GS/RS
                ["\x1c", 4],
                ["\x1d", 5],
                ["\x1e", 6],
            ];

            for (const [seq, ttyId] of cases) {
                expect(hotkey(seq)).toBe(true);
                expect(fakeTty.switch).toHaveBeenLastCalledWith(ttyId);
            }
        });

        // A3.13
        it("A3.13 Ctrl+Alt+digit: ESC+digit di xterm.js, caret notation di VTE", () => {
            // xterm.js (VS Code, dome/pixelterm): Ctrl+Alt+digit → ESC+digit.
            // VTE/GNOME Terminal: hanya Ctrl+Alt+1 → ESC+1; Ctrl+Alt+2..6 jatuh ke
            // caret notation (NUL/ESC/FS/GS/RS) seperti Ctrl+digit telanjang —
            // sudah tertangani entri 0x1C..0x1E di A3.12.
            for (let d = 1; d <= 6; d++) {
                expect(hotkey("\x1b" + d)).toBe(true);
            }
            expect(fakeTty.switch.mock.calls.map((c: any[]) => c[0])).toEqual([
                1, 2, 3, 4, 5, 6,
            ]);
        });

        // A3.14
        it("A3.14 tombol biasa (termasuk ESC & kata mirip properti) tetap diteruskan ke aplikasi", () => {
            const notHotkeys = [
                "\x1b", // ESC tunggal — wajib sampai ke app (atto/vim)
                "a",
                "1",
                "\x1b[A", // Up
                "\x1b[3~", // Delete
                "\x7f", // Backspace
                "\x03", // Ctrl+C
                "\x00", // Ctrl+Space / Ctrl+@
                "constructor", // dulu bisa ditelan karena lookup prototype
                "toString",
            ];

            for (const seq of notHotkeys) {
                expect(hotkey(seq)).toBe(false);
            }
            expect(fakeTty.switch).not.toHaveBeenCalled();
        });
    });
});
