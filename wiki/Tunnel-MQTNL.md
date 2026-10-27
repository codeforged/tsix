# 🕳️ Tunnel MQTNL (`smqtnltun` + `vpns`)

**Tunnel MQTNL** adalah mekanisme untuk melewati batas topologi broker: node di
broker A dapat menjangkau **semua** node di broker B, walaupun jalur antar-broker
dibatasi (mis. `forward` memblokir alamat tertentu).

Ini bukan VPN IP (tidak ada TUN/TAP, tidak ada routing table). Ini **overlay di
atas MQTNL**: paket dibungkus amplop biner, dititipkan ke satu node relay di
broker seberang, lalu relay meneruskannya ke tujuan sesungguhnya.

---

## Kenapa ini murah di TSIX

MQTT memakai **nama node sebagai topik**. Artinya jaringan itu sendiri sudah
menjadi tabel routing:

```
publish  mqtnl@1.2/<dstAddress>   →  semua node subscribe mqtnl@1.2/#
```

Konsekuensinya:

| Kebutuhan | Di IP/VPN | Di MQTNL |
| --- | --- | --- |
| Tahu node apa saja di seberang | routing protocol / config | **tidak perlu** — alamat dibawa di amplop |
| Route table | wajib | **tidak ada** |
| Node baru di seberang | tambah route | **langsung terjangkau** |

Karena itu modelnya bukan WARP (yang butuh tahu prefix mana yang di-route),
melainkan lebih dekat ke `ssh -D` (SOCKS5) atau *subnet router*: satu pintu
keluar, tujuan ditentukan per paket.

---

## Arsitektur

```
 X (broker A)                                        Z (broker B)
┌───────────────────────────────────┐               ┌──────────────────────────┐
│ aplikasi: sendTo(<alamat apa pun>)│               │ vpns                     │
│              ↓ default interface  │               │  ├ buka amplop           │
│ smqtnltun0 (SimpleMQTNLDriverTunnel)              │  ├ sesi NPR per tujuan   │
│  ├ tujuan lokal   → loopback      │   amplop      │  ├ sendTo(dst, port) ────┼──► Y
│  ├ ada di exclude → broker lokal  │──────────────►│  └ balasan → amplop      │
│  └ sisanya        → amplop        │  (PSK+Binfeo) │                          │
│         ↑                         │◄──────────────│                          │
│  RX: dekripsi → decode → deliverLocal(src asli)   │                          │
└───────────────────────────────────┘               └──────────────────────────┘
```

- **Sisi klien wajib device** (`[tunnel.*]`): hanya device yang bisa
  menyerahkan balasan ke aplikasi dengan **identitas asli** pengirim
  (`deliverLocal`), karena `send()` biasa selalu menimpa `srcAddress` menjadi
  alamat lokal.
- **Sisi relay cukup daemon** (`vpns`): ia hanya perlu `NetSocket` + decode
  amplop. Membuat relay sebagai device juga bisa, tetapi tidak wajib.

---

## Amplop (`TunnelEnvelope`)

Biner, little-endian, hidup **di dalam payload** MQTNL — header MQTNL tidak
diubah, jadi node yang tidak mengenal tunnel tetap bisa memproses paket normal.

| off | size | field |
| --- | --- | --- |
| 0 | 2 | magic `'T' 'N'` |
| 2 | 1 | version (`1`) |
| 3 | 1 | kind (`0` DATA, `1` NACK) |
| 4 | 1 | hops (anti-loop) |
| 5 | 1 | `PacketFlags` asli |
| 6 | 1 | proto (`0` JSON, `1` Binary, `2` Binfeo) |
| 7 | 1 | `srcLen` |
| 8 | n | `srcAddress` + `srcPort` |
| … | 1+n+2 | `dstLen` + `dstAddress` + `dstPort` |
| … | * | payload |

Overhead tetap 12 byte + panjang alamat. `flag` ikut dibawa supaya `ping`
(`FLAG_PING_REQUEST`) dan `scanif` (`FLAG_BROADCAST_PING`) tetap bekerja lewat
tunnel.

---

## Aturan routing di sisi klien

Berurutan, yang pertama cocok menang:

