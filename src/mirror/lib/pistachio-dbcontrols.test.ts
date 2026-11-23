import { describe, expect, it, vi } from "vitest";
import {
  EComponentError,
  EDatabaseError,
  TClientDataset,
  TComponent,
  TDataSource,
  TDBConnection,
  TDBEdit,
  TDBGrid,
  TDBListBox,
  TDBMemo,
  TDBNavigator,
  TDBPager,
  TDBQuery,
  TDBText,
  TEdit,
  TLabel,
  TListBox,
  TMemo,
  TProvider,
  type TDBDriver,
  type TDBResult,
} from "@tsix/pistachio";

const fields = [
  {
    name: "id",
    sourceName: "sensor_id",
    type: "ftInteger" as const,
    nullable: false,
    primaryKey: true,
    autoIncrement: true,
    table: "sensor_data",
  },
  {
    name: "value",
    sourceName: "sensor_value",
    type: "ftFloat" as const,
    nullable: false,
    primaryKey: false,
    autoIncrement: false,
    table: "sensor_data",
  },
  {
    name: "notes",
    sourceName: "notes",
    type: "ftString" as const,
    nullable: true,
    primaryKey: false,
    autoIncrement: false,
    table: "sensor_data",
  },
];

function makeDriver(result: TDBResult): TDBDriver {
  return {
    name: "test",
    capabilities: {
      canWrite: true,
      canTransact: false,
      canParam: true,
    },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    execute: vi.fn(async () => result),
    quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
  };
}

async function makeSource() {
  const driver = makeDriver({
    rows: [
      { id: 1, value: 10, notes: "first" },
      { id: 2, value: 20, notes: "second" },
    ],
    fields,
  });
  const connection = new TDBConnection({
    driver,
    host: "db.example",
    user: "test",
    password: "",
    database: "test",
  });
  await connection.open();
  const query = new TDBQuery({
    connection,
    sql: "SELECT sensor_id AS id, sensor_value AS value, notes FROM sensor_data",
  });
  const provider = new TProvider({ query });
  const dataset = new TClientDataset({ provider });
  const dataSource = new TDataSource({ dataset });
  await dataset.open();
  return { dataSource, dataset, driver };
}

function createPort() {
  return {
    mount: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    on: vi.fn(
      (_id: string, _event: string, _callback: (event: any) => void) => {},
    ),
    off: vi.fn(),
    unmount: vi.fn(async () => {}),
    setContent: vi.fn(async () => {}),
  };
}

function eventHandler(
  port: ReturnType<typeof createPort>,
  id: string,
  event: string,
) {
  const call = port.on.mock.calls.find(
    ([target, name]) => target === id && name === event,
  );
  if (!call) throw new Error(`No ${event} handler for ${id}`);
  return call[2];
}

function inputHandler(port: ReturnType<typeof createPort>, id: string) {
  return eventHandler(port, id, "input");
}

