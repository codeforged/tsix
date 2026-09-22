# FSTAB Configuration Guide

TSIX mounts filesystems automatically at boot. The kernel reads, in order:

1. **`/etc/fstab.conf`** — INI style (recommended, human-friendly)
2. `/etc/fstab.json` — legacy JSON array (still supported; used automatically
   when the `.conf` file does not exist)

If both exist, `.conf` wins.

## How to use

Create/edit the file with `edit` or `nano`, then reboot (or `mount` by hand).

## INI format (`.conf`)

One `[mount-point]` section per mount, followed by `key = value` lines:

```ini
# komentar pakai '#' atau ';'
[/tmp]
hostPath = RAM
mode     = 0o1777        ; sticky, seperti /tmp di Linux
type     = ramfs
uid      = 0
gid      = 100
active   = true

[/mnt/shared]
hostPath = shared
type     = host
uid      = 1000
mode     = 0o775

[/mnt/net]
hostPath  = jatitsix:7777   ; node:port milik SL NetFS
type      = netfs
via       = 8888            ; port netfsd --client lokal (opsional)
key       = c50f...c65      ; 64 hex, samakan dengan netfsd --key (opsional)
timeoutMs = 8000            ; opsional
```

Rules worth knowing:

- **`mode`**: tulis oktal secara eksplisit — `0o775` atau `0775`. Angka telanjang
  dibaca **desimal** (kompatibel dengan `fstab.json` lama: `509` = 0o775,
  `1023` = 0o1777). Nilai telanjang > `0o777` memicu peringatan saat boot, karena
  hampir selalu lupa oktal (`mode = 755` tanpa sadar menjadi 0o1363).
- Hanya key ini yang berupa angka: `uid`, `gid`, `mode`, `via`, `timeoutMs`,
  `cacheTtlMs`. Sisanya tetap string — termasuk `key`, walau isinya semua digit.
- Boolean menerima `true/false`, `yes/no`, `on/off`, `1/0`.
- Komentar sebaris (`nilai  # catatan`) dibuang kecuali nilainya dikutip.
- Nilai yang tidak dikenal DILAPORKAN saat boot (`logger` + `/var/log/syslog`),
  bukan diabaikan diam-diam.

## JSON format (`.json`, legacy)

The old array form is still read as a fallback. `mode` there is **decimal**
(`"mode": 1023` berarti 0o1777):

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
- `type`: `"host"` (host directory), `"bkfs"` (SQLite database), `"ramfs"` (RAM only), or `"netfs"` (another TSIX node over MQTNL). Any other value is reported on boot and the entry is skipped — it is never silently treated as `"host"`.
- `readOnly`: Boolean (`true` or `false`) to enforce read-only protection.
- `uid` (optional): Numeric UID to set as owner of the mount point (default: `0` = root).
- `gid` (optional): Numeric GID to set as group owner of the mount point (default: `0` = root).
- `mode` (optional): Permission mode — octal (`0o755`, `0775`) or decimal
  (`493` = 0o755, `509` = 0o775, `1023` = sticky rwxrwxrwt). Default: `0o755`.
  In `.conf` a bare number is DECIMAL; values > `0o777` get a boot warning.
- `active` (optional): Boolean, default `true`. Set to `false` to skip this entry during boot.
- `via` (netfs, optional): local `netfsd --client` port (`localhost:<via>`).
  Without it the kernel talks straight to the SL (`--direct`).
- `key` (netfs, optional): 64-hex session key — must match `netfsd --key`.
- `timeoutMs` / `cacheTtlMs` (netfs, optional): per-operation timeout (default
  `5000`) and metadata cache TTL (default `0`).

> New installs write `/etc/fstab.conf` (template: `scripts/lib/fresh-fstab.ts`);
> the installer also removes a leftover `/etc/fstab.json` so there is only one
> source of truth.
