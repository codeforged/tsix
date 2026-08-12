import { SerialPort } from 'serialport';
import { IDevice, KContext } from './IDevice';

/**
 * SERIAL DEVICE DRIVER
 * 
 * Wrapper untuk library 'serialport' Node.js agar bisa diakses
 * sebagai IDevice di dalam TSIX Kernel.
 */
export class SerialDevice implements IDevice {
    name: string;
    private port: SerialPort;
    private buffer: string = "";
    private refCount: number = 0; // Track how many FDs are using this port

    // IDevice properties
    uid: number = 0;
    gid: number = 100;    // Group 'users'
    mode: number = 0o660; // rw-rw----

    constructor(devPath: string, name: string, baudRate: number = 9600) {
        this.name = name;

        this.port = new SerialPort({
            path: devPath,
            baudRate: baudRate,
            autoOpen: false // Important: Don't auto-open!
        });

        this.port.on('data', (chunk) => {
            this.buffer += chunk.toString();
        });

        this.port.on('open', () => {
            // Hardware ready
        });

        // Handle SerialPort errors to prevent system crashes
        this.port.on('error', (err) => {
            console.error(`[SerialDevice] Error on ${this.name}: ${err.message}`);
        });
    }

    init(ctx: KContext): void {
        // Technical registration info
        ctx.syslog(`Registrasi Serial Driver pada ${this.port.path} (Baud: ${this.port.baudRate})`);
    }

    /**
     * open(): Lazy-open with reference counting
     * Called by syscall OPEN handler when userland opens /dev/ttyUSBx
     */
    open(): boolean {
        if (this.refCount === 0 && !this.port.isOpen) {
            // First open - actually open the hardware
            this.port.open((err) => {
                if (err) {
                    console.error(`[SerialDevice] Failed to open ${this.name}: ${err.message}`);
                }
            });
            // Small synchronous wait to give port time to open (typically 50-100ms)
            // This is a compromise: avoid complex async handling while preventing immediate writes
            const deadline = Date.now() + 200; // 200ms timeout
            while (!this.port.isOpen && Date.now() < deadline) {
                // Busy wait (not ideal, but simple and works for kernel-level driver)
            }
        }
        this.refCount++;
        return true;
    }

    read(): any {
        const data = this.buffer;
        this.buffer = "";
        return data;
    }

    write(data: any): boolean {
        if (!this.port.isOpen) {
            console.error(`[SerialDevice] Cannot write to ${this.name}: port not ready`);
            return false;
        }

        this.port.write(data, (err) => {
            if (err) {
                console.error(`[SerialDevice] Write error on ${this.name}: ${err.message}`);
            }
        });
        return true;
    }

    ioctl(cmd: number, arg: any): any {
        // 0x101: Get Baudrate, 0x102: Set Baudrate
        if (cmd === 0x101) return this.port.baudRate;
        if (cmd === 0x102) {
            const newBaud = parseInt(arg);
            if (!isNaN(newBaud)) {
                this.port.update({ baudRate: newBaud });
                return true;
            }
        }
        return true;
    }

    /**
     * close(): Reference-counted close
     * Only actually closes hardware when last FD is closed
     */
    close(): boolean {
        this.refCount--;

        if (this.refCount === 0) {
            // Last close - actually close the hardware
            if (this.port.isOpen) {
                this.port.close();
            }
        }
        return true;
    }
}
