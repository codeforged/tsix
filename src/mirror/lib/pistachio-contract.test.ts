/**
 * pistachio-contract.test.ts — Tes kontrak lintas-komponen (P2-3).
 *
 * Setiap kelas yang diekspor barrel `@tsix/pistachio` otomatis diuji terhadap
 * konvensi di wiki/pistachio-improve-plan.md §3:
 *   (a) tiga bentuk konstruktor   (b) `UNKNOWN_PROP`   (c) `isVisual` eksplisit
 *   (d) `dispose()` idempoten     (e) setter publik menyinkronkan UI setelah bind
 *   (f) nama event mengikuti K1
 *
 * Kelas baru yang butuh opsi wajib harus didaftarkan di `FIXTURES`; bila tidak,
 * tes konstruktornya gagal dengan pesan yang menunjuk ke sini.
 *
 * Pelanggaran yang SUDAH diketahui dicatat di `KNOWN_VIOLATIONS` dan dijalankan
 * sebagai `it.fails`. Saat paket P1 memperbaikinya, `it.fails` itu berubah gagal
 * — hapus entrinya dari daftar. Jangan menambah entri baru tanpa ID paket kerja.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as P from "@tsix/pistachio";
import {
  defineProps,
  EComponentError,
  TButton,
  TClientDataset,
  TComponent,
  TDataGrid,
  TDataSource,
  TDBConnection,
  TDBQuery,
  TEdit,
  TForm,
  TImage,
  TKeyboard,
  TMemo,
  TProvider,
  TSlider,
  TTabulatorGrid,
  TTreeView,
  type TDBDriver,
  type TOptions,
  type TScreenPort,
} from "@tsix/pistachio";

type Ctor = new (idOrOpts?: any, opts?: any) => TComponent;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeDriver(): TDBDriver {
  return {
    name: "contract",
    capabilities: { canWrite: true, canTransact: false, canParam: true },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    execute: vi.fn(async () => ({
      rows: [
        { id: 1, notes: "first" },
        { id: 2, notes: "second" },
      ],
      fields: [
        { name: "id", sourceName: "id", type: "ftInteger" as const, nullable: false, primaryKey: true, autoIncrement: true, table: "t" },
        { name: "notes", sourceName: "notes", type: "ftString" as const, nullable: true, primaryKey: false, autoIncrement: false, table: "t" },
      ],
    })),
    quoteIdent: (name) => `"${name}"`,
  };
}

// Dibangun saat modul dimuat (konstruksi tidak butuh koneksi), supaya nama
// event kelas DB bisa dikumpulkan saat koleksi tes; dibuka di beforeAll.
const SQL = "SELECT id, notes FROM t";
function makeStack() {
  const connection = new TDBConnection({ driver: makeDriver(), host: "h", user: "u", password: "", database: "d" });
  const dataset = new TClientDataset({ provider: new TProvider({ query: new TDBQuery({ connection, sql: SQL }) }) });
  return { connection, dataset, dataSource: new TDataSource({ dataset }) };
}
const stack = makeStack();
const { connection, dataset } = stack;

beforeAll(async () => {
  await connection.open();
  await dataset.open();
});

const newQuery = () => new TDBQuery({ connection: stack.connection, sql: SQL });

/** Opsi minimal: yang wajib, atau yang dibutuhkan agar setter bisa diuji (mis. `items`). */
const FIXTURES: Record<string, () => Record<string, any>> = {
  TComboBox: () => ({ items: ["a", "b", "c"] }),
  TListBox: () => ({ items: ["a", "b", "c"] }),
  TDBQuery: () => ({ connection: stack.connection, sql: SQL }),
  TProvider: () => ({ query: newQuery() }),
  TClientDataset: () => ({ provider: new TProvider({ query: newQuery() }) }),
  TDataSource: () => ({ dataset: stack.dataset }),
  TDBText: () => ({ dataSource: stack.dataSource, field: "notes" }),
  TDBEdit: () => ({ dataSource: stack.dataSource, field: "notes" }),
  TDBMemo: () => ({ dataSource: stack.dataSource, field: "notes" }),
  TDBListBox: () => ({ dataSource: stack.dataSource, field: "notes", items: ["first", "second", "third"] }),
  TDBGrid: () => ({ dataSource: stack.dataSource }),
  TDBNavigator: () => ({ dataSource: stack.dataSource }),
  // Pager mengubah dataset ke mode paging; jangan pakai stack bersama.
  TDBPager: () => ({ dataSource: makeStack().dataSource }),
};

