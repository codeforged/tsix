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
  TLabel,
  TListBox,
  TMemo,
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

  const lamp = new TIndicatorLamp({ id: "lamp", label: "Online", on: true });
  const tglLamp = new TToggleSwitch({ id: "tgl-lamp", label: "Lampu" });
  const relay = new TRelayCard({ id: "relay-fan", label: "FAN", icon: "🌀" });
  const sensor = new TSensorCard({
    id: "card-suhu",
    label: "Suhu",
    unit: "°C",
    icon: "🌡️",
    value: 27.4,
    min: 0,
    max: 50,
  });
  const gauge = new TRadialGauge({
    id: "gauge-hum",
    label: "Kelembaban",
    unit: "%",
    value: 61,
    max: 100,
  });
  const chart = new TLineChart({
    id: "chart-suhu",
    data: [24, 25, 25.5, 26, 27, 26.5, 27.4],
    spline: true,
    fill: true,
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

  form.add(toolbar);
  form.add(formGroup);
  form.add(dataGroup);
  form.add(iotGroup);
  form.add(dialogGroup);
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

  chkAgree.onClick = (checked) => {
    status.text = checked ? "Setuju dicentang" : "Setuju dibatalkan";
  };

  cmbMode.onChange = (_index, item) => {
    status.text = `Mode: ${item}`;
  };

  prioLow.onClick = () => {
    status.text = "Prioritas: Rendah";
  };
  prioMid.onClick = () => {
    status.text = "Prioritas: Sedang";
  };
  prioHigh.onClick = () => {
    status.text = "Prioritas: Tinggi";
  };

  list.onClick = (_index, item) => {
    status.text = `List: ${item}`;
  };

  grid.onRowClick = (index, record) => {
    status.text = `Baris ${index}: ${record.node}/${record.sensor} = ${record.value}`;
  };

  grid.onSort = (key, dir) => {
    status.text = `Urut ${key} (${dir})`;
  };

  tglLamp.onClick = (on) => {
    lamp.on = on;
    status.text = `Lampu: ${on ? "ON" : "OFF"}`;
  };

  relay.onToggle = (active) => {
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
    const result = await new TOpenDialog({ title: "Pilih file", filter: ["txt", "md"] }).execute(form);
    status.text = result ? `Open: ${result.path}` : "Open dibatalkan";
  };

  btnSaveFile.onClick = async () => {
    const result = await new TSaveDialog({ title: "Simpan file", defaultName: "catatan.txt" }).execute(form);
    status.text = result ? `Save: ${result.path}` : "Save dibatalkan";
  };

  sensor.value = 28.1;
  gauge.value = 64;
  progress.value = 78;
  segment.value = 2048;

  edtName.onInput = (value) => {
    status.text = `Mengetik: ${value}`;
  };

  await form.run();
});
