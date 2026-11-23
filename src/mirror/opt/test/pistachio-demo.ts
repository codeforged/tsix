/**
 * pistachio-demo.ts — Demo kontrol dasar & layout Pistachio.
 *
 * Jalankan: pistachio-demo (DOME harus hidup)
 * (c) 2026 TSIX Project
 */

import { Program } from "@tsix/Application";
import {
  TButton,
  TCheckBox,
  TComboBox,
  TDataGrid,
  TDialogs,
  TEdit,
  TIndicatorLamp,
  TLineChart,
  TForm,
  TGroupBox,
  THStack,
  TKeyboard,
  TLabel,
  TListBox,
  TMemo,
  TImage,
  TProgressBar,
  TRadialGauge,
  TRadioButton,
  TRelayCard,
  TSensorCard,
  TSevenSegment,
  TOpenDialog,
  TSaveDialog,
  TSpacer,
  TToggleSwitch,
  TVStack,
} from "@tsix/pistachio";

export const appMode = "gui";

export const main = Program(async () => {
  const form = new TForm({
    title: "Pistachio Demo",
    icon: "🌰",
    width: 760,
    height: 780,
    style: { overflow: "auto" },
  });

  const status = new TLabel({ id: "status", text: "Siap." });

  const btnGreet = new TButton({ id: "btn-greet", caption: "Sapa" });
  const btnSave = new TButton({ id: "btn-save", caption: "Simpan" });

  const toolbar = new THStack({
    id: "toolbar",
    children: [btnGreet, btnSave, new TSpacer(), status],
  });

  const edtName = new TEdit({
    id: "edt-name",
    placeholder: "Nama...",
    text: "dunia",
  });
  const edtLocked = new TEdit({
    id: "edt-locked",
    text: "hanya baca",
    readOnly: true,
  });
  const chkAgree = new TCheckBox({ id: "chk-agree", caption: "Setuju" });
  const cmbMode = new TComboBox({
    id: "cmb-mode",
    items: ["Santai", "Normal", "Ketat"],
    selectedIndex: 1,
  });

  // Radio harus satu parent agar pengelompokan `group` bekerja.
  const prioLow = new TRadioButton({
    id: "rb-low",
    caption: "Rendah",
    group: "prio",
    checked: true,
  });
  const prioMid = new TRadioButton({
    id: "rb-mid",
    caption: "Sedang",
    group: "prio",
  });
  const prioHigh = new TRadioButton({
    id: "rb-high",
    caption: "Tinggi",
    group: "prio",
  });

  const prioRow = new THStack({
    id: "row-prio",
    children: [
      new TLabel({ id: "lbl-prio", text: "Prioritas:" }),
      prioLow,
      prioMid,
      prioHigh,
    ],
  });

  const formGroup = new TGroupBox({
    id: "grp-input",
    caption: "Input",
    children: [
      new TVStack({
        children: [edtName, edtLocked, chkAgree, cmbMode, prioRow],
      }),
    ],
  });

  const list = new TListBox({
    id: "list",
    items: ["Satu", "Dua", "Tiga"],
    style: { flex: "1", minWidth: "220px" },
  });

  const memo = new TMemo({
    id: "memo",
    rows: 4,
    text: "Catatan...",
    style: { flex: "1", minWidth: "220px" },
  });

  // Isi manual — tidak terhubung ke database.
  const grid = new TDataGrid({
    id: "grid",
    height: 190,
    columns: [
      { key: "no", label: "No", width: 50, align: "right" },
      { key: "node", label: "Node", width: 120 },
      { key: "sensor", label: "Sensor", width: 110 },
      { key: "value", label: "Nilai", width: 80, align: "right" },
      { key: "waktu", label: "Waktu" },
    ],
    data: [
      { no: 1, node: "esp-01", sensor: "suhu", value: 27.4, waktu: "12:01" },
      { no: 2, node: "esp-01", sensor: "kelembaban", value: 61, waktu: "12:02" },
      { no: 3, node: "esp-02", sensor: "tekanan", value: 1012.3, waktu: "12:03" },
      { no: 4, node: "esp-02", sensor: "cahaya", value: 320, waktu: "12:04" },
    ],
  });

  const dataGroup = new TGroupBox({
    id: "grp-data",
    caption: "Data (manual)",
    children: [grid],
  });

  const lamp = new TIndicatorLamp({ id: "lamp", caption: "Online", on: true });
  const tglLamp = new TToggleSwitch({ id: "tgl-lamp", caption: "Lampu" });
  const relay = new TRelayCard({ id: "relay-fan", caption: "FAN", icon: "🌀" });
  const sensor = new TSensorCard({
    id: "card-suhu",
    caption: "Suhu",
    unit: "°C",
    icon: "🌡️",
    value: 27.4,
    min: 0,
    max: 50,
  });
  const gauge = new TRadialGauge({
    id: "gauge-hum",
    caption: "Kelembaban",
    unit: "%",
    value: 61,
    max: 100,
  });
  const chart = new TLineChart({
    id: "chart-suhu",
    data: [24, 25, 25.5, 26, 27, 26.5, 27.4],
    spline: true,
    fill: false,
    width: 280,
    height: 150,
  });
  const progress = new TProgressBar({
    id: "progress",
    value: 62,
    style: { flex: "1", width: "auto" },
  });
  const segment = new TSevenSegment({ id: "seg", value: 1234, digits: 4 });

  const iotGroup = new TGroupBox({
    id: "grp-iot",
    caption: "Widget IoT",
    children: [
      new THStack({
        id: "row-iot",
        style: { alignItems: "stretch" },
        children: [lamp, tglLamp, relay, sensor, gauge],
      }),
      new THStack({
        id: "row-iot-2",
        style: { alignItems: "center" },
        children: [progress, new TSpacer({ size: 8 }), segment],
      }),
      chart,
    ],
  });

  const btnAlert = new TButton({ id: "btn-alert", caption: "Alert" });
  const btnConfirm = new TButton({ id: "btn-confirm", caption: "Confirm" });
  const btnInput = new TButton({ id: "btn-input", caption: "Input" });
  const btnOpenFile = new TButton({ id: "btn-open-file", caption: "Open…" });
  const btnSaveFile = new TButton({ id: "btn-save-file", caption: "Save…" });
  const btnOpenImage = new TButton({
    id: "btn-open-image",
    caption: "Pilih gambar…",
  });
  const imagePreview = new TImage({
    id: "image-preview",
    alt: "Pratinjau gambar",
    width: 520,
    height: 260,
    fit: "contain",
    style: { background: "#f5f5f5", border: "1px solid #ccc" },
  });

  // Dialog file = komponen non-visual milik form (K6).
  const dlgOpen = new TOpenDialog({ id: "dlg-open", title: "Pilih file", filter: ["*", "txt", "md"] });
  const dlgImage = new TOpenDialog({
    id: "dlg-image",
    title: "Pilih gambar",
    filter: [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg"],
  });
  const dlgSave = new TSaveDialog({ id: "dlg-save", title: "Simpan file", defaultName: "catatan.txt" });

  const dialogGroup = new TGroupBox({
    id: "grp-dialog",
    caption: "Dialog",
    children: [
      new THStack({
        id: "row-dialog",
        children: [btnAlert, btnConfirm, btnInput, btnOpenFile, btnSaveFile],
      }),
    ],
  });
  const imageGroup = new TGroupBox({
    id: "grp-image",
    caption: "Pratinjau Gambar",
    children: [btnOpenImage, imagePreview],
  });

  form.add(toolbar);
  form.add(formGroup);
  form.add(dataGroup);
  form.add(iotGroup);
  form.add(dialogGroup);
  form.add(dlgOpen);
  form.add(dlgImage);
  form.add(dlgSave);
  form.add(imageGroup);
  form.add(
    new THStack({
      id: "row",
      style: { alignItems: "stretch" },
      children: [list, memo],
    }),
  );

  btnGreet.onClick = () => {
    status.text = `Halo ${edtName.text || "tanpa nama"}`;
  };

  btnSave.onClick = () => {
    status.text = `Disimpan: ${memo.text.length} karakter`;
  };

  chkAgree.onChange = (checked) => {
    status.text = checked ? "Setuju dicentang" : "Setuju dibatalkan";
  };

  cmbMode.onChange = (_index, item) => {
    status.text = `Mode: ${item}`;
  };

  prioLow.onChange = () => {
    status.text = "Prioritas: Rendah";
  };
  prioMid.onChange = () => {
    status.text = "Prioritas: Sedang";
  };
  prioHigh.onChange = () => {
    status.text = "Prioritas: Tinggi";
  };

  list.onChange = (_index, item) => {
    status.text = `List: ${item}`;
  };

  grid.onRowClick = (index, record) => {
    status.text = `Baris ${index}: ${record.node}/${record.sensor} = ${record.value}`;
  };

  grid.onSort = (key, dir) => {
    status.text = `Urut ${key} (${dir})`;
  };

  tglLamp.onChange = (on) => {
    lamp.on = on;
    status.text = `Lampu: ${on ? "ON" : "OFF"}`;
  };

  relay.onChange = (active) => {
    status.text = `Relay FAN: ${active ? "ON" : "OFF"}`;
  };

  btnAlert.onClick = () => {
    void TDialogs.alert(form, "Info", "Halo dari Pistachio!");
  };

  btnConfirm.onClick = async () => {
    const answer = await TDialogs.confirm(form, "Hapus data?", "Tidak bisa dibatalkan.", ["Ya", "Batal"]);
    status.text = `Confirm: ${answer}`;
  };

  btnInput.onClick = async () => {
    const value = await TDialogs.input(form, "Nama baru", "Masukkan nama:", edtName.text);
    if (value !== null) {
      edtName.text = value;
      status.text = `Input: ${value}`;
    }
  };

  btnOpenFile.onClick = async () => {
    const result = await dlgOpen.execute();
    status.text = result ? `Open: ${result.path}` : "Open dibatalkan";
  };

  btnOpenImage.onClick = async () => {
    const result = await dlgImage.execute();
    if (!result) {
      status.text = "Pilih gambar dibatalkan";
      return;
    }

    try {
      await imagePreview.loadFile(result.path);
      status.text = `Gambar dimuat: ${result.filename}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.text = `Gagal memuat gambar: ${message}`;
      await TDialogs.alert(form, "Gagal membuka gambar", message);
    }
  };

  btnSaveFile.onClick = async () => {
    const result = await dlgSave.execute();
    status.text = result ? `Save: ${result.path}` : "Save dibatalkan";
  };

  sensor.value = 28.1;
  gauge.value = 64;
  progress.value = 78;
  segment.value = 2048;

  edtName.onInput = (value) => {
    status.text = `Mengetik: ${value}`;
  };

  const keyboard = new TKeyboard({
    id: "kbd",
    shortcuts: {
      "Ctrl+S": () => {
        status.text = "Shortcut: Ctrl+S (simpan)";
      },
      F2: () => {
        edtName.text = "Nama dari F2";
        status.text = "Shortcut: F2";
      },
      "Ctrl+Q": () => {
        void TDialogs.confirm(form, "Keluar?", "Tutup aplikasi?", [
          "Ya",
          "Batal",
        ]).then((answer) => {
          if (answer === "Ya") void form.close();
        });
      },
    },
  });

  keyboard.onKey = (ev) => {
    if (ev.key === "Escape") status.text = "Escape ditekan";
  };

  form.add(keyboard);

  // Simulasi sensor: suhu, kelembaban, dan chart bergerak setiap 5 detik.
  const CHART_POINTS = 10; // chart menggeser: hanya 10 data terakhir yang tampil
  let suhu = sensor.value;
  let hum = gauge.value;
  let trend = [...chart.data];

  const timer = setInterval(() => {
    suhu = drift(suhu, 0.8, 20, 35);
    hum = drift(hum, 3, 40, 90);
    trend = [...trend, suhu].slice(-CHART_POINTS);

    sensor.value = suhu;
    gauge.value = hum;
    chart.data = trend;
  }, 5000);

  try {
    await form.run();
  } finally {
    clearInterval(timer);
  }
});

/** Langkah acak ±`step` dari `value`, dijepit ke [min, max], 1 desimal. */
function drift(value: number, step: number, min: number, max: number): number {
  const next = value + (Math.random() * 2 - 1) * step;
  return Math.round(Math.min(max, Math.max(min, next)) * 10) / 10;
}
