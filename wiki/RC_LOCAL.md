# RC.local - System Startup Scripts

## Overview

TSIX implements a traditional Unix-style `/etc/rc.local` boot script system for auto-starting daemons and services during system initialization.

## How It Works

1. **Boot Sequence**: After kernel initialization and identity setup, `init.ts` (PID 1) executes `/etc/rc.local`
2. **Synchronous Execution**: Init waits for rc.local to complete before spawning login services
3. **Exit Code**: rc.local should exit with code 0 for success, non-zero for failure

## File Location

```
/etc/rc.local
```

This file must be a valid TypeScript executable (like other TSIX binaries).

## Example rc.local

```typescript
import { UserLib } from "../lib/UserLib";

export default class RcLocal {
    async execute(lib: UserLib, args: string[]) {
        // Start daemons here
        await lib.shell.exec("/bin/airtermd.ts", [], undefined, undefined, undefined);
        
        // Exit with success
        await lib.shell.exit(0);
        return "";
    }
}
```

## Boot Flow

```
1. Kernel Boot
2. Init (PID 1) starts
3. System Identity Check
4. Execute /etc/rc.local ← Daemons start here
5. Spawn Login Services (TTY1-6)
6. Display Banner
7. Ready for user login
```

## Common Use Cases

- Start network daemons (`airtermd`)
- Initialize background services
- Mount additional filesystems
- Set system-wide configurations
- Start monitoring services

## Debugging

Check boot logs to see rc.local execution:
```bash
# During boot, you'll see:
[  OK  ] [INIT] Executing startup scripts (/etc/rc.local)...
[  OK  ] [rc.local] Starting system daemons...
[  OK  ] [rc.local] Airterm daemon started (PID 9).
[  OK  ] [INIT] Startup scripts completed successfully.
```

## Notes

- rc.local runs as **root** (UID 0)
- Services started from rc.local should daemonize themselves
- Use `lib.shell.exec()` to spawn background processes
- Always exit with proper exit code (0 = success)
