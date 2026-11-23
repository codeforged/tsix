import { describe, expect, it, vi } from "vitest";
import {
  EComponentError,
  TButton,
  TCheckBox,
  TComboBox,
  TEdit,
  TForm,
  TGridPanel,
  TGroupBox,
  THStack,
  TLabel,
  TListBox,
  TMemo,
  TPanel,
  TDataGrid,
  TTabulatorGrid,
  TRadioButton,
  TScrollBox,
  TSpacer,
  TTreeView,
  TVStack,
  type TScreenPort,
} from "@tsix/pistachio";

function createPort() {
  return {
    mount: vi.fn(async (_node: unknown, _parentId?: string) => {}),
    update: vi.fn(
      async (_targetId: string, _props: Record<string, unknown>) => {},
    ),
    on: vi.fn(
      (_targetId: string, _event: string, _callback: (ev: any) => void): void => {},
    ),
    off: vi.fn((_targetId: string) => {}),
    unmount: vi.fn(async (_targetId: string) => {}),
    setContent: vi.fn(async (_containerId: string, ..._children: unknown[]) => {}),
  };
}

function clickHandler(port: ReturnType<typeof createPort>, id: string) {
  const call = port.on.mock.calls.find(
    ([target, event]) => target === id && event === "click",
  );
  if (!call) throw new Error(`no click handler for ${id}`);
  return call[2] as () => void;
}

/** Baris pohon dirender ulang, jadi handler terakhir yang dipakai. */
function lastClickHandler(port: ReturnType<typeof createPort>, id: string) {
  const calls = port.on.mock.calls.filter(
    ([target, event]) => target === id && event === "click",
  );
  const call = calls[calls.length - 1];
  if (!call) throw new Error(`no click handler for ${id}`);
  return call[2] as () => void;
}

function inputHandler(port: ReturnType<typeof createPort>, id: string) {
  const call = port.on.mock.calls.find(
    ([target, event]) => target === id && event === "input",
  );
  if (!call) throw new Error(`no input handler for ${id}`);
  return call[2] as (ev: any) => void;
}

describe("layout", () => {
  it("applies defaults and lets user style override them", () => {
    const panel = new TPanel({ style: { padding: "0px" } });
    expect(panel.style.padding).toBe("0px");
    expect(panel.style.borderRadius).toBe("8px");

    expect(new THStack().style.display).toBe("flex");
    expect(new TVStack().style.flexDirection).toBe("column");
    expect(new TScrollBox().style.overflow).toBe("auto");
    expect(new TSpacer().style.flex).toBe("1");
    expect(new TSpacer({ size: 12 }).style.width).toBe("12px");
  });

  it("builds grid columns from the columns option", () => {
    const grid = new TGridPanel({ columns: 3 });
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, 1fr)");
  });

  it("adds a caption node for TGroupBox", () => {
    const group = new TGroupBox({ id: "grp", caption: "Filter" });
    const node = group.build();

    expect(node.children).toHaveLength(1);
    expect(node.children[0].props.text).toBe("Filter");
    group.caption = "Baru";
    expect(group.caption).toBe("Baru");
  });
});

