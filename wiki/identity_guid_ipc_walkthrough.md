# Walkthrough: Implementing Persistent UUID-based Application Identity

## Objective
The goal was to move away from ephemeral PID-based inter-process communication (IPC) towards a more robust system where applications are identified by a persistent, hard-coded UUID (similar to Windows GUIDs).

## Implementation Details

### Kernel Layer
- **New Syscall**: `SET_IDENTITY` (code 60) was added to allow apps to register their "well-known identity" at runtime.
- **Scheduler Core**: Added `uuidMap` to track the connection between UUID strings and current PIDs.
- **IPC Upgrade**: The `SEND_MSG` syscall now resolves string targets via the `uuidMap` before routing events.
- **Lifecycle Management**: The `reap()` method in the Scheduler was updated to automatically unregister UUIDs when a process exits, preventing stale identities.

### User Land Layer
- **UserLib**: Added `lib.shell.registerIdentity(uuid)` to the shell library.
- **PID/UUID Parsing**: Updated targeting logic to intelligently distinguish between numeric PIDs and UUID strings.

### Example Apps
- **ipc-listen**: Now registers a static UUID `6e8bc0f8-c2b5-11d0-a765-00a0c91e6bf6` on startup.
- **ipc-send**: Can now be called using a UUID: `ipc-send 6e8bc0f8-c2b5-11d0-a765-00a0c91e6bf6 "Hello persistence!"`.

## Bug Fixes during Implementation
- **Integer Truncation Bug**: Fixed an issue where UUIDs starting with numbers were truncated by `parseInt`. Added regex-based numeric verification to accurately detect PIDs.
- **VFS Staleness**: Identified and resolved a synchronization gap where new Syscall codes weren't immediately available to Workers until a full `vfs:bootstrap` was performed.

## How to Test
1. Start the listener: `ipc-listen`
2. Send a message to its permanent identity: `ipc-send 6e8bc0f8-c2b5-11d0-a765-00a0c91e6bf6 "Test Message"`
3. Verify the message is received even if the listener is restarted and assigned a different PID.
