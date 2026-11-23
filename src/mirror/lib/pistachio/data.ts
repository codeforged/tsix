/**
 * pistachio/data.ts — Koneksi dan query database Pistachio.
 *
 * (c) 2026 TSIX Project
 */

import { db } from "@tsix/Application";
import { defineProps, TComponent, TOptions } from "./core";
import type {
  DbConfig,
  DbQueryField,
  DbQueryParameters,
  DbQueryResult,
} from "../DbLib";

export type TFieldType =
  | "ftString"
  | "ftInteger"
  | "ftFloat"
  | "ftBoolean"
  | "ftDateTime"
  | "ftBlob"
  | "ftJSON";

export interface TFieldDef {
  name: string;
  sourceName?: string;
  type: TFieldType;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  table?: string;
}

export interface TDBResult {
  rows: Record<string, unknown>[];
  fields: TFieldDef[];
  affectedRows?: number;
  insertId?: number | string;
}

export interface TDBCapabilities {
  canWrite: boolean;
  canTransact: boolean;
  canParam: boolean;
}

export interface TDBDriver {
  readonly name: string;
  readonly capabilities: Readonly<TDBCapabilities>;
  connect(config: TDBConfig): Promise<void>;
  disconnect(): Promise<void>;
  execute(sql: string, params: TDBParams): Promise<TDBResult>;
  quoteIdent(name: string): string;
}

export type TDBConfig = DbConfig;
export type TDBParams = DbQueryParameters;

export interface TDBConnectionOptions extends TOptions, TDBConfig {
  driver?: string | TDBDriver;
}

export interface TDBQueryOptions extends TOptions {
  connection: TDBConnection;
  sql: string;
  params?: TDBParams;
}

export type TDatabaseErrorCode =
  | "DRIVER_NOT_FOUND"
  | "CONNECTION_ALREADY_OPEN"
  | "CONNECTION_NOT_OPEN"
  | "CONNECTION_FAILED"
  | "DISCONNECT_FAILED"
  | "QUERY_FAILED"
  | "QUERY_NOT_OPEN"
  | "INVALID_QUERY"
  | "PROVIDER_NOT_WRITABLE"
  | "PROVIDER_NOT_UPDATABLE"
  | "INVALID_UPDATE"
  | "DATASET_ALREADY_OPEN"
  | "DATASET_NOT_OPEN"
  | "DATASET_DIRTY"
  | "DATASET_NOT_BROWSE"
  | "INVALID_FIELD"
  /** Wiring stack DB salah tipe (mis. `TProvider` tanpa `TDBQuery`). */
  | "INVALID_BINDING";

export class EDatabaseError extends Error {
  public readonly code: TDatabaseErrorCode;
  public readonly driver?: string;
  public readonly cause?: unknown;

  constructor(
    code: TDatabaseErrorCode,
    message: string,
    driver?: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "EDatabaseError";
    this.code = code;
    this.driver = driver;
    this.cause = cause;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pageableSelect(sql: string): string {
  let source = sql.trim();
  if (source.endsWith(";")) source = source.slice(0, -1).trimEnd();
  if (!/^(SELECT|WITH)\b/i.test(source)) {
    throw new EDatabaseError(
      "INVALID_QUERY",
      "TDBPager requires a single SELECT query",
    );
  }

  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      if (char === "\\" && quote !== "`") {
        index++;
      } else if (char === quote) {
        if (next === quote) index++;
        else quote = null;
      }
      continue;
    }

    if (
      char === "-" &&
      next === "-" &&
      (source[index + 2] === undefined || /\s/.test(source[index + 2]))
    ) {
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (char === "#") {
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) {
        throw new EDatabaseError("INVALID_QUERY", "Unclosed SQL comment");
      }
      index = end + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth++;
      continue;
    }
    if (char === ")") {
      depth--;
      if (depth < 0) {
        throw new EDatabaseError("INVALID_QUERY", "Unbalanced SQL query");
      }
      continue;
    }
    if (depth === 0 && char === ";") {
      throw new EDatabaseError(
        "INVALID_QUERY",
        "TDBPager cannot page multiple SQL statements",
      );
    }
    if (depth === 0 && /[A-Za-z_]/.test(char)) {
      const start = index;
      while (/[A-Za-z0-9_]/.test(source[index] ?? "")) index++;
      const keyword = source.slice(start, index).toUpperCase();
      index--;
      if (keyword === "LIMIT" || keyword === "OFFSET") {
        throw new EDatabaseError(
          "INVALID_QUERY",
          "Remove the top-level LIMIT/OFFSET; TDBPager adds them automatically",
        );
      }
    }
  }

  if (quote || depth !== 0) {
    throw new EDatabaseError("INVALID_QUERY", "Unbalanced SQL query");
  }
  return source;
}

function mapMySQLType(code: number | undefined): TFieldType {
  switch (code) {
    case 1:
    case 2:
    case 3:
    case 8:
    case 9:
    case 13:
      return "ftInteger";
    case 4:
    case 5:
    case 0:
    case 246:
      return "ftFloat";
    case 7:
    case 10:
    case 11:
    case 12:
    case 14:
    case 17:
    case 18:
    case 19:
      return "ftDateTime";
    case 16:
      return "ftBoolean";
    case 245:
      return "ftJSON";
    case 249:
    case 250:
    case 251:
    case 252:
    case 255:
      return "ftBlob";
    default:
      return "ftString";
  }
}

function mapMySQLField(field: DbQueryField): TFieldDef {
  const flags = field.flags ?? 0;
  const tableName = field.orgTable || field.table;
  return {
    name: field.name,
    ...(field.orgName ? { sourceName: field.orgName } : {}),
    type: mapMySQLType(field.columnType),
    nullable: (flags & 1) === 0,
    primaryKey: (flags & 2) !== 0,
    autoIncrement: (flags & 512) !== 0,
    ...(tableName
      ? {
          table: field.schema
            ? `${field.schema}.${tableName}`
            : tableName,
        }
      : {}),
  };
}

function hasError(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  );
}

class TMySQLDriver implements TDBDriver {
  readonly name = "mysql";
  readonly capabilities = Object.freeze({
    canWrite: true,
    canTransact: false,
    canParam: true,
  });