describe("controls", () => {
  it("rejects unknown props instead of turning them into CSS", () => {
    try {
      new TButton({ id: "b", label: "Halo" } as any);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as EComponentError).code).toBe("UNKNOWN_PROP");
    }
  });

  it("TLabel syncs text changes to the host", () => {
    const label = new TLabel({ id: "lbl", text: "awal" });
    const port = createPort();
    label.bindEventHandler(port);

    label.text = "baru";

    expect(port.update).toHaveBeenCalledWith("lbl", { text: "baru" });
    expect(label.build().props.text).toBe("baru");
  });

  it("TButton runs onClick and reflects enabled state", () => {
    const button = new TButton({ id: "btn", caption: "OK" });
    const port = createPort();
    const onClick = vi.fn();
    button.onClick = onClick;
    button.bindEventHandler(port);

    clickHandler(port, "btn")();
    button.enabled = false;

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.enabled).toBe(false);
    expect(port.update).toHaveBeenCalledWith("btn", { disabled: true });
  });

  it("TEdit keeps .text live and pushes readOnly", () => {
    const edit = new TEdit({ id: "edt", placeholder: "nama" });
    const port = createPort();
    const onInput = vi.fn();
    edit.onInput = onInput;
    edit.bindEventHandler(port);

    inputHandler(port, "edt")({ value: "budi" });
    edit.readOnly = true;

    expect(edit.text).toBe("budi");
    expect(onInput).toHaveBeenCalledWith("budi");
    expect(edit.build().props.readOnly).toBe(true);
    expect(port.update).toHaveBeenCalledWith("edt", { readOnly: true });
  });

  it("TMemo keeps .text live", () => {
    const memo = new TMemo({ id: "memo", rows: 6 });
    const port = createPort();
    memo.bindEventHandler(port);

    inputHandler(port, "memo")({ value: "baris 1" });

    expect(memo.text).toBe("baris 1");
    expect(memo.build().props.rows).toBe(6);
  });

  it("TCheckBox toggles and updates its symbol", () => {
    const check = new TCheckBox({ id: "chk", caption: "Aktif" });
    const port = createPort();
    const onClick = vi.fn();
    check.onClick = onClick;
    check.bindEventHandler(port);

    clickHandler(port, "chk")();

    expect(check.checked).toBe(true);
    expect(onClick).toHaveBeenCalledWith(true);
    expect(port.update).toHaveBeenCalledWith("chk_sym", { text: "☑ " });
    expect(check.build().children[1].props.text).toBe("Aktif");
  });

  it("TRadioButton unchecks siblings in the same group", () => {
    const group = new THStack("group");
    const first = new TRadioButton({ id: "r1", group: "g" });
    const second = new TRadioButton({ id: "r2", group: "g" });
    group.add(first);
    group.add(second);

    const port = createPort();
    first.bindEventHandler(port);
    second.bindEventHandler(port);

    clickHandler(port, "r1")();
    clickHandler(port, "r2")();

    expect(first.checked).toBe(false);
    expect(second.checked).toBe(true);
  });

  it("TComboBox builds options and reports changes", () => {
    const combo = new TComboBox({
      id: "cmb",
      items: ["satu", "dua"],
      selectedIndex: 1,
    });
    const port = createPort();
    const onChange = vi.fn();
    combo.onChange = onChange;
    combo.bindEventHandler(port);

    expect(combo.build().children[1].props.selected).toBe(true);
    expect(combo.build().children).toHaveLength(2);

    inputHandler(port, "cmb")({ value: "0" });

    expect(combo.selectedIndex).toBe(0);
    expect(onChange).toHaveBeenCalledWith(0, "satu");
    expect(combo.build().children[0].props.selected).toBe(true);
    expect(combo.build().children[1].props.selected).toBeUndefined();
  });

  it("TListBox selects a row and restyles rows", () => {
    const list = new TListBox({ id: "list", items: ["a", "b"] });
    const port = createPort();
    const onClick = vi.fn();
    list.onClick = onClick;
    list.bindEventHandler(port);

    clickHandler(port, "list_item_1")();

    expect(list.selectedIndex).toBe(1);
    expect(onClick).toHaveBeenCalledWith(1, "b");
    expect(port.update).toHaveBeenCalledWith(
      "list_item_1",
      expect.objectContaining({ style: expect.any(Object) }),
    );
  });

  it("marks read-only inputs with an inset, dimmed look", () => {
    const edit = new TEdit({ id: "edt", text: "x" });
    expect(edit.style.boxShadow).toBeUndefined();

    edit.readOnly = true;
    expect(edit.style.boxShadow).toContain("inset");
    expect(edit.style.cursor).toBe("default");

    edit.readOnly = false;
    expect(edit.style.boxShadow).toBeUndefined();

    const memo = new TMemo({ id: "memo", text: "y", readOnly: true });
    expect(memo.style.boxShadow).toContain("inset");
  });

  it("keeps user style overrides when toggling read-only", () => {
    const edit = new TEdit({ id: "edt", style: { width: "50%" } });
    edit.readOnly = true;
    expect(edit.style.width).toBe("50%");
  });

  it("TListBox fills its container like other input controls", () => {
    const list = new TListBox("list");
    expect(list.style.width).toBe("100%");
    expect(list.style.minWidth).toBe("0");
  });
});

