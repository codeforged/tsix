# Lantana V2 — Arah Desain

Dokumen ini merangkum arah desain Lantana V2 berdasarkan diskusi implementasi
Violet. Violet tidak menjadi daemon atau produk terpisah; kebutuhan akun,
otorisasi, dan query dari rencana Violet ditambahkan ke Lantana.

**Status:** kontrak V2 untuk implementasi ulang. Lantana V1 belum dipakai
operasional, sehingga **tidak ada kewajiban kompatibilitas** dengan konfigurasi,
format payload, event IPC, atau API lama. Yang diuji hanyalah test V1; test itu
diperbarui mengikuti kontrak baru, bukan dipertahankan sebagai beban.
**OTA firmware ESP32/ESP8266 di luar cakupan**: OTA adalah fitur TSIX yang
terpisah dari layanan IoT.

## Tujuan

- Menulis ulang inti Lantana dengan model akun dan device sebagai identitas,
  bukan port.
- Menambahkan akun parent-child, izin inject/query/command per scheme, dan
  validasi data di sisi daemon.
- Memastikan DataBank eksternal hanya menerima data yang sudah terautentikasi,
  terotorisasi, dan tervalidasi.
- Menjaga kemampuan operasional yang sudah ada: ingest MQTNL, state device dan
  heartbeat, grouping, command dua arah, distribusi, dashboard, logger.

## Keputusan desain

### Identitas dan routing

| Nilai | Peran |
|---|---|
| `accountId` | Identitas akun dan dasar pemeriksaan hak akses. |
| `deviceId` | Identitas logis device untuk registry dan konfigurasi sensor. |
| MQTNL `address + port` | Endpoint untuk routing paket dan command balasan; bukan identitas akun atau device. |
| `schemeId` | Identitas skema/jenis data sensor yang di-inject atau di-query. |

- Lantana menerbitkan `deviceId` ketika user mendaftarkan device. ID harus unik,
  stabil, dan tidak dianggap rahasia. UUID acak adalah pilihan implementasi.
- Device diregistrasikan sebagai pasangan `accountId + deviceId`; metadata
  seperti nama, lokasi/kota, kategori, dan grup dikelola di konfigurasi.
- Jika MQTNL mensyaratkan pasangan endpoint `address + port` unik, aturan itu
  tetap berlaku di lapisan routing. Lantana boleh menyimpan endpoint terkini
  untuk command balasan, tetapi perubahan endpoint tidak mengubah `deviceId`.
- Dengan satu AccessKey bersama untuk satu akun, `deviceId` adalah klaim/logical
  identity, bukan bukti kriptografis bahwa paket datang dari perangkat fisik
  tertentu. Ini diterima untuk versi awal. Kredensial per-device dapat menjadi
  peningkatan opsional jika kelak dibutuhkan.

### Akun dan AccessKey

- Lantana menerbitkan AccessKey berentropi tinggi per akun. User memasangnya di
  firmware device milik akun tersebut.
- Child account memiliki AccessKey dan izin sendiri. Parent mengelola akun dan
  scheme dalam lingkupnya.
- AccessKey adalah kredensial autentikasi, **bukan session key enkripsi**.
  Semua device dalam satu akun berbagi hak akun yang sama; jika key bocor,
  seluruh akun dianggap terdampak sampai key dirotasi atau dicabut.
- AccessKey hanya memberi hak yang ditentukan policy. Kredensial device yang
  ditanam di firmware tidak otomatis memberi hak administrasi akun.
- AccessKey tidak diteruskan ke DataBank dan tidak ditulis ke log. Penyimpanan
  kredensial berada di Lantana, terpisah dari DataBank.
- User/admin menggunakan jalur kredensial terpisah untuk mengelola akun,
  scheme, dan device.

### Keamanan MQTNL

Rancangan MVP menggunakan pola key exchange seperti TSSH:

1. Device memverifikasi identitas server melalui public-key pin/fingerprint
   yang dipercaya dan diprovisikan sebelumnya.
2. Device membuat session key acak dan mengirimkannya dengan RSA-OAEP ke public
   key server.
