# TSIX Imut

Distro minimal TSIX untuk menguji instalasi paket TPKG.

## Install

```sh
npm install
npm run tsix:install
```

Start TSIX from the host shell:

```sh
./bootstrap.sh
```

```bat
bootstrap.bat
```

## Local TPKG lab

The image includes coreutils (`ls`, `clear`, and more), `tbuild`, the TPKG client, and a local repository server. `tpkgd` starts at boot. `procutils`, `nettools`, `hello-world`, `display-drivers`, and `joystick-driver` are staged in the repository for installation tests.

```sh
sudo tpkg update
sudo tpkg info procutils
sudo tpkg install procutils
ps
sudo mem
sudo tpkg install nettools
sudo tpkg install display-drivers
sudo reboot
sudo tpkg install joystick-driver
sudo reboot
sudo tpkg info hello-world
sudo tpkg download hello-world
sudo tpkg verify hello-world
sudo tpkg install hello-world
```

## Installed packages

- base-system
- coreutils
- tpkg

## Repository packages


This is a draft test image. Package source files are staged under `/var/lib/tpkg/repo` so the test package is available to `tpkgd` without being preinstalled.
