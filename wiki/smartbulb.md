# JayaLaras Smart Bulb di TSIX

Dokumen ini menjelaskan implementasi otomasi lampu rumah JayaLaras di TSIX: MCP23017, daemon service, GUI Cashew, mapping legacy NOS, IPC, deployment, operasi 24/7, dan rancangan akses web.

## 1. Gambaran Umum

Implementasi TSIX menggantikan aplikasi legacy NOS yang telah berjalan sekitar lima tahun. TSIX memisahkan tanggung jawab menjadi tiga lapisan:

```text
MCP23017 relay + TTP223/switch
              |
              v
     /opt/smartbulb/service.js
       jayalaras.service
              |
       IPC internal TSIX
              |
              v
     /opt/smartbulb/control.js
       GUI Cashew + denah rumah
```

- `service.js` adalah pemilik hardware dan logika saklar.
- GUI tidak mengakses MCP23017 ketika service tersedia; GUI mengirim perintah IPC dan menerima state push.
- Setiap perubahan saklar fisik atau output relay dipublikasikan sebagai `SMARTBULB_STATE` ke subscriber GUI.

Prefix `value ` wajib dipertahankan karena `docs/smartbulb/local.html` memeriksa
prefix tersebut sebelum memanggil `updateLightDisplay()`. Dengan begitu halaman
local menerima update realtime setiap kali switch fisik atau command mengubah
state service. `index.html` utama menggunakan `cygnus.rfc.js` dan tetap
kompatibel untuk snapshot awal serta command klik.

Dua device MCP23017 digunakan:

| Fungsi        | Device TSIX     | Konfigurasi                                                     |
| ------------- | --------------- | --------------------------------------------------------------- |
| Relay lampu   | `/dev/mcp-bulb` | Address mengikuti konfigurasi MCP23017 aktif |
| Switch/sensor | `/dev/mcp-sw`   | Address mengikuti konfigurasi MCP23017 aktif |

Driver berada di `src/kernel/devices/aux-devices/MCP23017Device.ts`.

IOCTL utama:

| Konstanta       |    Nilai | Fungsi                         |
| --------------- | -------: | ------------------------------ |
| `SET_PIN_MODE`  | `0x3001` | Mengatur input/output/pull-up  |
| `DIGITAL_WRITE` | `0x3002` | Menulis satu pin               |
| `DIGITAL_READ`  | `0x3003` | Membaca satu pin               |
| `READ_ALL`      | `0x3004` | Membaca 16 pin sebagai bitmask |

Relay bersifat **active-low**:

- relay ON = GPIO `LOW` / nilai `0`
- relay OFF = GPIO `HIGH` / nilai `1`

Konversi port logika NOS ke pin MCP23017:

```text
port genap  -> pin port / 2       (bank A)
port ganjil -> floor(port / 2) + 8 (bank B)
```

Contoh:

```text
port 0  -> pin 0
port 2  -> pin 1
port 9  -> pin 12
port 15 -> pin 15
```

> Pastikan address I2C dan bus pada driver sesuai hasil `i2cdetect` dan wiring Raspberry Pi. Jangan mengubah mapping software tanpa mencocokkan kabel fisik.

## 3. Daemon `service.ts`

Source: `src/mirror/opt/smartbulb/service.ts`

Runtime: `/opt/smartbulb/service.js`

Service mengikuti pola daemon TSIX seperti `tsshd`:

```ts
export default class SmartBulbService {
  async execute(lib: UserLib, args: string[]) {
    // daemonize, buka device, pasang event IPC, lalu polling switch
  }
}
```

Saat start, service:

1. Memanggil `shell.daemonize("JayaLaras Smart Home Service")`.
2. Membuka `/dev/mcp-bulb` dan `/dev/mcp-sw`.
3. Mengatur seluruh pin relay sebagai output.
4. Mengatur seluruh pin switch sebagai `INPUT_PULLUP`.
5. Mendaftarkan identity IPC `jayalaras.service`.
6. Memulai polling switch setiap 300 ms.
7. Menunggu IPC command dari GUI atau gateway internal.
8. Menutup file descriptor hardware ketika menerima `SIGTERM`.

Mode simulasi tetap tersedia bila device tidak ditemukan dan `--hw` tidak dipakai. Dengan `--hw`, service berhenti jika relay tidak tersedia.

### Menjalankan