  async connect(config: TDBConfig): Promise<void> {
    const connected = await db.connect(config);
    if (!connected) {
      throw new EDatabaseError(
        "CONNECTION_FAILED",
        "MySQL connection failed",
        this.name,
      );
    }
  }

  async disconnect(): Promise<void> {
    const disconnected = await db.disconnect();
    if (!disconnected) {
      throw new EDatabaseError(
        "DISCONNECT_FAILED",
        "MySQL disconnect failed",
        this.name,
      );
    }
  }

  async execute(sql: string, params: TDBParams): Promise<TDBResult> {
    const response = await db.queryWithFields(sql, params);
    if (hasError(response)) {
      throw new EDatabaseError("QUERY_FAILED", response.error, this.name);
    }

    const result = response as DbQueryResult;
    const rows = Array.isArray(result.rows)
      ? (result.rows as Record<string, unknown>[])
      : [];
    return {
      rows,
      fields: result.fields.map(mapMySQLField),
      ...(result.affectedRows !== undefined
        ? { affectedRows: result.affectedRows }
        : {}),
      ...(result.insertId !== undefined ? { insertId: result.insertId } : {}),
    };
  }

  quoteIdent(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
  }
}

let activeProcessConnection: TDBConnection | null = null;

function resolveDriver(
  driver: string | TDBDriver | undefined,
): { driver: TDBDriver; processScoped: boolean } {
  if (driver === undefined || driver === "mysql") {
    return { driver: new TMySQLDriver(), processScoped: true };
  }

  if (typeof driver === "string") {
    throw new EDatabaseError(
      "DRIVER_NOT_FOUND",
      `Database driver "${driver}" is not registered`,
      driver,
    );
  }

  return { driver, processScoped: false };
}

const CONNECTION_PROPS = defineProps<TDBConnectionOptions>()([
  "driver",
  "host",
  "port",
  "user",
  "password",
  "database",
]);

/** Koneksi database non-visual yang dimiliki satu proses TSIX. */
export class TDBConnection extends TComponent {
  public readonly driver: TDBDriver;

  private readonly config: TDBConfig;
  private readonly processScoped: boolean;
  private _connected = false;
  private _opening = false;

  constructor(
    idOrOpts?: string | TDBConnectionOptions,
    opts?: TDBConnectionOptions,
  ) {
    super(idOrOpts, opts, CONNECTION_PROPS);

    const options = this.options as TDBConnectionOptions;
    const resolved = resolveDriver(options.driver);
    this.driver = resolved.driver;
    this.processScoped = resolved.processScoped;
    this.config = {
      host: options.host,
      user: options.user,
      password: options.password,
      database: options.database,
      ...(options.port !== undefined ? { port: options.port } : {}),
    };
    this.isVisual = false;
  }

  get connected(): boolean {
    return this._connected;
  }

  get capabilities(): Readonly<TDBCapabilities> {
    return this.driver.capabilities;
  }

  async open(): Promise<void> {
    if (this._connected) return;
    if (this._opening) {
      throw new EDatabaseError(
        "CONNECTION_ALREADY_OPEN",
        "Database connection is already opening",
        this.driver.name,
      );
    }
    if (!this.config.host || !this.config.user || !this.config.database) {
      throw new EDatabaseError(
        "CONNECTION_FAILED",
        "host, user, and database are required",
        this.driver.name,
      );
    }
    if (
      this.config.port !== undefined &&
      (!Number.isInteger(this.config.port) ||
        this.config.port < 1 ||
        this.config.port > 65535)
    ) {
      throw new EDatabaseError(
        "CONNECTION_FAILED",
        "port must be an integer between 1 and 65535",
        this.driver.name,
      );
    }
    if (
      this.processScoped &&
      activeProcessConnection &&
      activeProcessConnection !== this
    ) {
      throw new EDatabaseError(
        "CONNECTION_ALREADY_OPEN",
        "Only one built-in database connection is supported per process",
        this.driver.name,
      );
    }

    if (this.processScoped) activeProcessConnection = this;
    this._opening = true;
    try {
      await this.driver.connect(this.config);
      this._connected = true;
    } catch (error) {
      if (activeProcessConnection === this) activeProcessConnection = null;
      if (error instanceof EDatabaseError) throw error;
      throw new EDatabaseError(
        "CONNECTION_FAILED",
        messageOf(error),
        this.driver.name,
        error,
      );
    } finally {
      this._opening = false;
    }
  }

  async close(): Promise<void> {
    if (this._opening) {
      throw new EDatabaseError(
        "CONNECTION_ALREADY_OPEN",
        "Wait for the connection attempt to finish before closing it",
        this.driver.name,
      );
    }
    if (!this._connected) return;
    try {
      await this.driver.disconnect();
    } catch (error) {
      if (error instanceof EDatabaseError) throw error;
      throw new EDatabaseError(
        "DISCONNECT_FAILED",
        messageOf(error),
        this.driver.name,
        error,
      );
    } finally {
      this._connected = false;
      if (activeProcessConnection === this) activeProcessConnection = null;
    }
  }

  async execute(
    sql: string,
    params: TDBParams = [],
  ): Promise<TDBResult> {
    if (!this._connected) {
      throw new EDatabaseError(
        "CONNECTION_NOT_OPEN",
        "Open the database connection before executing a query",
        this.driver.name,
      );
    }
    if (typeof sql !== "string" || !sql.trim()) {
      throw new EDatabaseError(
        "INVALID_QUERY",
        "SQL query must not be empty",
        this.driver.name,
      );
    }

    try {
      return await this.driver.execute(sql, params);
    } catch (error) {
      if (error instanceof EDatabaseError) throw error;
      throw new EDatabaseError(
        "QUERY_FAILED",
        messageOf(error),
        this.driver.name,
        error,
      );
    }
  }

  quoteIdent(name: string): string {
    return this.driver.quoteIdent(name);
  }

  override dispose(): void {
    if (this._connected) {
      void this.close().catch((error) => {
        console.error(`[Pistachio] Failed to close DB connection ${this.id}:`, error);
      });
    }
    super.dispose();
  }
}