/** K6: komponen non-visual. Kelas lain wajib `isVisual === true`. */
const NON_VISUAL = new Set([
  "TKeyboard",
  "TDBConnection",
  "TDBQuery",
  "TProvider",
  "TClientDataset",
  "TDataSource",
]);

/** Helper statis murni (K6) — sengaja bukan TComponent. */
const STATIC_HELPERS = new Set(["TDialogs"]);

/**
 * K1: event yang boleh ada dan kelas yang boleh memakainya
 * (`"*"` = semua; daftar = `instanceof` salah satu kelas).
 */
const GRIDS = [TDataGrid, TTabulatorGrid];
const EVENT_RULES: Record<string, "*" | Function[]> = {
  onClick: [TButton, TImage],
  onInput: [TEdit, TMemo, TSlider],
  onChange: "*",
  onSelect: [...GRIDS, TTreeView],
  onActivate: [...GRIDS, TTreeView],
  onError: "*",
  onRowClick: GRIDS,
  onSort: GRIDS,
  onRowContextMenu: GRIDS,
  onToggle: [TTreeView],
  // Event siklus hidup spesifik (tanpa padanan umum, K1 baris terakhir).
  onSetup: [TForm],
  onClose: [TForm],
  onKey: [TKeyboard],
};

/** `Kelas:cek` → paket kerja yang akan memperbaikinya. */
const KNOWN_VIOLATIONS: Record<string, string> = {
  // P1-5 (K6): dialog file sebagai komponen non-visual.
  "TOpenDialog:is TComponent": "P1-5",
  "TSaveDialog:is TComponent": "P1-5",
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const exported = Object.entries(P).filter(
  ([name, value]) => typeof value === "function" && /^T[A-Z]/.test(name),
) as [string, Function][];

const components = exported.filter(
  ([, C]) => C === TComponent || C.prototype instanceof TComponent,
) as [string, Ctor][];

function contract(name: string, check: string, fn: () => unknown | Promise<unknown>): void {
  const key = `${name}:${check}`;
  if (KNOWN_VIOLATIONS[key]) {
    it.fails(`${check} [diketahui, ${KNOWN_VIOLATIONS[key]}]`, fn);
  } else {
    it(check, fn);
  }
}

function fixture(name: string): Record<string, any> {
  return FIXTURES[name]?.() ?? {};
}

function construct(name: string, C: Ctor, extra: Record<string, any> = {}): TComponent {
  try {
    return new C({ ...fixture(name), ...extra });
  } catch (error) {
    if (extra.__unknown !== undefined) throw error;
    throw new Error(
      `${name} tidak bisa dibangun dengan fixture: ${(error as Error).message}. ` +
        `Tambahkan opsi minimal di FIXTURES (pistachio-contract.test.ts).`,
    );
  }
}

function createPort() {
  return {
    mount: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
    unmount: vi.fn(async () => {}),
    setContent: vi.fn(async () => {}),
  };
}

/**
 * Host yang semua operasi render-nya gagal (mis. window sudah ditutup).
 * Sengaja tanpa `vi.fn`: mock vitest memasang `.then` pada promise hasil
 * (untuk `settledResults`) sehingga rejection tidak pernah "unhandled".
 */
function createFailingPort() {
  const port = {
    calls: 0,
    mount: async () => fail(),
    update: async () => fail(),
    on: () => {},
    off: () => {},
    unmount: async () => fail(),
    setContent: async () => fail(),
  };
  function fail(): never {
    port.calls++;
    throw new Error("host gone");
  }
  return port;
}

// P2-4: rejection yang lolos dari komponen dicatat per tes.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
});

/** Beri kesempatan event loop melaporkan unhandled rejection. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Tiru `TForm.run()`: bind seluruh subtree lalu refresh. */
async function mount(component: TComponent, port: TScreenPort): Promise<void> {
  const walk = (c: TComponent, fn: (c: TComponent) => void) => {
    fn(c);
    for (const child of c.children) walk(child, fn);
  };
  walk(component, (c) => c.bindEventHandler(port));
  const refresh = async (c: TComponent) => {
    await c.refresh();
    for (const child of c.children) await refresh(child);
  };
  await refresh(component);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function publicSetters(C: Function): string[] {
  const names: string[] = [];
  for (let proto = C.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (desc.set && !key.startsWith("_") && !names.includes(key)) names.push(key);
    }
  }
  return names;
}

