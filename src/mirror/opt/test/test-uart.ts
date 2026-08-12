import { Program, std, fs } from "@tsix/Application";

/**
 * TEST-UART Utility
 * 
 * Interaksi langsung dengan Serial Port (UART).
 * Penggunaan: test-uart [/dev/ttyUSBx]
 */
export const main = Program(async (args) => {
    const devPath = args[0] || "/dev/ttyUSB0";
    const baudRate = parseInt(args[1] || "9600");

    await std.print(`\x1b[92mUART Terminal - Device: ${devPath} @ ${baudRate}baud\x1b[0m\n`);
    await std.print(`\x1b[90m(Press Ctrl+X to exit)\x1b[0m\n\n`);

    try {
        const fd = await fs.open(devPath, "w+");
        if (fd === null) {
            await std.print(`Error: Could not open ${devPath}\n`);
            return;
        }

        // Set Baud Rate
        await fs.ioctl(fd, 0x102, baudRate);

        let isRunning = true;
        await std.setRawMode(true);

        // --- RX LOOP (Background) ---
        const rxLoop = async () => {
            while (isRunning) {
                try {
                    const data = await fs.read(fd);
                    if (data && data.length > 0) {
                        await std.print(data);
                    }
                } catch (e) {
                    // Port might be closed
                }
                await new Promise(r => setTimeout(r, 50));
            }
        };
        rxLoop();

        // --- TX LOOP (Foreground) ---
        while (isRunning) {
            const char = await std.getChar();
            if (char === null) break;

            // Ctrl+X (0x18) to exit
            if (char === "\x18") {
                isRunning = false;
                break;
            }

            // Write character to UART
            await fs.write(fd, char);

            // Local echo (optional, but usually helpful for tests)
            // await std.print(char); 
        }

        await std.setRawMode(false);
        await fs.close(fd);
        await std.print(`\n\x1b[91mUART closed.\x1b[0m\n`);

    } catch (e: any) {
        await std.setRawMode(false);
        await std.print(`\nError: ${e.message}\n`);
    }
});