const QUERY_PROPS = defineProps<TDBQueryOptions>()(["connection", "sql", "params"]);

/** Definisi query SQL; hasil dan metadata dikembalikan oleh setiap eksekusi. */
export class TDBQuery extends TComponent {
  private _connection: TDBConnection;
  private _sql: string;
  private _params: TDBParams;
  private _fields: TFieldDef[] = [];
  private _open = false;
  private _pageSize: number | null = null;
  private _pageIndex = 0;
  private _totalCount: number | null = null;

  constructor(
    idOrOpts?: string | TDBQueryOptions,
    opts?: TDBQueryOptions,
  ) {
    super(idOrOpts, opts, QUERY_PROPS);
    const options = this.options as TDBQueryOptions;
    if (!(options.connection instanceof TDBConnection)) {
      throw new EDatabaseError(
        "INVALID_BINDING",
        "TDBQuery requires a TDBConnection",
      );
    }
    if (typeof options.sql !== "string" || !options.sql.trim()) {
      throw new EDatabaseError("INVALID_QUERY", "TDBQuery requires SQL");
    }
    this._connection = options.connection;
    this._sql = options.sql;
    this._params = options.params ?? [];
    this.isVisual = false;
  }

  get connection(): TDBConnection {
    return this._connection;
  }

  set connection(value: TDBConnection) {
    if (!(value instanceof TDBConnection)) {
      throw new EDatabaseError(
        "INVALID_BINDING",
        "TDBQuery requires a TDBConnection",
      );
    }
    this._connection = value;
  }

  get sql(): string {
    return this._sql;
  }

  set sql(value: string) {
    if (value === this._sql) return;
    this._sql = value;
    this._pageIndex = 0;
    this._totalCount = null;
  }

  get params(): TDBParams {
    return this._params;
  }

  set params(value: TDBParams) {
    this._params = value;
    this._pageIndex = 0;
    this._totalCount = null;
  }

  get fields(): readonly TFieldDef[] {
    return this._fields;
  }

  get isOpen(): boolean {
    return this._open;
  }

  get pageSize(): number | null {
    return this._pageSize;
  }

  get pageIndex(): number {
    return this._pageIndex;
  }

  get totalCount(): number | null {
    return this._totalCount;
  }

  setPaging(pageSize: number): void {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new EDatabaseError(
        "INVALID_QUERY",
        "Page size must be a positive safe integer",
      );
    }
    if (this._pageSize !== pageSize) {
      pageableSelect(this._sql);
      this._pageSize = pageSize;
      this._pageIndex = 0;
      this._totalCount = null;
    }
  }

  setPageIndex(pageIndex: number): void {
    if (
      !Number.isSafeInteger(pageIndex) ||
      pageIndex < 0 ||
      (this._pageSize !== null &&
        pageIndex > Math.floor(Number.MAX_SAFE_INTEGER / this._pageSize))
    ) {
      throw new EDatabaseError(
        "INVALID_QUERY",
        "Page index must be a non-negative safe integer",
      );
    }
    this._pageIndex = pageIndex;
  }

  async open(): Promise<TDBResult> {
    if (this._open) {
      throw new EDatabaseError(
        "INVALID_QUERY",
        "TDBQuery is already open",
        this._connection.driver.name,
      );
    }
    this._open = true;
    try {
      return await this.executeCurrent();
    } catch (error) {
      this._open = false;
      throw error;
    }
  }

  /** Jalankan ulang query terbuka, misalnya setelah parameternya berubah. */
  async fetch(): Promise<TDBResult> {
    if (!this._open) {
      throw new EDatabaseError(
        "QUERY_NOT_OPEN",
        "Open the query before fetching data",
        this._connection.driver.name,
      );
    }
    return await this.executeCurrent();
  }

  close(): void {
    this._open = false;
    this._fields = [];
    this._totalCount = null;
  }

  override dispose(): void {
    this.close();
    super.dispose();
  }

  private async executeCurrent(): Promise<TDBResult> {
    if (this._pageSize === null) {
      const result = await this._connection.execute(this._sql, this._params);
      this._fields = result.fields;
      this._totalCount = null;
      return result;
    }

    const baseSql = pageableSelect(this._sql);
    const countResult = await this._connection.execute(
      `SELECT COUNT(*) AS __tsix_total_count FROM (${baseSql}\n) AS __tsix_paging_count`,
      this._params,
    );
    const rawCount = countResult.rows[0]?.__tsix_total_count;
    const totalCount =
      typeof rawCount === "number" ? rawCount : Number(rawCount);
    if (
      rawCount === null ||
      rawCount === undefined ||
      !Number.isSafeInteger(totalCount) ||
      totalCount < 0
    ) {
      throw new EDatabaseError(
        "QUERY_FAILED",
        "The database returned an invalid total count for TDBPager",
        this._connection.driver.name,
      );
    }

    const pageCount = Math.ceil(totalCount / this._pageSize);
    this._pageIndex = Math.min(
      this._pageIndex,
      Math.max(0, pageCount - 1),
    );
    const offset = this._pageIndex * this._pageSize;
    const result = await this._connection.execute(
      `${baseSql}\nLIMIT ${this._pageSize} OFFSET ${offset}`,
      this._params,
    );
    this._fields = result.fields;
    this._totalCount = totalCount;
    return result;
  }
}

export interface TProviderOptions extends TOptions {
  query: TDBQuery;
  tableName?: string;
  primaryKey?: readonly string[];
}

export interface TProviderCapabilities extends TDBCapabilities {
  canFetch: true;
  canInsert: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export type TProviderChange =
  | {
      kind: "insert";
      values: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "update";
      keys: Readonly<Record<string, unknown>>;
      values: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "delete";
      keys: Readonly<Record<string, unknown>>;
    };

export type TProviderApplyRowResult =
  | {
      index: number;
      kind: TProviderChange["kind"];
      success: true;
      affectedRows?: number;
      insertId?: number | string;
    }
  | {
      index: number;
      kind: TProviderChange["kind"];
      success: false;
      error: EDatabaseError;
    };

export interface TProviderApplyResult {
  results: TProviderApplyRowResult[];
  succeeded: number;
  failed: number;
}

interface TPreparedProviderChange {
  kind: TProviderChange["kind"];
  sql: string;
  params: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROVIDER_PROPS = defineProps<TProviderOptions>()([
  "query",
  "tableName",
  "primaryKey",
]);

/** Jembatan non-visual dari TDBQuery ke buffer dataset. */
export class TProvider extends TComponent {
  private readonly _query: TDBQuery;
  private readonly _tableName?: string;
  private readonly _primaryKey?: readonly string[];

