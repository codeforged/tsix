# FSTAB Configuration Guide

TSIX supports automatic mounting of filesystems during boot via `/etc/fstab.json`.

## How to use

Create a file named `/etc/fstab.json` using the `edit` or `nano` command.

## JSON Format

The file should contain an array of mount objects:

```json
[
  {
    "vfsPath": "/tmp",
    "hostPath": "RAM",
    "type": "ramfs",
    "readOnly": false,
    "mode": 1023,
    "uid": 1000,
    "gid": 100
  },
  {
    "vfsPath": "/mnt/portal",
    "hostPath": "./portal",
    "type": "host",
    "readOnly": true
  },
  {
    "vfsPath": "/mnt/mydata",
    "hostPath": "./mydata.db",
    "type": "bkfs",
    "readOnly": false
  },
  {
    "vfsPath": "/mnt/shared",
    "hostPath": "./shared",
    "type": "host",
    "readOnly": false,
    "uid": 1000,
    "gid": 1000
  },
  {
    "vfsPath": "/mnt/backup",
    "hostPath": "./backup.db",
    "type": "bkfs",
    "readOnly": false,
    "active": false
  }
]
```

## Fields

- `vfsPath`: The absolute path within TSIX where the filesystem will be mounted.
- `hostPath`: The path on the host machine (relative to the TSIX project root or absolute).
- `type`: `"host"` (for host directories), `"bkfs"` (for SQLite databases), `"ramfs"` (for non persistent/RAM based storage)
- `readOnly`: Boolean (`true` or `false`) to enforce read-only protection.
- `uid` (optional): Numeric UID to set as owner of the mount point (default: `0` = root).
- `gid` (optional): Numeric GID to set as group owner of the mount point (default: `0` = root).
- `mode` (optional): Octal permission mode as decimal (e.g. `755` for rwxr-xr-x, `1023` for sticky rwxrwxrwt like /tmp). Default: `755`.
- `active` (optional): Boolean, default `true`. Set to `false` to skip this entry during boot.
