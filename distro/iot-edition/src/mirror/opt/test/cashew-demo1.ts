/**
 * test-gui-fw2.ts — Demo Cashew Framework (Delphi-style GUI)
 *
 * Menunjukkan bagaimana Cashew membuat kode GUI lebih flat & enak dibaca
 * seperti Delphi / Turbo Pascal.
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, fs } from "@tsix/Application";
import {
  TForm,
  TPanel,
  TLabel,
  TButton,
  TEdit,
  TMemo,
  TCheckBox,
  TListBox,
  TStatusBar,
  TRadioButton,
  TComboBox,
  TDialogs,
  HStack,
  VStack,
  Spacer,
} from "@tsix/cashew";

export const appMode = "gui";

export const main = Program(async (_args: string[]) => {
  await std.log("=== Cashew GUI Demo ===");

  // ================================================================
  // FORM — Deklarasi seperti Delphi
  // ================================================================
  const form = new TForm("🧪 Cashew GUI Demo", 720, 750);
  form.style = {
    ...form.style,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "6px",
    alignContent: "start",
  };
  form.onClose = () => std.log("[cashew] Form closed");

  // ================================================================
  // KOMPONEN — Semua flat, gak ada nesting!
  // ================================================================

  // --- Header (full width) ---
  const lblTitle = new TLabel("lbl-title");
  lblTitle.caption = "🌿 Cashew Framework — Delphi-style GUI untuk TSIX";
  lblTitle.style = {
    fontSize: "16px",
    color: "#4caf50",
    fontWeight: "700",
    marginBottom: "0",
    gridColumn: "1 / -1",
  };
  form.add(lblTitle);

  // --- Panel 1: Demo Tombol & Counter ---
  const pnlButtons = new TPanel("pnl-buttons");
  pnlButtons.style = { ...pnlButtons.style, marginTop: "0" };
  form.add(pnlButtons);

  const lblCounter = new TLabel("lbl-counter");
  lblCounter.caption = "Counter: 0";
  lblCounter.style = {
    fontSize: "14px",
    fontWeight: "700",
    color: "#4caf50",
    paddingRight: "10px",
  };
  pnlButtons.add(lblCounter);

  const btnCount = new TButton("btn-count", {
    color: "#ffae00",
    borderColor: "#ffe600",
    marginRight: "5px",
  });
  btnCount.caption = "Klik Saya";
  btnCount.onClick = () => {
    count++;
    lblCounter.caption = "Counter: " + count;
    lblStatus.text = "✅ Counter: " + count;
  };
  pnlButtons.add(btnCount);

  const btnReset = new TButton("btn-reset", {
    color: "#ff9800",
    borderColor: "#ff9800",
    marginRight: "5px",
  });
  btnReset.caption = "Reset";
  btnReset.onClick = () => {
    count = 0;
    lblCounter.caption = "Counter: 0";
    lblStatus.text = "↺ Reset";
  };
  pnlButtons.add(btnReset);

  // --- Panel 2: Demo Input ---
  const pnlInput = new TPanel("pnl-input");
  pnlInput.style = { ...pnlInput.style, marginTop: "0" };
  form.add(pnlInput);

  const lblName = new TLabel("lbl-name");
  lblName.caption = "Nama:";
  lblName.style = { ...lblName.style, marginBottom: "4px" };
  pnlInput.add(lblName);

  const edtName = new TEdit("edt-name");
  edtName.placeholder = "Ketik nama Anda...";
  edtName.onInput = (val) => {
    if (val.trim()) {
      lblStatus.text = "👋 Halo, " + val + "!";
    }
  };
  pnlInput.add(edtName);

  // --- Panel 3: Demo Checkbox & Layout ---
  const pnlCheck = new TPanel("pnl-check");
  pnlCheck.style = { ...pnlCheck.style, marginTop: "0" };
  form.add(pnlCheck);

  const chkOption1 = new TCheckBox("chk-opt1");
  chkOption1.caption = "Aktifkan Notifikasi";
  chkOption1.checked = true;
  chkOption1.onClick = (ch) => {
    lblStatus.text = ch ? "🔔 Notifikasi ON" : "🔕 Notifikasi OFF";
    chkOption1.checked = ch;
  };
  pnlCheck.add(chkOption1);

  const chkOption2 = new TCheckBox("chk-opt2");
  chkOption2.caption = "Mode Gelap";
  chkOption2.checked = false;
  chkOption2.onClick = (ch) => {
    lblStatus.text = ch ? "🌙 Mode Gelap ON" : "☀️ Mode Gelap OFF";
    chkOption2.checked = ch;
  };
  pnlCheck.add(chkOption2);

  // --- Panel 4: Demo ListBox ---
  const pnlList = new TPanel("pnl-list");
  pnlList.style = { ...pnlList.style, marginTop: "0", minHeight: "120px" };
  form.add(pnlList);

  const lblList = new TLabel("lbl-list");
  lblList.caption = "📋 Pilih Item:";
  lblList.style = { ...lblList.style, marginBottom: "4px" };
  pnlList.add(lblList);

  const listBox = new TListBox("lst-demo");
  listBox.items = [
    "🌡️ Temperature Sensor",
    "💧 Humidity Sensor",
    "🌀 Pressure Sensor",
    "☀️ Light Sensor",
    "⚡ Relay FAN",
    "💡 Relay LAMP",
  ];
  listBox.onClick = (idx, item) => {
    lblStatus.text = "📌 Selected: " + item;
  };
  pnlList.add(listBox);

  // --- Panel 5: Demo RadioButton (Grouped) ---
  const pnlRadio = new TPanel("pnl-radio");
  pnlRadio.style = { ...pnlRadio.style, marginTop: "0" };
  pnlRadio.caption = "";
  form.add(pnlRadio);

  const lblRadio = new TLabel("lbl-radio");
  lblRadio.caption = "🔘 Pilihan Warna:";
  lblRadio.style = {
    ...lblRadio.style,
    marginBottom: "4px",
    display: "block",
    gridColumn: "1 / -1",
  };
  pnlRadio.add(lblRadio);

  const rbRed = new TRadioButton("rb-red", "warna");
  rbRed.caption = "Merah";
  rbRed.checked = true;
  rbRed.onClick = () => {
    lblStatus.text = "🔴 Merah dipilih";
  };
  pnlRadio.add(rbRed);

  const rbGreen = new TRadioButton("rb-green", "warna");
  rbGreen.caption = "Hijau";
  rbGreen.onClick = () => {
    lblStatus.text = "🟢 Hijau dipilih";
  };
  pnlRadio.add(rbGreen);

  const rbBlue = new TRadioButton("rb-blue", "warna");
  rbBlue.caption = "Biru";
  rbBlue.onClick = () => {
    lblStatus.text = "🔵 Biru dipilih";
  };
  pnlRadio.add(rbBlue);

  // --- Panel 6: Demo ComboBox ---
  const pnlCombo = new TPanel("pnl-combo");
  pnlCombo.style = { ...pnlCombo.style, marginTop: "0" };
  form.add(pnlCombo);

  const lblCombo = new TLabel("lbl-combo");
  lblCombo.caption = "📑 Pilih Mode:";
  lblCombo.style = { ...lblCombo.style, marginBottom: "4px", display: "block" };
  pnlCombo.add(lblCombo);

  const cmbMode = new TComboBox("cmb-mode");
  cmbMode.items = ["Otomatis", "Manual", "Terjadwal", "Siaga"];
  cmbMode.selectedIndex = 0;
  cmbMode.onChange = (idx, item) => {
    lblStatus.text = "⚙️ Mode: " + item;
  };
  pnlCombo.add(cmbMode);

  // --- Panel 7: Demo Memo ---
  const pnlMemo = new TPanel("pnl-memo");
  pnlMemo.style = { ...pnlMemo.style, marginTop: "0" };
  form.add(pnlMemo);

  const lblMemo = new TLabel("lbl-memo");
  lblMemo.caption = "📝 Catatan:";
  lblMemo.style = { ...lblMemo.style, marginBottom: "4px", display: "block" };
  pnlMemo.add(lblMemo);

  const memo = new TMemo("memo-log");
  memo.text = "Sensor readings:\n  Temp: 32.4°C\n  Hum: 68%\n  Press: 1013 hPa";
  pnlMemo.add(memo);

  // --- Panel 8: Demo Dialog ---
  const pnlDialog = new TPanel("pnl-dialog");
  pnlDialog.style = { ...pnlDialog.style, marginTop: "0" };
  form.add(pnlDialog);

  const btnAlert = new TButton("btn-alert", {
    marginRight: "5px",
    marginBottom: "3px",
  });
  btnAlert.caption = "💬 Alert";
  btnAlert.onClick = async () => {
    await TDialogs.alert(form.screen, "Info", "🌿 Cashew Framework siap!");
  };
  pnlDialog.add(btnAlert);

  const btnConfirm = new TButton("btn-confirm", { marginRight: "5px" });
  btnConfirm.caption = "✅ Confirm";
  btnConfirm.onClick = async () => {
    const ans = await TDialogs.confirm(form.screen, "Konfirmasi", "Lanjutkan?");
    lblStatus.text = "📌 Confirm: " + ans;
  };
  pnlDialog.add(btnConfirm);

  const btnQuestion = new TButton("btn-question", { marginRight: "5px" });
  btnQuestion.caption = "✅ Input";
  btnQuestion.onClick = async () => {
    const ans = await TDialogs.input(form.screen, "Konfirmasi", "Nama anda?");
    lblStatus.text = "📌 Your name: " + ans;
  };
  pnlDialog.add(btnQuestion);

  const btnOpen = new TButton("btn-open", { marginRight: "5px" });
  btnOpen.caption = "📂 Open File";
  btnOpen.onClick = async () => {
    const path = await TDialogs.openFile(form.screen, fs, "Pilih File");
    lblStatus.text = path ? "📂 Open: " + path : "❌ Open: dibatalkan";
  };
  pnlDialog.add(btnOpen);

  const btnSave = new TButton("btn-save", { marginRight: "5px" });
  btnSave.caption = "💾 Save File";
  btnSave.onClick = async () => {
    const path = await TDialogs.saveFile(
      form.screen,
      fs,
      "Simpan Sebagai",
      "catatan.txt",
    );
    lblStatus.text = path ? "💾 Save: " + path : "❌ Save: dibatalkan";
  };
  pnlDialog.add(btnSave);

  // --- Status Bar ---
  const lblStatus = new TStatusBar("status");
  lblStatus.text = "✅ Ready — Cashew Framework v1";
  form.add(lblStatus);

  let count = 0;

  // Jalankan!
  await form.run();
});