  constructor(
    idOrOpts?: string | TProviderOptions,
    opts?: TProviderOptions,
  ) {
    super(idOrOpts, opts, PROVIDER_PROPS);
    const options = this.options as TProviderOptions;
    if (!(options.query instanceof TDBQuery)) {
      throw new EDatabaseError(
        "INVALID_BINDING",
        "TProvider requires a TDBQuery",
      );
    }
    if (
      options.tableName !== undefined &&
      (typeof options.tableName !== "string" ||
        !options.tableName.trim() ||
        options.tableName.split(".").some((part) => !part.trim()))
    ) {
      throw new EDatabaseError(
        "INVALID_UPDATE",
        "tableName must be a non-empty identifier",
      );
    }
    if (
      options.primaryKey !== undefined &&
      (!Array.isArray(options.primaryKey) ||
        options.primaryKey.length === 0 ||
        options.primaryKey.some((field) => typeof field !== "string") ||
        options.primaryKey.some((field) => !field.trim()) ||
        new Set(options.primaryKey).size !== options.primaryKey.length)
    ) {
      throw new EDatabaseError(
        "INVALID_UPDATE",
        "primaryKey must contain unique, non-empty field names",
      );
    }

    this._query = options.query;
    this._tableName = options.tableName;
    this._primaryKey = options.primaryKey
      ? [...options.primaryKey]
      : undefined;
    this.isVisual = false;
  }

  get query(): TDBQuery {
    return this._query;
  }

  get fields(): readonly TFieldDef[] {
    return this._query.fields;
  }

  get primaryKey(): readonly string[] {
    return this.resolvePrimaryKey();
  }

  get capabilities(): Readonly<TProviderCapabilities> {
    const writable =
      this._query.connection.capabilities.canWrite &&
      this._query.connection.capabilities.canParam;
    const tableName = this.resolveTableName();
    const hasTable = tableName !== null;
    const hasWritableFields = this._query.fields.some(
      (field) => Boolean(field.sourceName) && this.fieldBelongsToTable(field),
    );
    const keys = this.resolvePrimaryKey();
    const hasKeys =
      keys.length > 0 &&
      keys.every(
        (name) => {
          const matches = this._query.fields.filter(
            (field) => field.name === name,
          );
          return (
            matches.length === 1 &&
            Boolean(matches[0].sourceName) &&
            this.fieldBelongsToTable(matches[0])
          );
        },
      );
    return {
      ...this._query.connection.capabilities,
      canFetch: true,
      canInsert: writable && hasTable && hasWritableFields,
      canUpdate: writable && hasTable && hasWritableFields && hasKeys,
      canDelete: writable && hasTable && hasWritableFields && hasKeys,
    };
  }

  async fetch(): Promise<TDBResult> {
    return this._query.isOpen
      ? this._query.fetch()
      : this._query.open();
  }

  /**
   * Apply row changes serially. SQL shape/input errors reject the call;
   * database errors are reported explicitly for each attempted row.
   */
  async apply(
    changes: readonly TProviderChange[],
  ): Promise<TProviderApplyResult> {
    if (!Array.isArray(changes)) {
      throw new EDatabaseError("INVALID_UPDATE", "changes must be an array");
    }
    if (!this._query.isOpen) {
      throw new EDatabaseError(
        "QUERY_NOT_OPEN",
        "Fetch data before applying changes",
        this._query.connection.driver.name,
      );
    }
    if (!this._query.connection.capabilities.canWrite) {
      throw new EDatabaseError(
        "PROVIDER_NOT_WRITABLE",
        "The selected database driver is read-only",
        this._query.connection.driver.name,
      );
    }
    if (!this._query.connection.capabilities.canParam) {
      throw new EDatabaseError(
        "PROVIDER_NOT_WRITABLE",
        "Provider updates require parameterized queries",
        this._query.connection.driver.name,
      );
    }

    const prepared = changes.map((change) => this.prepareChange(change));
    const results: TProviderApplyRowResult[] = [];

    for (let index = 0; index < prepared.length; index++) {
      const change = prepared[index];
      try {
        const result = await this._query.connection.execute(
          change.sql,
          change.params,
        );
        results.push({
          index,
          kind: change.kind,
          success: true,
          ...(result.affectedRows !== undefined
            ? { affectedRows: result.affectedRows }
            : {}),
          ...(result.insertId !== undefined
            ? { insertId: result.insertId }
            : {}),
        });
      } catch (error) {
        const dbError =
          error instanceof EDatabaseError
            ? error
            : new EDatabaseError(
                "QUERY_FAILED",
                messageOf(error),
                this._query.connection.driver.name,
                error,
              );
        results.push({
          index,
          kind: change.kind,
          success: false,
          error: dbError,
        });
      }
    }

    const succeeded = results.filter((result) => result.success).length;
    return {
      results,
      succeeded,
      failed: results.length - succeeded,
    };
  }