describe("Pistachio DB controls", () => {
  it("binds TDBText to a basic TLabel and updates with the source", async () => {
    const { dataSource, dataset } = await makeSource();
    const text = new TDBText({ dataSource, field: "notes" });

    expect(text).toBeInstanceOf(TLabel);
    expect(text.text).toBe("first");

    dataset.next();
    expect(text.text).toBe("second");
    text.dispose();
  });

  it("updates every bound control when the dataset cursor moves", async () => {
    const { dataSource, dataset } = await makeSource();
    const text = new TDBText({ dataSource, field: "notes" });
    const edit = new TDBEdit({ dataSource, field: "value" });
    const memo = new TDBMemo({ dataSource, field: "notes" });
    const list = new TDBListBox({
      dataSource,
      field: "notes",
      items: ["first", "second"],
    });

    dataset.next();
    await vi.waitFor(() => expect(list.selectedIndex).toBe(1));

    expect(text.text).toBe("second");
    expect(edit.text).toBe("20");
    expect(memo.text).toBe("second");

    text.dispose();
    edit.dispose();
    memo.dispose();
    list.dispose();
  });

  it("binds TDBEdit to TEdit and parses numeric field input", async () => {
    const { dataSource, dataset, driver } = await makeSource();
    const edit = new TDBEdit({ dataSource, field: "value" });
    const port = createPort();
    edit.bindEventHandler(port);

    expect(edit).toBeInstanceOf(TEdit);
    expect(edit.readOnly).toBe(true);
    dataset.edit();
    expect(edit.readOnly).toBe(false);
    inputHandler(port, edit.id)({ value: "12.5" });
    expect(dataset.currentRecord?.value).toBe(12.5);
    dataset.post();
    expect(edit.readOnly).toBe(true);

    const result = await dataSource.applyUpdates();
    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
    expect(dataset.dirtyCount).toBe(0);
    expect(driver.execute).toHaveBeenLastCalledWith(
      'UPDATE "sensor_data" SET "sensor_value" = :p0 WHERE "sensor_id" = :k0',
      { p0: 12.5, k0: 1 },
    );
    edit.dispose();
  });

  it("binds TDBMemo to TMemo and writes input to the active edit buffer", async () => {
    const { dataSource, dataset } = await makeSource();
    const memo = new TDBMemo({ dataSource, field: "notes", rows: 3 });
    const port = createPort();
    memo.bindEventHandler(port);

    expect(memo).toBeInstanceOf(TMemo);
    dataset.edit();
    inputHandler(port, memo.id)({ value: "updated memo" });
    expect(dataset.currentRecord?.notes).toBe("updated memo");
    memo.dispose();
  });

  it("binds TDBListBox to TListBox and respects dataset edit state", async () => {
    const { dataSource, dataset } = await makeSource();
    const list = new TDBListBox({
      dataSource,
      field: "value",
      items: ["10", "20"],
    });

    expect(list).toBeInstanceOf(TListBox);
    expect(list.selectedIndex).toBe(0);
    expect(list.readOnly).toBe(true);
    dataset.edit();
    await list.refresh();
    expect(list.readOnly).toBe(false);
    list.onClick?.(1, "20");
    expect(dataset.currentRecord?.value).toBe(20);
    list.dispose();
  });

  it("builds TDBGrid columns from field metadata and moves the data cursor", async () => {
    const { dataSource, dataset } = await makeSource();
    const grid = new TDBGrid({ dataSource });
    await grid.refresh();

    expect(grid.columns.map((column) => column.key)).toEqual([
      "id",
      "value",
      "notes",
    ]);
    expect(grid.columns[1].align).toBe("right");
    expect(grid.data[1]).toMatchObject({ id: 2, value: 20 });
    expect(grid.selectedRecord).toMatchObject({ id: 1 });

    const onRecordDoubleClick = vi.fn();
    grid.onRecordDoubleClick = onRecordDoubleClick;
    grid.onRowDoubleClick?.(1, grid.data[1]);
    expect(dataset.currentIndex).toBe(1);
    expect(onRecordDoubleClick).toHaveBeenCalledWith(dataset.currentRecord);
    expect(grid.selectedRecord).toMatchObject({ id: 2 });

    let cursorEvents = 0;
    const unsubscribe = dataSource.subscribe((event) => {
      if (event.type === "cursor") cursorEvents++;
    });
    grid.onSelectionChange?.(grid.selectedIndex, grid.selectedRecord);
    expect(cursorEvents).toBe(0);
    unsubscribe();

    dataset.first();
    dataset.edit();
    grid.onSelectionChange?.(1, grid.data[1]);
    expect(dataset.currentIndex).toBe(0);
    dataset.cancel();
    grid.dispose();
  });

  it("navigates server-side pages and blocks paging during an edit", async () => {
    const rows = [
      { id: 1, value: 10, notes: "first" },
      { id: 2, value: 20, notes: "second" },
      { id: 3, value: 30, notes: "third" },
      { id: 4, value: 40, notes: "fourth" },
      { id: 5, value: 50, notes: "fifth" },
    ];
    const driver = makeDriver({ rows: [], fields });
    vi.mocked(driver.execute).mockImplementation(async (sql) => {
      if (sql.startsWith("SELECT COUNT(*)")) {
        return { rows: [{ __tsix_total_count: rows.length }], fields: [] };
      }
      const offset = Number(sql.match(/ OFFSET (\d+)$/)?.[1] ?? 0);
      return { rows: rows.slice(offset, offset + 2), fields };
    });
    const connection = new TDBConnection({
      driver,
      host: "db.example",
      user: "test",
      password: "",
      database: "test",
    });
    await connection.open();
    const query = new TDBQuery({
      connection,
      sql: "SELECT sensor_id AS id, sensor_value AS value, notes FROM sensor_data ORDER BY id",
    });
    const provider = new TProvider({ query });
    const dataset = new TClientDataset({ provider });
    const dataSource = new TDataSource({ dataset });
    const pager = new TDBPager({ dataSource, pageSize: 2 });
    await dataset.open();

    expect(pager.pageCount).toBe(3);
    expect(dataset.records.map((record) => record.id)).toEqual([1, 2]);

    dataset.next();
    await pager.goToPage(1);
    expect(pager.pageIndex).toBe(1);
    expect(dataset.records.map((record) => record.id)).toEqual([3, 4]);
    expect(dataset.currentRecord?.id).toBe(3);

    await pager.goToPage(99);
    expect(pager.pageIndex).toBe(2);
    expect(dataset.records.map((record) => record.id)).toEqual([5]);
    expect(pager.nextButton.enabled).toBe(false);

    await pager.goToPage(0);
    dataset.edit();
    await pager.goToPage(1);
    expect(pager.pageIndex).toBe(0);
    expect(dataset.currentIndex).toBe(0);
    dataset.cancel();

    pager.dispose();
    dataSource.dispose();
    dataset.close();
    query.close();
    await connection.close();
  });

  it("commits a typed page number on Enter and on field exit", async () => {
    const rows = [
      { id: 1, value: 10, notes: "a" },
      { id: 2, value: 20, notes: "b" },
      { id: 3, value: 30, notes: "c" },
      { id: 4, value: 40, notes: "d" },
      { id: 5, value: 50, notes: "e" },
      { id: 6, value: 60, notes: "f" },
    ];
    const driver = makeDriver({ rows: [], fields });
    vi.mocked(driver.execute).mockImplementation(async (sql) => {
      if (sql.startsWith("SELECT COUNT(*)")) {
        return { rows: [{ __tsix_total_count: rows.length }], fields: [] };
      }
      const offset = Number(sql.match(/ OFFSET (\d+)$/)?.[1] ?? 0);
      return { rows: rows.slice(offset, offset + 2), fields };
    });
    const connection = new TDBConnection({
      driver,
      host: "db.example",
      user: "test",
      password: "",
      database: "test",
    });
    await connection.open();
    const query = new TDBQuery({
      connection,
      sql: "SELECT sensor_id AS id, sensor_value AS value, notes FROM sensor_data ORDER BY id",
    });
    const provider = new TProvider({ query });
    const dataset = new TClientDataset({ provider });
    const dataSource = new TDataSource({ dataset });
    const pager = new TDBPager({ dataSource, pageSize: 2 });
    const port = createPort();
    const focus = vi.fn();
    (port as any).keyboard = { on: vi.fn(() => () => {}), focus };
    pager.pageEdit.bindEventHandler(port);

    await dataset.open();
    expect(pager.pageCount).toBe(3);
    expect(pager.pageEdit.text).toBe("1");

    inputHandler(port, pager.pageEdit.id)({ value: "3" });
    eventHandler(port, pager.pageEdit.id, "keydown")({ value: "Enter" });
    await vi.waitFor(() => expect(dataset.currentRecord?.id).toBe(5));
    expect(pager.pageIndex).toBe(2);
    expect(pager.pageEdit.text).toBe("3");
    expect(focus).toHaveBeenCalled();

    inputHandler(port, pager.pageEdit.id)({ value: "1" });
    eventHandler(port, pager.pageEdit.id, "change")({ value: "1" });
    await vi.waitFor(() => expect(dataset.records[0]?.id).toBe(1));
    expect(pager.pageIndex).toBe(0);
    expect(pager.pageEdit.text).toBe("1");

    inputHandler(port, pager.pageEdit.id)({ value: "99" });
    eventHandler(port, pager.pageEdit.id, "keydown")({ value: "Enter" });
    await vi.waitFor(() =>
      expect(pager.pageEdit.text).toBe("1"),
    );
    expect(pager.pageIndex).toBe(0);
    expect(
      (pager.byId(`${pager.id}-status`) as TLabel | undefined)?.text,
    ).toContain("maksimal 3");

    inputHandler(port, pager.pageEdit.id)({ value: "dua" });
    eventHandler(port, pager.pageEdit.id, "change")({ value: "dua" });
    expect(pager.pageIndex).toBe(0);
    expect(
      (pager.byId(`${pager.id}-status`) as TLabel | undefined)?.text,
    ).toContain("harus angka");

    pager.dispose();
    dataSource.dispose();
    dataset.close();
    query.close();
    await connection.close();
  });

  it("posts an active edit before navigating to another record", async () => {
    const { dataSource, dataset } = await makeSource();
    const navigator = new TDBNavigator({ dataSource });
    const grid = new TDBGrid({ dataSource });
    await grid.refresh();

    expect(navigator.firstButton.enabled).toBe(false);
    expect(navigator.nextButton.enabled).toBe(true);
    expect(navigator.editButton.enabled).toBe(true);

    navigator.nextButton.onClick?.();
    expect(dataset.currentIndex).toBe(1);
    expect(grid.selectedRecord).toMatchObject({ id: 2 });
    navigator.editButton.onClick?.();
    expect(navigator.postButton.enabled).toBe(true);
    expect(navigator.applyButton.enabled).toBe(false);
    expect(navigator.nextButton.enabled).toBe(false);
    expect(navigator.priorButton.enabled).toBe(true);

    dataSource.setField("value", 25);
    navigator.priorButton.onClick?.();

    expect(dataset.state).toBe("dsBrowse");
    expect(dataset.currentIndex).toBe(0);
    expect(dataset.records[1].value).toBe(25);
    expect(dataset.dirtyCount).toBe(1);
    expect(grid.selectedRecord).toMatchObject({ id: 1 });
    expect(navigator.nextButton.enabled).toBe(true);
    expect(navigator.priorButton.enabled).toBe(false);

    navigator.editButton.onClick?.();
    navigator.cancelButton.onClick?.();
    expect(dataset.state).toBe("dsBrowse");
    navigator.dispose();
    grid.dispose();
  });

  it("routes arrow keys once and keeps grid navigation within the record range", async () => {
    const { dataSource, dataset } = await makeSource();
    const form = new TComponent("form");
    const grid = new TDBGrid({ dataSource });
    const navigator = new TDBNavigator({ dataSource });
    form.add(grid);
    form.add(navigator);

    const key = (value: string) => ({
      key: value,
      code: value,
      down: true,
      repeat: false,
      ctrl: false,
      shift: false,
      alt: false,
    });

    expect(form.handleKeyEvent(key("ArrowDown"))).toBe(true);
    expect(dataset.currentIndex).toBe(1);
    expect(form.handleKeyEvent(key("ArrowDown"))).toBe(true);
    expect(dataset.currentIndex).toBe(1);
    form.handleKeyEvent(key("ArrowUp"));
    expect(dataset.currentIndex).toBe(0);
    form.handleKeyEvent(key("ArrowUp"));
    expect(dataset.currentIndex).toBe(0);
    form.handleKeyEvent(key("ArrowRight"));
    expect(dataset.currentIndex).toBe(1);
    form.handleKeyEvent(key("ArrowLeft"));
    expect(dataset.currentIndex).toBe(0);

    form.disposeTree();
  });

  it("lets a standalone navigator handle arrows and post an active edit", async () => {
    const { dataSource, dataset } = await makeSource();
    const form = new TComponent("form");
    const navigator = new TDBNavigator({ dataSource });
    form.add(navigator);
    dataset.edit();
    dataSource.setField("value", 11);

    form.handleKeyEvent({
      key: "ArrowDown",
      code: "ArrowDown",
      down: true,
      repeat: false,
      ctrl: false,
      shift: false,
      alt: false,
    });

    expect(dataset.state).toBe("dsBrowse");
    expect(dataset.currentIndex).toBe(1);
    expect(dataset.records[0].value).toBe(11);
    expect(dataset.dirtyCount).toBe(1);
    form.disposeTree();
  });

  it("reports failed provider writes from the navigator", async () => {
    const { dataSource, dataset, driver } = await makeSource();
    const navigator = new TDBNavigator({ dataSource });
    const onError = vi.fn();
    navigator.onError = onError;

    dataset.edit();
    dataset.setField("value", 11);
    dataset.post();
    vi.mocked(driver.execute).mockRejectedValueOnce(new Error("write failed"));

    navigator.applyButton.onClick?.();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][0]).toMatchObject({
      message: expect.stringContaining("write failed"),
    });
    navigator.dispose();
  });

  it("validates invalid field bindings once metadata is available", async () => {
    const { dataSource } = await makeSource();

    expect(
      () => new TDBText({ dataSource, field: "missing" }),
    ).toThrowError(EDatabaseError);
  });
});

