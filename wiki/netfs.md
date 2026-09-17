# 🌐 NetFS — Filesystem Antar-Node lewat MQTNL

> **NetFS** membuat filesystem milik node TSIX lain tampil sebagai mount point
> biasa: `cat /mnt/net/docs/a.txt` — padahal isinya diambil dari node lain.
> Transport-nya **MQTNL** (broker MQTT), jadi **tidak butuh IP publik** dan
> tidak perlu sewa VPS: cukup kedua node berada di broker yang sama.
>
> Analogi: NetFS itu "NFS versi TSIX", tapi server-nya (`netfsd --export`)
> dan klien-nya memakai **NetSocket**, dan driver VFS di kernel tetap tipis.

**Status:** driver VFS (kernel) + SL & daemon klien (userland) sudah jalan, 45 test hijau.

---

## 1. Kenapa MQTNL, bukan TCP/IP?

| Alasan | Konsekuensi desain |
| --- | --- |
| MQTNL adalah medium network andalan TSIX | tidak perlu IP publik / port forwarding / VPS |
| Routing lewat broker yang sudah ada | node baru cukup "numpang" di broker yang sama |
| Sudah punya fragmentasi + reassembly | payload besar (mis. 90 KB) otomatis dipecah 32 KB |
| Sudah punya security agent per-port | `--key <64 hex>` → ChaCha20-Poly1305 / AES-GCM |

Konsekuensi yang diterima: 1 operasi = 1 round-trip, jadi latensi lebih tinggi
daripada filesystem lokal. Untuk pola pemakaian yang disasar (file < 500 KB,
bukan streaming), ini masih nyaman — dan tersedia `--cache <ms>` untuk
meredam `ls`/`stat` yang berulang.

---

## 2. Peta komponen

```mermaid
graph TB
    subgraph Client ["Node KLIEN"]
        App["app: cat /mnt/net/a.txt"] --> SC["Syscalls (LS/OPEN/READ/...)"]
        SC --> MM["MountManager.resolve()"]
        MM --> NETFS["<b>NetFS</b><br/>src/vfs/NetFS.ts<br/>IVFS (async) + cache + timeout"]
        NETFS --> CH["<b>MQTNLNetFSChannel</b><br/>src/kernel/netfs/<br/>port ephemeral + handler"]
    end

    CH -->|"MQTNL loopback<br/>(--via 7778)"| CD["netfsd --client<br/>(userland · NetSocket)"]
    CH -->|"MQTNL langsung<br/>(--direct)"| SL
    CD -->|"MQTNL / broker"| SL["netfsd --export<br/>(userland · NetSocket)<br/>NetFSServer + NetFSBackend"]
    SL --> FS["lib.fs → VFS lokal SH<br/>(host / bkfs / ramfs)"]
```

| Lapisan | File | Land | Tanggung jawab |
| --- | --- | --- | --- |
| Driver VFS | `src/vfs/NetFS.ts` | kernel | implementasi `IVFS`: korelasi `id`, timeout, cache, kode error |
| Protokol | `src/common/netfs/NetFSProtocol.ts` | shared | op, amplop request/response, codec base64, parsing `addr:port` |
| Inti SL | `src/common/netfs/NetFSServer.ts` | shared | eksekusi op ke backend, prefix export, pagar read-only, mapping error |
| Transport kernel | `src/kernel/netfs/MQTNLNetFSChannel.ts` | kernel | "socket" kernel: alokasi port MQTNL + register handler + send |
| Transport userland | `src/mirror/sbin/netfsd.ts` | userland | SL (`--export`) & jembatan klien (`--client`), pakai **NetSocket** |
| Adapter userland | `src/mirror/lib/NetFSBackend.ts` | userland | `IVFS` → `lib.fs` (syscall), termasuk efek root-squash |
| Alat diagnosa | `src/mirror/bin/netfs.ts` | userland | `netfs info/ls/cat/status` (via NetSocket, tanpa mount) |

Kenapa dibelah dua begitu? Karena `IVFS` hidup di kernel, sedangkan NetSocket
adalah komponen **userland**. Maka kernel tetap memakai driver MQTNL (lapisan
socket yang sama dengan yang dipakai NetSocket), dan seluruh logika jaringan
yang "kaya" (handshake, enkripsi, proxy) ada di userland.

---

## 3. Alur satu operasi

