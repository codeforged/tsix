import { IDevice, KContext } from "../IDevice";
import { openSync } from "i2c-bus";

/**
 * MCP23017 I2C GPIO EXPANDER DRIVER
 *
 * Generic driver for MCP23017 16-bit I/O expander.
 * Provides basic GPIO control: pinMode, digitalWrite, digitalRead.
 *
 * AUTO-REGISTRATION CONVENTION:
 * This driver exports a static autoRegister() method that Kernel.ts
 * automatically calls during loadAuxDevices(). Platform-specific
 * hardware configuration lives here, not in Kernel.ts.
 */

// Platform-specific hardware configuration
// Modify this for your hardware setup
const HARDWARE_CONFIGS = [{ bus: 1, address: 0x24, name: "mcp-sw" }];

// MCP23017 Register Addresses
const IODIRA = 0x00; // Direction register A (pins 0-7)
const IODIRB = 0x01; // Direction register B (pins 8-15)
const GPPUA = 0x0c; // Pull-up register A
const GPPUB = 0x0d; // Pull-up register B
const GPIOA = 0x12; // Port register A (read/write)
const GPIOB = 0x13; // Port register B (read/write)

// Pin modes
const OUTPUT = 0;
const INPUT = 1;
const INPUT_PULLUP = 2;

export class MCP23017Device implements IDevice {
  name: string;
  uid: number = 0;
  gid: number = 0;
  mode: number = 0o660;
  disabled: boolean = true; // Set to true to skip loading during boot

  private i2cBus: any = null;
  private i2cBusNumber?: number;
  private address: number = 0x20;
  private directionCache: number[] = [0xff, 0xff]; // Cache for direction registers
  private initialized: boolean = false;

  constructor(i2cBusNumber?: number, address?: number, deviceName?: string) {
    this.name = deviceName || "mcp-bulb";
    this.i2cBusNumber = i2cBusNumber;
    this.address = address || 0x20;
  }

  /**
   * init(ctx): Unified initialization called by Kernel.
   * Use injected boot logging functions for TSIX standard output.
   */
  public init(ctx: KContext): void {
    // Technical info goes to syslog
    if (this.i2cBusNumber !== undefined) {
      ctx.syslog(
        `Inisialisasi Hardware MCP23017 pada 0x${this.address.toString(16)} (Bus ${this.i2cBusNumber})`,
      );
    }

    // Skip if no hardware parameters provided (auto-load discovery)
    if (this.i2cBusNumber === undefined) {
      return;
    }

    try {
      this.i2cBus = openSync(this.i2cBusNumber);

      // Initialize: Set all pins as INPUT by default
      this.writeRegister(IODIRA, 0xff);
      this.writeRegister(IODIRB, 0xff);

      // Disable pull-ups by default
      this.writeRegister(GPPUA, 0x00);
      this.writeRegister(GPPUB, 0x00);

      // Clear outputs
      this.writeRegister(GPIOA, 0x00);
      this.writeRegister(GPIOB, 0x00);

      this.initialized = true;
    } catch (err: any) {
      ctx.syslog(`Gagal inisialisasi hardware: ${err.message}`);
    }
  }

  /**
   * STATIC AUTO-REGISTER METHOD
   * Called automatically by Kernel.ts during loadAuxDevices()
   *
   * This is where platform-specific hardware gets registered!
   */
  static autoRegister(kernel: any): void {
    for (const config of HARDWARE_CONFIGS) {
      try {
        const device = new MCP23017Device(
          config.bus,
          config.address,
          config.name,
        );
        kernel.devices[config.name] = device;
        // Log is now handled by constructor for cleaner output
      } catch (e: any) {
        // Silently skip if hardware not present or i2c-bus not available
      }
    }
  }