3. Setelah sesi terenkripsi terbentuk, device mengautentikasi `accountId` dan
   AccessKey—misalnya mengirim kredensial dalam pesan terenkripsi atau memakai
   challenge-response.
4. Lantana mengikat sesi ke akun dan device terdaftar. Seluruh payload setelah
   itu dilindungi AEAD (ChaCha20-Poly1305) menggunakan session key.

AccessKey tidak boleh muncul dalam paket plaintext. MQTNL `address + port`
tetap untuk routing; keamanan dan identitas akun/device dikelola per sesi,
bukan dengan menetapkan satu key tenant untuk setiap port layanan.

RSA key transport adalah pilihan awal yang mirip TSSH dan tidak memberikan
forward secrecy. Peralihan ke pertukaran kunci ephemeral dapat dipertimbangkan
kemudian. Jika handshake, autentikasi, atau dekripsi gagal, paket ditolak:
jalur produksi tidak boleh diam-diam menerima plaintext.

### Dua mode handshake (hybrid)

MCU kecil tidak semuanya sanggup RSA-OAEP. Device memilih mode di `HELLO`:

| Mode | Device | Mekanisme |
|---|---|---|
| `rsa` | ESP32 | Public key server (fingerprint di-pin) → session key acak dibungkus RSA-OAEP → `AUTH` terenkripsi |
| `psk` | ESP8266 | `psk = SHA-256(AccessKey)`; server & device saling membuktikan lewat HMAC atas nonce; session key = HKDF-SHA256(psk, salt=`nonceC\|nonceS`) |

Mode `psk` tidak mengirim kunci apa pun, tetap mutual-authentication, dan hanya
membutuhkan SHA-256 + HMAC + HKDF (BearSSL/mbedtls). Server menyimpan `psk`
di samping verifier scrypt pada saat AccessKey diterbitkan. **AccessKey lama
(yang diterbitkan sebelum dukungan psk) tidak punya `psk` dan harus dirotasi**
sebelum dipakai oleh ESP8266.

Firmware: `platformio/TSIX-All-in-One/src/variants/lantana.cpp`
(env `lantana-esp32` / `lantana-esp8266`). Identitas dan AccessKey diisi di
`include/secrets.h`; fingerprint server untuk pinning dilihat lewat
`lantana-ctl server fingerprint`.

### Hak akses

- Akun parent memiliki kontrol administratif atas akun child dan scheme dalam
  lingkupnya.
- Izin akun mencakup `allowedInjectSchemes` dan `allowedQuerySchemes`, berupa
  ID tertentu atau rentang.
- Izin diperiksa di daemon Lantana untuk inject, query, dan command.
- Consumer **wajib** mendaftar dengan `accountId`; registrasi tanpa `accountId`
  ditolak karena akan membuka data seluruh akun. Filter consumer hanya
  membatasi tampilan — bukan pengganti otorisasi.
- Paket tidak sah ditolak sebelum mengubah DeviceBank, meneruskan data, atau
  memperbarui heartbeat.
- NACK/error perlu membedakan setidaknya unauthorized inject dan unauthorized
  query.

## Alur data

```text
Sensor
  -> MQTNL handshake dan sesi terenkripsi
  -> Lantana Listener/Receptor
  -> autentikasi akun dan pemeriksaan deviceId terdaftar
  -> izin scheme + validasi nilai/tipe
  -> DeviceBank (state terkini dan heartbeat)
  -> DataBank Adapter (inject ke aplikasi/layanan DataBank eksternal)
  -> Distributor -> consumer yang berhak
```

Query melalui IPC atau HTTP mengikuti policy akun dan scheme yang sama sebelum
data dibaca atau dikembalikan.

**DeviceBank dan DataBank adalah dua komponen berbeda:**

- **DeviceBank** adalah registry runtime Lantana untuk device, sensor terkini,
  endpoint balasan, dan heartbeat.
- **DataBank** adalah aplikasi/layanan eksternal. Lantana hanya meneruskan
  identitas akun/device dan data yang sudah lolos validasi; DataBank tidak
  memerlukan atau menyimpan AccessKey.

## Komponen yang terlibat

