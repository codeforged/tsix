import { describe, expect, it, vi } from "vitest";
import {
  EDatabaseError,
  TDBConnection,
  TDBQuery,
  TClientDataset,
  TDataSource,
  TProvider,
  type TDBConfig,
  type TDBDriver,
  type TDBResult,
} from "@tsix/pistachio";

function makeDriver(result?: TDBResult): TDBDriver {
  return {
    name: "test",
    capabilities: {
      canWrite: true,
      canTransact: false,
      canParam: true,
    },
    connect: vi.fn(async (_config: TDBConfig) => {}),
    disconnect: vi.fn(async () => {}),
    execute: vi.fn(async () => result ?? { rows: [], fields: [] }),
    quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
  };
}

function makeConnection(driver: TDBDriver): TDBConnection {
  return new TDBConnection({
    driver,
    host: "db.example",
    user: "test",
    password: "",
    database: "test",
  });
}

describe("TDBConnection", () => {
  it("requires an open connection before executing SQL", async () => {
    const connection = makeConnection(makeDriver());

    await expect(connection.execute("SELECT 1")).rejects.toMatchObject({
      code: "CONNECTION_NOT_OPEN",
    });
  });

  it("opens, executes, and closes through the selected driver", async () => {
    const result: TDBResult = {
      rows: [{ id: 1 }],
      fields: [
        {
          name: "id",
          type: "ftInteger",
          nullable: false,
          primaryKey: true,
          autoIncrement: true,
        },
      ],
    };
    const driver = makeDriver(result);
    const connection = makeConnection(driver);

    await connection.open();
    const response = await connection.execute("SELECT :id", { id: 1 });
    await connection.close();

    expect(response).toEqual(result);
    expect(connection.connected).toBe(false);
    expect(driver.connect).toHaveBeenCalledOnce();
    expect(driver.execute).toHaveBeenCalledWith("SELECT :id", { id: 1 });
    expect(driver.disconnect).toHaveBeenCalledOnce();
  });

  it("normalizes a driver failure as EDatabaseError", async () => {
    const driver = makeDriver();
    vi.mocked(driver.connect).mockRejectedValueOnce(new Error("offline"));
    const connection = makeConnection(driver);

    await expect(connection.open()).rejects.toMatchObject({
      name: "EDatabaseError",
      code: "CONNECTION_FAILED",
      message: "offline",
    });
  });

  it("rejects unimplemented driver names", () => {
    expect(
      () =>
        new TDBConnection({
          driver: "sqlite",
          host: "db.example",
          user: "test",
          password: "",
          database: "test",
        }),
    ).toThrowError(EDatabaseError);
  });
});

