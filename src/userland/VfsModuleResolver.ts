/**
 * VFS MODULE RESOLVER — resolusi import RELATIF (`./x`, `../y`) untuk program VFS
 *
 * MASALAH YANG DIPECAHKAN
 * -----------------------
 * Program userland dijalankan lewat jalur "Direct Memory Execution": Kernel
 * mengirim isi file sebagai `appContent`, lalu WorkerEntry men-_compile()-nya.
 * Akibatnya `require("./TpkgProtocol")` dari `/sbin/tpkgd.ts` mencari
 * `/sbin/TpkgProtocol` di **host filesystem** — padahal file itu ada di VFS
 * (BKFS). Hasilnya:
 *
 *     [Worker 35] Direct Execution Error: Cannot find module './TpkgProtocol'
 *
 * Sebelum ini hanya import ber-alias (`@tsix/*`, `@common/*`) dan `../lib/*`
 * yang jalan, karena keduanya dilayani cache framework di memory. Import
 * **sesama direktori** dulu memang tidak didukung — file harus dipindah ke
 * `/lib` supaya bisa diimpor. Sekarang tidak perlu lagi.
 *
 * CARA KERJA
 * ----------
 * `Module._load` bersifat SINKRON, sedangkan pembacaan VFS lewat syscall
 * bersifat ASINKRON — jadi tidak mungkin membaca file saat `require` berjalan.
 * Karena itu modul relatif dikumpulkan LEBIH DULU di `main()` (yang async):
 * telusuri import relatif dari isi program, resolve ke path VFS, baca
 * (fs.readFile), transitif, lalu simpan sebagai peta `id → kode ter-transpile`.
 * Hook `require` tinggal melihat peta itu — tanpa I/O, tanpa syscall.
 *
 * File ini SENGAJA BEBAS EFEK SAMPING (tidak menyentuh `Module._load`, tidak
 * memasang handler proses) supaya bisa di-unit-test langsung; WorkerEntry.ts
 * yang menyambungkannya ke loader sungguhan.
 *
 * (c) 2026 TSIX Project
 */

/** Batas jumlah modul relatif per program — pagar agar tidak menelusuri liar. */
export const MAX_RELATIVE_MODULES = 64;

/**
 * vfsCandidates(): Path VFS yang dicoba untuk sebuah module-id tanpa ekstensi.
 *
 * Urutan `.ts` sebelum `.js` — berbeda dari EXEC/PATH yang mengutamakan `.js`.
 * Alasannya: sidecar `.js` adalah hasil transpile dari `.ts`, dan saat program
 * baru saja di-update, `.js`-nya justru yang tertinggal (belum di-rebuild).
 * Untuk *modul pendamping* kita ingin definisi sumbernya.
 */
export function vfsCandidates(base: string): string[] {
    return [`${base}.ts`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`];
}

/**
 * resolveVfsRelative(): Terjemahkan request relatif jadi path VFS absolut.
 *
 *   ("/sbin/tpkgd.ts",    "./TpkgProtocol") → "/sbin/TpkgProtocol"
 *   ("/sbin/tpkgd.ts",    "../lib/util")    → "/lib/util"
 *   ("/opt/app/main.ts",  "../common/x")    → "/opt/common/x"
 *
 * Return `null` kalau hasilnya keluar dari root (`..` melewati `/`) — pemanggil
 * memperlakukannya sebagai "bukan modul VFS" dan membiarkan Node menyelesaikannya.
 *
 * Perhatikan: `../` yang MENEMBUS root memang `null`, bukan dipangkas ke root.
 * Modul framework tetap bisa diimpor karena WorkerEntry memetakan request apa
 * pun yang memuat `/common/` → `@common/*` dan `/lib/` → `@tsix/*`, keduanya
 * dilayani `vfsCache` (kernel mem-precompile seluruh `/lib`). Jadi
 * `("/lib/UserLib", "../../common/SyscallCode")` di sini = null, dan request-nya
 * ditangani jalur alias — bukan dibaca sebagai `/common/SyscallCode`.
 */
export function resolveVfsRelative(baseVfsFile: string, request: string): string | null {
    if (typeof baseVfsFile !== "string" || typeof request !== "string") return null;
    if (!request.startsWith(".")) return null;

    // Segmen kosong akibat '/' di depan SUDAH dibuang di sini. Dulu segmen itu
    // ikut dihitung sebagai direktori, sehingga `..` masih bisa "pop" ketika
    // pemanggil sudah berada di root dan hasilnya menempel ke root:
    //
    //   ("/lib/UserLib", "../../common/SyscallCode") → "/common/SyscallCode"  ❌
    //
    // `/common/**` tidak ada di VFS (`common` hidup di `/lib/common`), jadi
    // pembaca VFS melempar `File not found: /common/SyscallCode.ts` — dan karena
    // itu terjadi di tengah pemindaian, SELURUH modul relatif program ikut batal
    // (`Local module scan failed`).
    const segments = baseVfsFile
        .replace(/\\/g, "/")
        .split("/")
        .filter((s) => s !== "");
    segments.pop(); // buang nama file → tinggal direktori

    for (const seg of request.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") {
            // Sudah di root dan masih minta naik → di luar VFS.
            if (segments.length === 0) return null;
            segments.pop();
            continue;
        }
        segments.push(seg);
    }

    return segments.length === 0 ? null : "/" + segments.join("/");
}

/**
 * findRelativeImports(): Cari request relatif yang TERTULIS STATIS di kode.
 *
 * Menangkap bentuk yang lazim dipakai di userland:
 *   `import x from "./a"` · `export { x } from "./b"` · `require("./c")`
 *   `import("./d")` (dynamic tapi literal) · `require("../e.ts")` (dengan ekstensi)
 *
 * Yang TIDAK tertangkap: request yang dibentuk dari variabel
 * (`require("./" + name)`) — memang tidak bisa dianalisis statis; untuk kasus
 * itu perilakunya sama seperti sebelum fitur ini ada (error jelas, bukan diam).
 */
export function findRelativeImports(source: string): string[] {
    if (typeof source !== "string" || source.length === 0) return [];
    const out = new Set<string>();
    // `from "..."` menangkap import/export; `require(` dan `import(` eksplisit.
    const re = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)["'](\.[^"']*)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
        const req = m[1].replace(/\.(ts|js)$/, ""); // id selalu tanpa ekstensi
        out.add(req);
    }
    return [...out];
}