| Komponen | Tanggung jawab |
|---|---|
| `lantana.ts` daemon | Lifecycle dan wiring antar komponen Lantana. |
| MQTNL Listener/Receptor | Bind ke service port, decode payload, kelola sesi keamanan, autentikasi akun, dan catat endpoint routing. |
| Account/Credential Manager | Buat akun parent-child, terbitkan/rotasi/cabut AccessKey, dan simpan verifier/credential secara aman. |
| Device Registry/Provisioner | Terbitkan `deviceId`, ikat device ke akun, dan kelola nama/lokasi/kategori/grup. |
| Scheme Registry | CRUD definisi scheme: ID, tipe, unit, rentang, dan metadata. |
| Permission Policy | Pemeriksaan inject/query/command yang dipakai bersama oleh IPC, HTTP, dan MQTNL. |
| Scheme Validator | Validasi payload sensor berdasarkan definisi scheme sebelum data diterima. |
| DeviceBank | State device dan sensor terkini, heartbeat, grouping, serta endpoint untuk command balasan. |
| DataBank Adapter | Batas integrasi ke DataBank eksternal; hanya mengirim data terautentikasi dan tervalidasi. |
| Distributor | Normalisasi dan distribusi event/snapshot ke consumer; tidak menjadi satu-satunya lapisan otorisasi. |
| IPC Handler / HTTP Bridge | Query dan operasi consumer dengan pemeriksaan policy di daemon. |
| `lantana-ctl` | Manajemen akun, device, scheme, AccessKey, dan izin dari CLI. |
| `lantana-dashboard-server.ts` | Consumer MQTNL khusus dashboard portable; mengambil snapshot lewat IPC Lantana yang sudah difilter policy. |
| Flutter portable dashboard | Client Android; menghubungkan MQTT broker dan endpoint MQTNL dashboard secara terpisah. |
| Lantana Control Panel | GUI Cashew untuk mengelola akun, device, scheme, portable dashboard, dan melihat status server melalui `lantana-ctl`. |
| Dashboard/logger/DB injector | Consumer; kontrak event-nya diperbarui bersamaan dengan V2, tanpa lapisan kompatibilitas. |

### Struktur file V2

Mengikuti pola repo TSIX: library di `src/mirror/lib/lantana/` (alias
`@tsix/lantana/*`), daemon dan aplikasi di `src/mirror/opt/lantana/`.

```text
src/mirror/lib/lantana/
  lantana-core.ts          # tipe, konstanta, kode error, parser/encoder payload
  lantana-config.ts        # loader /etc/lantana/config.json (tanpa kredensial)
  account-manager.ts       # akun parent-child + AccessKey (verifier scrypt)
  dashboard-registry.ts    # portable dashboard per akun + verifier key dashboard
  device-registry.ts       # deviceId, ikatan account+device, metadata grup
  scheme-registry.ts       # definisi scheme + validasi tipe/rentang
  permission-policy.ts     # inject/query/command
  session-manager.ts       # state sesi MQTNL (nonce, binding akun/device)
  lantana-keys.ts          # key pair server (pinned fingerprint device)
  lantana-store.ts         # persistensi accounts/dashboard/devices/schemes
  lantana-ingest.ts        # pipeline auth → policy → validate
  lantana-listener.ts      # handshake + decrypt + ingest + command
  lantana-device-bank.ts   # state terkini + heartbeat + endpoint balik
  lantana-databank.ts      # sink + antrean berbatas (idempoten)
  lantana-distributor.ts   # event ke consumer + otorisasi command
  lantana-ctl-client.ts    # adapter proses lantana-ctl untuk GUI

src/mirror/opt/lantana/
  lantana.ts               # daemon
  lantana-ctl.ts           # CLI admin
  lantana-control-panel.ts # GUI admin Cashew (Lantana Control Panel)
  lantana-cmd.ts           # kirim command ke device
  lantana-dashboard.ts     # GUI monitoring
  lantana-dashboard-server.ts # consumer dashboard portable (default MQTNL 1001)
  lantana-db-injector.ts   # consumer DB
  lantana-file-logger.ts   # consumer log
```

Konfigurasi & state V2:

- `/etc/lantana/config.json` — service port dan kategori device. Tidak berisi
  kredensial.