describe("TDataGrid", () => {
  function createGridPort() {
    const bindHandler = vi.fn(
      (_targetId: string, _event: string, _cb: (ev?: any) => void): void => {},
    );
    return {
      bindHandler,
      port: {
        mount: vi.fn(async (_node: unknown, _parentId?: string) => {}),
        update: vi.fn(
          async (_targetId: string, _props: Record<string, unknown>) => {},
        ),
        on: vi.fn(
          (
            _targetId: string,
            _event: string,
            _callback: (ev: any) => void,
          ): void => {},
        ),
        off: vi.fn((_targetId: string) => {}),
        unmount: vi.fn(async (_targetId: string) => {}),
        setContent: vi.fn(
          async (_containerId: string, ..._children: unknown[]) => {},
        ),
        setText: vi.fn(async (_targetId: string, _text: string) => {}),
        win: {
          bindHandler,
          mount: vi.fn(async (_node: unknown, _parentId?: string) => {}),
          unmount: vi.fn(async (_targetId: string) => {}),
        },
      } as any,
    };
  }

  it("builds headers from manual columns", () => {
    const grid = new TDataGrid({
      id: "grid",
      columns: [
        { key: "no", label: "No" },
        { key: "node", label: "Node" },
      ],
      data: [{ no: 1, node: "esp-01" }],
    });

    const ids = JSON.stringify(grid.build());
    expect(ids).toContain("dg-grid-th-no");
    expect(ids).toContain("dg-grid-th-node");
  });

  it("stores manual data and exposes it through the grid", async () => {
    const { port } = createGridPort();
    const grid = new TDataGrid({
      id: "grid",
      columns: [{ key: "no", label: "No" }],
      data: [{ no: 1 }, { no: 2 }],
    });
    grid.bindEventHandler(port);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(grid.getRecord(1)).toEqual({ no: 1 });
    expect(grid.selectedIndex).toBe(-1);

    await grid.appendData([{ no: 3 }]);
    expect(grid.data).toHaveLength(3);
  });

  it("TTabulatorGrid exposes the same API surface", async () => {
    const { port } = createGridPort();
    const grid = new TTabulatorGrid({
      id: "tbg",
      columns: [{ key: "no", label: "No" }],
      data: [{ no: 1 }],
    });
    grid.bindEventHandler(port);

    await grid.appendData([{ no: 2 }]);

    expect(grid.data).toHaveLength(2);
  });

  it("routes Tabulator row double-clicks to the public callback", async () => {
    const { port, bindHandler } = createGridPort();
    const grid = new TTabulatorGrid({
      id: "tbg-double-click",
      columns: [{ key: "no", label: "No" }],
      data: [{ no: 1 }],
    });
    const onRowDoubleClick = vi.fn();
    grid.onRowDoubleClick = onRowDoubleClick;
    grid.bindEventHandler(port);

    const call = bindHandler.mock.calls.find(
      ([target, event]) =>
        target === "tb-tbg-double-click" && event === "tb_rowdblclick",
    );
    if (!call) throw new Error("row double-click handler not bound");
    call[2]({ value: JSON.stringify({ key: 1 }) });

    expect(onRowDoubleClick).toHaveBeenCalledWith(1, { no: 1 });
  });

  it("routes header clicks to onSort", () => {
    const { port, bindHandler } = createGridPort();
    const grid = new TDataGrid({
      id: "grid",
      columns: [{ key: "no", label: "No" }],
      data: [{ no: 1 }],
    });
    const onSort = vi.fn();
    grid.onSort = onSort;
    grid.bindEventHandler(port);

    const call = bindHandler.mock.calls.find(
      ([target, event]) => target === "dg-grid-th-no" && event === "click",
    );
    if (!call) throw new Error("header click not bound");
    call[2]();

    expect(onSort).toHaveBeenCalledWith("no", "asc");
  });
});