```bash
/opt/smartbulb/service.js
```

Mode hardware wajib:

```bash
/opt/smartbulb/service.js --hw
```

### Hak akses proses

`service.js` adalah hardware owner dan perlu akses ke `/dev/mcp-bulb` serta
`/dev/mcp-sw`. Dengan metadata MCP23017 saat ini (`uid=0`, `gid=0`, mode
`0660`), service produksi dijalankan sebagai **root** atau user yang menjadi
anggota group pemilik device.

`control.js` dan `web-gateway.js` tidak perlu root saat berjalan melalui IPC.
Keduanya hanya gagal berfungsi jika `jayalaras.service` belum hidup atau tidak
berhasil mendaftarkan identity-nya. Mode `control --hw` berbeda: mode itu
membuka `/dev/mcp-bulb` langsung dan karenanya mengikuti permission device.

Pola deployment yang disarankan:

```text
service.js       root / hardware owner
control.js       user biasa / IPC client
web-gateway.js   user biasa / IPC + HTTP/WebSocket client
```

Mode simulasi cocok untuk menguji GUI tanpa Raspberry Pi atau MCP23017.

### Polling switch

Setiap siklus polling:

1. Membaca `READ_ALL` dari `/dev/mcp-sw`.
2. Membandingkan nilai dengan `swStates` sebelumnya.
3. Mengabaikan pin yang tidak berubah.
4. Menjalankan mapping legacy hanya untuk pin yang berubah.
5. Menulis relay melalui antrean I2C berurutan agar beberapa perubahan tidak saling balap.
6. Mengirim `SMARTBULB_STATE` ke semua subscriber.

Polling dilindungi flag `pollInFlight`, sehingga pembacaan I2C tidak overlap jika satu operasi hardware melambat.

## 4. Mapping Lampu Legacy

Mapping UI mengikuti `setPos()` dari aplikasi web JayaLaras lama. `idx` adalah indeks gambar/GUI, `port` adalah port logika relay.

| Index | Ruangan               | Koordinat denah | Port |
| ----: | --------------------- | --------------: | ---: |
|     0 | Ruang Tengah Belakang |    `(320, 355)` |    8 |
|     1 | Ruang Tengah Depan    |    `(175, 355)` |    3 |
|     2 | Ruang Kerja           |    `(175, 175)` |    4 |
|     3 | Kamar Anak            |    `(185, 530)` |    2 |
|     4 | Dapur                 |    `(380, 180)` |    7 |
|     5 | WC Kamar              |    `(432, 600)` |   10 |
|     6 | WC Utama              |    `(265, 135)` |   11 |
|     7 | Kamar Utama           |    `(355, 530)` |   15 |
|     8 | Teras Belakang        |     `(380, 50)` |   12 |
|     9 | Teras Depan           |     `(70, 280)` |    9 |
|    10 | Taman                 |    `(420, 355)` |    5 |
|    11 | Exhaust Ruang Kerja   |    `(220, 110)` |   13 |

Setiap lampu adalah output independen. Tidak ada lagi relasi parent antara Teras dan Paviliun.

### Logika switch multi-state

Mapping legacy yang dipertahankan:

- Switch pin 7: mode multi-state untuk Kamar Utama.
- Switch pin 8: mode multi-state untuk Ruang Tengah Belakang.
- Switch pin 15: mode multi-state untuk Ruang Tengah Depan dengan aturan dusk.
- Switch pin 15 memetakan ke lampu port 9 pada mode normal.
- Switch pin 9 memetakan ke lampu port 11, yaitu WC Utama.
- Switch pin 8 memetakan ke lampu port 8.
- Switch pin 3 memetakan ke lampu port 7.
- Switch pin 7 memetakan ke lampu port 15.
- Switch pin 12 memetakan ke lampu port 10.
- Switch pin 11 mempertahankan perilaku sensor khusus untuk port 12 dan WC Kamar.

Switch WC Utama menggunakan pin 9 dan relay port 11. Pin switch asli disimpan sebelum remapping agar kondisi OFF tidak salah dianggap sebagai sensor khusus pin 11.

### Logika dusk

Untuk Ruang Tengah Depan, service mempertahankan aturan NOS:

- malam: jam `>= 18:00` atau `< 05:00`
- siang: mapping multi-state berbeda

Fungsi waktu memakai rumus legacy `hour + minute / 59` agar perilaku tetap sama dengan NOS.