  /**
   * pinMode(pin, mode): Configure pin as INPUT, OUTPUT, or INPUT_PULLUP
   */
  public pinMode(pin: number, pinMode: number): boolean {
    if (!this.initialized) {
      console.error(
        `[MCP23017] Device ${this.name} not initialized. Cannot set pin mode.`,
      );
      return false;
    }
    if (pin < 0 || pin > 15) return false;

    const bank = pin < 8 ? 0 : 1;
    const bitPos = pin % 8;
    const dirReg = bank === 0 ? IODIRA : IODIRB;
    const pullupReg = bank === 0 ? GPPUA : GPPUB;

    try {
      let direction = this.directionCache[bank];

      if (pinMode === OUTPUT) {
        direction &= ~(1 << bitPos);
        this.writeRegister(dirReg, direction);
        this.directionCache[bank] = direction;

        const pullup = this.readRegister(pullupReg);
        this.writeRegister(pullupReg, pullup & ~(1 << bitPos));
      } else if (pinMode === INPUT || pinMode === INPUT_PULLUP) {
        direction |= 1 << bitPos;
        this.writeRegister(dirReg, direction);
        this.directionCache[bank] = direction;

        if (pinMode === INPUT_PULLUP) {
          const pullup = this.readRegister(pullupReg);
          this.writeRegister(pullupReg, pullup | (1 << bitPos));
        }
      }

      return true;
    } catch (err: any) {
      console.error(`[MCP23017] pinMode error on pin ${pin}: ${err.message}`);
      return false;
    }
  }

  /**
   * digitalWrite(pin, value): Set output pin HIGH (1) or LOW (0)
   */
  public digitalWrite(pin: number, value: number): boolean {
    if (!this.initialized) {
      console.error(
        `[MCP23017] Device ${this.name} not initialized. Cannot write to pin.`,
      );
      return false;
    }
    if (pin < 0 || pin > 15) return false;

    const bank = pin < 8 ? 0 : 1;
    const bitPos = pin % 8;
    const gpioReg = bank === 0 ? GPIOA : GPIOB;

    try {
      let gpio = this.readRegister(gpioReg);

      if (value) {
        gpio |= 1 << bitPos;
      } else {
        gpio &= ~(1 << bitPos);
      }

      this.writeRegister(gpioReg, gpio);
      return true;
    } catch (err: any) {
      console.error(
        `[MCP23017] digitalWrite error on pin ${pin}: ${err.message}`,
      );
      return false;
    }
  }

  /**
   * digitalRead(pin): Read input pin state (0 or 1)
   */
  public digitalRead(pin: number): number | null {
    if (!this.initialized) {
      console.error(
        `[MCP23017] Device ${this.name} not initialized. Cannot read pin.`,
      );
      return null;
    }
    if (pin < 0 || pin > 15) return null;

    const bank = pin < 8 ? 0 : 1;
    const bitPos = pin % 8;
    const gpioReg = bank === 0 ? GPIOA : GPIOB;

    try {
      const gpio = this.readRegister(gpioReg);
      return (gpio >> bitPos) & 0x01;
    } catch (err: any) {
      console.error(
        `[MCP23017] digitalRead error on pin ${pin}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * readAll(): Read all 16 pins as bitmask
   */
  public readAll(): number | null {
    if (!this.initialized) {
      console.error(
        `[MCP23017] Device ${this.name} not initialized. Cannot read all pins.`,
      );
      return null;
    }
    try {
      const portA = this.readRegister(GPIOA);
      const portB = this.readRegister(GPIOB);
      return (portB << 8) | portA;
    } catch (err: any) {
      console.error(`[MCP23017] readAll error: ${err.message}`);
      return null;
    }
  }

  // IDevice interface implementations
  public read(): any {
    return this.readAll();
  }

  public write(data: any): boolean {
    return false; // Use ioctl for GPIO control
  }

  public ioctl(cmd: number, arg: any): any {
    try {
      switch (cmd) {
        case 0x3001: // SET_PIN_MODE
          const { pin: modePin, mode: pinMode } = arg;
          return this.pinMode(modePin, pinMode);

        case 0x3002: // DIGITAL_WRITE
          const { pin: writePin, value } = arg;
          return this.digitalWrite(writePin, value);

        case 0x3003: // DIGITAL_READ
          const { pin: readPin } = arg;
          return this.digitalRead(readPin);

        case 0x3004: // READ_ALL
          return this.readAll();

        default:
          return null;
      }
    } catch (err: any) {
      console.error(`[MCP23017] ioctl error: ${err.message}`);
      return null;
    }
  }

  // Low-level I2C operations
  private writeRegister(register: number, value: number): void {
    this.i2cBus.writeByteSync(this.address, register, value);
  }

  private readRegister(register: number): number {
    return this.i2cBus.readByteSync(this.address, register);
  }

  public close(): boolean {
    try {
      if (this.i2cBus) {
        this.i2cBus.closeSync();
      }
      return true;
    } catch (err: any) {
      console.error(`[MCP23017] Error closing ${this.name}: ${err.message}`);
      return false;
    }
  }
}

export default MCP23017Device;