1. tujuan = alamat device ini / node di proses yang sama → **loopback**
2. tujuan ada di `exclude` → **langsung** ke broker lokal
3. selain itu (termasuk `"*"`) → **tunnel**

`exclude` penting: node lain di broker A tidak ada di broker B, jadi kalau ikut
di-tunnel, paket akan hilang tanpa jawaban.

---

## Konfigurasi

```ini
# ── X: node di broker yang dibatasi ──────────────────────────────
[network]
defaultDevice = smqtnltun0
interfaces    = smqtnl0
# defaultDevice boleh tetap smqtnl0 (split tunnel): aplikasi yang ingin
# lewat tunnel menyebut iface-nya sendiri.

[iface.smqtnl0]
broker  = mqtt://192.168.1.204
address = wintsix

[tunnel.smqtnltun0]
broker   = mqtt://192.168.1.204
address  = wintsix-tun
peer     = tsixz-vpn:9360
exclude  = wintsix, wintsix_2
maxHops  = 3

# Tanpa `psk`, kunci sesi diambil otomatis lewat handshake RSA (disarankan):
# trustedFingerprint = A1B2C3D4E5F60718   # opsional, pin fingerprint relay
# rekey              = 300                # opsional, handshake ulang tiap 5 menit
```

```ini
# ── Z: node relay di broker seberang ─────────────────────────────
[iface.smqtnl1]
broker  = mqtt://192.168.1.191
address = tsixz-vpn
```

| Key `[tunnel.*]` | Wajib | Arti |
| --- | --- | --- |
| `broker` | ✅ | broker lokal (keluar lewat `forward`) |
| `address` | ✅ | alamat device tunnel — **harus unik** dalam satu proses |
| `peer` | ✅ | alamat relay: `node` atau `node:port` |
| `port` | — | port data tunnel (default 9360) |
| `controlPort` | — | port handshake (default `port + 1`) |
| `psk` | — | kunci statis ChaCha20 (64 hex). **Kosong = handshake RSA** |
| `handshake` | — | `false` memaksa plain (tidak disarankan) |
| `trustedFingerprint` | — | pin fingerprint relay (16 hex) |
| `rekey` | — | handshake ulang tiap N detik (0 = hanya saat start) |
| `agent` | — | agent enkripsi (default `chacha20`) |
| `exclude` | — | alamat yang tidak lewat tunnel |
| `maxHops` | — | batas hop amplop (default 3) |

Berkas konfigurasi lama tanpa `[tunnel.*]` berperilaku persis seperti sebelumnya.

---

## Keamanan: handshake RSA (tanpa secret manual)

Default-nya **tidak ada secret yang perlu dibagikan**: relay membangkitkan
keypair RSA + satu kunci sesi ChaCha20-Poly1305 saat start, lalu membagikan
kunci sesi itu ke tiap klien lewat RSA-OAEP. Primitifnya sama dengan
`RsaChaSocket`/`tsshd` (`SecurityAgent.generateKeyPair`,
`encryptWithPublicKey`, `decryptWithPrivateKey`, `verify`, `getFingerprint`).

```
klien → relay   HS_REQ
klien ← relay   HS_ACK  : publicKey :: fingerprint :: nonce
klien → relay   HS_KEY  : clientPublicKey :: signature(nonce)
klien ← relay   HS_OK   : session key (dibungkus public key klien)
```

- Klien **memverifikasi relay**: fingerprint dihitung ulang dari public key.
  Tanpa `trustedFingerprint` ia menerima + mencatat (TOFU); dengan pin, relay
  lain ditolak.
- Klien **membuktikan possession kunci** dengan menandatangani nonce; relay
  menolak tanda tangan yang tidak valid. `--trust-fp` di relay membatasi klien
  ke fingerprint tertentu.
- Kunci sesi **satu untuk semua klien**. Ini konsekuensi driver MQTNL yang
  hanya menyimpan satu kunci per port; ChaCha20 memakai IV acak per paket,
  jadi berbagi kunci antar-klien tidak membuat nonce bertabrakan.

### Kenapa handshake lewat port terpisah

