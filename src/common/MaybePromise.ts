/**
 * MaybePromise<T>
 *
 * Nilai yang boleh tersedia SINKRON atau lewat Promise.
 *
 * Dipakai di kontrak `IVFS` supaya backend yang murni lokal (VFS, BKFS,
 * HostVFS, RamFS) dan backend yang butuh I/O jaringan (NetFS) bisa memakai
 * interface yang sama:
 *
 *   - Driver lokal  : `ls()` → `any[]`            (sinkron, apa adanya)
 *   - Driver network: `ls()` → `Promise<any[]>`   (nunggu balasan SL)
 *
 * Pemakai (kernel) SELALU `await` hasilnya. `await` pada nilai sinkron hanya
 * mengembalikan nilai itu apa adanya, jadi biaya transisinya nol dan driver
 * lama tidak perlu diubah sama sekali.
 *
 * (c) 2026 TSIX Project
 */
export type MaybePromise<T> = T | Promise<T>;
