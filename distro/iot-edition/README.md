# TSIX IoT Edition

Distro TSIX untuk pengembangan dan operasi IoT, dengan Lantana serta seluruh komponen inti TSIX Desktop Environment.

Version: 0.1.0-draft (draft)

## Installation

Requires Node.js and npm. From this directory, install dependencies and run the interactive installer:

```sh
npm install
npm run tsix:install
```

The installer asks for a root password on a fresh distro image. It creates a locked root account and does not package node-local password files.

For a non-interactive image, run `npm run tsix:install -- --defaults`; the root account remains locked until a password is set through an interactive install.

## Features

- Kernel, runtime, command, shared runtime, library, dan trust anchor TSIX.
- Aplikasi Lantana dan dashboard IoT yang dikenali inventaris.
- Firmware IoT dan dependensi PlatformIO yang dikenali inventaris.
- PixelSpace Protocol serta komponen DOME, Asteracea, Emerald, Cashew, dan Pistachio.
- Konfigurasi boot, Tpkg, DOME, dan Asteracea yang dipilih secara eksplisit.

## Release notes

- Manifest ini masih draft; jangan gunakan sebagai image rilis tanpa review dependensi dan konfigurasi node.
- Menu Asteracea untuk aplikasi di luar scope tidak disertakan; semua menu yang dikemas telah diaudit terhadap file programnya.
- platformio.ini menyertakan upload_port khusus perangkat pengembang dan mungkin perlu penyesuaian untuk board pengguna.
