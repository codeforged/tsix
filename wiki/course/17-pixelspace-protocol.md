---
module: 17
title: PixelSpace Protocol
part: VII
partTitle: GUI & Desktop
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# PixelSpace Protocol

**RFC-TSIX-EDU-002** | Modul ketujuh belas kurikulum TSIX. Memahami kontrak data GUI: alur data Worker→Kernel→DOME→Browser, GUIRegistry sebagai otoritas kepemilikan window, dan sanksi keamanan.

> PixelSpace adalah **konstitusi GUI TSIX**. Kontraknya (`GUITypes.ts`) tidak boleh diubah sembarangan — semua lapisan di atasnya (DOME, Emerald, Cashew, Asteracea) bergantung pada bentuk data ini.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan alur data mounting UI dan event
- [ ] Menjelaskan peran GUIRegistry (auth wid↔pid)
- [ ] Menyebutkan GUIAction utama
- [ ] Menjelaskan sanksi keamanan (SIGKILL / SIGSEGV)
- [ ] Menjelaskan mengapa `payload.pid` di-override kernel

---

## Konsep Inti

### Alur data

```
Worker (app) → GUI_REQ (61) → Kernel (GUIRegistry auth pid↔wid)
  → DOME daemon (WS broadcast) → Browser (DOM)
Browser → event → DOME → Kernel (SEND_MSG) → Worker (callback)
```

### Alur mounting UI

```
Worker App   → GUI_REQ (MOUNT_NODE) → Kernel → gui_request event → DOME → WS → Browser (createElement)
```

### Alur event (klik/input)

```
Browser → WS → DOME → SEND_MSG ke pid → Kernel → ipc_message event → Worker → callback → updateProps
```

### GUIAction (operasi GUI)

| Action | Kegunaan |
|---|---|
| `CREATE_WINDOW` / `DESTROY_WINDOW` | Bikin / hancurkan jendela |
| `MOUNT_NODE` / `UNMOUNT_NODE` | Pasang / lepas elemen |
| `UPDATE_PROPS` | Ubah properti elemen |
| `MINIMIZE_WINDOW` / `RESTORE_WINDOW` | Sembunyikan / kembalikan |
| `MAXIMIZE_WINDOW` / `UNMAXIMIZE_WINDOW` | Layar penuh / normal |

### GUIRegistry (kernel)

Otoritas **tunggal** kepemilikan window:

- `wid → pid` (primary map) + `pid → Set<wid>` (reverse map, lookup cepat saat exit)
- Z-index auto-increment (mulai 100)
- `registerDaemon(pid)` — hanya "gued" yang boleh menerima forward GUI_REQ
- Cleanup otomatis saat proses mati (`destroyAllForPid`)

### Keamanan

| Pelanggaran | Sanksi |
|---|---|
| Payload format rusak | `SIGKILL` — proses ditembak mati |
| Akses window milik PID lain | `SIGSEGV` — segmentation fault |

> [!IMPORTANT] **`payload.pid` selalu di-override kernel.** Jangan pernah percaya `pid` yang dikirim aplikasi — kernel menetapkan identitas asli dari konteks proses.

---

## Kode Sumber

| File | Peran |
|---|---|
| `src/common/GUITypes.ts` | Kontrak data (IDOMNode, IGUIPayload, GUIAction, IBrowserEvent, IGUIEventIPC) |
| `src/kernel/GUIRegistry.ts` | Otoritas window + auth |
| `src/kernel/Syscalls.ts` | Handler `GUI_REQ` + security |
| `src/mirror/root/ps-sample1.ts` | Praktik raw protocol |

---

## Snippet (level kode)

### GUIRegistry.createWindow

```ts
public createWindow(wid: string, pid: number, title: string = "Untitled"): IWindowEntry {
    if (this.windows.has(wid)) {
        throw new Error(`GUIRegistry: Window '${wid}' already exists.`);
    }
    const entry: IWindowEntry = { wid, pid, title,
        zIndex: this.nextZIndex++, focused: true, createdAt: Date.now() };
    this.windows.set(wid, entry);
    // Update reverse map pid → Set<wid>
    if (!this.pidToWids.has(pid)) this.pidToWids.set(pid, new Set());
    this.pidToWids.get(pid)!.add(wid);
    // Defocus window lain
    return entry;
}
```

---

## Latihan / Praktik

1. Baca `src/common/GUITypes.ts` — pahami seluruh interface "konstitusi".
2. Baca `src/mirror/root/ps-sample1.ts` — praktik raw protocol tanpa toolkit.
3. Jalankan app GUI lalu `ps` — cari PID gued/DOME. Baca `wiki/identity_guid_ipc_walkthrough.md` untuk alur identitas.
4. Modifikasi window milik PID lain lewat GUI_REQ — amati SIGSEGV.

---

## Referensi

- `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §1-2, 10
- `wiki/course/00-overview.md` §10
- `src/common/GUITypes.ts`, `src/kernel/GUIRegistry.ts`, `src/kernel/Syscalls.ts`

---

*Modul 17 — selesai. Lanjut ke [Modul 18 — DOME Engine](18-dome-engine.md).*
