/**
 * lantana-databank.ts — Batas integrasi ke DataBank eksternal.
 *
 * DataBank adalah aplikasi/layanan terpisah. Lantana hanya mengirim data yang
 * sudah terautentikasi, terotorisasi, dan tervalidasi — tanpa AccessKey.
 *
 * Kontrak V2:
 *  - submit idempoten berdasarkan `readingId`.
 *  - antrean berbatas; bila penuh, submit gagal (pemanggil mengembalikan NACK)
 *    agar tidak ada data yang dibuang diam-diam.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { AcceptedReading } from "@tsix/lantana/lantana-core";

export interface DataBankResult {
    ok: boolean;
    error?: string;
    /** Jumlah bacaan yang benar-benar diterima (setelah dedup). */
    stored?: number;
}

export interface DataBankSink {
    submit(readings: AcceptedReading[]): Promise<DataBankResult>;
}

export class DataBankError extends Error {}

/**
 * Implementasi in-memory — dipakai untuk pengembangan dan test.
 * DataBank produksi cukup mengimplementasikan `DataBankSink`.
 */
export class MemoryDataBank implements DataBankSink {
    private stored: AcceptedReading[] = [];
    private seen: Set<string> = new Set();

    async submit(readings: AcceptedReading[]): Promise<DataBankResult> {
        let count = 0;
        for (const reading of readings) {
            if (this.seen.has(reading.readingId)) continue;
            this.seen.add(reading.readingId);
            this.stored.push(reading);
            count++;
        }
        return { ok: true, stored: count };
    }

    all(): AcceptedReading[] {
        return this.stored.slice();
    }

    get size(): number {
        return this.stored.length;
    }
}

export interface QueueOptions {
    capacity?: number;
}

/**
 * Antrean berbatas di depan sink DataBank.
 *
 * `submit()` menerima bacaan (dedup by readingId), lalu `drain()` mengirimkannya
 * ke sink. Bila antrean penuh, submit langsung gagal sehingga listener dapat
 * menjawab NACK DATABANK_UNAVAILABLE alih-alih membuang data diam-diam.
 */
export class DataBankQueue implements DataBankSink {
    private queue: AcceptedReading[] = [];
    private queuedIds: Set<string> = new Set();
    private deliveredIds: Set<string> = new Set();
    private capacity: number;

    constructor(
        private sink: DataBankSink,
        options: QueueOptions = {},
    ) {
        this.capacity = Math.max(1, options.capacity ?? 4096);
    }

    get pending(): number {
        return this.queue.length;
    }

    async submit(readings: AcceptedReading[]): Promise<DataBankResult> {
        const fresh = readings.filter(
            (r) => !this.queuedIds.has(r.readingId) && !this.deliveredIds.has(r.readingId),
        );
        if (fresh.length === 0) return { ok: true, stored: 0 };

        if (this.queue.length + fresh.length > this.capacity) {
            return { ok: false, error: "DATABANK_QUEUE_FULL" };
        }

        for (const reading of fresh) {
            this.queue.push(reading);
            this.queuedIds.add(reading.readingId);
        }
        return { ok: true, stored: fresh.length };
    }

    /** Kirim isi antrean ke sink. Bacaan yang gagal tetap di antrean. */
    async drain(): Promise<DataBankResult> {
        if (this.queue.length === 0) return { ok: true, stored: 0 };

        const batch = this.queue.slice();
        const result = await this.sink.submit(batch);

        if (!result.ok) {
            return { ok: false, error: result.error || "DATABANK_UNAVAILABLE" };
        }

        for (const reading of batch) {
            this.queuedIds.delete(reading.readingId);
            this.deliveredIds.add(reading.readingId);
        }
        this.queue = [];

        // Batasi memori dedup agar tidak tumbuh tanpa batas.
        if (this.deliveredIds.size > 50_000) {
            this.deliveredIds = new Set(Array.from(this.deliveredIds).slice(-20_000));
        }
        return { ok: true, stored: result.stored ?? batch.length };
    }
}

export const DRAIN_REPORT_INTERVAL_MS = 60_000;

/**
 * Ringkas hasil `drain()` berulang menjadi log yang tidak membanjiri: satu
 * baris saat mulai gagal, ringkasan berkala selama masih gagal, dan satu baris
 * saat pulih. Mengembalikan pesan yang perlu dicatat, atau null.
 */
export class DrainReporter {
    private failingSince: number | null = null;
    private lastReportAt = 0;
    private failures = 0;

    constructor(private intervalMs: number = DRAIN_REPORT_INTERVAL_MS) {}

    report(result: DataBankResult, pending: number, now: number = Date.now()): string | null {
        if (result.ok) {
            if (this.failingSince === null) return null;
            const downSec = Math.round((now - this.failingSince) / 1000);
            const failures = this.failures;
            this.failingSince = null;
            this.failures = 0;
            return `DataBank pulih setelah ${downSec} detik (${failures} percobaan gagal); antrean ${pending}.`;
        }

        this.failures++;
        if (this.failingSince === null) {
            this.failingSince = now;
            this.lastReportAt = now;
            return `DataBank belum menerima data (${result.error}); antrean ${pending}.`;
        }
        if (now - this.lastReportAt >= this.intervalMs) {
            this.lastReportAt = now;
            const downSec = Math.round((now - this.failingSince) / 1000);
            return `DataBank masih gagal ${downSec} detik (${result.error}, ${this.failures} percobaan); antrean ${pending}.`;
        }
        return null;
    }
}