Driver hanya punya satu `portSecurity` per port. Kalau port data sudah
berkunci, frame handshake (yang harus plaintext) tidak akan terbaca. Karena
itu handshake memakai **port kontrol** (`port + 1`) yang tidak berkunci,
sedangkan port data memakai kunci sesi:

```
klien ──HS_*──► relay :9361   (tanpa kunci; isi = public key + kunci ter-RSA)
klien ──DATA──► relay :9360   (ChaCha20-Poly1305, kunci sesi bersama)
```

Isi port kontrol aman: kunci sesi di dalamnya sudah dibungkus RSA-OAEP, dan
tidak ada payload aplikasi yang lewat situ.

### Mode kunci statis (`psk`)

Kalau ingin kunci yang tetap (tahan restart relay tanpa handshake ulang),
pakai PSK yang sama di dua sisi:

```ini
[tunnel.smqtnltun0]
psk = 81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619
```

```bash
vpns --listen 9360 --psk 81ff71ed...d67619
```

---

## Menjalankan relay

```bash
# di Z
vpns --listen 9360                      # handshake RSA (default, tanpa secret)
vpns --listen 9360 --psk <hex64>        # alternatif: kunci statis
vpns --listen 9360 --trust-fp A1B2C3D4E5F60718
vpns --listen 9360 --trace --foreground
vpns --help
```

Saat start, relay mencetak **fingerprint**-nya. Catat dan pasang di klien
sebagai `trustedFingerprint` kalau ingin mencegah MITM.

`vpns` membuat **satu socket ephemeral per kombinasi**
`(clientAddr, clientPort, dstAddr, dstPort)`. Socket itulah "NPR" di sisi broker
B; balasan dari tujuan otomatis kembali ke port aplikasi klien yang benar.
Sesi menganggur ditutup setelah `--idle` detik (default 60) supaya port
ephemeral (rentang kernel hanya 10.000) tidak habis.

Kalau relay tidak bisa membuat sesi (penuh / gagal bind), ia mengirim **NACK**
agar klien tidak menunggu buta sampai timeout.

---

## Contoh pemakaian

```bash
# X: default interface = tunnel → semua aplikasi otomatis lewat relay
ifconfig smqtnltun0

tssh  tsix-node-y          # node yang diblokir forward, tetap bisa
ping  tsix-node-y
scanif                     # discovery menembus mesh broker B
scanif -p 22,24 tsix-node-y

netfsd --client --to tsix-node-y:7777   # mount NetFS lewat tunnel

# kembali ke jalur langsung
ifconfig smqtnl0
```

Tanpa mengubah `defaultDevice`, aplikasi bisa memilih jalur per-socket:

```ts
new NetSocket({ port: 0, iface: "smqtnltun0" }); // lewat tunnel
new NetSocket({ port: 0, iface: "smqtnl0" });     // langsung
```

---

## Batasan & hal yang harus disadari

- **Identitas.** Di sisi tujuan, pengirim terlihat sebagai `Z:NPR` (nat). Kalau
  dibutuhkan, identitas asli ada di `srcAddress`/`srcPort` amplop — relay bisa
  meneruskannya ke aplikasi (mis. via header aplikasi), tetapi tidak otomatis.
- **Relay = satu titik mati.** Semua trafik X→broker B lewat Z. Rencana ke depan:
  daftar `peers` + failover.
- **Enkripsi dua lapis.** Jalur klien↔relay dilindungi kunci sesi (hasil
  handshake RSA, atau PSK). Enkripsi milik aplikasi (mis. airterm v2) tetap
  ujung-ke-ujung — relay buta terhadap isinya.
- **Relay restart.** Kunci sesi hilang saat relay restart. Klien akan pulih
  otomatis kalau `rekey` di-set (handshake ulang berkala), atau saat proses
  klien dijalankan ulang. Mode `psk` tidak punya masalah ini.
- **Broadcast** (`*`) diteruskan; satu sesi menerima balasan dari banyak node,
  jadi relay memakai TTL pendek untuk sesi broadcast.
- **Bukan bypass autentikasi broker.** Tunnel mengubah header MQTNL sehingga
  aturan ACL di `forward` tidak cocok lagi; ia **tidak** menembus autentikasi
  atau ACL di level broker MQTT itu sendiri.