describe("TDBQuery", () => {
  it("forwards params and exposes field metadata from the result", async () => {
    const driver = makeDriver({
      rows: [{ id: 7 }],
      fields: [
        {
          name: "id",
          type: "ftInteger",
          nullable: false,
          primaryKey: true,
          autoIncrement: false,
        },
      ],
    });
    const connection = makeConnection(driver);
    const query = new TDBQuery({
      connection,
      sql: "SELECT :id",
      params: { id: 7 },
    });

    await connection.open();
    const result = await query.open();

    expect(result.rows).toEqual([{ id: 7 }]);
    expect(query.fields).toEqual(result.fields);
    expect(driver.execute).toHaveBeenCalledWith("SELECT :id", { id: 7 });

    query.params = { id: 8 };
    await query.fetch();
    expect(driver.execute).toHaveBeenLastCalledWith("SELECT :id", { id: 8 });

    query.close();
    await expect(query.fetch()).rejects.toMatchObject({
      code: "QUERY_NOT_OPEN",
    });
    await connection.close();
  });

  it("counts and fetches only the requested page", async () => {
    const fields = [
      {
        name: "id",
        type: "ftInteger" as const,
        nullable: false,
        primaryKey: true,
        autoIncrement: false,
      },
    ];
    const driver = makeDriver();
    vi.mocked(driver.execute).mockImplementation(async (sql) =>
      sql.startsWith("SELECT COUNT(*)")
        ? { rows: [{ __tsix_total_count: "5" }], fields: [] }
        : { rows: [{ id: 3 }, { id: 4 }], fields },
    );
    const connection = makeConnection(driver);
    const query = new TDBQuery({
      connection,
      sql: "SELECT id FROM readings WHERE active = :active ORDER BY id",
      params: { active: true },
    });
    query.setPaging(2);
    query.setPageIndex(1);

    await connection.open();
    const result = await query.open();

    expect(driver.execute).toHaveBeenNthCalledWith(
      1,
      "SELECT COUNT(*) AS __tsix_total_count FROM (SELECT id FROM readings WHERE active = :active ORDER BY id\n) AS __tsix_paging_count",
      { active: true },
    );
    expect(driver.execute).toHaveBeenNthCalledWith(
      2,
      "SELECT id FROM readings WHERE active = :active ORDER BY id\nLIMIT 2 OFFSET 2",
      { active: true },
    );
    expect(result.rows).toEqual([{ id: 3 }, { id: 4 }]);
    expect(query.totalCount).toBe(5);
    expect(query.pageIndex).toBe(1);
    query.close();
    await connection.close();
  });

  it("clamps the requested page and resets paging when SQL changes", async () => {
    const driver = makeDriver();
    vi.mocked(driver.execute).mockImplementation(async (sql) =>
      sql.startsWith("SELECT COUNT(*)")
        ? { rows: [{ __tsix_total_count: 3 }], fields: [] }
        : { rows: [{ id: 3 }], fields: [] },
    );
    const connection = makeConnection(driver);
    const query = new TDBQuery({ connection, sql: "SELECT id FROM readings" });
    query.setPaging(2);
    query.setPageIndex(4);

    await connection.open();
    await query.open();

    expect(query.pageIndex).toBe(1);
    expect(driver.execute).toHaveBeenLastCalledWith(
      "SELECT id FROM readings\nLIMIT 2 OFFSET 2",
      [],
    );

    query.sql = "SELECT id FROM another_table";
    expect(query.pageIndex).toBe(0);
    expect(query.totalCount).toBeNull();
    query.close();
    await connection.close();
  });

  it("rejects queries with a top-level LIMIT or OFFSET when paging is enabled", () => {
    const query = new TDBQuery({
      connection: makeConnection(makeDriver()),
      sql: "SELECT id FROM readings LIMIT 10",
    });

    expect(() => query.setPaging(2)).toThrowError(
      "Remove the top-level LIMIT/OFFSET; TDBPager adds them automatically",
    );
  });
});

