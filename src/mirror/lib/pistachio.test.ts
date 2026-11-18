import { describe, expect, it } from "vitest";
import {
  EComponentError,
  TComponent,
  resolveOptions,
  type TOptions,
} from "@tsix/pistachio";

class TInvisible extends TComponent {
  constructor(idOrOpts?: string | TOptions, opts?: TOptions) {
    super(idOrOpts, opts);
    this.isVisual = false;
  }
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as EComponentError).code;
  }
  return undefined;
}

describe("resolveOptions", () => {
  it("normalizes id string, object, and merged forms", () => {
    expect(resolveOptions("edt")).toEqual({ id: "edt" });
    expect(resolveOptions({ id: "edt", style: { color: "red" } })).toEqual({
      id: "edt",
      style: { color: "red" },
    });
    expect(
      resolveOptions({ id: "first", style: { color: "red" } }, { id: "second" }),
    ).toEqual({ id: "second", style: { color: "red" } });
    expect(resolveOptions()).toEqual({});
  });

  it("rejects non-object options", () => {
    expect(codeOf(() => resolveOptions(42 as any))).toBe("INVALID_OPTIONS");
  });
});

describe("TComponent options", () => {
  it("accepts id, style, and children in one object", () => {
    const label = new TComponent("label");
    const panel = new TComponent({
      id: "panel",
      style: { display: "flex" },
      children: [label],
    });

    expect(panel.id).toBe("panel");
    expect(panel.style).toEqual({ display: "flex" });
    expect(panel.children).toEqual([label]);
    expect(label.parent).toBe(panel);
  });

  it("rejects unknown properties instead of treating them as CSS", () => {
    expect(codeOf(() => new TComponent({ id: "x", colour: "red" } as any))).toBe(
      "UNKNOWN_PROP",
    );
  });

  it("allows subclasses to declare additional props", () => {
    class TLabelish extends TComponent {
      constructor(idOrOpts?: string | TOptions, opts?: TOptions) {
        super(idOrOpts, opts, ["text"]);
      }
    }

    const label = new TLabelish({ id: "lbl", text: "Halo" } as any);
    expect(label.id).toBe("lbl");
  });
});

describe("TComponent tree", () => {
  it("rejects duplicate ids atomically", () => {
    const root = new TComponent("root");
    root.add(new TComponent("dup"));

    const nested = new TComponent("nested");
    nested.add(new TComponent("other"));
    nested.add(new TComponent("dup"));

    expect(codeOf(() => root.add(nested))).toBe("DUPLICATE_ID");
    expect(nested.parent).toBeNull();
    expect(root.children).toHaveLength(1);
  });

  it("rejects a component that already has a parent", () => {
    const first = new TComponent("first");
    const second = new TComponent("second");
    const child = new TComponent("child");
    first.add(child);

    expect(codeOf(() => second.add(child))).toBe("ALREADY_PARENTED");
    expect(first.children).toEqual([child]);
  });

  it("rejects cycles", () => {
    const parent = new TComponent("parent");
    const child = new TComponent("child");
    parent.add(child);

    expect(codeOf(() => child.add(parent))).toBe("CYCLE");
  });

  it("finds components by id across the tree", () => {
    const root = new TComponent("root");
    const panel = new TComponent("panel");
    const deep = new TComponent("deep");
    panel.add(deep);
    root.add(panel);

    expect(root.byId("deep")).toBe(deep);
    expect(deep.byId("root")).toBe(root);
    expect(root.byId("missing")).toBeNull();
  });

  it("remove detaches, frees the id, and allows re-parenting", () => {
    const root = new TComponent("root");
    const other = new TComponent("other");
    const child = new TComponent("child");
    root.add(child);

    root.remove(child);

    expect(child.parent).toBeNull();
    expect(root.children).toHaveLength(0);
    expect(root.byId("child")).toBeNull();
    expect(codeOf(() => root.remove(child))).toBe("NOT_A_CHILD");

    other.add(child);
    expect(other.byId("child")).toBe(child);
  });

  it("dispose cascades, detaches, and blocks further use", () => {
    const root = new TComponent("root");
    const panel = new TComponent("panel");
    const child = new TComponent("child");
    panel.add(child);
    root.add(panel);

    panel.dispose();

    expect(panel.disposed).toBe(true);
    expect(child.disposed).toBe(true);
    expect(panel.parent).toBeNull();
    expect(root.children).toHaveLength(0);
    expect(root.byId("child")).toBeNull();

    panel.dispose();
    expect(codeOf(() => root.add(panel))).toBe("DISPOSED");
  });
});

describe("TComponent.build", () => {
  it("omits non-visual children and empty style", () => {
    const root = new TComponent("root");
    const visible = new TComponent({ id: "visible", style: { padding: "4px" } });
    const invisible = new TInvisible("invisible");
    root.add(visible);
    root.add(invisible);

    const node = root.build();

    expect(node.children.map((child) => child.id)).toEqual(["visible"]);
    expect(node.props.style).toBeUndefined();
    expect(node.children[0].props.style).toEqual({ padding: "4px" });
  });
});