describe("TComboBox", () => {
  it("replaces options and keeps the current value when it survives", async () => {
    const port = createPort();
    const combo = new TComboBox({ id: "combo", items: ["a", "b", "c"] });
    combo.bindEventHandler(port);
    combo.selectedIndex = 1;

    await combo.setItems(["b", "c", "d"]);

    expect(combo.items).toEqual(["b", "c", "d"]);
    expect(combo.selectedIndex).toBe(0);
    const content = port.setContent.mock.calls.at(-1);
    expect(content?.[0]).toBe("combo");
    expect(content?.slice(1)).toHaveLength(3);
    expect(port.update).toHaveBeenCalledWith("combo", { value: "0" });
    combo.dispose();
  });

  it("falls back to the first option or an empty selection", async () => {
    const port = createPort();
    const combo = new TComboBox({ id: "combo", items: ["a"] });
    combo.bindEventHandler(port);
    combo.selectedIndex = 0;

    await combo.setItems(["x", "y"]);
    expect(combo.selectedIndex).toBe(0);
    expect(combo.items[0]).toBe("x");

    await combo.setItems([]);
    expect(combo.selectedIndex).toBe(-1);
    expect(combo.items).toEqual([]);
    combo.dispose();
  });
});

describe("TTreeView", () => {
  function makeNodes() {
    return [
      {
        id: "acc",
        label: "juragan",
        icon: "◉",
        children: [
          {
            id: "grp-devices",
            label: "Device (1)",
            children: [{ id: "dev-a", label: "Sensor A", hint: "d1" }],
          },
          {
            id: "dash",
            label: "Sensor Rumah",
            children: [{ id: "item-1", label: "Suhu Ruangan" }],
          },
        ],
      },
    ];
  }

  /** Id baris mengikuti id simpul (bukan indeks) — lihat build(). */
  function rowIdOf(tree: TTreeView, nodeId: string): string {
    const key = encodeURIComponent(nodeId);
    const row = tree.build().children.find((child) => child.id === `${tree.id}_r_${key}`);
    if (!row) throw new Error(`no row for ${nodeId}`);
    return row.id;
  }

  function toggleIdOf(tree: TTreeView, nodeId: string): string {
    const row = tree.build().children.find(
      (child) => child.id === rowIdOf(tree, nodeId),
    );
    const toggle = row?.children[0];
    if (!toggle) throw new Error(`no toggle for ${nodeId}`);
    return toggle.id;
  }

  it("renders only open branches and toggles them from the chevron", async () => {
    const port = createPort();
    const tree = new TTreeView({ nodes: makeNodes() });
    tree.bindEventHandler(port);

    expect(tree.rows.map((row) => row.node.id)).toEqual(["acc"]);

    lastClickHandler(port, toggleIdOf(tree, "acc"))();
    await vi.waitFor(() =>
      expect(tree.rows.map((row) => row.node.id)).toEqual([
        "acc",
        "grp-devices",
        "dash",
      ]),
    );
    expect(tree.rows[1].depth).toBe(1);

    lastClickHandler(port, toggleIdOf(tree, "acc"))();
    await vi.waitFor(() => expect(tree.rows).toHaveLength(1));
    tree.dispose();
  });

  it("selects a row, opens its ancestors, and reports the node", async () => {
    const port = createPort();
    const tree = new TTreeView({ nodes: makeNodes() });
    tree.bindEventHandler(port);
    const onSelect = vi.fn();
    tree.onSelect = onSelect;

    lastClickHandler(port, rowIdOf(tree, "acc"))();

    // Pemberitahuan pemilihan sinkron: tidak menunggu render ulang pohon.
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acc" }),
    );
    expect(tree.selectedId).toBe("acc");
    expect(tree.isExpanded("acc")).toBe(true);

    await tree.select("item-1");
    expect(tree.selectedNode?.label).toBe("Suhu Ruangan");
    expect(tree.isExpanded("dash")).toBe(true);
    expect(tree.rows.map((row) => row.node.id)).toContain("item-1");
    tree.dispose();
  });

  it("keeps row ids stable when branches open", async () => {
    const port = createPort();
    const tree = new TTreeView({ nodes: makeNodes() });
    tree.bindEventHandler(port);

    const before = rowIdOf(tree, "acc");
    await tree.expand("acc");
    await tree.expand("dash");

    expect(rowIdOf(tree, "acc")).toBe(before);
    expect(rowIdOf(tree, "dash")).toContain(encodeURIComponent("dash"));
    tree.dispose();
  });

  it("reports a leaf selection without waiting for setContent", () => {
    const port = createPort();
    // Render ulang yang lambat tidak boleh menahan pemberitahuan pemilihan.
    port.setContent.mockImplementation(() => new Promise<void>(() => {}));
    const nodes = makeNodes().map((node) => ({
      ...node,
      expanded: true,
      children: node.children?.map((child) => ({ ...child, expanded: true })),
    }));
    const tree = new TTreeView({ nodes });
    tree.bindEventHandler(port);
    const onSelect = vi.fn();
    tree.onSelect = onSelect;

    lastClickHandler(port, rowIdOf(tree, "item-1"))();

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "item-1" }),
    );
    expect(tree.selectedId).toBe("item-1");
    tree.dispose();
  });

  it("keeps expansion for ids that survive setNodes", async () => {
    const port = createPort();
    const tree = new TTreeView({ nodes: makeNodes() });
    tree.bindEventHandler(port);
    await tree.expand("acc");
    await tree.select("dev-a", false);

    await tree.setNodes([
      {
        id: "acc",
        label: "juragan",
        children: [{ id: "dev-b", label: "Sensor B" }],
      },
    ]);

    expect(tree.isExpanded("acc")).toBe(true);
    expect(tree.selectedId).toBeNull();
    expect(tree.rows.map((row) => row.node.id)).toEqual(["acc", "dev-b"]);
    tree.dispose();
  });
});