## 5. IPC Service

Identity service:

```text
jayalaras.service
```

### Command dari client

Register GUI sebagai subscriber:

```json
{ "type": "REGISTER" }
```

Berhenti menerima push:

```json
{ "type": "UNREGISTER" }
```

Minta state terbaru:

```json
{ "type": "GET" }
```

Atur satu lampu:

```json
{ "type": "SET", "port": 11, "on": true }
```

Atur semua output:

```json
{ "type": "SETALL", "on": false }
```

Ping/state request:

```json
{ "type": "PING" }
```

### Event state

Service mengirim:

```json
{
  "type": "SMARTBULB_STATE",
  "ports": [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "switches": [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  "manual": 0
}
```

- `ports[0..15]` = state logika output lampu.
- `switches[0..15]` = nilai input MCP23017.
- `manual` = penanda perubahan berasal dari logika switch/manual legacy.

Push dikirim ketika:

- switch fisik berubah;
- perintah `SET` selesai diterima;
- perintah `SETALL` diterima;
- client melakukan `REGISTER`, `GET`, atau `PING`.

Subscriber yang sudah mati dibuang otomatis ketika pengiriman IPC gagal.

## 6. GUI `control.ts`

Source: `src/mirror/opt/smartbulb/control.ts`

Runtime: `/opt/smartbulb/control.js`

GUI dibuat dengan Cashew:

- `TForm` sebagai window.
- `TImage` untuk denah rumah.
- `TImage` clickable untuk setiap lampu.
- `TStatusBar` untuk status operasi.
- `TTimer` untuk polling status ketika mode hardware langsung digunakan.

Asset yang digunakan:

```text
/opt/smartbulb/layoutrumah.png
/opt/smartbulb/bulbon.png
/opt/smartbulb/bulboff.png
```

State visual diperbarui dengan mengganti `src` gambar. Label lampu tidak dibuat karena nama ruangan sudah ada pada denah.

### Mode GUI

Simulasi:

```bash
/opt/smartbulb/control.js
```

Hardware langsung:

```bash
/opt/smartbulb/control.js --hw
```

Mode `--hw` dipakai sebagai fallback ketika `jayalaras.service` tidak tersedia. Jika service tersedia, GUI mengirim command IPC dan service tetap menjadi pemilik hardware.

Saat dibuka, GUI mengirim `REGISTER`. Saat ditutup, GUI mengirim `UNREGISTER`. Event `SMARTBULB_STATE` dari service langsung mengubah gambar lampu.

## 7. Deployment

Dari host repository, sinkronkan file TypeScript ke VFS:

```bash
node -r esbuild-register -r tsconfig-paths/register \
  scripts/sync-vfs.ts src/mirror/opt/smartbulb/service.ts

node -r esbuild-register -r tsconfig-paths/register \
  scripts/sync-vfs.ts src/mirror/opt/smartbulb/control.ts
```

Sinkronkan asset PNG dengan mekanisme VFS/bkfs yang digunakan perangkat:

```text
/opt/smartbulb/layoutrumah.png
/opt/smartbulb/bulbon.png
/opt/smartbulb/bulboff.png
```

Setelah perubahan library atau daemon:

1. Stop daemon lama.
2. Sync file ke VFS.
3. Start ulang service.
4. Buka ulang control GUI.
5. Uji satu lampu melalui switch fisik dan GUI.
6. Pastikan `SMARTBULB_STATE` memperbarui GUI.

`service.ts` dan `web-gateway.ts` belum otomatis dijalankan oleh
`src/mirror/etc/rc.local.ts` pada konfigurasi saat ini. Untuk operasi rumah
yang benar-benar unattended, tambahkan startup entry setelah device/kernel
siap, atau gunakan supervisor TSIX yang me-restart daemon jika proses berhenti.

## 8. Operasi 24/7

Checklist operasional:

- Gunakan power supply Raspberry Pi dan MCP23017 yang stabil.
- Pastikan ground Raspberry Pi, MCP23017, dan TTP223 tersambung benar.
- Pastikan I2C address tidak bentrok.
- Gunakan `--hw` pada deployment produksi agar kegagalan relay tidak diam-diam berubah menjadi simulasi.
- Pantau log daemon dan status device.
- Pastikan service hanya memiliki satu instance; dua daemon yang mengendalikan relay yang sama dapat membuat state saling menimpa.
- Jangan membuka device MCP23017 langsung dari banyak aplikasi produksi secara bersamaan.
- Gunakan daemon service sebagai single writer hardware.
- Pertahankan polling non-overlap dan antrean I2C.
- Uji perilaku setelah reboot, kehilangan GUI, kehilangan broker, dan cabut-pasang client.

