import { afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({ screens: [] as any[] }));

vi.mock("@tsix/emerald", () => ({
  Keyboard: class {
    async attach(): Promise<void> {}
    async detach(): Promise<void> {}
    on(): () => void {
      return () => {};
    }
  },
  Screen: class {
    win = {
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
    };
    keyboard: unknown = null;
    closed = false;

    constructor(_options: unknown) {
      mockState.screens.push(this);
    }

    async mount(): Promise<void> {}
    async maximize(): Promise<void> {}
    async minimize(): Promise<void> {}
    async restore(): Promise<void> {}
    async close(): Promise<void> {
      this.closed = true;
    }
    async loopUntilClose(beforeClose?: () => void): Promise<void> {
      beforeClose?.();
      this.closed = true;
    }
  },
}));

vi.mock("@tsix/theme", () => ({
  theme: {
    loadCurrent: vi.fn(async () => {}),
    watch: vi.fn(),
  },
}));

vi.mock("@tsix/Application", () => ({
  shell: { ps: vi.fn(async () => []) },
}));

import { TLabel } from "./pistachio/controls";
import { TForm } from "./pistachio/form";
import { TTimer } from "./pistachio/layout";

describe("TForm window-close lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    mockState.screens.length = 0;
  });

  it("disposes timers before the window is destroyed", async () => {
    vi.useFakeTimers();

    const form = new TForm({ title: "Timer lifecycle" });
    const label = new TLabel({ id: "timer-label", text: "0" });
    const timer = new TTimer({
      id: "lifecycle-timer",
      interval: 10,
      enabled: true,
    });
    const onTimer = vi.fn(() => {
      label.text = "tick";
    });
    const onClose = vi.fn();
    timer.onTimer = onTimer;
    form.onClose = onClose;
    form.add(label);
    form.add(timer);

    await form.run();

    expect(mockState.screens[0].closed).toBe(true);
    expect(form.disposed).toBe(true);
    expect(timer.disposed).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(50);
    expect(onTimer).not.toHaveBeenCalled();
    expect(label.text).toBe("0");
  });
});