/** Nilai baru yang pasti berbeda dari nilai sekarang. */
function nextValue(name: string, prop: string, current: unknown): unknown {
  switch (prop) {
    case "style":
      return { outline: "1px solid red" };
    case "items":
      return ["p", "q", "r"];
    case "columns":
      return [{ key: "k", label: "K" }];
    case "data":
      return name === "TLineChart" ? [1, 2, 3] : [{ k: 1 }];
    case "selectedIndex":
      return current === 1 ? 2 : 1;
    case "src":
      return "data:image/png;base64,AAAA";
  }
  if (typeof current === "boolean") return !current;
  if (typeof current === "number") return current + 1;
  if (typeof current === "string" || current == null) return `${current ?? ""}x`;
  throw new Error(`Tidak tahu nilai uji untuk ${name}.${prop}; tambahkan di nextValue()`);
}

/**
 * Grid Tabulator menyinkronkan lewat IPC DOME (`TB_DATA`/`TB_COLS` via
 * `shell.send`), bukan `TScreenPort`. Untuk kelas itu, panggilan ke method
 * grid emerald yang sesuai (`setData`, `setColumns`, ...) dihitung sebagai sinkron.
 */
function spyIpcChannel(c: TComponent, prop: string) {
  if (!(c instanceof TTabulatorGrid)) return null;
  const grid = (c as any)._grid;
  const method = `set${prop[0].toUpperCase()}${prop.slice(1)}`;
  return typeof grid?.[method] === "function" ? vi.spyOn(grid, method) : null;
}