## 9. Akses Web untuk Keluarga

### Rekomendasi

Jangan menjadikan `jayalaras.service` langsung sebagai endpoint internet/web. Service sebaiknya tetap menjadi **hardware owner internal**. Buat satu daemon gateway, misalnya:

```text
Browser keluarga
      |
      | WebSocket + HTTPS/auth
      v
smartbulb-web-gateway
      |
      | IPC internal TSIX
      v
jayalaras.service
      |
      v
MCP23017 relay/switch
```

Gateway ini menjadi pintu utama kontrol dan monitoring:

- `GET /api/smartbulb/state` untuk snapshot awal.
- `POST /api/smartbulb/lights/:port` untuk command ON/OFF.
- `POST /api/smartbulb/all` untuk semua lampu.
- `WS /ws/smartbulb` untuk push state real-time.
- Gateway melakukan `REGISTER` ke `jayalaras.service` dan meneruskan setiap `SMARTBULB_STATE` ke seluruh browser yang tersambung.
- Command dari browser divalidasi gateway sebelum diteruskan sebagai `SET`/`SETALL`.

### Mengapa WebSocket cocok

WebSocket cocok untuk monitoring karena state switch fisik bisa berubah tanpa menunggu browser polling. Saat TTP223 disentuh:

```text
TTP223 → MCP23017 → service polling → SMARTBULB_STATE IPC
        → web gateway → semua browser menerima event state
```

REST tetap berguna untuk:

- snapshot awal;
- command sederhana;
- health check;
- integrasi automation lain.

Jadi desain ideal adalah **REST untuk request/snapshot + WebSocket untuk live updates**, bukan WebSocket saja.

### Keamanan minimum

Gateway harus:

- hanya bind ke jaringan LAN/VPN, bukan langsung ke internet;
- memakai HTTPS/WSS bila melewati jaringan tidak tepercaya;
- memakai login/token atau session cookie;
- memberi authorization per user bila diperlukan;
- memvalidasi port hanya `0..15` dan payload boolean;
- menolak command jika service/hardware tidak siap;
- tidak mengekspos socket MCP23017 atau IPC kernel langsung;
- mencatat siapa yang mengubah lampu dan kapan;
- membatasi command burst agar relay tidak dihajar loop/browser bug.

Untuk akses dari luar rumah, lebih baik gunakan VPN seperti WireGuard/Tailscale daripada port-forwarding langsung ke gateway.

### Alternatif paling sederhana

Jika kebutuhan awal hanya keluarga di LAN:

1. Buat gateway kecil di `/opt/smartbulb-web`.
2. Sajikan halaman kontrol lokal.
3. Gateway connect ke `jayalaras.service` melalui IPC.
4. Browser connect ke gateway melalui WebSocket.
5. Tambahkan auth sederhana dan bind hanya ke alamat LAN.

### Compatibility gateway untuk `docs/smartbulb/index.html`

TSIX sekarang menyediakan source gateway legacy di:

```text
src/mirror/opt/smartbulb/web-gateway.ts
```

Runtime:

```text
/opt/smartbulb/web-gateway.js
```

Gateway mengikuti pola daemon app TSIX dan membuka HTTP + WebSocket pada port
`45452` secara default:

```bash
/opt/smartbulb/web-gateway.js 45452
```

> **Arsitektur sementara:** `web-gateway.ts` saat ini memakai `hostRequire()`
> untuk modul Node `http`, `ws`, `path`, dan `url`. Ini sengaja diposisikan
> sebagai compatibility bridge untuk aplikasi legacy, bukan pola final TSIX.
> Implementasi final sebaiknya menyediakan HTTP/WebSocket lewat kernel land,
> dispatcher, dan `UserLib`, seperti device/transport TSIX lainnya.

Setelah asset lama disalin ke VFS:

```text
/opt/smartbulb/index.html
/opt/smartbulb/cygnus.rfc.js
/opt/smartbulb/jquery-3.6.0.min.js
/opt/smartbulb/layoutrumah.png
/opt/smartbulb/bulbon.png
/opt/smartbulb/bulboff.png
```