- `/etc/lantana/accounts.json` — akun, relasi parent, izin, dan **verifier**
  AccessKey akun (salt + scrypt), bukan key mentah. Tidak berisi konfigurasi
  dashboard.
- `/etc/lantana/dashboard.json` — portable dashboard per akun. Setiap entri
  berbentuk `{ accountId, portableDashboard, createdAt }`; `portableDashboard`
  adalah array dashboard dengan `dashboardId`, `title`, `accessKeyHash`
  (SHA-256), dan `dashboardItems`. Key dashboard mentah tidak disimpan. State
  lama yang masih menyimpan `portableDashboard` di `accounts.json` dipindahkan
  otomatis saat state dimuat.
- `/etc/lantana/devices.json` — ikatan `accountId + deviceId` dan metadata.
- `/etc/lantana/schemes.json` — definisi scheme.
- `/etc/lantana/keys/server-key.json` — key pair server untuk handshake;
  fingerprint di-pin di firmware. Jangan commit.

`accounts.json`, `dashboard.json`, `devices.json`, dan `schemes.json` **dibuat
otomatis** (isi `[]`) saat daemon atau CLI pertama kali dijalankan, jadi
instalasi baru tidak gagal start. Keempatnya sengaja tidak disertakan di mirror
`src/mirror/etc/lantana/` supaya `vfs:bootstrap` tidak menimpa state runtime
dengan file kosong.

Tabel DataBank yang diharapkan consumer contoh (`lantana-db-injector`):

```sql
CREATE TABLE IF NOT EXISTS sensor_readings (
    reading_id  VARCHAR(36) PRIMARY KEY,
    account_id  VARCHAR(64) NOT NULL,
    device_id   VARCHAR(64) NOT NULL,
    scheme_id   INT NOT NULL,
    label       VARCHAR(128) NOT NULL,
    unit        VARCHAR(32) NOT NULL,
    value       VARCHAR(64) NOT NULL,
    received_at DATETIME NOT NULL,
    INDEX idx_account_device_time (account_id, device_id, received_at)
);
```

`reading_id` sebagai PRIMARY KEY membuat retry idempoten: pengiriman ulang
tidak menggandakan baris.

## Yang dipakai ulang dan yang dibuang

Dipakai ulang (kode dan ide, kontraknya ditulis ulang):

- Parser frame sensor biner dan format teks ber-`nodeId`.
- DeviceBank: state sensor terkini, heartbeat ONLINE/STALE/OFFLINE, grouping.
- Distributor dan pola consumer IPC.
- Command dua arah via endpoint terakhir device.
- Dashboard monitoring, DB injector, file logger.

Dibuang tanpa pengganti kompatibilitas:

- `ports.<port>.tenant` dan `apiKeyHex` sebagai identitas, serta key tenant
  per port pada `net.ioctl(0x1001)`.
- `mode: "auto" | "binary" | "plain"` dan fallback plaintext otomatis.
- Format legacy `sensorId:value;...` tanpa `deviceId`.
- `deviceGroupMap` bentuk flat legacy.
- Filter tenant pada registrasi consumer sebagai pengganti otorisasi.
- Default config yang menanam API key di repo.
- Test V1 yang mengunci kontrak lama; diganti test untuk kontrak V2.

Konsekuensinya: device dan consumer lama tidak akan jalan tanpa penyesuaian.
Itu diterima karena belum ada pemakaian operasional.

## Tahapan implementasi

1. [x] Kontrak tipe V2 (`account`, `device`, `scheme`, `session`, `reading`)
   dan kontrak DataBank.
2. [x] Account/Credential Manager dan Device Registry: penerbitan AccessKey
   akun, penerbitan `deviceId`, rotasi, pencabutan.
3. [x] Sesi MQTNL per device: handshake RSA-OAEP, autentikasi akun, penolakan
   plaintext.
4. [x] Permission policy dan validasi scheme pada jalur ingest sebelum mutasi
   DeviceBank atau pengiriman ke DataBank.
5. [~] Query: snapshot IPC sudah difilter policy dan dipakai oleh consumer
   MQTNL dashboard; endpoint HTTP REST umum belum dibuat.