describe("TForm", () => {
  it("mounts components added after run into their real parent", () => {
    const form = new TForm({ id: "main", title: "Demo" });
    const port = createPort();
    (form as any)._screen = port;

    const panel = new TPanel("panel");
    form.add(panel);

    const label = new TLabel({ id: "lbl", text: "hai" });
    panel.add(label);

    expect(port.mount).toHaveBeenCalledTimes(2);
    expect(port.mount).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "lbl" }),
      "panel",
    );
  });

  it("disposes children when closing", async () => {
    const form = new TForm("main");
    const port = createPort();
    (form as any)._screen = { ...port, close: vi.fn(async () => {}) };

    const label = new TLabel("lbl");
    form.add(label);

    await form.close();

    expect(label.disposed).toBe(true);
    expect(form.children).toHaveLength(0);
  });
});

describe("pemilihan setelah isi koleksi diganti (K2.3)", () => {
  it("TListBox mempertahankan item terpilih yang masih ada", async () => {
    const port = createPort();
    const list = new TListBox({ id: "list", items: ["a", "b", "c"], selectedIndex: 1 });
    list.bindEventHandler(port);

    await list.setItems(["x", "b", "y", "z"]);
    expect(list.selectedIndex).toBe(1);

    await list.setItems(["c", "b"]);
    expect(list.selectedIndex).toBe(1);
    list.dispose();
  });

  it("TListBox kembali ke -1 (bukan item pertama) bila item terpilih hilang", async () => {
    const port = createPort();
    const list = new TListBox({ id: "list", items: ["a", "b"], selectedIndex: 0 });
    list.bindEventHandler(port);

    await list.setItems(["x", "y"]);
    expect(list.selectedIndex).toBe(-1);
    list.dispose();
  });

  it("TComboBox dan TListBox memakai aturan yang sama kecuali fallback", async () => {
    const port = createPort();
    const combo = new TComboBox({ id: "c", items: ["a", "b"], selectedIndex: 1 });
    const list = new TListBox({ id: "l", items: ["a", "b"], selectedIndex: 1 });
    combo.bindEventHandler(port);
    list.bindEventHandler(port);

    await combo.setItems(["b", "a"]);
    await list.setItems(["b", "a"]);
    expect([combo.selectedIndex, list.selectedIndex]).toEqual([0, 0]);

    await combo.setItems(["q"]);
    await list.setItems(["q"]);
    expect([combo.selectedIndex, list.selectedIndex]).toEqual([0, -1]);
  });

  it("indeks tanpa item valid dipertahankan selama masih dalam jangkauan", async () => {
    const combo = new TComboBox({ id: "c" });
    combo.selectedIndex = 2; // diset sebelum items ada
    await combo.setItems(["a", "b", "c"]);
    expect(combo.selectedIndex).toBe(2);

    const list = new TListBox({ id: "l" });
    list.selectedIndex = 5;
    await list.setItems(["a", "b"]);
    expect(list.selectedIndex).toBe(-1);
  });
});
