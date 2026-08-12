# 🥜 Cashew Framework — Delphi-style GUI untuk TSIX

**Cashew** adalah framework GUI deklaratif untuk TSIX yang mengadopsi pola komponen ala **Delphi / Turbo Pascal**. Tujuannya: bikin kode GUI lebih flat, mudah dibaca, dan bebas dari nesting berlebihan.

---

## 📦 Instalasi

Cashew sudah termasuk dalam library TSIX. Tinggal import:

```typescript
import {
  TForm,
  TPanel,
  TLabel,
  TButton,
  TEdit,
  TMemo,
  TCheckBox,
  TListBox,
  TStatusBar,
  TRadioButton,
  TComboBox,
  TDialogs,
  TScrollBox,
  TFlowPanel,
  TGridPanel,
  TSplitHorizontal,
  TSplitVertical,
  TGroupBox,
  HStack,
  VStack,
  Spacer,
} from "@tsix/cashew";
```

---

## 🚀 Quick Start

```typescript
import { Program, std } from "@tsix/Application";
import { TForm, TLabel, TButton, TStatusBar } from "@tsix/cashew";

export const main = Program(async () => {
  const form = new TForm("My App", 400, 300);
  let count = 0;

  const lblCounter = new TLabel("counter");
  lblCounter.caption = "Count: 0";
  form.add(lblCounter);

  const btnClick = new TButton("btn-click");
  btnClick.caption = "Klik";
  btnClick.onClick = () => {
    count++;
    lblCounter.caption = "Count: " + count;
  };
  form.add(btnClick);

  const status = new TStatusBar("status");
  status.text = "✅ Siap";
  form.add(status);

  form.onSetup = async (screen) => {
    btnClick.bind(screen);
    lblCounter.bind(screen);
    status.bind(screen);
  };

  await form.run();
});
```

---

## 🧱 Komponen

### TForm — Window Utama

Constructor `TForm` bisa dipanggil **dua cara** (setara): sequential atau object literal.

```typescript
// Bentuk 1 — sequential: (title, width, height, maximizable, resizable, fullscreen, frameless)
const form = new TForm("Judul", 800, 600);
form.style = { ...form.style, background: "#111" };
form.onClose = () => console.log("Closed");
await form.run();

// Bentuk 2 — object literal
const form = new TForm({
  title: "Judul",
  width: 800,
  height: 600,
  maximizable: true, // bisa di-maximize (default true)
  resizable: true, // bisa di-resize (default true)
  fullscreen: false, // mode fullscreen tanpa frame (default false)
  frameless: false, // tanpa titlebar/border (default false)
  style: { padding: "0", margin: "0", background: "#111" }, // style tambahan (di-merge)
});
```

| Opsi          | Tipe                  | Default | Fungsi                                                                       |
| :------------ | :-------------------- | :------ | :--------------------------------------------------------------------------- |
| `title`       | string                | —       | Judul window                                                                 |
| `width`       | number                | `800`   | Lebar window (px)                                                            |
| `height`      | number                | `600`   | Tinggi window (px)                                                           |
| `maximizable` | boolean               | `true`  | Bisa di-maximize                                                             |
| `resizable`   | boolean               | `true`  | Bisa di-resize                                                               |
| `fullscreen`  | boolean               | `false` | Mode fullscreen                                                              |
| `frameless`   | boolean               | `false` | Tanpa titlebar/border                                                        |
| `style`       | `Record<string, any>` | —       | Style tambahan (margin, padding, background, dll) — di-merge di atas default |

Semua opsi juga bisa di-set lewat properti: `form.maximizable = false`, `form.frameless = true`, `form.style = { ...form.style, padding: "0" }`, dst.

| Method                     | Fungsi                       |
| :------------------------- | :--------------------------- |
| `form.add(component)`      | Tambah komponen              |
| `form.alert(title, msg)`   | Dialog info                  |
| `form.confirm(title, msg)` | Dialog konfirmasi            |
| `form.screen`              | Akses Screen (buat TDialogs) |
| `form.onSetup`             | Callback setelah mount       |

