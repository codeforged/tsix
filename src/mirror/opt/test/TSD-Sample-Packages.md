# TSD Sample Packages

Ini adalah contoh paket untuk TSD/tsdd agar bisa langsung dicoba.

## Paket yang disediakan

1. **myapp**
   - Version: `1.0.0`
   - Deskripsi: Simple hello-world utility
   - Package files:
     - `/var/tsd/packages/myapp`
     - `/var/tsd/packages/myapp.README`
   - Instalasi:
     - `/usr/local/bin/myapp`
     - `/usr/share/doc/myapp/README.md`
   - Post-install: `/usr/local/bin/myapp --configure`
   - Undo script: `/usr/local/bin/myapp --cleanup`

2. **webserver**
   - Version: `2.1.0`
   - Deskripsi: Lightweight HTTP server simulator
   - Package files:
     - `/var/tsd/packages/webserver`
     - `/var/tsd/packages/webserver.conf`
   - Instalasi:
     - `/usr/local/bin/webserver`
     - `/etc/webserver/config.conf`
   - Post-install: `/usr/local/bin/webserver --init`
   - Undo script: `/usr/local/bin/webserver --cleanup`

3. **tsd-utils**
   - Version: `0.4.0`
   - Deskripsi: Helper scripts untuk TSIX
   - Package files:
     - `/var/tsd/packages/cleanup.sh`
     - `/var/tsd/packages/checker.sh`
   - Instalasi:
     - `/usr/local/bin/cleanup.sh`
     - `/usr/local/bin/checker.sh`
   - Post-install: `/usr/local/bin/checker.sh --install`
   - Undo script: `/usr/local/bin/cleanup.sh --uninstall`

## Cara pakai

1. Copy manifest ke server:
   ```sh
   cp src/mirror/bin/tsd-sample-manifests/*.json /etc/tsd/manifests/
   ```

2. Copy paket ke lokasi server:
   ```sh
   mkdir -p /var/tsd/packages
   cp src/mirror/bin/tsd-sample-packages/* /var/tsd/packages/
   chmod +x /var/tsd/packages/myapp /var/tsd/packages/webserver /var/tsd/packages/cleanup.sh /var/tsd/packages/checker.sh
   ```

3. Jalankan server:
   ```sh
   tsdd --port 8090
   ```

4. Update client:
   ```sh
   tsd update antigonon:8090
   tsd list
   ```

5. Install paket contoh:
   ```sh
   tsd install myapp --from antigonon:8090
   tsd install webserver --from antigonon:8090
   tsd install tsd-utils --from antigonon:8090
   ```
