# TSIX Boot Sequence Diagram

Berikut adalah visualisasi urutan proses booting pada platform TSIX, mulai dari skrip bootstrap host hingga munculnya shell user. Sekali lagi, urutan ini terinspirasi dari **boot sequence UNIX/Linux** yang telah teruji selama puluhan tahun.

```mermaid
sequenceDiagram
    participant B as Bootstrap (Host)
    participant M as main.ts (Node.js)
    participant K as Kernel.ts (Core)
    participant V as VFS (system.db)
    participant I as /bin/init.ts (PID 1)
    participant S as /bin/tsh.ts (User Shell)

    Note over B: bootstrap.bat / .sh
    B->>M: node src/main.ts
    
    activate M
    M->>K: new Kernel()
    M->>K: kernel.boot()
    
    activate K
    K->>V: Connect & Init Schema
    
    alt Dev Mode (src/root exists)
        K->>V: syncFromHost(src/root -> /)
        Note right of K: Termasuk Fix /etc/fstab.md
    else Prod Mode
        Note right of K: Rely on existing system.db
    end
    
    K->>K: Init HAL & Subsystems
    K-->>M: Boot Completed
    deactivate K
    
    M->>K: kernel.runInit()
    activate K
    K->>I: spawn process (PID 1)
    deactivate K
    deactivate M
    
    activate I
    I->>I: Run /etc/rc.local.ts
    I->>I: Start Getty/Login on TTYs
    
    I->>S: exec /bin/tsh.ts (after login)
    activate S
    Note over S: User Session Active
    deactivate I
```

## Penjelasan Tahapan:
1.  **Bootstrap**: Skrip pembungkus di host (Windows/Linux) yang memastikan Node.js berjalan dan menangani reboot otomatis.
2.  **Main**: Titik masuk TypeScript, menginisialisasi konfigurasi dan memulai siklus hidup Kernel.
3.  **Kernel Boot**:
    *   **BKFS**: Menghubungkan database SQLite sebagai filesystem.
    *   **Sync**: Jika di mode pengembangan, menyalin file dari folder fisik ke database.
    *   **HAL**: Menyiapkan driver hardware virtual (TTY, Keyboard, dsb).
4.  **Init (PID 1)**: Proses pertama di User-land. Ia yang mengatur jalannya sistem, eksekusi script startup, dan menyediakan prompt login.
5.  **Shell**: Antarmuka akhir tempat user berinteraksi dengan sistem.
