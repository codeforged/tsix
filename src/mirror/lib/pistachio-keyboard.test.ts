import { describe, expect, it, vi } from "vitest";
import {
  TComponent,
  TKeyboard,
  TLabel,
  TForm,
  type TKeyEvent,
} from "@tsix/pistachio";

type Handler = (ev: TKeyEvent) => void;

class TKeyProbe extends TComponent {
  public readonly events: TKeyEvent[] = [];

  constructor(
    id: string,
    private readonly consumesEvent: boolean,
  ) {
    super(id);
  }

  override handleKeyEvent(event: TKeyEvent): boolean {
    this.events.push(event);
    return this.consumesEvent;
  }
}

function createKeyboardPort() {
  let handler: Handler | null = null;
  const unsubscribe = vi.fn(() => {
    handler = null;
  });

  const port = {
    mount: vi.fn(async (_node: unknown, _parentId?: string) => {}),
    update: vi.fn(
      async (_targetId: string, _props: Record<string, unknown>) => {},
    ),
    on: vi.fn((): void => {}),
    off: vi.fn((_targetId: string) => {}),
    unmount: vi.fn(async (_targetId: string) => {}),
    keyboard: {
      on: (cb: Handler) => {
        handler = cb;
        return unsubscribe;
      },
    },
  };

  return {
    port,
    unsubscribe,
    emit(ev: Partial<TKeyEvent>) {
      if (!handler) throw new Error("keyboard handler not attached");
      handler({
        key: "",
        code: "",
        down: true,
        repeat: false,
        ctrl: false,
        shift: false,
        alt: false,
        ...ev,
      });
    },
  };
}

describe("TKeyboard", () => {
  it("is non-visual so it never reaches the DOM tree", () => {
    const form = new TForm("Form");
    const keyboard = new TKeyboard("kbd");
    form.add(keyboard);

    expect(keyboard.isVisual).toBe(false);
    expect(form.build().children).toHaveLength(0);
  });

  it("runs the shortcut for a matching combination", () => {
    const { port, emit } = createKeyboardPort();
    const save = vi.fn();
    const keyboard = new TKeyboard({ id: "kbd", shortcuts: { "Ctrl+S": save } });
    keyboard.bindEventHandler(port);

    emit({ key: "s", ctrl: true });
    emit({ key: "s" });

    expect(save).toHaveBeenCalledTimes(1);
    expect(keyboard.attached).toBe(true);
  });

  it("normalizes spelling of combinations", () => {
    const { port, emit } = createKeyboardPort();
    const handler = vi.fn();
    const keyboard = new TKeyboard("kbd");
    keyboard.bind("ctrl+shift+f2", handler);
    keyboard.bindEventHandler(port);

    emit({ key: "F2", ctrl: true, shift: true });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores keyup and auto-repeat", () => {
    const { port, emit } = createKeyboardPort();
    const handler = vi.fn();
    const keyboard = new TKeyboard("kbd");
    keyboard.bind("F2", handler);
    keyboard.bindEventHandler(port);

    emit({ key: "F2", down: false });
    emit({ key: "F2", repeat: true });
    emit({ key: "F2" });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still reports raw events through onKey", () => {
    const { port, emit } = createKeyboardPort();
    const keyboard = new TKeyboard("kbd");
    const onKey = vi.fn();
    keyboard.onKey = onKey;
    keyboard.bindEventHandler(port);

    emit({ key: "Escape" });

    expect(onKey).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Escape" }),
    );
  });

  it("unbinds shortcuts and detaches on dispose", () => {
    const { port, emit, unsubscribe } = createKeyboardPort();
    const handler = vi.fn();
    const keyboard = new TKeyboard("kbd");
    keyboard.bind("F2", handler);
    keyboard.bindEventHandler(port);

    keyboard.unbind("F2");
    emit({ key: "F2" });
    expect(handler).not.toHaveBeenCalled();

    keyboard.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(keyboard.attached).toBe(false);
  });

  it("stays inert when the window has no keyboard capture", () => {
    const port = {
      mount: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      on: vi.fn((): void => {}),
    };
    const keyboard = new TKeyboard("kbd");
    keyboard.bind("F2", vi.fn());

    expect(() => keyboard.bindEventHandler(port as any)).not.toThrow();
    expect(keyboard.attached).toBe(false);
  });

  it("works alongside other non-visual children", () => {
    const form = new TForm("Form");
    form.add(new TLabel({ id: "lbl", text: "Halo" }));
    form.add(new TKeyboard("kbd"));

    expect(form.build().children.map((child) => child.id)).toEqual(["lbl"]);
  });

  it("forwards captured window keys to the first component that handles them", () => {
    const { port, emit, unsubscribe } = createKeyboardPort();
    const form = new TForm("Form");
    const first = new TKeyProbe("first", true);
    const second = new TKeyProbe("second", true);
    form.add(first);
    form.add(second);
    form.bindEventHandler(port);

    emit({ key: "ArrowDown" });
    emit({ key: "ArrowDown", repeat: true });
    emit({ key: "ArrowDown", down: false });

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(0);

    form.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
