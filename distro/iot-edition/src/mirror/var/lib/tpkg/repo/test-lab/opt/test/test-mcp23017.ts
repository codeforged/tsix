import { Program, std, fs } from "@tsix/Application";

/**
 * TEST-MCP23017 Utility
 * 
 * Test and control MCP23017 GPIO expander.
 * 
 * Usage:
 *   test-mcp23017 /dev/mcp0 pinMode 0 OUTPUT
 *   test-mcp23017 /dev/mcp0 write 0 HIGH
 *   test-mcp23017 /dev/mcp0 read 15
 *   test-mcp23017 /dev/mcp0 readAll
 */

const IOCTL_SET_PIN_MODE = 0x3001;
const IOCTL_DIGITAL_WRITE = 0x3002;
const IOCTL_DIGITAL_READ = 0x3003;
const IOCTL_READ_ALL = 0x3004;

const MODE_OUTPUT = 0;
const MODE_INPUT = 1;
const MODE_INPUT_PULLUP = 2;

export const main = Program(async (args) => {
    if (args.length < 2) {
        await std.print("Usage: test-mcp23017 <device> <command> [args...]\n\n");
        await std.print("Commands:\n");
        await std.print("  pinMode <pin> <OUTPUT|INPUT|INPUT_PULLUP>\n");
        await std.print("  write <pin> <HIGH|LOW|1|0>\n");
        await std.print("  read <pin>\n");
        await std.print("  readAll\n\n");
        await std.print("Example:\n");
        await std.print("  test-mcp23017 /dev/mcp0 pinMode 0 OUTPUT\n");
        await std.print("  test-mcp23017 /dev/mcp0 write 0 HIGH\n");
        await std.print("  test-mcp23017 /dev/mcp0 read 15\n");
        return;
    }

    const device = args[0];
    const command = args[1];

    try {
        const fd = await fs.open(device, "w+");
        if (fd === null) {
            await std.print(`Error: Could not open ${device}\n`);
            return;
        }

        switch (command) {
            case "pinMode": {
                if (args.length < 4) {
                    await std.print("Usage: pinMode <pin> <OUTPUT|INPUT|INPUT_PULLUP>\n");
                    break;
                }

                const pin = parseInt(args[2]);
                const modeStr = args[3].toUpperCase();

                let mode: number;
                if (modeStr === "OUTPUT") mode = MODE_OUTPUT;
                else if (modeStr === "INPUT") mode = MODE_INPUT;
                else if (modeStr === "INPUT_PULLUP") mode = MODE_INPUT_PULLUP;
                else {
                    await std.print(`Invalid mode: ${modeStr}\n`);
                    break;
                }

                const result = await fs.ioctl(fd, IOCTL_SET_PIN_MODE, { pin, mode });
                if (result) {
                    await std.print(`✅ Pin ${pin} set to ${modeStr}\n`);
                } else {
                    await std.print(`❌ Failed to set pin ${pin} mode\n`);
                }
                break;
            }

            case "write": {
                if (args.length < 4) {
                    await std.print("Usage: write <pin> <HIGH|LOW|1|0>\n");
                    break;
                }

                const pin = parseInt(args[2]);
                const valueStr = args[3].toUpperCase();

                let value: number;
                if (valueStr === "HIGH" || valueStr === "1") value = 1;
                else if (valueStr === "LOW" || valueStr === "0") value = 0;
                else {
                    await std.print(`Invalid value: ${valueStr}\n`);
                    break;
                }

                const result = await fs.ioctl(fd, IOCTL_DIGITAL_WRITE, { pin, value });
                if (result) {
                    await std.print(`✅ Pin ${pin} set to ${valueStr}\n`);
                } else {
                    await std.print(`❌ Failed to write to pin ${pin}\n`);
                }
                break;
            }

            case "read": {
                if (args.length < 3) {
                    await std.print("Usage: read <pin>\n");
                    break;
                }

                const pin = parseInt(args[2]);
                const value = await fs.ioctl(fd, IOCTL_DIGITAL_READ, { pin });

                if (value !== null) {
                    await std.print(`Pin ${pin}: ${value ? 'HIGH' : 'LOW'} (${value})\n`);
                } else {
                    await std.print(`❌ Failed to read pin ${pin}\n`);
                }
                break;
            }

            case "readAll": {
                const value = await fs.ioctl(fd, IOCTL_READ_ALL, {});

                if (value !== null) {
                    await std.print(`All pins (16-bit): 0b${value.toString(2).padStart(16, '0')}\n`);
                    await std.print(`              Hex: 0x${value.toString(16).padStart(4, '0')}\n\n`);

                    // Display pin-by-pin
                    await std.print("Pin States:\n");
                    for (let i = 0; i < 16; i++) {
                        const state = (value >> i) & 0x01;
                        await std.print(`  Pin ${i.toString().padStart(2)}: ${state ? 'HIGH' : 'LOW '}\n`);
                    }
                } else {
                    await std.print(`❌ Failed to read all pins\n`);
                }
                break;
            }

            default:
                await std.print(`Unknown command: ${command}\n`);
                break;
        }

        await fs.close(fd);

    } catch (e: any) {
        await std.print(`Error: ${e.message}\n`);
    }
});
