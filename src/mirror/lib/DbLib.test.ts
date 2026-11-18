import { describe, expect, it, vi } from "vitest";
import { SyscallCode } from "../../common/SyscallCode";
import { DbLib } from "./DbLib";

describe("DbLib parameterized queries", () => {
  it("keeps the legacy string payload when params are omitted", async () => {
    const dispatch = vi.fn().mockResolvedValue([{ id: 1 }]);
    const db = new DbLib(dispatch);

    await db.query("SELECT 1");

    expect(dispatch).toHaveBeenCalledWith(SyscallCode.DB_QUERY, "SELECT 1");
  });

  it("forwards positional and named parameters", async () => {
    const dispatch = vi.fn().mockResolvedValue([]);
    const db = new DbLib(dispatch);

    await db.query("SELECT ?", [5]);
    await db.query("SELECT :id", { id: 5 });

    expect(dispatch).toHaveBeenNthCalledWith(1, SyscallCode.DB_QUERY, {
      sql: "SELECT ?",
      params: [5],
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, SyscallCode.DB_QUERY, {
      sql: "SELECT :id",
      params: { id: 5 },
    });
  });

  it("requests query metadata explicitly", async () => {
    const dispatch = vi.fn().mockResolvedValue({ rows: [], fields: [] });
    const db = new DbLib(dispatch);

    await db.queryWithFields("SELECT :id", { id: 5 });

    expect(dispatch).toHaveBeenCalledWith(SyscallCode.DB_QUERY, {
      sql: "SELECT :id",
      params: { id: 5 },
      includeFields: true,
    });
  });
});
