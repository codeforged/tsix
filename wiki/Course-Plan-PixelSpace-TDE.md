# Course Plan — PixelSpace Protocol & TDE Architecture

**RFC-TSIX-EDU-001** | Kurikulum pembelajaran internal untuk memahami model GUI TSIX (PixelSpace + TDE).

> **Ruang lingkup**: Khusus model GUI di TSIX. Bukan "GUI architecture" global (terlalu umum) — melainkan arsitektur konkret: PixelSpace Protocol, DOME Engine, Emerald Toolkit, Asteracea WM, dan interaksinya dengan Kernel.

---

## Prasyarat

- Dasar TypeScript/JavaScript
- Sudah paham TSIX umum: Worker Thread, syscall, IPC (`postMessage`), VFS
- Nyaman membaca kode di `src/kernel`, `src/common`, `src/mirror`

---

## Peta Materi — 10 Modul

```
┌─────────────────────────────────────────────────────────────┐
│  MODUL 1-2: Fondasi (apa itu display server, protokol)      │
├─────────────────────────────────────────────────────────────┤
│  MODUL 3-5: Inti PixelSpace (protocol, DOME, event)         │
├─────────────────────────────────────────────────────────────┤
│  MODUL 6-8: Toolkit & Desktop (Emerald, WM, TDE)            │
├─────────────────────────────────────────────────────────────┤
│  MODUL 9-10: Lanjutan (state/security, future)              │
└─────────────────────────────────────────────────────────────┘
```

---

## MODUL 1 — Konsep Display Server & Protokol

**Tujuan**: Paham posisi PixelSpace dalam ekosistem TSIX dan analoginya dengan X11/Wayland.

| Sub-topik | Inti |
|-----------|------|
| Apa itu display server | Jembatan antara aplikasi dan hardware/layar |
| DOM-Based Remote Rendering | Browser host sebagai GPU; WebSocket bus; JSON protokol |
| Posisi vs device driver | PixelSpace = protokol display, BUKAN `/dev/fb0` |
| Analogi X11/Wayland | `PixelSpace = X11/Wayland`, `Emerald = GTK/Qt` |