```mermaid
sequenceDiagram
    participant App as app (cat)
    participant K as Syscalls + NetFS (kernel)
    participant C as MQTNLNetFSChannel
    participant D as netfsd (klien / SH)
    participant B as NetFSServer + backend

    App->>K: READ /mnt/net/docs/a.txt
    K->>K: MountManager.resolve → NetFS
    K->>C: rpc("read", "/docs/a.txt") + id
    C->>D: paket MQTNL {v,id,op,path}
    D->>B: handle() → resolvePath(prefix) → backend.read()
    B-->>D: konten (base64)
    D-->>C: {id, ok:true, result}
    C-->>K: cocokkan id → resolve promise
    K-->>App: konten file
```

---

## 4. Cara pakai

### 4.1 Di node storage host (SH)

```bash
# /mnt/shared = export read-only, terenkripsi
netfsd --export /mnt/shared --label shared --port 7777 --ro --key <64-hex>

# sudut pandang kernel SH
root@tsix_2# lsblk
MOUNTPOINT           TYPE       SOURCE                    OPTS
/mnt/shared          host       shared                    rw
/mnt/sbak            bkfs       systembak.db              rw
```

### 4.2 Di node klien

```bash
# A. lewat daemon klien (disarankan: urusan jaringan tetap di userland)
netfsd --client --to tsix_2:7777 --port 7778 --key <64-hex>
mount /mnt/net tsix_2:7777 --netfs --via 7778 --key <64-hex> --cache 500

# B. langsung ke SL (tanpa daemon klien)
mount /mnt/net tsix_2:7777 --netfs --direct --key <64-hex>

root@tsix# lsblk
MOUNTPOINT           TYPE       SOURCE                    OPTS
/mnt/net              netfs      tsix://tsix_2:7777        rw
root@tsix# cat /mnt/net/docs/a.txt      # dibaca dari node lain
```

Cek dulu sebelum mount (tanpa mount, murni NetSocket):

```bash
netfs info tsix_2:7777          # label, prefix, read-only, ops, RTT
netfs ls   tsix_2:7777 /docs
netfs cat  tsix_2:7777 /docs/a.txt
netfs status                    # mount netfs aktif + status stale
```

### 4.3 Otomatis saat boot (`/etc/fstab.json`)

```json
[
  { "vfsPath": "/mnt/net", "hostPath": "tsix_2:7777", "type": "netfs",
    "readOnly": true, "active": true, "via": 7778, "timeoutMs": 5000 }
]
```

Saat boot, `processFstab()` membuat mount point lalu handshake. **Kalau peer
mati, boot tidak digagalkan** — baris itu dicatat gagal di boot log dan mount
bisa dilakukan manual setelah peer hidup.

Kalau daemon klien ingin selalu siap: jalankan dari `/etc/rc.local.ts`
(pola yang sama dengan `scpd`/`tsshd`):

```ts
await lib.shell.exec("/sbin/netfsd.js", ["--client", "--to", "tsix_2:7777", "--port", "7778"]);
```

### 4.4 Opsi `mount --netfs`

| Opsi | Arti |
| --- | --- |
| `--via <port>` | lewat daemon klien di `localhost:<port>` |
| `--direct` | kernel bicara langsung ke SL node tujuan |
| `--key <64 hex>` | aktifkan enkripsi (harus sama dengan `netfsd --key`) |
| `--agent <nama>` | agent enkripsi: `chacha20` (default) atau `aes-gcm` |
| `--timeout <ms>` | timeout satu operasi (default 5000) |
| `--cache <ms>` | TTL cache `ls`/`stat` (default 0 = mati) |
| `--iface <nama>` | interface MQTNL lokal (default: interface default kernel) |

---

## 4.5 Simpan perintah panjang jadi skrip

Perintah `netfsd` yang panjang cukup ditulis sekali di file skrip:

```bash
# /mnt/sbak/start-netfs.sh
#!/bin/tsh
netfsd --export /mnt/sbak/ --label databank --port 7777 \
  --key c50f67b70e2f0dcf5246ccde04cb1297742ea20a51355eb61807137e003b5c65
```

```bash
chmod +x /mnt/sbak/start-netfs.sh   # wajib — skrip tanpa bit x ditolak (126)
./start-netfs.sh                    # jalankan dari mana saja
tsh start-netfs.sh                  # non-interaktif (cron / rc.local)
./start-netfs.sh &                  # background (subshell tsh terpisah)
```

