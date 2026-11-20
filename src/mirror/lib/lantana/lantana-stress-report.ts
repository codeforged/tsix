export interface DeliverySummary {
    sentBatches: number;
    ingestObservedBatches: number;
    nacks: number;
    estimatedUnconfirmedBatches: number;
    overObservedBatches: number;
    ingestObservedPercent: number;
}

export function summarizeDelivery(
    sentBatches: number,
    ingestObservedBatches: number,
    nacks: number,
): DeliverySummary {
    const resolvedBatches = ingestObservedBatches + nacks;
    return {
        sentBatches,
        ingestObservedBatches,
        nacks,
        estimatedUnconfirmedBatches: Math.max(0, sentBatches - resolvedBatches),
        overObservedBatches: Math.max(0, resolvedBatches - sentBatches),
        ingestObservedPercent: sentBatches
            ? Number(((ingestObservedBatches / sentBatches) * 100).toFixed(1))
            : 0,
    };
}
