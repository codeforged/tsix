import { describe, expect, it } from "vitest";
import { summarizeDelivery } from "./lantana-stress-report";

describe("summarizeDelivery", () => {
    it("reports observed rate and unconfirmed batches separately from NACKs", () => {
        expect(summarizeDelivery(100, 80, 5)).toEqual({
            sentBatches: 100,
            ingestObservedBatches: 80,
            nacks: 5,
            estimatedUnconfirmedBatches: 15,
            overObservedBatches: 0,
            ingestObservedPercent: 80,
        });
    });

    it("handles empty runs and never reports a negative unconfirmed count", () => {
        expect(summarizeDelivery(0, 0, 0).ingestObservedPercent).toBe(0);
        expect(summarizeDelivery(10, 12, 0)).toMatchObject({
            estimatedUnconfirmedBatches: 0,
            overObservedBatches: 2,
        });
    });
});