### TPanel — Container

```typescript
// Tanpa extra style
const pnl = new TPanel("panel1");

// Dengan extra style
const pnl = new TPanel("panel1", { marginTop: "8px", background: "#222" });
```

### TLabel — Teks

```typescript
const lbl = new TLabel("lbl-nama");
lbl.caption = "Hello World"; // otomatis update ke layar (setelah bind)
```

### TButton — Tombol

```typescript
// Constructor: (id, extraStyle?)
const btn = new TButton("btn-save", {
  color: "#4caf50",
  marginRight: "5px",
});
btn.caption = "Simpan";
btn.onClick = () => {
  /* action */
};
```

### TEdit — Input Teks

```typescript
const edt = new TEdit("edt-email");
edt.placeholder = "Masukkan email...";
edt.onInput = (val) => console.log(val);
```

### TMemo — Textarea Multiline

```typescript
const memo = new TMemo("memo-catatan");
memo.text = "Baris 1\nBaris 2";
memo.rows = 5;
```

### TCheckBox — Checkbox

```typescript
const chk = new TCheckBox("chk-aktif");
chk.caption = "Aktifkan";
chk.checked = true;
chk.onClick = (checked) => console.log(checked);
```

### TRadioButton — Radio Button (Grouped)

```typescript
// Constructor: (id, groupName?, extraStyle?)
const rb1 = new TRadioButton("rb-merah", "warna");
rb1.caption = "Merah";
rb1.checked = true;
rb1.onClick = () => console.log("Merah");

const rb2 = new TRadioButton("rb-hijau", "warna");
rb2.caption = "Hijau";

// Group = "warna" — milih hijau otomatis uncheck merah
```

### TComboBox — Dropdown

```typescript
const cmb = new TComboBox("cmb-mode");
cmb.items = ["Auto", "Manual", "Scheduled"];
cmb.selectedIndex = 0;
cmb.onChange = (idx, item) => console.log(item);
```

### TListBox — Daftar Pilihan

```typescript
const lb = new TListBox("lst-sensor");
lb.items = ["Sensor 1", "Sensor 2", "Sensor 3"];
lb.onClick = (idx, item) => console.log(item);
// Panggil lb.refresh(screen) setelah set items
```

### TStatusBar — Status Bar

```typescript
const status = new TStatusBar("status");
status.text = "✅ Ready";
```

---

## 📐 Layout

### Grid Layout

Form bisa pake CSS Grid untuk layout 2 kolom:

```typescript
form.style = {
  ...form.style,
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "6px",
};
```

Header full width:

```typescript
lblTitle.style = { gridColumn: "1 / -1" };
```

### Layout Helpers

| Helper                                | Fungsi                                                    |
| :------------------------------------ | :-------------------------------------------------------- |
| **`TGridPanel(id, cols?, style?)**    | Panel dengan CSS Grid, jumlah kolom tetap                 |
| **`TFlowPanel(id, style?)**           | Flex wrap — item otomatis pindah baris                    |
| **`TScrollBox(id, style?)**           | Panel dengan overflow auto (scroll)                       |
| **`TSplitHorizontal(c1, c2, ratio?)** | Dua panel bersebelahan (kiri \| kanan) — **bisa di-drag** |
| **`TSplitVertical(c1, c2, ratio?)**   | Dua panel bertumpuk (atas \| bawah) — **bisa di-drag**    |
| **`TGroupBox(id, caption, style?)**   | Panel dengan border + label (kayak GroupBox Delphi)       |
| **`HStack(...children)**              | Flex row horizontal                                       |
| **`VStack(...children)**              | Flex column vertical                                      |
| **`Spacer(size?)**                    | Pengisi ruang fleksibel                                   |

Contoh splitter:

```typescript
const panelKiri = new TPanel("kiri", { padding: "8px" });
const panelKanan = new TPanel("kanan", { padding: "8px" });
const split = TSplitHorizontal(panelKiri, panelKanan, "1");
form.add(split);
// Splitter bisa di-drag pake mouse!
```

Contoh group box:

```typescript
const group = TGroupBox("grup1", "⚙️ Pengaturan", { height: "150px" });
group.add(new TButton("btn1").withCaption("Simpan"));
form.add(group);
```

---

## 🎯 Event Binding

Semua komponen yang diubah dinamis (caption, text, visibility) harus di-`bind` di `onSetup`:

```typescript
form.onSetup = async (screen) => {
  btnClick.bind(screen);
  lblCounter.bind(screen);
  status.bind(screen);
  cmbMode.bind(screen);
  // ...
};
```

Tanpa `bind()`, perubahan properti kayak `caption = "..."` gak akan sync ke layar.

---

## 💬 Dialogs

Cashew menyediakan `TDialogs` — static methods tanpa perlu form:

```typescript
import { TDialogs } from "@tsix/cashew";

