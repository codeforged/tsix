import { describe, it, expect, vi } from "vitest";
import { ConnectedDataGrid } from "./emerald";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("ConnectedDataGrid", () => {
  it("keeps the latest data order when renders overlap", async () => {
    const firstRenderGate = deferred<void>();
    const secondRenderGate = deferred<void>();
    const appliedSnapshots: string[][] = [];

    const screen = {
      setContent: vi.fn(async (_containerId: string, ...children: any[]) => {
        const snapshot = children.map((row: any) => row.children?.[0]?.props?.text ?? "");
        appliedSnapshots.push(snapshot);

        if (snapshot[0] === "1") {
          await firstRenderGate.promise;
        } else {
          await secondRenderGate.promise;
        }
      }),
      setText: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      win: {
        bindHandler: vi.fn(),
      },
    };

    const grid = new ConnectedDataGrid({
      id: "grid-test",
      columns: [{ key: "no", label: "No" }],
      data: [{ no: 1 }],
    });

    (grid as any).screen = screen;

    const firstRenderPromise = (grid as any).render();
    await Promise.resolve();

    const secondRenderPromise = grid.setData([{ no: 2 }]);
    await Promise.resolve();

    secondRenderGate.resolve();
    await Promise.resolve();
    firstRenderGate.resolve();

    await Promise.all([firstRenderPromise, secondRenderPromise]);

    expect(appliedSnapshots[appliedSnapshots.length - 1]).toEqual(["2"]);
  });
});