describe("TProvider", () => {
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
      nullable: true,
      primaryKey: false,
      autoIncrement: false,
      table: "sensor_data",
    },
  ];

  async function makeProvider(
    driver: TDBDriver,
    queryFields = fields,
    rows: Record<string, unknown>[] = [{ id: 1, value: 22.5 }],
  ): Promise<TProvider> {
    const connection = makeConnection(driver);
    await connection.open();
    const query = new TDBQuery({
      connection,
      sql: "SELECT sensor_id AS id, sensor_value AS value FROM sensor_data",
    });
    const provider = new TProvider({ query });
    vi.mocked(driver.execute).mockResolvedValue({
      rows,
      fields: queryFields,
    });
    return provider;
  }

  it("fetches rows and field metadata through its query", async () => {
    const driver = makeDriver();
    const provider = await makeProvider(driver);

    const result = await provider.fetch();

    expect(result.rows).toEqual([{ id: 1, value: 22.5 }]);
    expect(provider.fields).toEqual(fields);
    expect(provider.capabilities).toMatchObject({
      canFetch: true,
      canInsert: true,
      canUpdate: true,
      canDelete: true,
    });
  });

  describe("TClientDataset and TDataSource", () => {
    it("navigates, sorts, filters, and notifies bound sources", async () => {
      const driver = makeDriver();
      const provider = await makeProvider(driver, fields, [
        { id: 1, value: 10 },
        { id: 2, value: 30 },
        { id: 3, value: 20 },
      ]);
      const dataset = new TClientDataset({ provider });
      const source = new TDataSource({ dataset });
      const events: string[] = [];
      source.subscribe((event) => events.push(event.type));
      await dataset.open();

      expect(source.currentRecord).toEqual({ id: 1, value: 10 });
      source.next();
      expect(source.currentRecord).toEqual({ id: 2, value: 30 });
      dataset.setSort((left, right) => Number(left.id) - Number(right.id));
      dataset.setFilter((record) => Number(record.value) >= 20);

      expect(source.recordCount).toBe(2);
      expect(source.currentRecord).toEqual({ id: 2, value: 30 });
      expect(events).toContain("cursor");
      expect(events).toContain("data");
    });

    it("keeps an empty dataset at both BOF and EOF during navigation", async () => {
      const driver = makeDriver();
      const provider = await makeProvider(driver, fields, []);
      const dataset = new TClientDataset({ provider });
      await dataset.open();
      dataset.next();

      expect(dataset.currentRecord).toBeNull();
      expect(dataset.bof).toBe(true);
      expect(dataset.eof).toBe(true);
    });

    it("supports edit, cancel, post, and protects dirty rows from refresh", async () => {
      const driver = makeDriver();
      const provider = await makeProvider(driver);
      const dataset = new TClientDataset({ provider });
      await dataset.open();

      dataset.edit();
      dataset.setField("value", 99);
      dataset.cancel();
      expect(dataset.currentRecord?.value).toBe(22.5);
      expect(dataset.dirtyCount).toBe(0);

      dataset.edit();
      dataset.setField("value", 24);
      dataset.post();
      expect(dataset.state).toBe("dsBrowse");
      expect(dataset.currentRecord?.value).toBe(24);
      expect(dataset.dirtyCount).toBe(1);
      await expect(dataset.refresh()).rejects.toMatchObject({
        code: "DATASET_DIRTY",
      });

      const result = await dataset.applyUpdates();
      expect(result.succeeded).toBe(1);
      expect(dataset.dirtyCount).toBe(0);
    });

    it("applies pending inserts, updates, and deletes and retains a clean buffer", async () => {
      const driver = makeDriver();
      const provider = await makeProvider(driver, fields, [
        { id: 1, value: 10 },
        { id: 2, value: 20 },
      ]);
      const dataset = new TClientDataset({ provider });
      vi.mocked(driver.execute)
        .mockResolvedValueOnce({
          rows: [
            { id: 1, value: 10 },
            { id: 2, value: 20 },
          ],
          fields,
        })
        .mockResolvedValueOnce({ rows: [], fields, affectedRows: 1 })
        .mockResolvedValueOnce({ rows: [], fields, affectedRows: 1 })
        .mockResolvedValueOnce({
          rows: [],
          fields,
          affectedRows: 1,
          insertId: 3,
        });
      await dataset.open();

      dataset.edit();
      dataset.setField("value", 11);
      dataset.post();
      dataset.last();
      dataset.delete();
      dataset.insert();
      dataset.setField("value", 30);
      dataset.post();

      const result = await dataset.applyUpdates();

      expect(result).toMatchObject({ succeeded: 3, failed: 0 });
      expect(dataset.dirtyCount).toBe(0);
      expect(dataset.recordCount).toBe(2);
      expect(driver.execute).toHaveBeenNthCalledWith(
        2,
        'UPDATE "sensor_data" SET "sensor_value" = :p0 WHERE "sensor_id" = :k0',
        { k0: 1, p0: 11 },
      );
      expect(driver.execute).toHaveBeenNthCalledWith(
        3,
        'DELETE FROM "sensor_data" WHERE "sensor_id" = :k0',
        { k0: 2 },
      );
      expect(driver.execute).toHaveBeenNthCalledWith(
        4,
        'INSERT INTO "sensor_data" ("sensor_value") VALUES (:p0)',
        { p0: 30 },
      );
      expect(dataset.currentRecord).toEqual({ value: 30, id: 3 });
    });

    it("keeps database-failed rows dirty for retry", async () => {
      const driver = makeDriver();
      const provider = await makeProvider(driver);
      const dataset = new TClientDataset({ provider });
      await dataset.open();
      dataset.edit();
      dataset.setField("value", 25);
      dataset.post();
      vi.mocked(driver.execute).mockRejectedValueOnce(
        new Error("temporary write failure"),
      );

      const result = await dataset.applyUpdates();

      expect(result.failed).toBe(1);
      expect(dataset.dirtyCount).toBe(1);
      expect(dataset.currentRecord?.value).toBe(25);
    });
  });

  it("generates parameterized insert, update, and delete statements", async () => {
    const driver = makeDriver();
    const provider = await makeProvider(driver);
    await provider.fetch();

    const result = await provider.apply([
      { kind: "insert", values: { value: 23 } },
      { kind: "update", keys: { id: 1 }, values: { value: 24 } },
      { kind: "delete", keys: { id: 1 } },
    ]);

    expect(result).toMatchObject({ succeeded: 3, failed: 0 });
    expect(driver.execute).toHaveBeenNthCalledWith(
      2,
      'INSERT INTO "sensor_data" ("sensor_value") VALUES (:p0)',
      { p0: 23 },
    );
    expect(driver.execute).toHaveBeenNthCalledWith(
      3,
      'UPDATE "sensor_data" SET "sensor_value" = :p0 WHERE "sensor_id" = :k0',
      { k0: 1, p0: 24 },
    );
    expect(driver.execute).toHaveBeenNthCalledWith(
      4,
      'DELETE FROM "sensor_data" WHERE "sensor_id" = :k0',
      { k0: 1 },
    );
  });

  it("reports each database failure and continues applying later rows", async () => {
    const driver = makeDriver();
    vi.mocked(driver.execute)
      .mockResolvedValueOnce({ rows: [{ id: 1, value: 22.5 }], fields })
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce({ rows: [], fields, affectedRows: 1 });
    const provider = await makeProvider(driver);
    await provider.fetch();

    const result = await provider.apply([
      { kind: "update", keys: { id: 1 }, values: { value: 23 } },
      { kind: "update", keys: { id: 2 }, values: { value: 24 } },
    ]);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0]).toMatchObject({
      success: false,
      error: { name: "EDatabaseError", message: "write failed" },
    });
    expect(result.results[1]).toMatchObject({
      success: true,
      affectedRows: 1,
    });
  });

  it("rejects writes when the driver is read-only", async () => {
    const driver = makeDriver();
    Object.defineProperty(driver, "capabilities", {
      value: { canWrite: false, canTransact: false, canParam: true },
    });
    const provider = await makeProvider(driver);
    await provider.fetch();

    await expect(
      provider.apply([{ kind: "insert", values: { value: 23 } }]),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_WRITABLE" });
    expect(driver.execute).toHaveBeenCalledOnce();
  });

  it("does not allow updates without primary-key metadata", async () => {
    const driver = makeDriver();
    const provider = await makeProvider(
      driver,
      fields.map((field) => ({ ...field, primaryKey: false })),
    );
    await provider.fetch();

    expect(provider.capabilities.canUpdate).toBe(false);
    await expect(
      provider.apply([{ kind: "delete", keys: { id: 1 } }]),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_UPDATABLE" });
  });

  it("does not apply a field from a different source table", async () => {
    const driver = makeDriver();
    const multiTableFields = [
      fields[0],
      { ...fields[1], table: "other_table" },
    ];
    const connection = makeConnection(driver);
    await connection.open();
    const query = new TDBQuery({
      connection,
      sql: "SELECT ...",
    });
    const provider = new TProvider({
      query,
      tableName: "sensor_data",
      primaryKey: ["id"],
    });
    vi.mocked(driver.execute).mockResolvedValue({
      rows: [{ id: 1, value: 22.5 }],
      fields: multiTableFields,
    });
    await provider.fetch();

    await expect(
      provider.apply([
        { kind: "update", keys: { id: 1 }, values: { value: 23 } },
      ]),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_UPDATABLE" });
    expect(driver.execute).toHaveBeenCalledOnce();
  });
});