Di dalam skrip tersedia `$0`, `$1..$9`, `$@`, `$#`; komentar `#`; dan `\` untuk
sambung baris. Detail + batasan: [`changelogs/tsh.md`](changelogs/tsh.md).

Skrip yang sama bisa dipakai sebagai **startup boot**: salin ke `/etc/rc.local`,
`chmod +x`, dan init akan menjalankannya saat TSIX start (lihat
[RC_LOCAL.md](RC_LOCAL.md)) — jadi node SH bisa otomatis meng-export storage
setiap kali hidup.

---

## 5. Protokol (NetFS v1)

Satu request = satu paket MQTNL, satu balasan = satu paket.

```json
→ { "v": 1, "id": 42, "op": "read", "path": "/docs/a.txt" }
← { "v": 1, "id": 42, "ok": true, "result": { "enc": "base64", "size": 10, "data": "aGFsbyBuZXRm" } }
← { "v": 1, "id": 43, "ok": false, "code": "EROFS", "err": "touch: export read-only", "path": "/x" }
```

| Op | Argumen | Balasan |
| --- | --- | --- |
| `info` | — | metadata export (handshake) |
| `ls` | `path` | daftar entri |
| `mkdir` | `path`, `[uid,gid,mode]` | boolean |
| `read` | `path` | konten base64 |
| `touch` | `path`, `[content,uid,gid,mode]` | boolean |
| `stat` | `path` | metadata node |
| `chmod` / `chown` | `path`, argumen | boolean |
| `unlink` / `rmdir` | `path` | boolean |
| `exists` | `path`, `[type]` | boolean |
| `append` | `path`, `[content]` | boolean |
| `getUsage` | — | `{size,files,dirs}` |
| `readChunk` / `writeChunk` | `path`, `[offset,length]` / `[chunk,offset]` | konten base64 / boolean |
| `getSize` | `path` | byte atau `-1` |

Aturan penting:

- **Konten selalu base64** (string internal TSIX = latin1), jadi byte 0–255
  round-trip utuh — bukan cuma teks.
- **Konten besar wajib lewat chunk.** `readChunk`/`writeChunk` dibatasi 32 KB
  per panggilan; request di atas 96 KB ditolak `ETOOBIG`.
- Kode error: `ENOENT`, `EACCES`, `EPERM`, `EROFS`, `ENOTEMPTY`, `EINVAL`,
  `EBADREQ`, `EBADOP`, `ETOOBIG`, `ETIMEDOUT`, `ESTALE`, `EIO`.

---

## 6. Keamanan (berlapis)

| Lapisan | Mekanisme |
| --- | --- |
| Transport | `--key` → ChaCha20-Poly1305 / AES-GCM per-port (MQTNL security agent) |
| Identitas | hak akses remote = uid proses `netfsd` di SH (**efek root-squash NFS**) |
| Filter klien | `--allow tsix,tsix_2` — hanya alamat MQTNL itu yang dilayani |
| Pagar tulis | `--ro` **dipaksa di SH**, klien tidak bisa "memaksa" rw |
| Isolasi path | `..` dinormalisasi → klien tidak mungkin keluar dari root export |
| Pagar ukuran | request > 96 KB ditolak; chunk > 32 KB ditolak |

Catatan: `uid`/`gid` yang dikirim klien **tidak** dipakai sebagai identitas
(userland `lib.fs` tidak menerimanya) — SATPAM di SH tetap memutuskan
berdasarkan identitas `netfsd`. Jadi klien tidak bisa memalsukan kepemilikan.

---

## 7. Perilaku & batasan

**Yang sudah ditangani:**

- `IVFS` kini `MaybePromise` → driver jaringan tidak memblokir kernel; worker
  yang memanggil FS jaringan **disuspend** (bukan menahan seluruh kernel),
  jadi TTY lain tetap responsif.
- Timeout → error `ETIMEDOUT` + mount ditandai **stale** (terlihat di
  `lsblk` sebagai `rw,stale` dan di `df` sebagai `STALE`). Mount **pulih
  sendiri** begitu peer hidup lagi (soft mount, tidak hang).
- `umount` menutup channel: port MQTNL dilepas + session key dibersihkan.
- Cache `ls`/`stat` (opsional) dibersihkan otomatis setiap operasi tulis.

**Batasan yang perlu diketahui:**

- Tidak ada `rename`, hardlink, file lock, atau `mmap` — `IVFS` memang tidak
  punya, jadi NetFS juga tidak.
- `df` melaporkan ukuran export di SH, bukan kapasitas disk fisik SH.
- Di backend userland, `append` = read + write (2 syscall) karena `lib.fs`
  belum punya append native. Untuk file besar, pakai `writeChunk`.
- Throughput dibatasi broker MQTT — untuk transfer besar berulang, jalur TCP
  langsung (mis. `/dev/httpd`) masih lebih cepat.

---

## 8. Diagnosa

```bash
netfs status                 # mount netfs + stale?
netfs info tsix_2:7777       # peer hidup? label/prefix/ro? RTT berapa?
lsblk                        # OPTS menampilkan ",stale" kalau peer mati
df                           # kolom Disk = NET / STALE
cat /logs/boot.log           # kegagalan mount netfs saat boot
```

Gejala umum:

| Gejala | Penyebab yang paling sering |
| --- | --- |
| mount gagal "tidak merespons" | `netfsd --export` tidak jalan di SH, atau `--client` belum jalan di klien (pakai `--direct`) |
| timeout terus / `stale` | alamat/port salah, node beda broker, **key tidak sama**, atau **`--iface` berbeda** antara daemon klien dan mount |
| mount normal, lalu **mendadak** timeout begitu `tssh`/`scanif`/OTA jalan di node itu | framing protocol per-port (lihat di bawah) — sudah diperbaiki: port channel NetFS di-pin `JSON`, payload Buffer diterima di semua titik masuk NetFS |
| `EROFS` saat menulis | `netfsd --export --ro`, atau mount dipasang `--ro` |
| `EACCES` | uid `netfsd` tidak punya hak di folder export |

> **Kenapa protocol wajib di-pin eksplisit?** MQTNL memilih **framing per-port**
> (JSON v1.0 / Binfeo v1.2 / OTA v1.1) dan penerima tidak mengontrol pilihan
> pengirim. Port yang tidak di-pin akan mewarisi protocol "terakhir dipakai"
> (`protocolRegistry`) atau default global — jadi aplikasi di node yang sama
> bisa saling mengubah framing. Aturan praktisnya, untuk tiap socket baru:
>
> 1. **Pengirim:** sebutkan `protocol` (atau `binary`) — `NetSocket` sudah
>    melakukannya otomatis; port buatan kernel wajib `ioctl 0x1002` sendiri.
> 2. **Penerima:** jangan asumsikan payload berupa string — pakai
>    `parseNetFSPayload()` (NetFS) atau `NetworkLib.toBuffer()` untuk biner,
>    supaya payload Buffer tidak dibuang diam-diam.

---

## 9. Test

```bash
npx vitest run src/common/netfs src/vfs/NetFS.test.ts \
                src/kernel/netfs src/mirror/lib/NetFSBackend.test.ts
