# TSIX Architecture: The Four Rings of Power

Dokumen ini mendefinisikan batas-batas keamanan dan tanggung jawab kode di dalam TSIX. Setiap komponen diklasifikasikan ke dalam "Ring" tertentu untuk menjaga stabilitas sistem — sebuah konsep yang terinspirasi dari **protection rings** pada arsitektur UNIX/Linux yang telah teruji selama puluhan tahun dalam menjaga stabilitas dan keamanan sistem.

> ⚠️ **Catatan Ring 0**: Dalam arsitektur komputer konvensional, Ring 0 adalah privilege level tertinggi — milik kernel OS yang berjalan langsung di atas hardware (bare metal). Sebagai sebuah platform aplikasi, TSIX berjalan di atas **Node.js / V8 interpreter**, bukan bare metal. Oleh karena itu, **Ring 0 adalah domain host OS (Linux/Windows) dan V8 engine**. TSIX memulai penomoran dari **Ring 1**, yang merupakan level paling kritis dalam platform kami. Meski demikian, **seluruh konsep arsitektur — separation of concern, privilege levels, dan layered security — tetap mengacu pada prinsip-prinsip UNIX yang matang dan telah teruji.

---

## 🟢 Ring 1: Kernel Core (The Heart)
Ini adalah area paling kritis. Jika kode di sini bermasalah, seluruh platform akan mati (Kernel Panic).
- **Komponen**: 
    - `kernel.ts` (Bootstrap & Initialization)
    - `PermissionManager.ts` (Satpam Utama)
    - `Scheduler.ts` (Manajemen Proses)
    - `Syscalls.ts` (Pintu Gerbang Utama)
- **Aturan**: Hanya boleh dimodifikasi oleh Core Developer. Tidak boleh memiliki dependensi ke User-Land.

## 🟡 Ring 2: Drivers & File System (The HAL)
Area yang menghubungkan logika kernel dengan data atau hardware (virtual).
- **Komponen**:
    - `Device Drivers` (Termasuk folder `aux-devices/`)
    - `VFS / BKFS.ts` (Logika File System)
- **Aturan**: Harus stabil dan tidak boleh menyimpan state yang bisa mengganggu Ring 1. Perubahan di sini tidak boleh merusak fungsionalitas Syscall.

## 🟠 Ring 3: User Libraries (The Bridge)
Jembatan antara aplikasi dan kernel. Memberikan abstraksi agar aplikasi lebih mudah digunakan.
- **Komponen**:
    - Semua file di `src/root/lib/` (UserLib, FsLib, NetLib, dll)
- **Aturan**: Dilarang mengakses variabel internal Ring 1 & 2 secara langsung. Komunikasi wajib lewat Syscall.

## 🔴 Ring 4: Applications & Config (The User-Land)
Area terluar di mana aplikasi user dan konfigurasi berada. Ini adalah area paling aman untuk berekspresi.
- **Komponen**:
    - Semua aplikasi di `/bin/` (Shell, ls, chown, airtermd, dll)
- **Konfigurasi**: `sysconfig.json`
- **Entry Point**: `main.ts`
- **Aturan**: Jika aplikasi di sini crash, sistem utama (Ring 1) harus tetap berjalan normal.

---

## Ring Comparison Policy

| Fitur | Linux Equivalent | TSIX Ring |
| :--- | :--- | :--- |
| Core OS Logic | Ring 0 (Kernel Mode) | **Ring 1** |
| Drivers & FS | Ring 0 (Kernel Mode) | **Ring 2** |
| Standard Library | Ring 3 (glibc) | **Ring 3** |
| User Apps | Ring 3 (User Mode) | **Ring 4** |

---

> **"Everything is a File, and every file belongs to a Ring — sebuah prinsip UNIX yang telah bertahan lebih dari 50 tahun karena ia benar."** 🚀🤖
