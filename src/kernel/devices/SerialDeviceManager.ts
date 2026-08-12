import { SerialPort } from 'serialport';
import { SerialDevice } from './SerialDevice';
import { Logger } from '../../common/Logger';

/**
 * SERIAL DEVICE MANAGER
 * 
 * Bertanggung jawab melakukan scanning port serial (USB-to-Serial)
 * secara berkala dan mendaftarkannya ke Kernel Registry.
 */
export class SerialDeviceManager {
    private kernel: any; // Use any to avoid circular dependency in types if needed
    private registeredPorts: Map<string, SerialDevice> = new Map();
    private logger: Logger;
    private scanInterval: NodeJS.Timeout | null = null;

    constructor(kernel: any) {
        this.kernel = kernel;
        this.logger = new Logger("SerialManager");
    }

    public startAutoDetection(intervalMs: number = 3000) {
        this.logger.info("Serial auto-detection enabled.");
        this.scan(); // Initial scan
        this.scanInterval = setInterval(() => this.scan(), intervalMs);
    }

    public stopAutoDetection() {
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
            this.scanInterval = null;
        }
    }

    private async scan() {
        try {
            const ports = await SerialPort.list();
            const currentPortPaths = new Set(ports.map(p => p.path));

            // 1. Deteksi perangkat yang dicabut (Hot-unplug)
            for (const [path, device] of this.registeredPorts.entries()) {
                if (!currentPortPaths.has(path)) {
                    this.logger.info(`Serial port removed: ${path} (/dev/${device.name})`);
                    device.close();

                    if (this.kernel.devices && this.kernel.devices[device.name]) {
                        delete this.kernel.devices[device.name];
                    }

                    this.registeredPorts.delete(path);
                    this.kernel.syslog?.("Kernel", `Device /dev/${device.name} removed (USB unplugged).`);
                }
            }

            // 2. Deteksi perangkat baru (Hot-plug)
            for (const portInfo of ports) {
                if (!this.registeredPorts.has(portInfo.path)) {
                    // Decide prefix: ttyUSB for USB devices, ttyS for onboard/unknown
                    // Onboard ports usually lack vendorId/productId.
                    // Windows standard ports often have manufacturer "(Standard port types)" which we should ignore.
                    const isUsb = !!(portInfo.vendorId || portInfo.productId);
                    const prefix = isUsb ? "ttyUSB" : "ttyS";

                    const devName = this.getNextDevName(prefix);
                    this.logger.info(`New serial port found: ${portInfo.path} (${isUsb ? 'USB' : 'Internal'}) -> /dev/${devName}`);

                    const device = new SerialDevice(portInfo.path, devName);

                    // Daftarkan ke Kernel
                    if (!this.kernel.devices) this.kernel.devices = {};
                    this.kernel.devices[devName] = device;
                    this.registeredPorts.set(portInfo.path, device);

                    // Inisialisasi Driver
                    device.init({
                        syslog: (msg) => this.kernel.syslog?.(devName, msg)
                    });

                    this.kernel.syslog?.("Kernel", `New device /dev/${devName} registered for ${portInfo.path} (${isUsb ? 'USB-Serial' : 'Standard-UART'})`);
                }
            }
        } catch (e: any) {
            this.logger.debug(`Serial scan error: ${e.message}`);
        }
    }

    /**
     * getNextDevName(): Mencari index ttyS/ttyUSBx yang kosong.
     */
    private getNextDevName(prefix: string): string {
        let i = 0;
        while (this.kernel.devices && this.kernel.devices[`${prefix}${i}`]) {
            i++;
        }
        return `${prefix}${i}`;
    }
}
