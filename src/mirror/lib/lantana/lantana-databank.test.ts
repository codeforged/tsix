/**
 * lantana-databank.test.ts — Idempotensi dan backpressure antrean DataBank.
 */

import { describe, it, expect } from "vitest";
import { DataBankQueue, MemoryDataBank } from "./lantana-databank";
import { AcceptedReading } from "./lantana-core";

function reading(id: string, schemeId = 101): AcceptedReading {
    return {
        readingId: id,
        accountId: "acc",
        deviceId: "dev",
        schemeId,
        value: 25,
        label: "Suhu",
        unit: "°C",
        receivedAt: 1000,
    };
}

describe("MemoryDataBank", () => {
    it("menyimpan bacaan dan mengabaikan readingId duplikat", async () => {
        const sink = new MemoryDataBank();
        await sink.submit([reading("r1"), reading("r1"), reading("r2")]);
        expect(sink.size).toBe(2);
    });
});

describe("DataBankQueue", () => {
    it("mengirim antrean ke sink saat drain", async () => {
        const sink = new MemoryDataBank();
        const queue = new DataBankQueue(sink);

        const res = await queue.submit([reading("r1")]);
        expect(res.ok).toBe(true);
        expect(queue.pending).toBe(1);
        expect(sink.size).toBe(0);

        await queue.drain();
        expect(queue.pending).toBe(0);
        expect(sink.size).toBe(1);
    });

    it("idempoten: submit ulang readingId yang sudah terkirim tidak menggandakan", async () => {
        const sink = new MemoryDataBank();
        const queue = new DataBankQueue(sink);

        await queue.submit([reading("r1")]);
        await queue.drain();
        const again = await queue.submit([reading("r1")]);
        await queue.drain();

        expect(again.stored).toBe(0);
        expect(sink.size).toBe(1);
    });

    it("menolak submit saat antrean penuh (backpressure, bukan drop)", async () => {
        const queue = new DataBankQueue(new MemoryDataBank(), { capacity: 2 });

        expect((await queue.submit([reading("r1"), reading("r2")])).ok).toBe(true);
        const overflow = await queue.submit([reading("r3")]);
        expect(overflow.ok).toBe(false);
        expect(overflow.error).toBe("DATABANK_QUEUE_FULL");
        expect(queue.pending).toBe(2);
    });

    it("mempertahankan antrean bila sink gagal", async () => {
        const failing = { submit: async () => ({ ok: false, error: "down" }) };
        const queue = new DataBankQueue(failing);

        await queue.submit([reading("r1")]);
        const res = await queue.drain();
        expect(res.ok).toBe(false);
        expect(queue.pending).toBe(1);
    });
});