**Kode sumber**: `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §1, `wiki/Arsitektur-Sistem.md`
**Praktik**: Diskusi + diagram layer

---

## MODUL 2 — Kontrak Data PixelSpace

**Tujuan**: Hafal struktur data yang menjadi "konstitusi" protokol.

| Sub-topik | Inti |
|-----------|------|
| `IDOMNode` | Virtual DOM: `{ id, tag, props, children }` |
| `IGUIPayload` | Envelope syscall: `{ syscall, pid, wid, action, targetId, node, props }` |
| `GUIAction` | 11 aksi protokol (CREATE/MOUNT/UPDATE/.../REGISTER) |
| `IBrowserEvent` | Event dari browser: `{ wid, targetId, eventType, value }` |
| `IGUIEventIPC` | Event ke Worker: `{ type: "GUI_EVENT", ... }` |

**Kode sumber**: `src/common/GUITypes.ts` (KONSTITUSI — jangan diubah sembarangan)
**Praktik**: Baca `GUITypes.ts` baris per baris; catat enum & interface

---

## MODUL 3 — Alur Data & Syscall GUI_REQ

**Tujuan**: Menguasai jalur lengkap payload dari Worker sampai browser dan kembali.

| Sub-topik | Inti |
|-----------|------|
| Outbound (Worker→Browser) | `Worker → GUI_REQ(61) → Kernel → DOME → WS → Browser` |
| Inbound (Browser→Worker) | `Browser → DOME → Kernel(SEND_MSG) → Worker` |
| Handler kernel | Validasi → override pid → auth → forward ke DOME |
| Autentikasi kepemilikan | `pid↔wid` binding; `CREATE_WINDOW` = registrasi |
| Sanksi | Payload rusak → SIGKILL; akses window orang → SIGSEGV |

**Kode sumber**: `src/kernel/Syscalls.ts` (case `GUI_REQ`), `src/kernel/GUIRegistry.ts`
**Praktik**: **ps-sample1.ts** (raw protocol, satu window)

---

## MODUL 4 — DOME Engine (Display Server)

**Tujuan**: Memahami peran DOME sebagai relay + primitive DOM producer + kompositor.

| Sub-topik | Inti |
|-----------|------|
| Arsitektur DOME | Daemon Ring 4, port 8080, `shell.daemonize()` |
| Server-side (`dome.ts`) | Window registry, Z-index, focus, replay, broadcast |
| Client-side (`dome-client.html`) | `handleCreateWindow`, `handleMountNode`, `handleUpdateProps` |
| Kompositor built-in | Titlebar, tombol, drag, resize 4 pojok, minimize/restore animasi |
| Catatan desain | Monolitik karena latency (lihat §1 guide) |

**Kode sumber**: `src/mirror/bin/dome.ts`, `src/mirror/bin/dome-client.html`
**Praktik**: Run `dome`, buka browser, inspect DOM `.tsix-window`

---

## MODUL 5 — Event Handling & IPC

**Tujuan**: Menguasai sistem event — dari klik di browser sampai callback di Worker.

| Sub-topik | Inti |
|-----------|------|
| Event types | click, input, keydown, close/min/max, window_state, focus |
| Flow event | Browser listener → socket.send → DOME → Kernel → Worker |
| Mount-time listeners | `onClickId`/`onInputId`/`onKeydownId` di props |
| `bindHandler` vs `app.on` | Kapan pakai yang mana (masalah cloneNode!) |
| Window lifecycle events | `GUI_WINDOW_CREATED/MINIMIZED/RESTORED/CLOSED` |

**Kode sumber**: `emerald.ts` (`Window` handler map), `dome.ts` (relay), `dome-client.html` (listener)
**Praktik**: **ps-sample3.ts** (input/keydown/click, bindHandler) — pelajaran bug cloneNode

---

## MODUL 6 — Emerald Widget Toolkit

**Tujuan**: Membedakan layer protokol vs toolkit, dan memakai Emerald produktif.

| Sub-topik | Inti |
|-----------|------|
| Layer toolkit | Protokol stabil di tengah; toolkit bisa diganti |
| `Screen` wrapper | mount, setContent, update, on, loopUntilClose |
| Factory functions | div, button, input, text, span, h1-h3, paragraph, dll |
| Komponen siap pakai | badge, taskbarButton, sensorCard, lineChart, gauge, dll |
| Connected widgets | Self-rendering: `ConnectedSensorCard`, `ConnectedToggle` |
| Tema | `theme.loadCurrent()`, `theme.colors.*`, `theme.watch()` |

**Kode sumber**: `src/mirror/lib/emerald.ts`, `src/mirror/lib/theme.ts`
**Praktik**: **ps-sample2.ts** (Screen dasar), **ps-sample3.ts** (dinamis + tema)

---

## MODUL 7 — Window Management (Sisi Aplikasi)

**Tujuan**: Mengontrol siklus hidup window dari sisi aplikasi.

| Sub-topik | Inti |
|-----------|------|
| Aksi lifecycle | minimize/restore/maximize/unmaximize/close |
| State window browser | `_savedRect`, `_unmaximizeRect`, `_isMaximized` |
| Titlebar controls | Tombol ─ 🗖 🗗 ✕ + double-click toggle |
| Move mode / context menu | Right-click taskbar → Move/Close |
| Fullscreen vs frameless | `fullscreen: true`, `frameless: true` |

**Kode sumber**: `emerald.ts` (`Window.minimize/maximize/...`), `dome-client.html` (titlebar)
**Praktik**: Program yang panggil `app.minimize()`, `app.maximize()` dari tombol dalam window

---

## MODUL 8 — Asteracea & TDE (Window Manager)

**Tujuan**: Memahami WM sebagai aplikasi PixelSpace, bukan bagian kernel/DOME.

| Sub-topik | Inti |
|-----------|------|
| Asteracea sebagai app | Fullscreen frameless `new Window(...)` |
| Taskbar | Pinned vs Running vs Foreign apps, badge RI |
| Launcher & menu | `/etc/asteracea/menu/*.menu`, fuzzy search |
| IPC lifecycle | Listen `GUI_WINDOW_CREATED/MINIMIZED/CLOSED` |
| PID file | `/etc/asteracea/wm-pid` — broadcast event ke WM |
| Peran masa depan | Kandidat compositor terpisah dari DOME |

**Kode sumber**: `src/mirror/bin/asteracea.ts`, `src/mirror/etc/asteracea/`
**Praktik**: Baca asteracea.ts; telusuri handler event lifecycle

---

## MODUL 9 — State Replay, Pruning & Keamanan

**Tujuan**: Menguasai mekanisme yang membuat UI survive F5 + model keamanan.

| Sub-topik | Inti |
|-----------|------|
| State replay | `windowStates` → replay MOUNT_NODE + UPDATE_PROPS saat reconnect |
| `pruneWindowState` | Bersihkan state saat UNMOUNT (cegah orphan leak) |
| Orphan discard | Browser discard node tanpa parent (bukan fallback) |
| Overlay layer search | `findElementById` 3 level: window → start menu → overlay |
| Model keamanan | SIGKILL (payload rusak) / SIGSEGV (akses orang) / auto-destroy |

**Kode sumber**: `dome.ts` (replay), `dome-client.html` (orphan discard), `GUIRegistry.ts`
**Praktik**: F5 di browser saat app running — perhatikan UI kembali utuh

---

## MODUL 10 — Lanjutan & Arsitektur Target

**Tujuan**: Melihat ke depan — arah arsitektur ideal dan gap yang ada.

| Sub-topik | Inti |
|-----------|------|
| Compositor terpisah | Tradeoff: arsitektur bersih vs latency drag (~2-4ms) |
| Optimistic updates | Compositor update posisi lokal, sync belakangan |
| Sapphire (future) | Toolkit declarative/reactive kedua di atas protokol sama |
| Multi-client | Banyak browser konek ke satu DOME |
| Gap arsitektur | DOME monolitik; Asteracea belum jadi compositor penuh |

**Kode sumber**: `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §1 (Catatan Arsitektur)
**Praktik**: Tulis RFC "Compositor Protocol" sebagai latihan desain

---

## Alur Pembelajaran Terpadu (Sample → Materi)

| Sample | Modul | Skill |
|--------|-------|-------|
| **ps-sample1.ts** | 2, 3 | Raw protocol: CREATE/MOUNT/UPDATE/DESTROY + auth |
| **ps-sample2.ts** | 6 | Emerald Screen: mount, on, setText, loopUntilClose |
| **ps-sample3.ts** | 5, 6, 9 | Dinamis: setContent, bindHandler, event flow, tema |
| *(ps-sample4)* | 7, 8 | Window lifecycle + multi-window |
| *(ps-sample5)* | 6 | Connected widgets (self-rendering, targeted update) |
| *(ps-sample6)* | 5 | IPC antar aplikasi via `shell.send()` |
| *(ps-sample7)* | 3, 9 | Multi-client & state replay |

---

## Referensi Kode (Cheat Sheet)

| File | Peran dalam materi |
|------|--------------------|
| `src/common/GUITypes.ts` | Konstitusi protokol (Modul 2) |
| `src/common/SyscallCode.ts` | `GUI_REQ = 61` (Modul 3) |
| `src/kernel/Syscalls.ts` | Handler GUI_REQ + keamanan (Modul 3, 9) |
| `src/kernel/GUIRegistry.ts` | Registry + ownership (Modul 3, 9) |
| `src/mirror/bin/dome.ts` | DOME server (Modul 4, 9) |
| `src/mirror/bin/dome-client.html` | DOME browser (Modul 4, 5, 7) |
| `src/mirror/bin/asteracea.ts` | WM (Modul 8) |
| `src/mirror/lib/emerald.ts` | Toolkit (Modul 5, 6) |
| `src/mirror/lib/theme.ts` | Tema (Modul 6) |
| `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` | Dokumentasi utama (semua modul) |

---

*Kurikulum ini hidup — perbarui seiring bertambahnya pemahaman dan kode.*
*TSIX Desktop Environment — "Your pixels, your space." 🎨*