function eventNames(instance: TComponent): string[] {
  const names = new Set(Object.keys(instance).filter((k) => /^on[A-Z]/.test(k)));
  for (const key of publicSetters(instance.constructor)) {
    if (/^on[A-Z]/.test(key)) names.add(key);
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Tes
// ---------------------------------------------------------------------------

describe("kontrak: kelas yang diekspor", () => {
  it("barrel mengekspor kelas komponen (sanity)", () => {
    expect(components.length).toBeGreaterThan(30);
  });

  for (const [name, C] of exported) {
    if (STATIC_HELPERS.has(name) || components.some(([n]) => n === name)) continue;
    describe(name, () => {
      contract(name, "is TComponent", () => {
        expect(C.prototype).toBeInstanceOf(TComponent);
      });
    });
  }
});

for (const [name, C] of components) {
  describe(`kontrak: ${name}`, () => {
    // (a) tiga bentuk konstruktor
    contract(name, "konstruktor ({...})", () => {
      const c = construct(name, C);
      expect(c).toBeInstanceOf(C);
      expect(c.id).toMatch(/\S/);
    });

    contract(name, "konstruktor ({ id, ... })", () => {
      expect(construct(name, C, { id: "k-obj" }).id).toBe("k-obj");
    });

    contract(name, 'konstruktor ("id", {...})', () => {
      expect(new C("k-pair", fixture(name)).id).toBe("k-pair");
    });

    if (!FIXTURES[name]) {
      contract(name, 'konstruktor ("id")', () => {
        expect(new C("k-str").id).toBe("k-str");
      });
    }

    contract(name, "konstruktor menolak argumen bukan string/objek", () => {
      expect(() => new C(42)).toThrow(expect.objectContaining({ code: "INVALID_OPTIONS" }));
    });

    // (b) props tak dikenal
    contract(name, "UNKNOWN_PROP", () => {
      let error: unknown;
      try {
        construct(name, C, { __unknown: 1 });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(EComponentError);
      expect((error as EComponentError).code).toBe("UNKNOWN_PROP");
    });

    // (c) isVisual eksplisit
    contract(name, "isVisual", () => {
      expect(construct(name, C).isVisual).toBe(!NON_VISUAL.has(name));
    });

    // (d) dispose idempoten
    contract(name, "dispose() idempoten", () => {
      const c = construct(name, C);
      const port = createPort();
      c.bindEventHandler(port);
      c.dispose();
      expect(() => c.dispose()).not.toThrow();
      expect(c.disposed).toBe(true);
      expect(c.host).toBeNull();
      for (const child of c.children) expect(child.disposed).toBe(true);
    });

    // (e) setter publik menyinkronkan UI setelah bind (K2.1)
    if (!NON_VISUAL.has(name)) {
      for (const prop of publicSetters(C)) {
        if (/^on[A-Z]/.test(prop)) continue;
        contract(name, `setter ${prop} sinkron ke UI`, async () => {
          const c = construct(name, C);
          const port = createPort();
          await mount(c, port);
          await flush();
          port.update.mockClear();
          port.setContent.mockClear();
          port.mount.mockClear();
          const ipc = spyIpcChannel(c, prop);

          const value = nextValue(name, prop, (c as any)[prop]);
          try {
            (c as any)[prop] = value;
          } catch (error) {
            // Operasi yang sengaja ditolak (K4) bukan pelanggaran sinkronisasi.
            if (error instanceof EComponentError && error.code === "UNSUPPORTED") return;
            throw error;
          }
          await flush();

          const synced =
            port.update.mock.calls.length +
            port.setContent.mock.calls.length +
            port.mount.mock.calls.length +
            (ipc?.mock.calls.length ?? 0);
          expect(synced, `${name}.${prop} = … tidak memanggil host`).toBeGreaterThan(0);
        });
      }
    }

    // (e2) P2-4: host yang gagal tidak menghasilkan unhandled rejection.
    if (!NON_VISUAL.has(name)) {
      contract(name, "host gagal: tanpa unhandled rejection", async () => {
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
        const c = construct(name, C);
        const port = createFailingPort();
        try {
          await mount(c, port);
        } catch {
          // refresh() yang ditunggu boleh menolak; yang diuji adalah jalur fire-and-forget.
        }
        for (const prop of publicSetters(C)) {
          if (/^on[A-Z]/.test(prop)) continue;
          try {
            (c as any)[prop] = nextValue(name, prop, (c as any)[prop]);
          } catch (error) {
            if (!(error instanceof EComponentError && error.code === "UNSUPPORTED")) throw error;
          }
        }
        c.dispose();
        await settle();
        expect(unhandled, `${name}: rejection lolos dari fire-and-forget`).toEqual([]);
        if (port.calls > 0) expect(errorLog).toHaveBeenCalled();
      });
    }

    // (f) nama event K1 — dikumpulkan dari instance saat koleksi tes.
    let declared: string[] = [];
    try {
      declared = eventNames(construct(name, C));
    } catch {
      // Kegagalan konstruksi sudah dilaporkan oleh tes (a).
    }
    for (const event of declared) {
      contract(name, `event ${event}`, () => {
        const c = construct(name, C);
        expect(eventAllowed(c, event), `${name}.${event} tidak sesuai K1`).toBe(true);
      });
    }
  });
}

function eventAllowed(instance: TComponent, event: string): boolean {
  const rule = EVENT_RULES[event];
  if (!rule) return false;
  return rule === "*" || rule.some((cls) => instance instanceof (cls as any));
}


// ---------------------------------------------------------------------------
// K5 — satu sumber props (diperiksa oleh `npm run typecheck:pistachio`)
// ---------------------------------------------------------------------------

interface TProbeOptions extends TOptions {
  alpha?: string;
  beta?: number;
}
interface TProbeChildOptions extends TProbeOptions {
  gamma?: boolean;
}

describe("kontrak: defineProps (K5)", () => {
  it("menerima daftar yang sama persis dengan interface", () => {
    expect(defineProps<TProbeOptions>()(["alpha", "beta"])).toEqual(["alpha", "beta"]);
    expect(defineProps<TProbeChildOptions, TProbeOptions>()(["gamma"])).toEqual(["gamma"]);
  });

  it("menolak daftar yang tidak cocok saat compile", () => {
    // @ts-expect-error — "beta" ada di interface tapi tidak di array.
    defineProps<TProbeOptions>()(["alpha"]);
    // @ts-expect-error — "delta" tidak ada di interface.
    defineProps<TProbeOptions>()(["alpha", "beta", "delta"]);
    // @ts-expect-error — subclass hanya mendaftarkan props tambahannya.
    defineProps<TProbeChildOptions, TProbeOptions>()(["alpha", "gamma"]);
  });
});

describe("kontrak: pelaporan error async (P2-4)", () => {
  it("diteruskan ke onError bila komponen punya", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const grid = new P.TDBGrid({ dataSource: stack.dataSource });
    const seen: unknown[] = [];
    grid.onError = (error) => seen.push(error);
    (grid as any).background(Promise.reject(new Error("boom")), "test");
    await settle();
    expect(seen).toEqual([expect.objectContaining({ message: "boom" })]);
    expect(errorLog).not.toHaveBeenCalled();
    grid.dispose();
  });

  it("dilog ke console.error bila tidak ada onError, termasuk bila onError melempar", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const label = new P.TLabel("lbl-err");
    (label as any).background(Promise.reject(new Error("boom")), "update");
    await settle();
    expect(errorLog).toHaveBeenCalledWith('[Pistachio] TLabel "lbl-err" update failed:', expect.any(Error));

    errorLog.mockClear();
    const grid = new P.TDBGrid({ dataSource: stack.dataSource });
    grid.onError = () => {
      throw new Error("handler");
    };
    (grid as any).background(Promise.reject(new Error("boom")), "refresh");
    await settle();
    expect(errorLog).toHaveBeenCalledTimes(2);
    expect(unhandled).toEqual([]);
    grid.dispose();
  });
});