  private prepareChange(change: TProviderChange): TPreparedProviderChange {
    if (!isRecord(change)) {
      throw new EDatabaseError(
        "INVALID_UPDATE",
        "Each change must be an object",
      );
    }

    const tableName = this.resolveTableName();
    if (!tableName) {
      throw new EDatabaseError(
        "PROVIDER_NOT_UPDATABLE",
        "A single source table is required for provider updates",
        this._query.connection.driver.name,
      );
    }
    const table = this.quoteTable(tableName);

    if (change.kind === "insert") {
      if (!isRecord(change.values) || Object.keys(change.values).length === 0) {
        throw new EDatabaseError(
          "INVALID_UPDATE",
          "Insert changes require at least one field value",
          this._query.connection.driver.name,
        );
      }
      const entries = this.resolveValues(change.values);
      const params: Record<string, unknown> = {};
      const columns = entries.map(({ field, value }, index) => {
        params[`p${index}`] = value;
        return this.quoteField(field);
      });
      const placeholders = entries.map((_, index) => `:p${index}`);
      return {
        kind: "insert",
        sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
        params,
      };
    }

    if (change.kind !== "update" && change.kind !== "delete") {
      throw new EDatabaseError(
        "INVALID_UPDATE",
        "Change kind must be insert, update, or delete",
        this._query.connection.driver.name,
      );
    }

    const primaryKey = this.resolvePrimaryKey();
    if (primaryKey.length === 0) {
      throw new EDatabaseError(
        "PROVIDER_NOT_UPDATABLE",
        "Primary key metadata or provider primaryKey is required",
        this._query.connection.driver.name,
      );
    }
    if (!isRecord(change.keys)) {
      throw new EDatabaseError(
        "INVALID_UPDATE",
        `${change.kind} changes require key values`,
        this._query.connection.driver.name,
      );
    }

    const keyFields = primaryKey.map((name) => {
      const field = this.resolveField(name);
      const value = change.keys[name];
      if (value === undefined || value === null) {
        throw new EDatabaseError(
          "INVALID_UPDATE",
          `A non-null key value is required for "${name}"`,
          this._query.connection.driver.name,
        );
      }
      return { name, field, value };
    });
    if (
      Object.keys(change.keys).length !== primaryKey.length ||
      primaryKey.some((name) => !Object.hasOwn(change.keys, name))
    ) {
      throw new EDatabaseError(
        "INVALID_UPDATE",
        `${change.kind} keys must contain exactly the configured primary key fields`,
        this._query.connection.driver.name,
      );
    }
    const params: Record<string, unknown> = {};
    const where = keyFields
      .map(({ field, value }, index) => {
        params[`k${index}`] = value;
        return `${this.quoteField(field)} = :k${index}`;
      })
      .join(" AND ");

    if (change.kind === "delete") {
      return {
        kind: "delete",
        sql: `DELETE FROM ${table} WHERE ${where}`,
        params,
      };
    }

    if (!isRecord(change.values) || Object.keys(change.values).length === 0) {
      throw new EDatabaseError(
        "INVALID_UPDATE",
        "Update changes require at least one field value",
        this._query.connection.driver.name,
      );
    }
    const entries = this.resolveValues(change.values);
    entries.forEach(({ value }, index) => {
      params[`p${index}`] = value;
    });
    const set = entries
      .map(
        ({ field }, index) =>
          `${this.quoteField(field)} = :p${index}`,
      )
      .join(", ");
    return {
      kind: "update",
      sql: `UPDATE ${table} SET ${set} WHERE ${where}`,
      params,
    };
  }

  private resolveValues(
    values: Readonly<Record<string, unknown>>,
  ): { field: TFieldDef; value: unknown }[] {
    return Object.entries(values).map(([name, value]) => {
      if (value === undefined) {
        throw new EDatabaseError(
          "INVALID_UPDATE",
          `Undefined is not a valid value for field "${name}"`,
          this._query.connection.driver.name,
        );
      }
      return { field: this.resolveField(name), value };
    });
  }

  private resolveField(name: string): TFieldDef {
    const matches = this._query.fields.filter((field) => field.name === name);
    if (matches.length !== 1) {
      throw new EDatabaseError(
        "INVALID_UPDATE",
        matches.length === 0
          ? `Field "${name}" is not present in the query result`
          : `Field "${name}" is ambiguous in the query result`,
        this._query.connection.driver.name,
      );
    }
    return matches[0];
  }

  private quoteField(field: TFieldDef): string {
    if (!field.sourceName) {
      throw new EDatabaseError(
        "PROVIDER_NOT_UPDATABLE",
        `Source column metadata is unavailable for "${field.name}"`,
        this._query.connection.driver.name,
      );
    }
    if (!this.fieldBelongsToTable(field)) {
      throw new EDatabaseError(
        "PROVIDER_NOT_UPDATABLE",
        `Field "${field.name}" does not belong to the provider table`,
        this._query.connection.driver.name,
      );
    }
    return this._query.connection.quoteIdent(field.sourceName);
  }

  private fieldBelongsToTable(field: TFieldDef): boolean {
    const tableName = this.resolveTableName();
    return !field.table || !tableName || field.table === tableName;
  }

  private resolveTableName(): string | null {
    if (this._tableName) return this._tableName;
    const tables = [
      ...new Set(
        this._query.fields
          .map((field) => field.table)
          .filter((table): table is string => Boolean(table)),
      ),
    ];
    return tables.length === 1 ? tables[0] : null;
  }

  private resolvePrimaryKey(): string[] {
    return (
      this._primaryKey ??
      this._query.fields
        .filter((field) => field.primaryKey)
        .map((field) => field.name)
    ).filter((name) => this._query.fields.some((field) => field.name === name));
  }

  private quoteTable(tableName: string): string {
    const parts = tableName.split(".");
    if (parts.some((part) => !part.trim())) {
      throw new EDatabaseError(
        "INVALID_UPDATE",
        "Table name contains an empty identifier",
        this._query.connection.driver.name,
      );
    }
    return parts
      .map((part) => this._query.connection.quoteIdent(part))
      .join(".");
  }
}

export type TDataSetState = "dsBrowse" | "dsEdit" | "dsInsert";
export type TDataSetEventType = "data" | "cursor" | "state";

export interface TDataSetEvent {
  type: TDataSetEventType;
  dataset: TClientDataset;
}

export interface TClientDatasetOptions extends TOptions {
  provider: TProvider;
}

interface TBufferedRow {
  values: Record<string, unknown>;
  original: Record<string, unknown> | null;
  status: "clean" | "insert" | "update" | "delete";
}

function copyRecord(
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { ...record };
}

function recordsEqual(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => Object.is(left[key], right[key]));
}

const CLIENTDATASET_PROPS = defineProps<TClientDatasetOptions>()(["provider"]);

/** In-memory row buffer with cursor, edit state, filtering, and dirty tracking. */
export class TClientDataset extends TComponent {
  private readonly _provider: TProvider;
  private _rows: TBufferedRow[] = [];
  private _viewRows: TBufferedRow[] = [];
  private _cursor = -1;
  private _state: TDataSetState = "dsBrowse";
  private _open = false;
  private _editingRow: TBufferedRow | null = null;
  private _editBuffer: Record<string, unknown> | null = null;
  private _filter: ((record: Readonly<Record<string, unknown>>) => boolean) | null =
    null;
  private _sort:
    | ((
        left: Readonly<Record<string, unknown>>,
        right: Readonly<Record<string, unknown>>,
      ) => number)
    | null = null;
  private readonly _listeners = new Set<(event: TDataSetEvent) => void>();