```

| Suite | Cakupan |
| --- | --- |
| `NetFSServer.test.ts` (N1/N3) | op, prefix, read-only, allow, `..` escape, codec, parsing spec, payload Buffer |
| `NetFS.test.ts` (N2) | driver klien lewat channel loopback in-memory: op, chunk I/O, timeout→stale, pemulihan, cache, close |
| `MQTNLNetFSChannel.test.ts` (N4) | alokasi port kernel, registrasi handler, srcPort, pelepasan resource, key→ioctl, pin protocol JSON |
| `NetFSProtocol.test.ts` (N6) | decoder payload: string JSON, Buffer, artefak IPC, payload rusak |
| `NetFSBackend.test.ts` (N5) | adapter userland: mode, error mapping, append, getUsage root |

Isolasi protocol diuji terpisah di `src/kernel/devices/SimpleMQTNLDriver.protocol.test.ts`
(N7): gema paket sendiri, registry peer, pin per-port, pembersihan pin.

Tidak ada broker MQTT yang dibutuhkan untuk test — transport diganti channel
loopback / spy.

---

## 10. Belum ada (kandidat lanjutan)

- NFS-style **hard mount** (tahan retry) sebagai opsi untuk batch job.
- **Locking** & `rename` (perlu tambahan di `IVFS` dulu).
- **Multi-export per daemon** (saat ini satu `netfsd --export` = satu export).
- **Auto-spawn daemon klien** dari `mount --netfs` (sekarang: jalankan
  `netfsd --client` dulu, atau pakai `--direct`).
- `netfs df` (kapasitas disk fisik SH) & `netfs stat` yang lebih detail.

---

Changelog: [`changelogs/netfs.md`](changelogs/netfs.md) (2026-09-17).