// Alert — info, 1 tombol OK
await TDialogs.alert(screen, "Info", "Pesan");

// Confirm — pilihan Yes/No
const ans = await TDialogs.confirm(screen, "Yakin?", "Lanjutkan?");
// ans = "Yes" atau "No"

// Input — teks dari user
const name = await TDialogs.input(screen, "Nama", "Siapa?");
// name = input user, atau "" kalau cancel

// Open File — pilih file dari VFS
// (butuh fs dari @tsix/Application)
const path = await TDialogs.openFile(screen, fs, "Pilih File", "/");
// path = "/home/kakang/file.txt" atau null

// Save File — tentukan path simpan
const path = await TDialogs.saveFile(screen, fs, "Simpan", "data.txt");
// path = "/home/kakang/data.txt" atau null
```

---

## 🧅 Lapisan API

```
Kernel → Syscall GUI_REQ
  ↓
DOME Engine → WebSocket
  ↓
Browser DOM
  ↑
Emerald → Screen, Window, mount, alert, confirm
  ↑
Cashew → TForm, TButton, TPanel, TDialogs ...
```

**Emerald** = low-level: widget mentah (`div`, `button`, `span`), DOM manipulation.

**Cashew** = high-level: komponen OOP ala Delphi, auto-sync caption/text, layout helpers.

---

## 🎨 Styling

Semua style pake CSS-in-JS (object style). Bisa di-set di constructor atau langsung:

```typescript
// Di constructor
const btn = new TButton("btn-ok", { color: "red", marginRight: "5px" });

// Setelah constructor (tapi hindari kalo bisa pake constructor)
btn.style = { ...btn.style, color: "red" };
```

Style dari constructor **override** default style component.

### Theme / CSS Variables

Cashew pake **CSS variables** biar semua komponen otomatis ngikut theme aktif:

```css
var(--bg, #0d1b2a)        /* Background utama */
var(--surface, #16213e)   /* Panel / card */
var(--text, #e0e0e0)     /* Teks utama */
var(--text-dim, #ccc)     /* Teks redup */
var(--text-muted, #888)   /* Teks samar */
var(--accent, #4caf50)    /* Warna aksen */
var(--border, ...)        /* Warna border */
var(--button-bg, #0f3460) /* Tombol */
var(--input-bg, ...)      /* Input field */
```

Tinggal panggil `theme.applyToDome()` di `onSetup`:

```typescript
import { theme } from "@tsix/theme";

form.onSetup = async (screen) => {
  await theme.loadCurrent();
  theme.watch();
  const domePid = ...; // dari ps
  if (domePid) await theme.applyToDome(domePid, form.screen.win.wid);
};
```

---

## 📝 Contoh Lengkap

| Demo                   | File                                                   | Deskripsi                                        |
| :--------------------- | :----------------------------------------------------- | :----------------------------------------------- |
| **Cashew GUI Demo**    | [`cashew-demo1.ts`](../src/mirror/bin/cashew-demo1.ts) | Counter, input, checkbox, radio, listbox, dialog |
| **Cashew Layout Demo** | [`cashew-demo2.ts`](../src/mirror/bin/cashew-demo2.ts) | Grid, flow, splitter, scroll, anchor, groupbox   |