  constructor(
    idOrOpts?: string | TClientDatasetOptions,
    opts?: TClientDatasetOptions,
  ) {
    super(idOrOpts, opts, CLIENTDATASET_PROPS);
    const options = this.options as TClientDatasetOptions;
    if (!(options.provider instanceof TProvider)) {
      throw new EDatabaseError(
        "INVALID_BINDING",
        "TClientDataset requires a TProvider",
      );
    }
    this._provider = options.provider;
    this.isVisual = false;
  }

  get provider(): TProvider {
    return this._provider;
  }

  get state(): TDataSetState {
    return this._state;
  }

  get isOpen(): boolean {
    return this._open;
  }

  get currentIndex(): number {
    return this._cursor;
  }

  get recordCount(): number {
    return this._viewRows.length;
  }

  get bof(): boolean {
    return this._cursor < 0;
  }

  get eof(): boolean {
    return this._cursor < 0 || this._cursor >= this._viewRows.length;
  }

  get dirtyCount(): number {
    return this._rows.filter((row) => row.status !== "clean").length;
  }

  get hasChanges(): boolean {
    return this._state !== "dsBrowse" || this.dirtyCount > 0;
  }

  get currentRecord(): Readonly<Record<string, unknown>> | null {
    if (this._editBuffer) return copyRecord(this._editBuffer);
    const row = this.currentRow();
    return row ? copyRecord(row.values) : null;
  }

  get records(): readonly Readonly<Record<string, unknown>>[] {
    return this._viewRows.map((row) =>
      copyRecord(
        row === this._editingRow && this._editBuffer
          ? this._editBuffer
          : row.values,
      ),
    );
  }

  get fields(): readonly TFieldDef[] {
    return this._provider.fields;
  }