describe("TDBGrid hanya diisi dari TDataSource (P0-4)", () => {
  const expectUnsupported = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(EComponentError);
      expect((error as EComponentError).code).toBe("UNSUPPORTED");
      return;
    }
    throw new Error("expected UNSUPPORTED");
  };

  it("menolak setData/appendData dan setter data, tanpa mengubah isi grid", async () => {
    const { dataSource } = await makeSource();
    const grid = new TDBGrid({ id: "g", dataSource });
    await grid.refresh();
    const before = grid.data.map((row) => row.id);

    await expect(grid.setData([{ id: 99 }])).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(grid.appendData([{ id: 99 }])).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expectUnsupported(() => {
      grid.data = [{ id: 99 }];
    });

    expect(grid.data.map((row) => row.id)).toEqual(before);
  });

  it("kolom auto tidak bisa diganti manual", async () => {
    const { dataSource } = await makeSource();
    const grid = new TDBGrid({ id: "g", dataSource });
    await grid.refresh();

    await expect(grid.setColumns([{ key: "id", label: "ID" }])).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expectUnsupported(() => {
      grid.columns = [{ key: "id", label: "ID" }];
    });
    expect(grid.columns.map((c) => c.key)).toEqual(["id", "value", "notes"]);
  });

  it("kolom eksplisit boleh diganti; data tetap dari dataset", async () => {
    const { dataSource, dataset } = await makeSource();
    const grid = new TDBGrid({ id: "g", dataSource, columns: [{ key: "id", label: "ID" }] });
    await grid.refresh();

    await grid.setColumns([{ key: "value", label: "Nilai" }]);
    expect(grid.columns.map((c) => c.key)).toEqual(["value"]);

    dataset.last();
    await grid.refresh();
    expect(grid.data).toHaveLength(2);
    expect(grid.selectedRecord).toMatchObject({ id: 2 });
  });
});