- **Tidak menembus `PortManager`.** Port tunnel (9360) tidak dipesan lewat
  `PortManager`; hindari mem-bind port itu di aplikasi lain.

---

## Cakupan uji

| Berkas | Isi |
| --- | --- |
| `src/common/protocols/TunnelEnvelope.test.ts` | codec: round-trip, payload 0..255, frame terpotong, hops clamp, flag |
| `src/kernel/devices/SimpleMQTNLDriverTunnel.test.ts` | routing (tunnel/direct/loopback), kontrak amplop yang diterima relay, NACK, anti-loop, identitas asli pada balasan, handshake RSA (terima/tolak fingerprint, tanda tangan nonce, antrian) |
| `src/common/SysConfigIni.test.ts` | `[tunnel.*]`: parse, validasi wajib, format ulang, kompatibilitas konfigurasi lama |
| `src/mirror/lib/Firewall.test.ts` | ACL `forward`: deny/allow alamat dua arah **dan berarah (src/dst)**, port, wildcard, berkas hilang |

Semua uji berjalan tanpa broker (memakai loopback antar-device di satu proses).

---

## Firewall forwarder (skenario yang mau ditembus)

`forward` membaca ACL dari `/etc/packetforwarder/firewalltables.conf` — berkas
ini **hanya dibaca oleh node yang menjalankan `forward`** (node bridge). Node
lain tidak pernah membacanya walaupun berkasnya ada di rootfs-nya. Cakupannya
juga terbatas: hanya lalu lintas yang **lewati bridge itu**.

```ini
[address]
# dua arah (ringkas): cukup salah satu ujung cocok
allow     = "tsix-z", "tsix-c"   # atau "*" untuk semua
deny      = "tsix-y", "tsix-d"   # atau "*" untuk semua

# berarah (presisi): hanya sumber, atau hanya tujuan
allow-src = "wintsix"            # hanya pengirim ini
allow-dst = "tsix-z", "tsix-c"   # hanya tujuan ini
deny-src  = "tsix-d"
deny-dst  = "tsix-y"

[port]
allow-dst = 24, 80               # atau "*"
allow-src = 11, 21
deny-dst  = 22
deny-src  = 4000
```

**Dua gaya penulisan:**

| Gaya | Key | Kapan dipakai |
| --- | --- | --- |
| Dua arah | `allow`, `deny` | "blokir node Y" tanpa memikirkan arah |
| Berarah | `allow-src/-dst`, `deny-src/-dst` | "hanya X yang boleh mengakses Y" |

- `deny` (dua arah) memeriksa sumber **atau** tujuan. Ini disengaja: kalau
  hanya tujuan yang diperiksa, balasan dari node yang diblokir tetap lolos.
- Semua `allow` yang diisi harus lolos (AND), jadi `allow-src` + `allow-dst`
  = aturan berpasangan sumber→tujuan.
- `deny-*` selalu dievaluasi sebelum `allow-*`.

**Jebakan penting — balasan berbalik arah.** Paket `X→Y` punya `src=X, dst=Y`;
balasannya `src=Y, dst=X`. Jadi `allow-dst = "tsix-z"` membuat `X→Z` lolos
tetapi **memblokir balasan `Z→X`**. Untuk whitelist berarah, daftarkan kedua
sisi:

```ini
allow-dst = "tsix-z", "tsix-c"
allow-src = "tsix-z", "tsix-c"
```

```bash
forward --fw                              # tampilkan aturan aktif
forward --fw-check wintsix:5000 tsix-y:24 # uji satu paket (exit 3 = diblokir)
forward -s broker1 -d broker2             # start bridge (ACL langsung berlaku)
forward -s broker1 -d broker2 --no-fw     # tanpa ACL
```

Karena tunnel mengubah header luar menjadi alamat relay, aturan `deny` untuk
alamat tujuan **tidak pernah cocok** pada paket yang lewat tunnel — itulah
demonstrasi "blocking bisa diakali dengan tunneling". Ini hanya menembus ACL
di `forward`, **bukan** autentikasi/ACL di level broker MQTT.

**Halaman terkait:** [🌐 Networking (MQTNL)](Networking-MQTNL.md)
