# Developer Guide: Scripting V2.1 (Explicit Import Architecture)

Selamat datang di **Ring 4 (v2.1)**! Versi ini memperkenalkan arsitektur **Explicit Import**. Gak ada lagi "God Object" atau `AppContext` yang membingungkan. Om punya kontrol penuh atas apa yang mau di-import, dimanapun posisi scriptnya!

---

## 1. Import Alias (@tsix & @bin)

TSIX sekarang mendukung **Path Aliases**. Om gak perlu lagi pusing menghitung titik-titik (`../../`) untuk import library.

-   `@tsix/*`: Merujuk ke semua library sistem (`Application`, `UserLib`, dll).
-   `@bin/*`: Merujuk ke folder binary aplikasi.

### Keuntungan Alias: Path Independence 📂
Gak peduli om naruh script di `/bin/`, `/root/test/`, atau folder sedalam `/root/a/b/c/d/`, importnya tetap sama! Ini menghilangkan resiko error "Module not found" gara-gara pindah folder.

---

## 2. Struktur Dasar (Explicit Style)

Gunakan `Program` sebagai wrapper, dan import library yang om butuhkan secara eksplisit dari `@tsix/Application`.

```typescript
import { Program, std } from "@tsix/Application";

export const main = Program(async () => {
    await std.println("Halo om! Ini style v2.1 yang eksplisit dan bersih. 🔥");
});
```

---

## 3. Masih Suka Gaya OOP? (Native Style with Aliases)

Kalau om masih lebih nyaman pakai `class` (Native Style), om tetap bisa menikmati fiturnya tanpa pusing **relative path**.

Cukup gunakan alias `@tsix` untuk import interface-nya:

```typescript
import { IProgram, OSContext } from "@tsix/Application";

export class main implements IProgram {
    async execute(os: OSContext, args: string[]) {
        const { std } = os;
        await std.println("Ini gaya OOP pake alias @tsix om! Tetap rapi. 🎩");
    }
}
```

Om bebas mau ditaruh di folder mana saja, import `@tsix` gak akan pernah pecah! 📂✨

**Contoh Riil: Airterm (Pure OOP + Alias)**
```typescript
import { UserLib } from "@tsix/UserLib";
import { PacketFlags } from "@common/PacketFlags";
import { SecurityAgent } from "@common/SecurityAgent";

export default class Airterm {
    async execute(lib: UserLib, args: string[]) {
        // Bersih, jujur, dan anti relative-path! 🦅
    }
}
```

---

## 4. Library yang Tersedia

Om bisa import library ini secara independen:

| Library | Kegunaan | Contoh Method |
| :--- | :--- | :--- |
| `std` | Standard I/O | `println()`, `print()`, `readLine()`, `log()` |
| `fs` | Filesystem | `readFile()`, `writeFile()`, `open()`, `ls()` |
| `shell` | System Control | `exec()`, `ps()`, `kill()`, `daemonize()` |
| `net` | Networking | `socket()`, `bind()`, `sendto()`, `recv()` |
| `os` | Process Info | `os.pid`, `os.rand` (Random generator) |

---

## 4. Contoh Script Relevan (v2.1)

### A. Network Ping (Explicit Net)
```typescript
import { Program, std, net } from "@tsix/Application";

export const main = Program(async () => {
    await std.println("📡 Mencoba kirim MQTNL Ping...");
    const fd = await net.socket();
    await net.sendto(fd, "mac", 65535, "Hello mac!");
    await std.println("✅ Ping terkirim.");
});
```

### B. File Watcher (Explicit FS & Shell)
```typescript
import { Program, std, fs, shell } from "@tsix/Application";

export const main = Program(async () => {
    await std.println("📂 Memulai watcher di /tmp...");
    await shell.daemonize("TmpWatcher");

    while(true) {
        const files = await fs.ls("/tmp");
        await std.log(`File count in /tmp: ${files.length}`, "Watcher");
        await new Promise(r => setTimeout(r, 10000));
    }
});
```

### C. Game Random Number (Explicit OS & Std)
```typescript
import { Program, std, os } from "@tsix/Application";

export const main = Program(async () => {
    const target = os.rand.nextInt(1, 10);
    await std.println("🎲 Tebak angka (1-10)!");
    
    // ... logic tebak angka ...
});
```

---

## 5. Kenapa Explicit Import Lebih Baik?

1.  **Transparan**: Om tahu persis library apa yang masuk ke aplikasi.
2.  **No More "Manja"**: Menghindari objek context yang kegedean.
3.  **Flexibilitas**: Bisa di-import di sub-module atau helper function tanpa harus oper-operan parameter `lib`.
4.  **Modern**: Mengikuti standar penulisan library JavaScript modern.

**Selamat berkarya dengan TSIX v2.1! Jaga Ring 4 tetap elegan!** 🫡🚀
