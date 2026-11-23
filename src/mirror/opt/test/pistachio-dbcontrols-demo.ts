/**
 * pistachio-dbcontrols-demo.ts — Browser tabel dan editor DB Pistachio.
 *
 * Set DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, dan DB_PORT (opsional)
 * di environment TSIX sebelum menjalankan demo.
 *
 * Jalankan: pistachio-dbcontrols-demo (DOME harus hidup)
 *
 * (c) 2026 TSIX Project
 */

import { Program, shell, std } from "@tsix/Application";
import {
  TClientDataset,
  TDataSource,
  TDBConnection,
  TDBEdit,
  TDBGrid,
  TDBMemo,
  TDBNavigator,
  TDBPager,
  TDBQuery,
  TDBText,
  TDialogs,
  TForm,
  TButton,
  TLabel,
  TListBox,
  TProvider,
  THStack,
  TVStack,
} from "@tsix/pistachio";

export const appMode = "gui";

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
  const tablesQuery = new TDBQuery({
    connection,
    sql: `
      SELECT TABLE_NAME AS table_name
      FROM information_schema.tables
      WHERE TABLE_SCHEMA = :schema
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `,
    params: { schema: database },
  });
  const query = new TDBQuery({
    connection,
    sql: "SELECT 1 AS empty_dataset WHERE 1 = 0",
  });
  const provider = new TProvider({ query });
  const dataset = new TClientDataset({ provider });
  const dataSource = new TDataSource({ dataset });
  const pager = new TDBPager({
    id: "db-pager",
    dataSource,
    pageSize: 200,
  });

  const tableNames = new TListBox({
    id: "db-tables",
    style: { height: "130px", minHeight: "100px" },
  });
  const tableLabel = new TLabel({
    id: "db-selected-table",
    text: "Pilih tabel untuk melihat data.",
  });
  const status = new TLabel({ id: "db-status", text: "Menghubungkan..." });
  const refreshRows = new TButton({
    id: "db-refresh",
    caption: "Refresh Data",
    enabled: false,
  });
  const grid = new TDBGrid({
    id: "db-grid",
    dataSource,
    style: { height: "390px" },
  });
  const navigator = new TDBNavigator({
    id: "db-navigator",
    dataSource,
  });

  let currentTable: string | null = null;
  let loading = false;
  let editorOpen = false;
  let browserClosing = false;
  let activeEditor: TForm | null = null;
  let activeEditorRun: Promise<void> | null = null;
  const getActiveEditor = (): TForm | null => activeEditor;
  const getActiveEditorRun = (): Promise<void> | null => activeEditorRun;

  async function loadTable(tableName: string): Promise<void> {
    if (loading) return;
    if (editorOpen) {
      status.text = "Tutup form editor sebelum Refresh atau pindah tabel.";
      if (currentTable) {
        tableNames.selectedIndex = [...tableNames.items].indexOf(currentTable);
      }
      return;
    }
    if (dataset.isOpen && dataSource.state !== "dsBrowse") {
      status.text =
        "Post atau Cancel edit aktif sebelum Refresh atau pindah tabel.";
      if (currentTable) {
        tableNames.selectedIndex = [...tableNames.items].indexOf(currentTable);
      }
      return;
    }
    if (dataset.isOpen && dataset.dirtyCount > 0) {
      status.text =
        "Ada perubahan yang sudah di-Post. Klik Apply sebelum Refresh atau pindah tabel.";
      if (currentTable) {
        tableNames.selectedIndex = [...tableNames.items].indexOf(currentTable);
      }
      return;
    }
    loading = true;
    status.text = `Memuat ${tableName}...`;

    try {
      const quotedTable = connection.driver.quoteIdent(tableName);
      query.sql = `SELECT * FROM ${quotedTable}`;
      if (dataset.isOpen) {
        await dataset.refresh();
      } else {
        await dataset.open();
      }

      currentTable = tableName;
      tableLabel.text = `Tabel: ${tableName}`;
      const totalCount = pager.totalCount ?? dataset.recordCount;
      status.text = `Menampilkan ${dataset.recordCount} dari ${totalCount} baris.`;
      tableNames.selectedIndex = [...tableNames.items].indexOf(tableName);
      refreshRows.enabled = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.text = `Gagal memuat ${tableName}: ${message}`;
      if (currentTable) {
        tableNames.selectedIndex = [...tableNames.items].indexOf(currentTable);
        const quotedTable = connection.driver.quoteIdent(currentTable);
        query.sql = `SELECT * FROM ${quotedTable}`;
      }
      console.error("[pistachio-dbcontrols-demo] Gagal memuat tabel:", error);
    } finally {
      loading = false;
    }
  }

  tableNames.onChange = (_index, tableName) => {
    void loadTable(tableName);
  };
  refreshRows.onClick = () => {
    if (currentTable) void loadTable(currentTable);
  };

  function openEditor(insert: boolean): void {
    if (editorOpen || !dataset.isOpen) return;
    if (insert ? !dataSource.capabilities.canInsert : !dataSource.capabilities.canUpdate) {
      status.text = "Tabel ini tidak mendukung operasi tersebut.";
      return;
    }
    if (!insert && !dataSource.currentRecord) {
      status.text = "Pilih record yang akan diedit.";
      return;
    }

    try {
      if (insert) {
        dataSource.insert();
      } else {
        dataSource.edit();
      }

      const fieldControls = dataSource.fields.map((field) => {
        const readOnly =
          field.autoIncrement ||
          field.type === "ftBlob" ||
          (field.primaryKey && !insert);
        const editor = readOnly
          ? new TDBText({ dataSource, field: field.name })
          : field.type === "ftJSON"
            ? new TDBMemo({
                dataSource,
                field: field.name,
                rows: 4,
                style: { width: "100%" },
              })
            : new TDBEdit({
                dataSource,
                field: field.name,
                style: { width: "100%" },
              });

        return new TVStack({
          style: { gap: "3px" },
          children: [
            new TLabel({
              text: `${field.name} (${field.type}${field.nullable ? "" : ", wajib"})`,
            }),
            editor,
          ],
        });
      });

      const editorStatus = new TLabel({
        text: "Navigasi akan Post otomatis ke buffer. Apply tetap dilakukan dari browser.",
      });
      const editorNavigator = new TDBNavigator({
        id: "db-editor-navigator",
        dataSource,
      });
      for (const button of [
        editorNavigator.insertButton,
        editorNavigator.deleteButton,
        editorNavigator.applyButton,
      ]) {
        button.style = { ...button.style, display: "none" };
      }
      const closeButton = new TButton({
        id: "db-editor-close",
        caption: "Tutup",
      });
      const editorForm = new TForm({
        title: `Editor — ${currentTable ?? "record"}`,
        icon: "🌰",
        width: 580,
        height: 700,
        style: { overflow: "auto" },
        children: [
          new TVStack({
            style: { flex: "1", minHeight: "0", overflowY: "auto" },
            children: [
              new TLabel({
                text: "Gunakan navigator untuk berpindah record. Cancel dulu jika ingin membuang edit.",
              }),
              ...fieldControls,
              new THStack({
                children: [editorNavigator, closeButton],
                style: { flexWrap: "wrap" },
              }),
              editorStatus,
            ],
          }),
        ],
      });

      editorForm.onClose = () => {
        if (dataSource.state !== "dsBrowse") dataSource.cancel();
      };
      editorNavigator.postButton.onClick = () => {
        try {
          dataSource.post();
          editorStatus.text = `${dataSource.dirtyCount} perubahan menunggu Apply.`;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          editorStatus.text = `Post gagal: ${message}`;
        }
      };
      editorNavigator.cancelButton.onClick = () => {
        if (dataSource.state !== "dsBrowse") dataSource.cancel();
        editorStatus.text = "Perubahan edit dibatalkan.";
      };
      closeButton.onClick = async () => editorForm.close();

      editorOpen = true;
      refreshRows.enabled = false;
      activeEditor = editorForm;
      activeEditorRun = editorForm
        .run()
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          status.text = `Form editor gagal: ${message}`;
          console.error("[pistachio-dbcontrols-demo] Form editor gagal:", error);
        })
        .finally(() => {
          try {
            if (dataSource.state !== "dsBrowse") dataSource.cancel();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            status.text = `Gagal membatalkan edit saat editor ditutup: ${message}`;
            console.error(
              "[pistachio-dbcontrols-demo] Gagal membatalkan edit:",
              error,
            );
          } finally {
            editorOpen = false;
            if (!browserClosing) {
              refreshRows.enabled = currentTable !== null;
            }
            if (activeEditor === editorForm) activeEditor = null;
            activeEditorRun = null;
          }
          editorForm.dispose();
        });
    } catch (error) {
      if (dataSource.state !== "dsBrowse") dataSource.cancel();
      const message = error instanceof Error ? error.message : String(error);
      status.text = `Tidak bisa membuka editor: ${message}`;
    }
  }

  grid.onActivate = () => openEditor(false);
  navigator.editButton.onClick = () => openEditor(false);
  navigator.insertButton.onClick = () => openEditor(true);
  navigator.firstButton.onClick = () => {
    if (!editorOpen) dataSource.first();
  };
  navigator.priorButton.onClick = () => {
    if (!editorOpen) dataSource.prior();
  };
  navigator.nextButton.onClick = () => {
    if (!editorOpen) dataSource.next();
  };
  navigator.lastButton.onClick = () => {
    if (!editorOpen) dataSource.last();
  };
  navigator.postButton.onClick = () => {
    if (editorOpen) {
      status.text = "Gunakan tombol Post pada form editor.";
      return;
    }
    dataSource.post();
  };
  navigator.cancelButton.onClick = () => {
    if (editorOpen) {
      status.text = "Gunakan tombol Cancel pada form editor.";
      return;
    }
    dataSource.cancel();
  };
  const applyUpdates = navigator.applyButton.onClick;
  navigator.applyButton.onClick = () => {
    if (editorOpen) {
      status.text = "Tutup form editor sebelum Apply.";
      return;
    }
    applyUpdates?.();
  };
  navigator.onError = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    status.text = `Apply gagal: ${message}`;
    console.error("[pistachio-dbcontrols-demo] Apply gagal:", error);
  };
  const form = new TForm({
    title: "Pistachio DB Browser",
    icon: "🌰",
    width: 820,
    height: 760,
    children: [
      new TVStack({
        style: { flex: "1", minHeight: "0" },
        children: [
          new TLabel({
            id: "db-demo-info",
            text: "Gunakan pager untuk memuat record per halaman. Panah atas/bawah: record sebelumnya/berikutnya; kiri/kanan: record pertama/terakhir. Edit tersedia untuk tabel dengan primary key.",
          }),
          new TLabel({ id: "db-tables-label", text: "Tabel:" }),
          tableNames,
          new THStack({
            id: "db-toolbar",
            children: [tableLabel, refreshRows],
          }),
          grid,
          pager,
          navigator,
          status,
        ],
      }),
    ],
  });

  form.onClose = () => {
    browserClosing = true;
  };

  navigator.deleteButton.onClick = async () => {
    if (editorOpen) {
      status.text = "Tutup form editor sebelum menghapus record.";
      return;
    }
    try {
      const answer = await TDialogs.confirm(
        form,
        "Hapus record?",
        "Record akan dihapus dari MySQL setelah Apply.",
        ["Hapus", "Batal"],
      );
      if (answer === "Hapus") {
        dataSource.delete();
        status.text = "Penghapusan menunggu Apply.";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.text = `Hapus gagal: ${message}`;
    }
  };

  form.onSetup = async () => {
    try {
      await connection.open();
      const result = await tablesQuery.open();
      const names = result.rows
        .map((row) => row.table_name)
        .filter((name): name is string => typeof name === "string");
      await tableNames.setItems(names);

      if (names.length === 0) {
        status.text = `Tidak ada tabel atau view di database "${database}".`;
        return;
      }

      tableNames.selectedIndex = 0;
      await loadTable(names[0]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.text = `Koneksi gagal: ${message}`;
      console.error("[pistachio-dbcontrols-demo] Koneksi/query gagal:", error);
    }
  };

  try {
    await form.run();
  } finally {
    const editorRun = getActiveEditorRun();
    const editor = getActiveEditor();
    if (editor) await editor.close();
    if (editorRun) await editorRun;
    dataSource.dispose();
    if (dataset.isOpen && dataset.dirtyCount === 0) dataset.close();
    else if (dataset.isOpen) {
      console.warn(
        "[pistachio-dbcontrols-demo] Perubahan belum di-Apply; perubahan lokal tidak disimpan ke MySQL.",
      );
    }
    tablesQuery.close();
    query.close();
    if (connection.connected) await connection.close();
  }
});
