import { afterEach, describe, expect, it, vi } from "vitest";
import { Screen } from "@tsix/emerald";
import {
  TButton,
  TComponent,
  TEdit,
  TForm,
  TPanel,
  TTimer,
} from "@tsix/cashew";

function createScreen(): Screen {
  const screen = Object.create(Screen.prototype) as Screen;
  Object.defineProperty(screen, "_timers", { value: [], writable: true });
  Object.defineProperty(screen, "running", { value: true, writable: true });
  Object.defineProperty(screen, "win", {
    value: { unmount: vi.fn(async () => {}), unregisterHandler: vi.fn() },
    writable: true,
  });
  return screen;
}

function fakeMountedScreen() {
  return {
    mount: vi.fn(async () => {}),
    unmount: vi.fn(async () => {}),
    on: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    unregisterHandler: vi.fn(),
    close: vi.fn(async () => {}),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TComponent tree", () => {
  it("rejects adding a component to multiple parents", () => {
    const firstParent = new TComponent("first-parent");
    const secondParent = new TComponent("second-parent");
    const child = new TComponent("child");

    firstParent.add(child);

    expect(() => secondParent.add(child)).toThrow(/already belongs/);
    expect(firstParent.children).toEqual([child]);
    expect(secondParent.children).toEqual([]);
  });

  it("indexes form descendants and rejects duplicate IDs only within that form", () => {
    const form = new TForm("First");
    const panel = new TComponent("panel");
    const child = new TComponent("shared-id");
    panel.add(child);
    form.add(panel);

    expect(form.byId("shared-id")).toBe(child);
    expect(() => form.add(new TComponent("shared-id"))).toThrow(
      /Duplicate component id "shared-id"/,
    );

    const otherForm = new TForm("Second");
    const sameIdInOtherForm = new TComponent("shared-id");
    otherForm.add(sameIdInOtherForm);
    expect(otherForm.byId("shared-id")).toBe(sameIdInOtherForm);
  });
});

describe("TEdit.readOnly", () => {
  it("supports initial configuration and live changes in both directions", () => {
    const initiallyReadOnly = new TEdit("initial-read-only", { readOnly: true });
    expect(initiallyReadOnly.readOnly).toBe(true);

    const edit = new TEdit("read-only-edit");
    const update = vi.fn(async () => {});
    const screen = {
      on: vi.fn(),
      update,
    } as unknown as Screen;

    edit.bindEventHandler(screen);
    edit.readOnly = true;
    expect(update).toHaveBeenCalledWith("read-only-edit", { readOnly: true });

    edit.readOnly = false;

    expect(edit.readOnly).toBe(false);
    expect(edit.build().props.readOnly).toBe(false);
    expect(update).toHaveBeenCalledWith("read-only-edit", { readOnly: false });
  });
});

describe("TTimer", () => {
  it("restarts one interval and stops/re-enables without duplicate callbacks", () => {
    vi.useFakeTimers();
    const screen = createScreen();
    const timer = new TTimer({ interval: 1000, enabled: true });
    const onTimer = vi.fn();
    timer.onTimer = onTimer;

    timer.bindEventHandler(screen);
    timer.interval = 500;
    timer.interval = 250;

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(250);
    expect(onTimer).toHaveBeenCalledTimes(1);

    timer.enabled = false;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(onTimer).toHaveBeenCalledTimes(1);

    timer.enabled = true;
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(250);
    expect(onTimer).toHaveBeenCalledTimes(2);
  });
});

describe("TComponent lifecycle", () => {
  it("keeps non-visual components out of the DOM tree", () => {
    const form = new TForm("Form");
    const button = new TButton("btn");
    const timer = new TTimer({ interval: 1000 });
    form.add(button);
    form.add(timer);

    const childIds = form.build().children.map((child) => child.id);
    expect(childIds).toContain("btn");
    expect(childIds).not.toContain(timer.id);
  });

  it("removes a subtree along with its registry entries and DOM node", () => {
    const form = new TForm("Form");
    const panel = new TPanel("panel");
    const child = new TComponent("child");
    panel.add(child);
    form.add(panel);
    const screen = fakeMountedScreen();
    (form as any)._screen = screen;

    form.remove(panel);

    expect(form.children).toEqual([]);
    expect(form.byId("child")).toBeNull();
    expect(panel.parent).toBeNull();
    expect(screen.unmount).toHaveBeenCalledWith("panel");
    expect(screen.unregisterHandler).toHaveBeenCalledWith("child");
  });

  it("stops timers inside a removed subtree", () => {
    vi.useFakeTimers();
    const screen = createScreen();
    const form = new TForm("Form");
    const panel = new TPanel("panel");
    const timer = new TTimer({ interval: 1000, enabled: true });
    timer.onTimer = vi.fn();
    panel.add(timer);
    form.add(panel);

    (form as any)._screen = screen;
    timer.bindEventHandler(screen);
    expect(vi.getTimerCount()).toBe(1);

    form.remove(panel);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("mounts and binds components added after run()", () => {
    const form = new TForm("Form");
    const screen = fakeMountedScreen();
    (form as any)._screen = screen;
    const button = new TButton("late-btn");
    button.onClick = vi.fn();

    form.add(button);

    expect(screen.mount).toHaveBeenCalledWith(
      expect.objectContaining({ id: "late-btn" }),
      form.id,
    );
    expect(screen.on).toHaveBeenCalledWith(
      "late-btn",
      "click",
      expect.any(Function),
    );
  });

  it("mounts post-run additions into their actual parent", () => {
    const form = new TForm("Form");
    const screen = fakeMountedScreen();
    (form as any)._screen = screen;
    const panel = new TPanel("panel");
    form.add(panel);

    const button = new TButton("nested-btn");
    panel.add(button);

    expect(screen.mount).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "nested-btn" }),
      "panel",
    );
  });
});
