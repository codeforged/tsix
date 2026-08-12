# Manual MCP23017 Registration Guide

## Auto-Load Behavior

By default, `MCP23017Device` is **auto-loaded** but **not initialized** because it requires hardware-specific parameters (I2C bus number and address). On boot you'll see:

```
[MCP23017] Device mcp23017 registered but not initialized (no I2C parameters)
```

This is **normal and safe** - the driver is loaded but inactive.

## Manual Registration

To use MCP23017 with your hardware, add manual registration in `src/root/etc/rc.local.ts`:

### Example: Single MCP23017 at 0x20

```typescript
import { MCP23017Device } from "@tsix/kernel/devices/aux-devices/MCP23017Device";

// Register MCP23017 on I2C bus 0, address 0x20
const mcp0 = new MCP23017Device(0, 0x20, "mcp0");
kernel.devices["mcp0"] = mcp0;

console.log("MCP23017 registered at /dev/mcp0");
```

### Example: Multiple MCP23017 Chips

```typescript
import { MCP23017Device } from "@tsix/kernel/devices/aux-devices/MCP23017Device";

// First chip at 0x20 (for relays)
const relays = new MCP23017Device(0, 0x20, "relays");
kernel.devices["relays"] = relays;

// Second chip at 0x24 (for switches)  
const switches = new MCP23017Device(0, 0x24, "switches");
kernel.devices["switches"] = switches;

console.log("GPIO expanders registered: /dev/relays, /dev/switches");
```

## Verify I2C Address

Before registration, check your hardware address:

```bash
sudo i2cdetect -y 0
# or
sudo i2cdetect -y 1
```

Look for device address in the output (0x20, 0x24, etc.)

## Testing

After registration, test with:

```bash
test-mcp23017 /dev/mcp0 readAll
test-mcp23017 /dev/mcp0 pinMode 0 OUTPUT
test-mcp23017 /dev/mcp0 write 0 HIGH
```

## Troubleshooting

**Error: "Cannot find module 'i2c-bus'"**
```bash
npm install i2c-bus
```

**Error: "Permission denied" on I2C bus**
```bash
sudo usermod -a -G i2c $USER
# Logout and login again
```

**Error: "No such device"**
- Check I2C is enabled: `sudo orangepi-config` → Hardware → i2c
- Verify wiring: SDA, SCL, VCC (3.3V), GND
- Confirm address with `i2cdetect`