  subscribe(listener: (event: TDataSetEvent) => void): () => void {
    if (typeof listener !== "function") {
      throw new EDatabaseError(
        "INVALID_QUERY",
        "Dataset listener must be a function",
      );
    }
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  async open(): Promise<void> {
    if (this._open) {
      throw new EDatabaseError(
        "DATASET_ALREADY_OPEN",
        "Client dataset is already open",
      );
    }
    const result = await this._provider.fetch();
    this._rows = result.rows.map((record) => ({
      values: copyRecord(record),
      original: copyRecord(record),
      status: "clean",
    }));
    this._open = true;
    this._state = "dsBrowse";
    this._rebuildView(null, 0);
    this.emit("data");
    this.emit("state");
    this.emit("cursor");
  }

  async refresh(): Promise<void> {
    this.requireOpen();
    this.requireBrowse();
    if (this.dirtyCount > 0) {
      throw new EDatabaseError(
        "DATASET_DIRTY",
        "Post or cancel pending changes before refreshing the dataset",
      );
    }
    const cursor = this._cursor;
    const result = await this._provider.fetch();
    this._rows = result.rows.map((record) => ({
      values: copyRecord(record),
      original: copyRecord(record),
      status: "clean",
    }));
    this._rebuildView(null, cursor);
    this.emit("data");
    this.emit("cursor");
  }

  close(): void {
    if (!this._open) return;
    if (this.hasChanges) {
      throw new EDatabaseError(
        "DATASET_DIRTY",
        "Post or cancel pending changes before closing the dataset",
      );
    }
    this._rows = [];
    this._viewRows = [];
    this._cursor = -1;
    this._open = false;
    this._state = "dsBrowse";
    this.emit("data");
    this.emit("state");
    this.emit("cursor");
  }

  first(): void {
    this.requireBrowseOpen();
    this._cursor = this._viewRows.length > 0 ? 0 : -1;
    this.emit("cursor");
  }

  next(): void {
    this.requireBrowseOpen();
    if (
      this._viewRows.length > 0 &&
      this._cursor < this._viewRows.length
    ) {
      this._cursor++;
    }
    this.emit("cursor");
  }

  prior(): void {
    this.requireBrowseOpen();
    if (this._cursor >= this._viewRows.length && this._viewRows.length > 0) {
      this._cursor = this._viewRows.length - 1;
    } else if (this._cursor > 0) {
      this._cursor--;
    }
    this.emit("cursor");
  }

  last(): void {
    this.requireBrowseOpen();
    this._cursor = this._viewRows.length - 1;
    this.emit("cursor");
  }

  setCurrentIndex(index: number): void {
    this.requireBrowseOpen();
    if (
      !Number.isInteger(index) ||
      index < -1 ||
      index >= this._viewRows.length
    ) {
      throw new EDatabaseError(
        "INVALID_UPDATE",
        `Dataset cursor index ${index} is out of range`,
      );
    }
    if (index === this._cursor) return;
    this._cursor = index;
    this.emit("cursor");
  }

  getField(name: string): unknown {
    this.requireOpen();
    this.requireField(name);
    return this.currentRecord?.[name];
  }

  setField(name: string, value: unknown): void {
    if (
      this._state !== "dsEdit" &&
      this._state !== "dsInsert"
    ) {
      throw new EDatabaseError(
        "DATASET_NOT_BROWSE",
        "Call edit() or insert() before changing a field",
      );
    }
    this.requireField(name);
    if (value === undefined) {
      throw new EDatabaseError(
        "INVALID_UPDATE",
        `Undefined is not a valid value for field "${name}"`,
      );
    }
    this._editBuffer![name] = value;
    this.emit("data");
  }

  edit(): void {
    this.requireBrowseOpen();
    const row = this.currentRow();
    if (!row) {
      throw new EDatabaseError(
        "DATASET_NOT_BROWSE",
        "There is no current record to edit",
      );
    }
    this._state = "dsEdit";
    this._editingRow = row;
    this._editBuffer = copyRecord(row.values);
    this.emit("state");
    this.emit("data");
  }

  insert(initialValues: Readonly<Record<string, unknown>> = {}): void {
    this.requireBrowseOpen();
    if (!isRecord(initialValues)) {
      throw new EDatabaseError(
        "INVALID_UPDATE",
        "Initial insert values must be an object",
      );
    }
    for (const name of Object.keys(initialValues)) this.requireField(name);
    this._state = "dsInsert";
    this._editingRow = null;
    this._editBuffer = copyRecord(initialValues);
    this.emit("state");
    this.emit("data");
  }

  post(): void {
    if (
      this._state !== "dsEdit" &&
      this._state !== "dsInsert"
    ) {
      throw new EDatabaseError(
        "DATASET_NOT_BROWSE",
        "There are no pending field edits to post",
      );
    }
    const values = copyRecord(this._editBuffer ?? {});
    let row: TBufferedRow;
    if (this._state === "dsInsert") {
      row = { values, original: null, status: "insert" };
      this._rows.push(row);
    } else {
      row = this._editingRow!;
      row.values = values;
      row.status =
        row.status === "insert"
          ? "insert"
          : recordsEqual(values, row.original ?? {})
            ? "clean"
            : "update";
    }
    this._state = "dsBrowse";
    this._editingRow = null;
    this._editBuffer = null;
    this._rebuildView(row, this._cursor);
    this.emit("state");
    this.emit("data");
    this.emit("cursor");
  }

  cancel(): void {
    if (
      this._state !== "dsEdit" &&
      this._state !== "dsInsert"
    ) {
      throw new EDatabaseError(
        "DATASET_NOT_BROWSE",
        "There are no pending field edits to cancel",
      );
    }
    this._state = "dsBrowse";
    this._editingRow = null;
    this._editBuffer = null;
    this.emit("state");
    this.emit("data");
  }

  delete(): void {
    this.requireBrowseOpen();
    const row = this.currentRow();
    if (!row) {
      throw new EDatabaseError(
        "DATASET_NOT_BROWSE",
        "There is no current record to delete",
      );
    }
    const index = this._cursor;
    if (row.status === "insert") {
      this._rows.splice(this._rows.indexOf(row), 1);
    } else {
      row.status = "delete";
    }
    this._rebuildView(null, index);
    this.emit("data");
    this.emit("cursor");
  }

  setFilter(
    predicate: ((record: Readonly<Record<string, unknown>>) => boolean) | null,
  ): void {
    this.requireBrowseOpen();
    if (predicate !== null && typeof predicate !== "function") {
      throw new EDatabaseError("INVALID_QUERY", "Filter must be a function");
    }
    const cursor = this._cursor;
    const row = this.currentRow();
    this._filter = predicate;
    this._rebuildView(row, cursor);
    this.emit("data");
    this.emit("cursor");
  }

  setSort(
    comparator:
      | ((
          left: Readonly<Record<string, unknown>>,
          right: Readonly<Record<string, unknown>>,
        ) => number)
      | null,
  ): void {
    this.requireBrowseOpen();
    if (comparator !== null && typeof comparator !== "function") {
      throw new EDatabaseError("INVALID_QUERY", "Sort must be a function");
    }
    const cursor = this._cursor;
    const row = this.currentRow();
    this._sort = comparator;
    this._rebuildView(row, cursor);
    this.emit("data");
    this.emit("cursor");
  }

  async applyUpdates(): Promise<TProviderApplyResult> {
    this.requireBrowseOpen();
    const pending = this._rows.filter((row) => row.status !== "clean");
    const prepared: { row: TBufferedRow; change: TProviderChange }[] = [];
    const unchanged: TBufferedRow[] = [];
    const primaryKey = this._provider.primaryKey;

    for (const row of pending) {
      if (row.status === "insert") {
        prepared.push({ row, change: { kind: "insert", values: row.values } });
        continue;
      }
      if (row.status === "delete") {
        prepared.push({
          row,
          change: { kind: "delete", keys: this.keyValues(row.original, primaryKey) },
        });
        continue;
      }

      const original = row.original ?? {};
      const values = Object.fromEntries(
        this._provider.fields
          .filter(
            (field) =>
              !Object.is(original[field.name], row.values[field.name]) &&
              Object.hasOwn(row.values, field.name),
          )
          .map((field) => [field.name, row.values[field.name]]),
      );
      if (Object.keys(values).length === 0) {
        unchanged.push(row);
        continue;
      }
      prepared.push({
        row,
        change: {
          kind: "update",
          keys: this.keyValues(row.original, primaryKey),
          values,
        },
      });
    }

    const result =
      prepared.length > 0
        ? await this._provider.apply(prepared.map(({ change }) => change))
        : { results: [], succeeded: 0, failed: 0 };

    for (const row of unchanged) {
      row.values = copyRecord(row.values);
      row.original = copyRecord(row.values);
      row.status = "clean";
    }
    const removed = new Set<TBufferedRow>();
    for (let index = 0; index < result.results.length; index++) {
      const row = prepared[index]?.row;
      const rowResult = result.results[index];
      if (!row || !rowResult || rowResult.index !== index) {
        throw new EDatabaseError(
          "QUERY_FAILED",
          "Provider returned an invalid apply report",
        );
      }
      if (!rowResult.success) continue;

      if (row.status === "delete") {
        removed.add(row);
        continue;
      }
      if (row.status === "insert" && rowResult.insertId !== undefined) {
        const autoField = this._provider.fields.find(
          (field) =>
            field.autoIncrement &&
            this._provider.primaryKey.includes(field.name),
        );
        if (autoField && row.values[autoField.name] === undefined) {
          row.values[autoField.name] = rowResult.insertId;
        }
      }
      row.values = copyRecord(row.values);
      row.original = copyRecord(row.values);
      row.status = "clean";
    }
    if (removed.size > 0) {
      this._rows = this._rows.filter((row) => !removed.has(row));
    }
    if (pending.length > 0) {
      const cursor = this._cursor;
      const row = this.currentRow();
      this._rebuildView(row, cursor);
      this.emit("data");
      this.emit("cursor");
    }
    return result;
  }

  override dispose(): void {
    this._listeners.clear();
    super.dispose();
  }

  private keyValues(
    record: Readonly<Record<string, unknown>> | null,
    primaryKey: readonly string[],
  ): Record<string, unknown> {
    if (!record || primaryKey.length === 0) {
      throw new EDatabaseError(
        "PROVIDER_NOT_UPDATABLE",
        "Primary key values are required to apply this row",
      );
    }
    const values: Record<string, unknown> = {};
    for (const name of primaryKey) {
      if (!Object.hasOwn(record, name)) {
        throw new EDatabaseError(
          "PROVIDER_NOT_UPDATABLE",
          `Primary key field "${name}" is not present in the buffered row`,
        );
      }
      values[name] = record[name];
    }
    return values;
  }

  private requireField(name: string): void {
    if (!this._provider.fields.some((field) => field.name === name)) {
      throw new EDatabaseError(
        "INVALID_FIELD",
        `Field "${name}" is not present in the dataset`,
      );
    }
  }

  private currentRow(): TBufferedRow | null {
    return this._viewRows[this._cursor] ?? null;
  }

  private requireOpen(): void {
    if (!this._open) {
      throw new EDatabaseError(
        "DATASET_NOT_OPEN",
        "Open the dataset before using it",
      );
    }
  }

  private requireBrowse(): void {
    if (this._state !== "dsBrowse") {
      throw new EDatabaseError(
        "DATASET_NOT_BROWSE",
        "Post or cancel the current edit before continuing",
      );
    }
  }

  private requireBrowseOpen(): void {
    this.requireOpen();
    this.requireBrowse();
  }

  private _rebuildView(
    preferredRow: TBufferedRow | null,
    fallbackIndex: number,
  ): void {
    const rows = this._rows.filter(
      (row) =>
        row.status !== "delete" &&
        (!this._filter || this._filter(copyRecord(row.values))),
    );
    if (this._sort) {
      rows.sort((left, right) =>
        this._sort!(copyRecord(left.values), copyRecord(right.values)),
      );
    }
    this._viewRows = rows;
    const preferredIndex = preferredRow ? rows.indexOf(preferredRow) : -1;
    this._cursor =
      preferredIndex >= 0
        ? preferredIndex
        : rows.length > 0
          ? Math.max(0, Math.min(fallbackIndex, rows.length - 1))
          : -1;
  }

  private emit(type: TDataSetEventType): void {
    const event = { type, dataset: this };
    for (const listener of [...this._listeners]) listener(event);
  }
}

export interface TDataSourceOptions extends TOptions {
  dataset: TClientDataset;
}

const DATASOURCE_PROPS = defineProps<TDataSourceOptions>()(["dataset"]);

/** Non-visual binding point that forwards dataset changes to multiple views. */
export class TDataSource extends TComponent {
  private readonly _dataset: TClientDataset;
  private readonly _listeners = new Set<(event: TDataSetEvent) => void>();
  private readonly _unsubscribe: () => void;

