import { describe, expect, it, vi } from "vitest";
import {
  TIndicatorLamp,
  TLineChart,
  TProgressBar,
  TRadialGauge,
  TRelayCard,
  TSensorCard,
  TSevenSegment,
  TToggleSwitch,
  TVerticalGauge,
} from "@tsix/pistachio";

function createPort() {
  return {
    mount: vi.fn(async (_node: unknown, _parentId?: string) => {}),
    update: vi.fn(async (_targetId: string, _props: Record<string, unknown>) => {}),
    on: vi.fn(
      (_targetId: string, _event: string, _cb: (ev?: any) => void): void => {},
    ),
    off: vi.fn((_targetId: string) => {}),
    unmount: vi.fn(async (_targetId: string) => {}),
  };
}

function handlerFor(port: ReturnType<typeof createPort>, id: string) {
  const call = port.on.mock.calls.find(([target]) => target === id);
  if (!call) throw new Error(`no handler for ${id}`);
  return call[2] as () => void;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TProgressBar", () => {
  it("clamps its value and updates only the fill", () => {
    const bar = new TProgressBar({ id: "bar", value: 40 });
    const port = createPort();
    bar.bindEventHandler(port);

    expect(bar.build().children[0].props.style.width).toBe("40%");

    bar.value = 140;
    expect(bar.value).toBe(100);
    expect(port.update).toHaveBeenLastCalledWith("bar_fill", {
      style: { width: "100%" },
    });

    bar.value = -5;
    expect(bar.value).toBe(0);
  });
});

describe("TViewWidget", () => {
  it("TIndicatorLamp remounts its view when toggled", async () => {
    const lamp = new TIndicatorLamp({ id: "lamp", on: false });
    const port = createPort();
    const viewId = lamp.build().children[0].id;
    lamp.bindEventHandler(port);

    lamp.on = true;
    await flush();

    expect(port.unmount).toHaveBeenCalledWith(viewId);
    expect(port.mount).toHaveBeenCalledWith(
      expect.objectContaining({ id: viewId }),
      "lamp",
    );
  });

  it("TToggleSwitch toggles on click and reports the new state", async () => {
    const toggle = new TToggleSwitch({ id: "tgl", on: false, label: "Lampu" });
    const port = createPort();
    toggle.build();
    toggle.bindEventHandler(port);
    const onClick = vi.fn();
    toggle.onClick = onClick;

    handlerFor(port, "ts-tgl")();
    await flush();

    expect(toggle.on).toBe(true);
    expect(onClick).toHaveBeenCalledWith(true);
    expect(port.mount).toHaveBeenCalled();
  });

  it("TRelayCard toggles active state and reports it", async () => {
    const relay = new TRelayCard({ id: "relay", label: "FAN" });
    const port = createPort();
    relay.build();
    relay.bindEventHandler(port);
    const onToggle = vi.fn();
    relay.onToggle = onToggle;

    handlerFor(port, "rc-relay")();
    await flush();

    expect(relay.active).toBe(true);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("TSensorCard remounts when the value changes", async () => {
    const card = new TSensorCard({ id: "suhu", label: "Suhu", unit: "°C" });
    const port = createPort();
    const viewId = card.build().children[0].id;
    card.bindEventHandler(port);

    card.value = 27.5;
    await flush();

    expect(card.value).toBe(27.5);
    expect(port.unmount).toHaveBeenCalledWith(viewId);
  });

  it("TLineChart stores new series and rerenders", async () => {
    const chart = new TLineChart({ id: "chart", data: [1, 2, 3] });
    const port = createPort();
    chart.build();
    chart.bindEventHandler(port);

    await chart.setData([4, 5, 6]);

    expect(chart.data).toEqual([4, 5, 6]);
    expect(port.mount).toHaveBeenCalledTimes(1);
  });

  it("TRadialGauge rerenders on value change", async () => {
    const gauge = new TRadialGauge({ id: "gauge", value: 10, max: 50 });
    const port = createPort();
    gauge.build();
    gauge.bindEventHandler(port);

    gauge.value = 25;
    await flush();

    expect(gauge.value).toBe(25);
    expect(port.mount).toHaveBeenCalledTimes(1);
  });

  it("TSevenSegment and TVerticalGauge keep their ranges", async () => {
    const seg = new TSevenSegment({ id: "seg", value: 12, digits: 4 });
    const port = createPort();
    seg.build();
    seg.bindEventHandler(port);
    seg.value = 34;
    await flush();
    expect(seg.value).toBe(34);

    const vertical = new TVerticalGauge({ id: "vg", value: 150 });
    expect(vertical.value).toBe(100);
    vertical.value = -20;
    expect(vertical.value).toBe(0);
  });
});

describe("card footprint", () => {
  it("gives lamp, switch, relay, sensor, and gauge the same size", () => {
    const cards = [
      new TIndicatorLamp("lamp"),
      new TToggleSwitch("tgl"),
      new TRelayCard("relay"),
      new TSensorCard("sensor"),
      new TRadialGauge("gauge"),
    ];

    const sizes = cards.map(
      (card) => `${card.style.width}x${card.style.height}`,
    );
    expect(new Set(sizes).size).toBe(1);
    expect(cards[0].style.width).toBe("132px");
    expect(cards[0].style.height).toBe("156px");
  });

  it("stretches the emerald view to fill the card", () => {
    const lamp = new TIndicatorLamp("lamp");
    const view = lamp.build().children[0];

    expect(view.props.style.width).toBe("100%");
    expect(view.props.style.height).toBe("100%");
    expect(view.props.style.minWidth).toBe("0");
  });

  it("lets apps override the card size through style", () => {
    const lamp = new TIndicatorLamp({
      id: "lamp",
      style: { width: "200px", height: "90px" },
    });

    expect(lamp.style.width).toBe("200px");
    expect(lamp.style.height).toBe("90px");
  });
});