halaman lama dapat dipanggil langsung:

```text
http://alamat-tsix:45452/
```

WebSocket memakai format RPC lama tanpa perubahan pada HTML:

```json
{
  "name": "getAllPortStatus",
  "params": [],
  "id": 12345,
  "callType": "function"
}
```

Gateway membalas:

```json
{
  "protocol": "RFC",
  "id": 12345,
  "ret": [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
}
```

RPC yang didukung:

| RPC legacy                                          | Terjemahan TSIX                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `getAllPortStatus`                                  | IPC `{ type: "GET" }` ke `jayalaras.service`                        |
| `setLight(id, value)`                               | IPC `{ type: "SET", port, on }` melalui tabel kompatibilitas legacy |
| `MQTTsendMsg("jayalarasiot/portstates", "get")`     | Ambil state service                                                 |
| `MQTTsendMsg("jayalarasiot/portstates", "set p:v")` | Set output port `p`                                                 |

Gateway juga meneruskan state service sebagai envelope MQTT legacy:

```json
{
  "protocol": "MQTT",
  "topic": "jayalarasiot/portstates",
  "ret": "value 0010000000000000"
}
```

Prefix `value ` wajib dipertahankan karena `docs/smartbulb/local.html` memeriksa
prefix tersebut sebelum memanggil `updateLightDisplay()`. Dengan begitu
`local.html` menerima update realtime setiap kali switch fisik atau command
mengubah state service. `index.html` utama menggunakan `cygnus.rfc.js` dan
tetap kompatibel untuk snapshot awal serta command klik.

Deploy source gateway:

```bash
node -r esbuild-register -r tsconfig-paths/register \
  scripts/sync-vfs.ts src/mirror/opt/smartbulb/web-gateway.ts
```

Urutan produksi yang disarankan:

```text
1. MCP23017Device siap
2. service.js --hw aktif dan mendaftarkan jayalaras.service
3. web-gateway.js aktif di port 45452
4. browser keluarga membuka http://alamat-tsix:45452/
```

> **Catatan keamanan:** gateway saat ini adalah compatibility layer LAN dan
> belum menyediakan login/authentication. Jangan expose port `45452` langsung
> ke internet. Untuk akses dari luar rumah, gunakan VPN atau tambahkan auth
> dan WSS sebelum membuka port ke jaringan tidak tepercaya.

DOME/WebSocket internal TSIX tetap dipakai untuk GUI desktop Cashew, tetapi sebaiknya tidak dijadikan API web publik karena DOME adalah windowing/desktop relay, bukan boundary keamanan smart-home.

## 10. Troubleshooting

### GUI tidak berubah setelah switch disentuh

- Pastikan service hidup.
- Pastikan GUI berhasil `REGISTER` ke `jayalaras.service`.
- Pastikan event `SMARTBULB_STATE` sampai ke GUI.
- Pastikan `ports[]` yang dikirim service sesuai mapping `LIGHTS[].port`.

### Relay berubah tetapi gambar salah

- Periksa `LIGHTS` di `control.ts`.
- Cocokkan port relay, bukan index lampu.
- Pastikan `bulbon.png` dan `bulboff.png` tersedia di `/opt/smartbulb`.

### Switch WC Utama hanya bisa ON

- Switch TTP223 WC Utama adalah pin 9.
- Pin 9 dipetakan ke relay port 11.
- Jangan memakai hasil remapping `pin === 11` untuk mendeteksi sensor khusus; gunakan pin switch asli.

### Service masuk simulasi

- Jalankan dengan `--hw` untuk memaksa kegagalan terlihat.
- Periksa `/dev/mcp-bulb` dan `/dev/mcp-sw`.
- Periksa I2C bus/address dan permission device.
- Pastikan `MCP23017Device` sudah diinisialisasi oleh kernel.

## 11. Referensi Source

- `src/mirror/opt/smartbulb/service.ts`
- `src/mirror/opt/smartbulb/control.ts`
- `src/kernel/devices/aux-devices/MCP23017Device.ts`
- `src/mirror/lib/cashew.ts`
- `src/mirror/etc/rc.local.ts`
- `wiki/mcp23017-registration.md`
- `wiki/netsocket-in-a-nutshell.md`
