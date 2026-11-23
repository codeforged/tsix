import { describe, expect, it } from "vitest";
import type { TScreenPort } from "./core";
import { TLineChart, TToggleSwitch } from "./widgets";

describe("Pistachio widget state handling", () => {
  it("reports the requested state without rendering an optimistic state", () => {
    const handlers = new Map<string, (event: unknown) => void>();
    let mounts = 0;
    let unmounts = 0;
    const host: TScreenPort = {
      mount: async () => {
        mounts++;
      },
      update: async () => {},
      on: (id, event, callback) => {
        if (event === "click") handlers.set(id, callback);
      },
      off: () => {},
      unmount: async () => {
        unmounts++;
      },
    };
    const toggle = new TToggleSwitch({
      id: "controlled-switch",
      on: false,
      controlled: true,
    });
    const requestedStates: boolean[] = [];
    const toggleViewId = toggle.build().children[0].id;

    toggle.onChange = (state) => requestedStates.push(state);
    toggle.bindEventHandler(host);
    handlers.get("ts-controlled-switch")?.({});

    expect(requestedStates).toEqual([true]);
    expect(toggleViewId).toBe("ts-controlled-switch");
    expect(toggle.on).toBe(false);
    expect(mounts).toBe(0);
    expect(unmounts).toBe(0);
  });

  it("serializes chart rerenders and skips unchanged data", async () => {
    let activeOperations = 0;
    let maxActiveOperations = 0;
    let mounts = 0;
    const mountedParents: Array<string | undefined> = [];
    const unmountedIds: string[] = [];
    const delay = async () => {
      activeOperations++;
      maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      activeOperations--;
    };
    const host: TScreenPort = {
      mount: async (_node, parentId) => {
        mounts++;
        mountedParents.push(parentId);
        await delay();
      },
      update: async () => {},
      on: () => {},
      unmount: async (targetId) => {
        unmountedIds.push(targetId);
        await delay();
      },
    };
    const chart = new TLineChart({ id: "queued-chart" });
    chart.bindEventHandler(host);
    const tree = chart.build();
    const viewId = tree.children[0].id;

    await chart.setData([1]);
    await Promise.all([
      chart.setData([2]),
      chart.setData([3]),
      chart.setData([4]),
    ]);

    expect(maxActiveOperations).toBe(1);
    expect(chart.data).toEqual([4]);
    expect(viewId).not.toBe(chart.id);
    expect(unmountedIds).toEqual([viewId, viewId, viewId, viewId]);
    expect(mountedParents).toEqual([
      chart.id,
      chart.id,
      chart.id,
      chart.id,
    ]);
    const mountCount = mounts;
    await chart.setData([4]);
    expect(mounts).toBe(mountCount);
  });

  it("hides both axis labels and expands the plot area", () => {
    const chart = new TLineChart({
      id: "chart-without-x-labels",
      data: [1, 2],
      width: 240,
      height: 82,
      showXAxisLabels: false,
      showYAxisLabels: false,
    });
    const view = chart.build().children[0];
    const svg = view.children.find((child) => typeof child.props.innerHTML === "string")
      ?.props.innerHTML;

    expect(svg).not.toContain('text-anchor="end"');
    expect(svg).not.toContain('text-anchor="middle"');
    expect(svg).toContain('<rect x="12" y="20" width="216" height="52"/>');
  });
});