6. [x] Distributor, dashboard, logger, DB injector, dan CLI mengikuti kontrak
   baru.

## Alur kerja

```sh
# 1. Siapkan akun + kredensial
lantana-ctl account create-root juragan
lantana-ctl account key-issue juragan        # simpan key di firmware

# 2. Daftarkan scheme dan device (deviceId diterbitkan di sini)
lantana-ctl scheme add juragan 101 --label Suhu --unit C --min -40 --max 125
lantana-ctl scheme add juragan 102 --label Kelembapan --unit % --min 0 --max 100
lantana-ctl scheme add juragan 103 --label Tekanan --unit hPa --min 800 --max 1100
lantana-ctl scheme add juragan 104 --label Cahaya --unit lx --min 0 --max 100
lantana-ctl device add juragan --name "Sensor Bandung" --city Bandung --group jabar
lantana-ctl server fingerprint   # untuk TSIX_LANTANA_FINGERPRINT di secrets.h

# 3. Jalankan daemon dan simulator
lantana
esp32-demo --account=juragan --device=<deviceId> --key=<accessKey>

# 4. Consumer dan command
lantana-dashboard <daemonPid> juragan
lantana-file-logger juragan
lantana-cmd juragan <deviceId> "RELAY_1:ON"
```

### Lantana Control Panel

Lantana Control Panel tersedia dari menu **IoT** di Asteracea. Panel Cashew
menyediakan navigasi pohon akun, device, scheme, dan portable dashboard di
sisi kiri, serta editor detail di panel tengah. Toolbar di atas menyediakan
aksi tambah, edit, simpan, hapus, pengelolaan key, dan muat ulang. Bagian Server
menampilkan fingerprint dan konfigurasi layanan yang sedang dibaca. Operasi
mutasi dan pembacaan tetap dijalankan oleh
`lantana-ctl --json`, dengan adapter proses terpusat. Panel tidak mengimpor
registry/store atau mengedit file state secara langsung.

Rotasi/penerbitan AccessKey menampilkan key satu kali dalam dialog. Cabut key,
hapus akun, device, scheme, dashboard, dan item dashboard meminta konfirmasi.
Penghapusan akun ditolak selama akun masih memiliki child atau resource terkait.
Izin query/inject bersifat eksplisit dan tidak diwariskan dari parent.

### Portable dashboard Android

Dashboard portable memakai credential terpisah dari AccessKey sensor. Terbitkan
key dashboard; key mentah dicetak satu kali, sedangkan
`/etc/lantana/dashboard.json` hanya menyimpan SHA-256 verifier:

```sh
lantana-ctl dashboard key-issue juragan
lantana-ctl dashboard show juragan
lantana-ctl dashboard key-rotate juragan 1000
lantana-ctl dashboard key-revoke juragan 1000
lantana-dashboard-server 1001
```

`key-issue` menambahkan dashboard baru ke array akun di `dashboard.json`.
`key-rotate` mengganti key untuk `dashboardId` yang dipilih tanpa menghapus item;
`key-revoke` mencabut key dashboard tersebut tanpa menghapus konfigurasinya.
Default endpoint MQTNL adalah `tsix:1001`. Port ini berbeda dari port listener
sensor (default `1000`).

Item dashboard dapat dikelola melalui Lantana Control Panel atau CLI. Mode
`--json` menyediakan envelope versi 1 (`{ version, ok, data }` untuk sukses;
`{ version, ok, error }` untuk gagal) yang dipakai GUI, tanpa mengubah output
teks CLI biasa. GUI menjalankan operasi lewat `lantana-ctl`; ia tidak membaca
atau menulis registry/state secara langsung. AccessKey mentah hanya tampil
saat diterbitkan/dirotasi dan tidak disimpan oleh GUI.

Contoh mengubah judul dashboard dan menambah item lewat CLI:

```sh
lantana-ctl dashboard update juragan 1000 --title "Sensor Rumah"
lantana-ctl dashboard item-set juragan 1000 new \
  --type text --title "Suhu Ruangan" --icon thermostat \
  --interval 5 --device-id <deviceId> --scheme-id 101
```

