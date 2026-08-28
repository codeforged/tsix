/**
 * SYSCALL CODE
 * 
 * Daftar kode syscall yang disepakati antara User-land dan Kernel.
 */
export enum SyscallCode {
    PRINT = 1,    // Mencetak teks ke layar
    MKDIR = 2,    // Membuat folder
    LS = 3,       // Melihat isi folder
    EXIT = 4,     // Mematikan proses
    OPEN = 5,     // Membuka file (Dapat FD)
    READ = 6,     // Membaca file lewat FD
    WRITE = 7,    // Menulis ke file lewat FD
    CLOSE = 8,    // Menutup FD 
    SCREEN_INFO = 9, // Mendapatkan info layar ($LINES, $COLUMNS)
    PS = 10,      // Melihat daftar proses
    KILL = 11,    // Menghentikan proses berdasarkan PID
    EXEC = 12,    // Melakukan eksekusi binary berdasarkan Path
    CHDIR = 13,   // Mengubah direktori kerja proses
    GETCWD = 14,  // Mendapatkan direktori kerja saat ini
    CHMOD = 15,   // Mengubah permission file
    CHOWN = 16,   // Mengubah kepemilikan file
    WHOAMI = 17,  // Mendapatkan info user saat ini
    GETENV = 18,  // Mendapatkan environment variable
    SETENV = 19,  // Menetapkan environment variable
    STAT = 20,     // Mendapatkan info file
    UNLINK = 21,   // Menghapus file
    RMDIR = 22,    // Menghapus direktori kosong
    IOCTL = 23,    // Control Device (e.g. Set Raw Mode)
    SEND_MSG = 24, // Horizontal IPC (App-to-App)
    WAITPID = 25,  // Menunggu proses selesai berdasarkan PID
    SIGNAL = 26,   // Mengirim signal ke proses (e.g. SIGKILL, SIGTERM)
    SETUID = 27,   // Mengubah User ID (Hanya untuk root)
    SETGID = 28,   // Mengubah Group ID (Hanya untuk root)
    PIPE = 29,     // Membuat pipe (FIFO)
    UPTIME = 35,   // Mendapatkan waktu aktif sistem
    SETGROUPS = 38, // Menetapkan supplementary groups (Hanya untuk root)

    // --- NETWORKING (MQTNL) ---
    SOCKET = 30,
    BIND = 31,
    SENDTO = 32,
    RECVFROM = 33,
    NETSTAT = 34,

    // --- SYSTEM CONTROL ---
    SHUTDOWN = 50,
    DETACH = 36,
    UNAME = 37,
    SYNC_TO_HOST = 53,
    REEXEC = 54,
    SYNC_FROM_HOST = 55,
    MOUNT = 56,
    UMOUNT = 57,
    GET_MOUNTS = 58,
    GET_SYSPATH = 40, // Mendapatkan mapping path host dari VFS path
    GET_USAGE = 41,   // Mendapatkan statistik penggunaan disk (size, files, dirs)

    SET_IDENTITY = 60, // Menetapkan UUID permanen untuk aplikasi (Well-known Identity)
    GUI_REQ = 61,      // PixelSpace Display Protocol (RFC-TSIX-002)
    GET_PPID = 62,     // Mendapatkan parent PID dari proses saat ini

    // --- CHUNKED I/O (Progress-aware file operations) ---
    READ_CHUNK = 63,   // Membaca sebagian konten file (path, offset, length)
    WRITE_CHUNK = 64,  // Menulis sebagian konten file (path, chunk, offset)
    GET_SIZE = 65,     // Mendapatkan ukuran file dalam byte
    REPARENT = 66,     // Mengubah parent PID suatu proses (pid, newPpid)

    // --- DATABASE (DbLib → device/service transport) ---
    DB_CONNECT = 67,     // Membuka koneksi database eksternal (cfg {host,user,password,database})
    DB_QUERY = 68,       // Eksekusi SQL (SELECT → rows, INSERT/UPDATE/DELETE → ResultSetHeader)
    DB_DISCONNECT = 69,  // Menutup koneksi database
    DB_SERVICE_REGISTER = 70,  // Daemon DB mendaftarkan diri sebagai transport service (kernel route DB_* ke daemon)
    DB_SERVICE_REPLY = 71,     // Daemon DB mengirim hasil request kembali ke kernel (requestId, result)

    // --- NETWORK SNIFFER (bitshark, ala Wireshark) ---
    NET_SNIFFER_REGISTER = 72,   // Daftarkan proses sebagai sniffer interface (args: interfaceName | "*")
    NET_SNIFFER_UNREGISTER = 73, // Hentikan sniffing (args: interfaceName | "*")

    // --- PSEUDO TERMINAL (PTY, on-demand) ---
    PTY_ALLOC = 74,   // Alokasi PTY baru (args: optional {rows,cols}) → { id, slavePath }
    PTY_FREE = 75,    // Bebaskan PTY (args: id)
}


