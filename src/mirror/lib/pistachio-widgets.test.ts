import { describe, expect, it, vi } from "vitest";
import {
  TIndicatorLamp,
  TLineChart,
  TProgressBar,
  TRadialGauge,
  TRelayCard,
  TSensorCard,
  TSevenSegment,
  TSlider,
  TStatusBar,
  TImage,
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
  return call[2] as (ev?: any) => void;
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
    const toggle = new TToggleSwitch({ id: "tgl", on: false, caption: "Lampu" });
    const port = createPort();
    toggle.build();
    toggle.bindEventHandler(port);
    const onChange = vi.fn();
    toggle.onChange = onChange;

    handlerFor(port, "ts-tgl")();
    await flush();

    expect(toggle.on).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(port.mount).toHaveBeenCalled();
  });

  it("TRelayCard toggles active state and reports it", async () => {
    const relay = new TRelayCard({ id: "relay", caption: "FAN" });
    const port = createPort();
    relay.build();
    relay.bindEventHandler(port);
    const onChange = vi.fn();
    relay.onChange = onChange;

    handlerFor(port, "rc-relay")();
    await flush();

    expect(relay.active).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("TSensorCard remounts when the value changes", async () => {
    const card = new TSensorCard({ id: "suhu", caption: "Suhu", unit: "°C" });
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
    expect(lamp.style.minWidth).toBe("200px");
  });

  it("keeps a smaller custom width from being overridden by minWidth", () => {
    const lamp = new TIndicatorLamp({
      id: "lamp",
      style: { width: "100px" },
    });

    expect(lamp.style.width).toBe("100px");
    expect(lamp.style.minWidth).toBe("100px");
  });

  it("centers card content vertically", () => {
    const lamp = new TIndicatorLamp("lamp");
    const view = lamp.build().children[0];

    expect(view.props.style.display).toBe("flex");
    expect(view.props.style.flexDirection).toBe("column");
    expect(view.props.style.justifyContent).toBe("center");
    expect(view.props.style.alignItems).toBe("stretch");
  });
});

describe("TStatusBar", () => {
  it("renders both sides and updates them live", () => {
    const bar = new TStatusBar({
      id: "sb",
      leftText: "Siap",
      rightText: "0 item",
    });
    const port = createPort();
    bar.bindEventHandler(port);

    expect(bar.build().children.map((child) => child.props.text)).toEqual([
      "Siap",
      "0 item",
    ]);

    bar.leftText = "Memuat";
    bar.rightText = "5 item";

    expect(port.update).toHaveBeenCalledWith("sb_left", { text: "Memuat" });
    expect(port.update).toHaveBeenCalledWith("sb_right", { text: "5 item" });
  });
});

describe("TSlider", () => {
  it("clamps input, refreshes the display, and reports changes", () => {
    const sliderWidget = new TSlider({
      id: "sl",
      min: 0,
      max: 100,
      unit: "%",
      value: 40,
    });
    const port = createPort();
    sliderWidget.build();
    sliderWidget.bindEventHandler(port);
    const onInput = vi.fn();
    sliderWidget.onInput = onInput;

    handlerFor(port, "sl-input-sl")({ value: "120" });

    expect(sliderWidget.value).toBe(100);
    expect(port.update).toHaveBeenCalledWith("sl-val-sl", { text: "100%" });
    expect(onInput).toHaveBeenCalledWith(100);
  });

  it("rerenders when the value is set programmatically", async () => {
    const sliderWidget = new TSlider({ id: "sl", value: 10 });
    const port = createPort();
    sliderWidget.build();
    sliderWidget.bindEventHandler(port);

    sliderWidget.value = 70;
    await flush();

    expect(sliderWidget.value).toBe(70);
    expect(port.mount).toHaveBeenCalledTimes(1);
  });
});

describe("TImage", () => {
  it("renders src, alt, size, and click binding", () => {
    const image = new TImage({
      id: "logo",
      src: "data:image/png;base64,AAA",
      alt: "Logo",
      width: 40,
      height: "40px",
    });
    const port = createPort();
    const onClick = vi.fn();
    image.onClick = onClick;
    image.bindEventHandler(port);

    const node = image.build();
    expect(node.tag).toBe("img");
    expect(node.props.src).toBe("data:image/png;base64,AAA");
    expect(node.props.alt).toBe("Logo");
    expect(node.props.onClickId).toBe("logo");
    expect(node.props.style.width).toBe("40px");
    expect(node.props.style.height).toBe("40px");

    handlerFor(port, "logo")();
    expect(onClick).toHaveBeenCalledTimes(1);

    image.src = "data:image/png;base64,BBB";
    expect(port.update).toHaveBeenCalledWith("logo", {
      src: "data:image/png;base64,BBB",
    });
  });
});

describe("K3: judul widget = caption (P1-2)", () => {
  const WIDGETS = {
    TIndicatorLamp,
    TToggleSwitch,
    TRelayCard,
    TSensorCard,
    TRadialGauge,
    TSevenSegment,
    TVerticalGauge,
    TSlider,
  } as const;

  for (const [name, C] of Object.entries(WIDGETS)) {
    it(`${name}: caption tampil di view, label ditolak`, () => {
      const widget = new (C as any)({ id: `w-${name}`, caption: "Judul-Uji" });
      const view = JSON.stringify((widget as any).createView());
      expect(view).toContain("Judul-Uji");

      expect(() => new (C as any)({ label: "x" })).toThrow(
        expect.objectContaining({ code: "UNKNOWN_PROP" }),
      );
    });
  }
});

describe("K2.4: properti tampilan widget bisa diubah runtime (P1-3)", () => {
  const flushAll = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("caption dan color yang di-set setelah bind memicu render ulang", async () => {
    const port = {
      mount: vi.fn(async (_node: unknown, _parentId?: string) => {}),
      update: vi.fn(async () => {}),
      on: vi.fn(),
      off: vi.fn(),
      unmount: vi.fn(async () => {}),
      setContent: vi.fn(async () => {}),
    };
    const card = new TSensorCard({ id: "rt", caption: "Suhu", value: 20 });
    card.bindEventHandler(port);
    await card.refresh();
    await flushAll();
    port.mount.mockClear();

    card.caption = "Suhu Ruang";
    card.color = "#ff0000";
    await flushAll();

    expect(card.caption).toBe("Suhu Ruang");
    expect(card.color).toBe("#ff0000");
    const lastView = JSON.stringify(port.mount.mock.calls.at(-1)?.[0]);
    expect(lastView).toContain("Suhu Ruang");
    expect(lastView).toContain("#ff0000");
  });

  it("TSlider: mengubah min/max menjepit ulang value", () => {
    const slider = new TSlider({ min: 0, max: 100, value: 80 });
    slider.max = 50;
    expect(slider.value).toBe(50);
    slider.max = 100;
    slider.min = 70;
    expect(slider.value).toBe(70);
  });

  it("TProgressBar: color diterapkan ke bar isi", async () => {
    const update = vi.fn(async () => {});
    const bar = new TProgressBar({ id: "pb" });
    bar.bindEventHandler({ mount: vi.fn(), update, on: vi.fn() });
    bar.color = "#123456";
    expect(update).toHaveBeenCalledWith("pb_fill", { style: { background: "#123456" } });
    expect(JSON.stringify(bar.build())).toContain("#123456");
  });
});