Jangan menulis key mentah di `dashboard.json`; file tersebut hanya menyimpan
`accessKeyHash`. Contoh:

```json
[
  {
    "accountId": "juragan",
    "portableDashboard": [
      {
        "dashboardId": 1000,
        "title": "Sensor Rumah",
        "accessKeyHash": "<SHA-256 dashboard key, 64 karakter hex>",
        "dashboardItems": [
          {
            "type": "radialGauge",
            "title": "Kelembaban",
            "icon": "water_drop",
            "updateInterval": 60,
            "deviceId": "7f352db1-c787-4976-b441-d1bf7387fe49",
            "schemeId": 102
          },
          {
            "type": "lineChart",
            "title": "Tekanan",
            "icon": "bolt",
            "updateInterval": 60,
            "scrollAfter": 7,
            "deviceId": "7f352db1-c787-4976-b441-d1bf7387fe49",
            "schemeId": 103
          }
        ]
      }
    ],
    "createdAt": 1794912387013
  }
]
```

`type` yang didukung: `text`, `radialGauge`, `lineChart`, dan
`switchIndicator`. `scrollAfter` adalah jumlah sampel chart yang ditampilkan
(default 7); sampel dikumpulkan di aplikasi berdasarkan `updateInterval` dan
bersifat sementara selama aplikasi berjalan. Bacaan yang tidak lolos izin query
tidak disertakan server.

Pada Android, isi alamat/port MQTT broker, alamat/port server MQTNL, dashboard
ID, dan key yang dicetak CLI. App hanya menyimpan hash key di Android secure
storage dan mengirim HMAC proof yang terikat nonce challenge (bukan raw key atau
hash verifier yang bisa diputar ulang). Hash verifier tetap setara credential
bila dicuri, jadi lindungi permission file `accounts.json`/`dashboard.json` dan
Android secure storage. Key exchange RSA-OAEP memakai encoding yang sama dengan
TSSH/TSIX; paket data menggunakan ChaCha20-Poly1305. Saat koneksi pertama, bandingkan
fingerprint di layar dengan `lantana-ctl server fingerprint`.

Build APK debug:

```sh
cd /home/andriansah/Codes/flutter/helloworld/flutter_helloworld
flutter build apk --debug
```

## Kriteria penerimaan

- Mengubah service/source port tidak mengubah akun atau `deviceId`.
- Lantana menolak `deviceId` yang tidak terdaftar pada akun terautentikasi.
- AccessKey tidak dikirim plaintext, tidak muncul di log, dan tidak diteruskan
  ke DataBank.
- Key/session yang tidak valid, device tidak terdaftar, scheme tidak diizinkan,
  atau payload tidak valid tidak mengubah DeviceBank, heartbeat, DataBank,
  maupun event consumer.
- Query dan command dicek di Lantana, bukan hanya difilter oleh UI/consumer.
- Tidak ada jalur kode yang menerima payload sensor tanpa sesi terautentikasi.

## Keputusan default V2

Keputusan berikut dipakai kecuali ada alasan kuat untuk berubah:

- **`schemeId` unik global**, dimiliki satu akun (`ownerAccountId`). Akun lain
  hanya bisa memakai scheme jika diberi izin eksplisit. Ini menghindari
  ambiguitas saat query lintas akun dan menyederhanakan NACK.
- **Tidak ada inheritance izin.** Child hanya mendapat izin yang diberikan
  eksplisit; parent boleh mengelola akun child dan scheme miliknya sendiri.
  Hanya parent (root) yang boleh membuat scheme baru.
- **DataBank menerima submit idempoten** dengan `readingId` unik. Jika DataBank
  tidak tersedia: antrean in-memory berbatas, lalu NACK ke device ketika penuh.
  Tidak ada drop diam-diam.
- **Server public key di-pin** sebagai fingerprint di firmware. Rotasi memakai
  dua key aktif bersamaan (overlap) agar device lama tidak langsung mati.
- **Satu AccessKey per akun**, boleh dipakai banyak device, dengan rotasi dan
  pencabutan per akun. Tidak ada kredensial per device pada V2.
- **Tidak ada mode kompatibilitas.** Konfigurasi V2 memakai file baru; config
  V1 tidak dibaca.
