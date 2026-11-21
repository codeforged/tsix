/**
 * pistachio-dbdemo.ts — Demo DB stack Pistachio.
 *
 * Set DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, dan DB_PORT (opsional)
 * di environment TSIX sebelum menjalankan demo.
 *
 * Jalankan: pistachio-dbdemo
 *
 * (c) 2026 TSIX Project
 */

import { Program, shell, std } from "@tsix/Application";
import {
  TClientDataset,
  TDataSource,
  TDBConnection,
  TDBQuery,
  TProvider,
} from "@tsix/pistachio";

export const main = Program(async () => {
  const [host, user, password, database, portValue] = await Promise.all([
    shell.getenv("DB_HOST"),
    shell.getenv("DB_USER"),
    shell.getenv("DB_PASSWORD"),
    shell.getenv("DB_NAME"),
    shell.getenv("DB_PORT"),
  ]);

  if (!host || !user || password === null || !database) {
    await std.print(
      "DB config belum lengkap. Set DB_HOST, DB_USER, DB_PASSWORD, dan DB_NAME.\n",
    );
    return;
  }

  let port: number | undefined;
  if (portValue) {
    const parsedPort = Number(portValue);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      await std.print("DB_PORT harus berupa angka antara 1 dan 65535.\n");
      return;
    }
    port = parsedPort;
  }

  const connection = new TDBConnection({
    driver: "mysql",
    host,
    user,
    password,
    database,
    ...(port !== undefined ? { port } : {}),
  });
  const query = new TDBQuery({
    connection,
    sql: "SELECT :probe AS connection_test",
    params: { probe: 1 },
  });
  const provider = new TProvider({ query });
  const dataset = new TClientDataset({ provider });
  const dataSource = new TDataSource({ dataset });

  try {
    await std.print("▶ Connect via Pistachio TDBConnection...\n");
    await connection.open();
    await std.print("  ✓ Connected\n");

    await dataset.open();
    await std.print(
      `  ✓ Query result: ${JSON.stringify(dataset.records)}\n`,
    );
    await std.print(
      `  ✓ Field metadata: ${JSON.stringify(dataSource.fields)}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await std.print(`❌ DB demo gagal: ${message}\n`);
  } finally {
    dataSource.dispose();
    if (dataset.isOpen) dataset.close();
    query.close();
    if (connection.connected) {
      try {
        await connection.close();
        await std.print("▶ Disconnected\n");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await std.print(`❌ Gagal disconnect: ${message}\n`);
      }
    }
  }
});