/** Opsi `collectRelativeModules()` — semua I/O & transpile disuntikkan. */
export interface CollectOptions {
    /** Module-id entry, mis. "/sbin/tpkgd" (tanpa ekstensi). */
    entryId: string;
    /** Isi sumber entry (TS/JS apa adanya). */
    source: string;
    /**
     * Pembaca VFS. Kontraknya: return null kalau file tidak ada. Pembaca yang
     * MELEMPAR untuk file tidak ada (seperti `lib.fs.readFile` asli) tetap
     * ditoleransi — lihat `readMaybe()` di `collectRelativeModules`.
     */
    readFile: (vfsPath: string) => Promise<string | null>;
    /** Transpile sumber → JS (CJS). Dipanggil untuk file `.ts` saja. */
    transpile: (source: string, moduleId: string) => string;
    /** Pagar jumlah modul (default `MAX_RELATIVE_MODULES`). */
    maxFiles?: number;
}

/**
 * collectRelativeModules(): Telusuri closure import relatif dari sebuah program.
 *
 * Hasilnya peta `module-id → kode JS`, dipakai hook `require` di WorkerEntry.
 * Entry sendiri TIDAK dimasukkan (sudah di-compile jalur program).
 *
 * Dependensi yang disuntikkan membuat fungsi ini bisa diuji tanpa VFS, tanpa
 * worker, dan tanpa esbuild — sekaligus menjaga `WorkerEntry.ts` tetap tipis.
 */
export async function collectRelativeModules(opts: CollectOptions): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const limit = opts.maxFiles ?? MAX_RELATIVE_MODULES;
    const seen = new Set<string>([opts.entryId]);
    const queue: Array<{ id: string; source: string }> = [{ id: opts.entryId, source: opts.source }];

    /**
     * Baca calon path dengan TOLERAN GAGAL.
     *
     * Kontrak `opts.readFile` bilang "return null kalau file tidak ada", tapi
     * pembaca VFS yang asli (`lib.fs.readFile` di dalam worker) justru MELEMPAR
     * `File not found: <path>` — syscall OPEN menolak file yang tidak ada untuk
     * flag `r` (lihat `wiki/file-operation.md`). Karena kandidat selalu diuji
     * berurutan (`.ts` → `.js` → `index.*`), satu kandidat yang tidak ada DULU
     * dulu membatalkan seluruh pemindaian: program lalu kehilangan SEMUA modul
     * sesama direktori hanya karena satu import opsional/typo.
     */
    const readMaybe = async (vfsPath: string): Promise<string | null> => {
        try {
            return await opts.readFile(vfsPath);
        } catch {
            return null;
        }
    };

    while (queue.length > 0) {
        const current = queue.shift()!;

        for (const request of findRelativeImports(current.source)) {
            // Pagar diperiksa DI DALAM loop: satu file bisa punya puluhan import,
            // jadi cek di kondisi `while` saja tidak cukup untuk membatasi.
            if (seen.size > limit) break;

            const base = resolveVfsRelative(current.id, request);
            if (!base || seen.has(base)) continue;

            let found: string | null = null;
            let raw = "";
            for (const candidate of vfsCandidates(base)) {
                const content = await readMaybe(candidate);
                if (typeof content === "string") {
                    found = candidate;
                    raw = content;
                    break;
                }
            }
            // Tidak ketemu → biarkan jalur lama (Node) yang menangani.
            if (!found) continue;

            seen.add(base);
            out[base] = found.endsWith(".js") ? raw : opts.transpile(raw, base);
            // Telusuri import relatif milik modul ini juga (kedalaman bebas).
            queue.push({ id: base, source: raw });
        }
    }

    return out;
}
