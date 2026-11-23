/**
 * pistachio-csv-demo.ts — GUI tester untuk driver CSV read-only Pistachio.
 *
 * Jalankan: pistachio-csv-demo (DOME harus hidup)
 * (c) 2026 TSIX Project
 */

import { Program, fs } from "@tsix/Application";
import {
  EDatabaseError,
  TButton,
  TDataGrid,
  TDBConnection,
  TEdit,
  TForm,
  TLabel,
  TMemo,
  THStack,
  TVStack,
} from "@tsix/pistachio";

export const appMode = "gui";

const SAMPLE_PATH = "/tmp/pistachio-sample.csv";
const SAMPLE_CSV = [
  "id,name,city",
  "1,Ayu,Jakarta",
  "2,Bima,Bandung",
  '3,"Citra, Sari",Surabaya',
].join("\n");

export const main = Program(async () => {
  const form = new TForm({
    title: "Pistachio CSV Driver Tester",
    width: 760,
    height: 620,
    style: { overflow: "auto" },
  });
  const path = new TEdit({
    id: "csv-path",
    text: SAMPLE_PATH,
    placeholder: "Path file CSV",
  });
  const delimiter = new TEdit({
    id: "csv-delimiter",
    text: ",",
    placeholder: "Delimiter",
    style: { width: "60px" },
  });
  const sql = new TMemo({
    id: "csv-query",
    rows: 3,
    text: "SELECT id, name, city FROM people",
    style: { width: "100%" },
  });
  const status = new TLabel({
    id: "csv-status",
    text: "Buat CSV contoh atau masukkan path file CSV yang sudah ada.",
  });
  const grid = new TDataGrid({
    id: "csv-results",
    height: 300,
    columns: [],
    data: [],
  });

  const createSample = new TButton({
    id: "csv-create-sample",
    caption: "Buat CSV Contoh",
  });
  const runQuery = new TButton({
    id: "csv-run-query",
    caption: "Jalankan SELECT",
  });
  const testReadOnly = new TButton({
    id: "csv-test-readonly",
    caption: "Uji Read-only",
  });

  createSample.onClick = () => {
    void fs.writeFile(path.text, SAMPLE_CSV).then((written) => {
      status.text = written
        ? `CSV contoh dibuat: ${path.text}`
        : `Gagal membuat file: ${path.text}`;
    }).catch((error: unknown) => {
      status.text = `Gagal membuat CSV: ${messageOf(error)}`;
    });
  };

  runQuery.onClick = () => {
    void queryCsv().catch((error: unknown) => {
      status.text = `Query gagal: ${messageOf(error)}`;
    });
  };

  testReadOnly.onClick = () => {
    void verifyReadOnly().catch((error: unknown) => {
      status.text = `Tes read-only gagal: ${messageOf(error)}`;
    });
  };

  async function queryCsv(): Promise<void> {
    const connection = createConnection();
    try {
      await connection.open();
      const result = await connection.execute(sql.text);
      await grid.setColumns(result.fields.map((field) => ({
        key: field.name,
        label: field.name,
      })));
      await grid.setData(result.rows);
      status.text = `OK — ${result.rows.length} baris dari ${path.text}`;
    } finally {
      await connection.close();
      connection.dispose();
    }
  }

  async function verifyReadOnly(): Promise<void> {
    const connection = createConnection();
    try {
      await connection.open();
      try {
        await connection.execute("DELETE FROM people");
        status.text = "GAGAL — driver menerima DELETE, seharusnya read-only.";
      } catch (error) {
        if (error instanceof EDatabaseError && error.code === "PROVIDER_NOT_WRITABLE") {
          status.text = "OK — DELETE ditolak dengan PROVIDER_NOT_WRITABLE.";
          return;
        }
        throw error;
      }
    } finally {
      await connection.close();
      connection.dispose();
    }
  }

  function createConnection(): TDBConnection {
    return new TDBConnection({
      driver: "csv",
      path: path.text.trim(),
      delimiter: delimiter.text || ",",
    });
  }

  form.add(new TVStack({
    id: "csv-layout",
    children: [
      new TLabel({
        text: "Driver CSV Pistachio: baca file CSV, jalankan SELECT, dan verifikasi bahwa penulisan ditolak.",
      }),
      new THStack({
        children: [
          new TLabel({ text: "File:" }),
          path,
          new TLabel({ text: "Delimiter:" }),
          delimiter,
        ],
      }),
      new TLabel({ text: "Query SELECT:" }),
      sql,
      new THStack({ children: [createSample, runQuery, testReadOnly] }),
      status,
      grid,
    ],
  }));

  await form.run();
});

function messageOf(error: unknown): string {
  if (error instanceof EDatabaseError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