  constructor(
    idOrOpts?: string | TDataSourceOptions,
    opts?: TDataSourceOptions,
  ) {
    super(idOrOpts, opts, DATASOURCE_PROPS);
    const options = this.options as TDataSourceOptions;
    if (!(options.dataset instanceof TClientDataset)) {
      throw new EDatabaseError(
        "INVALID_BINDING",
        "TDataSource requires a TClientDataset",
      );
    }
    this._dataset = options.dataset;
    this._unsubscribe = this._dataset.subscribe((event) => {
      for (const listener of [...this._listeners]) listener(event);
    });
    this.isVisual = false;
  }

  get dataset(): TClientDataset {
    return this._dataset;
  }

  get fields(): readonly TFieldDef[] {
    return this._dataset.fields;
  }

  get records(): readonly Readonly<Record<string, unknown>>[] {
    return this._dataset.records;
  }

  get state(): TDataSetState {
    return this._dataset.state;
  }

  get isOpen(): boolean {
    return this._dataset.isOpen;
  }

  get currentIndex(): number {
    return this._dataset.currentIndex;
  }

  get dirtyCount(): number {
    return this._dataset.dirtyCount;
  }

  get capabilities(): Readonly<TProviderCapabilities> {
    return this._dataset.provider.capabilities;
  }

  get currentRecord(): Readonly<Record<string, unknown>> | null {
    return this._dataset.currentRecord;
  }

  get recordCount(): number {
    return this._dataset.recordCount;
  }

  subscribe(listener: (event: TDataSetEvent) => void): () => void {
    if (typeof listener !== "function") {
      throw new EDatabaseError(
        "INVALID_QUERY",
        "Data source listener must be a function",
      );
    }
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  getField(name: string): unknown {
    return this._dataset.getField(name);
  }

  setField(name: string, value: unknown): void {
    this._dataset.setField(name, value);
  }

  edit(): void {
    this._dataset.edit();
  }

  insert(values?: Readonly<Record<string, unknown>>): void {
    this._dataset.insert(values);
  }

  post(): void {
    this._dataset.post();
  }

  cancel(): void {
    this._dataset.cancel();
  }

  delete(): void {
    this._dataset.delete();
  }

  first(): void {
    this._dataset.first();
  }

  next(): void {
    this._dataset.next();
  }

  prior(): void {
    this._dataset.prior();
  }

  last(): void {
    this._dataset.last();
  }

  setCurrentIndex(index: number): void {
    this._dataset.setCurrentIndex(index);
  }

  setFilter(
    predicate: ((record: Readonly<Record<string, unknown>>) => boolean) | null,
  ): void {
    this._dataset.setFilter(predicate);
  }

  setSort(
    comparator:
      | ((
          left: Readonly<Record<string, unknown>>,
          right: Readonly<Record<string, unknown>>,
        ) => number)
      | null,
  ): void {
    this._dataset.setSort(comparator);
  }

  async refresh(): Promise<void> {
    await this._dataset.refresh();
  }

  async applyUpdates(): Promise<TProviderApplyResult> {
    return this._dataset.applyUpdates();
  }

  override dispose(): void {
    this._unsubscribe();
    this._listeners.clear();
    super.dispose();
  }
}
