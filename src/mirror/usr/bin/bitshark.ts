/**
 * bitshark.ts — Network Sniffer (ala Wireshark) berbasis Cashew.
 *
 * Menangkap paket MQTNL per interface:
 *   - TX (pergi)  : payload SEBELUM dienkripsi (plaintext asli)
 *   - RX (datang) : payload SETELAH didekripsi (hasil decrypt)
 * Jadi datanya langsung terbaca, tanpa perlu dekripsi manual.
 *
 * Pilih interface (smqtnl0 / smqtnl1 / Semua), lalu Start.
 * Kernel mengirim event "NET_SNIFF" via ipc_message ke proses ini
 * (syscall NET_SNIFFER_REGISTER = 72).
 *
 * Jalankan:  bitshark
 * (Pastikan DOME running)
 *
 * (c) 2026 TSIX Project
 */

import { Program, shell } from "@tsix/Application";
import {
  TForm,
  TComboBox,
  TButton,
  TLabel,
  TDataGrid,
  HStack,
  TDialogs,
  TEdit,
  TPanel,
  VStack,
  TComponent,
  Spacer,
  TTabulatorGrid
} from "@tsix/cashew";

export const appMode = "gui";

/** Nilai interface asli per index combobox (label tampilan boleh beda). */
const IFACES = ["*", "smqtnl0", "smqtnl1"];

export const main = Program(async () => {
  const form = new TForm("🦈 Bitshark — Network Sniffer", 940, 660);

  // ── Toolbar ──
  const lblIface = new TLabel("iface-label", {
    color: "var(--accent, #4caf50)",
    fontWeight: "700",
    fontSize: "13px"
  });
  lblIface.caption = "🛰 Interface:";

  const selIface = new TComboBox("iface-select", {
    width: "200px"
  });
  selIface.items = ["🌐 Semua (All)", "📡 smqtnl0", "📡 smqtnl1"];
  selIface.selectedIndex = 0;

  const btnToggle = new TButton("btn-toggle", {width: "140px", height: "35px"});
  btnToggle.caption = "▶️ Start Sniffing";

  const btnClear = new TButton("btn-clear", {
    background: "rgba(244,67,54,0.15)",
    color: "#f44336",
    border: "1px solid #f44336",
    height: "35px"
  });
  btnClear.caption = "🗑 Clear";

  const btnFilter = new TButton("btn-filter", {
    background: "rgba(33,150,243,0.15)",
    color: "#2196f3",
    border: "1px solid #2196f3",
    height: "35px"
  });
  btnFilter.caption = "🔍 Filter";

  const status = new TLabel("status", { color: "var(--text-muted, #888)" });
  status.caption = "⏸ idle — pilih interface lalu Start";

  form.add(HStack({padding: "5px"}, lblIface, selIface, btnToggle, btnClear, btnFilter, status));

  const grid = new TTabulatorGrid(
    "packets",
    [
      { key: "no", label: "#", width: 40, align: "right" },
      { key: "time", label: "Time", width: 120 },
      { key: "dir", label: "Dir", width: 60 },
      { key: "iface", label: "Interface", width: 90 },
      { key: "src", label: "Src", width: 160 },
      { key: "dst", label: "Dst", width: 160 },
      { key: "port", label: "Port", width: 60, align: "right" },
      { key: "proto", label: "Proto", width: 60 },
      { key: "size", label: "Size", width: 60, align: "right" },
      { key: "flag", label: "Flag", width: 130 },
      { key: "data", label: "Data (plaintext)", width: "40%" },
    ],
    [],
    { maxRows: 500 },
  );

  // Track double-clicks untuk detail view
  let lastRowClick = { no: -1, time: 0 };
  grid.onRowClick = (index: number, record: Record<string, any>) => {
    const now = Date.now();
    const packetNo = record.no;
    if (lastRowClick.no === packetNo && now - lastRowClick.time < 400) {
      // Double-click detected
      lastRowClick = { no: -1, time: 0 };
      void viewPacketDetails(packetNo);
    } else {
      lastRowClick = { no: packetNo, time: now };
    }
  };

  form.add(grid);

  /** Map nilai numerik PacketHeaderFlag ke nama yang human-readable. */
  function flagName(f: number): string {
    const MAP: Record<number, string> = {
      0:  "DATA",
      1:  "PING_REQ",
      2:  "PING_REPLY",
      3:  "BCAST_PING",
      4:  "BCAST_REPLY",
      10: "FILE_HEADER",
      11: "FILE_GETFILE",
      12: "FILE_PAYLOAD",
      13: "FILE_LIST",
      14: "FILE_PUT_OK",
      20: "RSA_REQ",
      21: "RSA_ACK",
      22: "AUTH_FAILED",
    };
    return MAP[f] !== undefined
      ? `0x${f.toString(16).padStart(2, "0").toUpperCase()} ${MAP[f]}`
      : `0x${f.toString(16).padStart(2, "0").toUpperCase()}`;
  }

  // ── State ──
  let sniffing = false;
  let counter = 0;
  let currentIface = "*";
  let rows: Record<string, any>[] = [];
  let filteredRows: Record<string, any>[] = []; // Filtered display version
  let packetHistory: Map<number, any> = new Map(); // Store full packet details by row number
  let onSniffRegistered = false;

  // Filter criteria state
  let filterCriteria: Record<string, any> = {
    dir: "",
    iface: "",
    srcAddr: { value: "", operator: "=" },
    srcPort: { value: "", operator: "=" },
    dstAddr: { value: "", operator: "=" },
    dstPort: { value: "", operator: "=" },
    port: { value: "", operator: "=" },
    proto: "",
    data: "",
    bytes: { value: "", operator: "=" },
    flag: { value: "", operator: "=" },
  };

  /** Predikat: apakah satu baris lolos kriteria filter? */
  function rowMatchesFilter(row: any): boolean {
    // Direction filter
    if (filterCriteria.dir) {
      const dirMatch = filterCriteria.dir === "TX" ? "⬆" : "⬇";
      if (!row.dir.includes(dirMatch)) return false;
    }

    // Interface filter
    if (filterCriteria.iface && row.iface !== filterCriteria.iface) return false;

    // Source address filter
    if (filterCriteria.srcAddr.value) {
      const match = row.src.includes(filterCriteria.srcAddr.value);
      if (filterCriteria.srcAddr.operator === "=" && !match) return false;
      if (filterCriteria.srcAddr.operator === "!=" && match) return false;
    }

    // Source port filter
    if (filterCriteria.srcPort.value) {
      const portMatch = row.src.endsWith(`:${filterCriteria.srcPort.value}`);
      if (filterCriteria.srcPort.operator === "=" && !portMatch) return false;
      if (filterCriteria.srcPort.operator === "!=" && portMatch) return false;
    }

    // Dest address filter
    if (filterCriteria.dstAddr.value) {
      const match = row.dst.includes(filterCriteria.dstAddr.value);
      if (filterCriteria.dstAddr.operator === "=" && !match) return false;
      if (filterCriteria.dstAddr.operator === "!=" && match) return false;
    }

    // Dest port filter
    if (filterCriteria.dstPort.value) {
      const portMatch = row.dst.endsWith(`:${filterCriteria.dstPort.value}`);
      if (filterCriteria.dstPort.operator === "=" && !portMatch) return false;
      if (filterCriteria.dstPort.operator === "!=" && portMatch) return false;
    }

    // Port filter (dst port)
    if (filterCriteria.port.value) {
      const portNum = parseInt(filterCriteria.port.value);
      const rowPort = row.port;
      if (filterCriteria.port.operator === "=") {
        if (rowPort !== portNum) return false;
      } else if (filterCriteria.port.operator === "!=") {
        if (rowPort === portNum) return false;
      } else if (filterCriteria.port.operator === "<") {
        if (rowPort >= portNum) return false;
      } else if (filterCriteria.port.operator === ">") {
        if (rowPort <= portNum) return false;
      }
    }

    // Proto filter
    if (filterCriteria.proto) {
      const protoVal = filterCriteria.proto === "JSON" ? "json" : filterCriteria.proto === "Binary" ? "binary" : "";
      if (protoVal && !(row.proto || "").toLowerCase().includes(protoVal)) return false;
    }

    // Data filter
    if (filterCriteria.data) {
      if (!row.data.includes(filterCriteria.data)) return false;
    }

    // Bytes filter
    if (filterCriteria.bytes.value) {
      const bytesNum = parseInt(filterCriteria.bytes.value);
      const rowSize = row.size;
      if (filterCriteria.bytes.operator === "=") {
        if (rowSize !== bytesNum) return false;
      } else if (filterCriteria.bytes.operator === "!=") {
        if (rowSize === bytesNum) return false;
      } else if (filterCriteria.bytes.operator === "<") {
        if (rowSize >= bytesNum) return false;
      } else if (filterCriteria.bytes.operator === ">") {
        if (rowSize <= bytesNum) return false;
      }
    }

    // Flag filter
    if (filterCriteria.flag.value) {
      const match = row.flag.includes(filterCriteria.flag.value);
      if (filterCriteria.flag.operator === "=" && !match) return false;
      if (filterCriteria.flag.operator === "!=" && match) return false;
    }

    return true;
  }

  /**
   * Coalesce append: kumpulkan baris baru, lalu flush SEKALI tiap ±80ms.
   * → traffic WS tetap kecil (1 mount kecil per baris, bukan seluruh tabel).
   */
  let pendingAppend: Record<string, any>[] = [];
  let appendTimer: any = null;

  function flushAppend() {
    if (appendTimer) {
      clearTimeout(appendTimer);
      appendTimer = null;
    }
    if (pendingAppend.length === 0) return;
    const batch = pendingAppend;
    pendingAppend = [];
    void grid.appendData(batch);
  }

  function scheduleAppend(rowsToAdd: Record<string, any>[]) {
    pendingAppend.push(...rowsToAdd);
    if (!appendTimer) appendTimer = setTimeout(flushAppend, 80);
  }

  /** Apply filter ke rows buffer, tampilkan filtered result */
  function applyFilter() {
    filteredRows = rows.filter(rowMatchesFilter);
    void grid.setData([...filteredRows]);
  }

  /** Reset filter */
  function clearFilter() {
    filterCriteria = {
      dir: "",
      iface: "",
      srcAddr: { value: "", operator: "=" },
      srcPort: { value: "", operator: "=" },
      dstAddr: { value: "", operator: "=" },
      dstPort: { value: "", operator: "=" },
      port: { value: "", operator: "=" },
      proto: "",
      data: "",
      bytes: { value: "", operator: "=" },
      flag: { value: "", operator: "=" },
    };
    filteredRows = [...rows];
    void grid.setData([...filteredRows]);
  }

  const lib = (global as any)._tsixLib;

  /** Handler paket dari kernel (event "ipc_message" → data.type === "NET_SNIFF"). */
  function onSniff(msg: any) {
    const sniff = msg?.data || msg;
    if (!sniff || sniff.type !== "NET_SNIFF") return;
    if (currentIface !== "*" && sniff.iface !== currentIface) return;

    counter++;
    let dataStr: string;
    if (typeof sniff.data === "string") dataStr = sniff.data;
    else if (sniff.data != null) dataStr = JSON.stringify(sniff.data);
    else dataStr = "";

    const sekarang = new Date(sniff.timestamp);

    const hh = String(sekarang.getHours()).padStart(2, '0');
    const mm = String(sekarang.getMinutes()).padStart(2, '0');
    const ss = String(sekarang.getSeconds()).padStart(2, '0');
    const ms = String(sekarang.getMilliseconds()).padStart(3, '0');

    const rowData = {
      no: counter,
      //time: new Date(sniff.timestamp).toLocaleTimeString(),
      time: `${hh}:${mm}:${ss}.${ms}`,
      dir: sniff.dir === "TX" ? "⬆ TX" : "⬇ RX",
      iface: sniff.iface,
      src: `${sniff.srcAddress}:${sniff.srcPort}`,
      dst: `${sniff.dstAddress}:${sniff.dstPort}`,
      port: sniff.dstPort,
      proto: sniff.protocol,
      size: sniff.size,
      flag: flagName(sniff.flag ?? 0),
      data: (dataStr || "").slice(0, 140),
    };

    // Store full packet info
    packetHistory.set(counter, sniff);

    rows.push(rowData);
    if (rows.length > 500) {
      rows = rows.slice(-500);
      // Clean up old packet history
      const validNos = rows.map((r: any) => r.no);
      for (const [no] of packetHistory) {
        if (!validNos.includes(no)) packetHistory.delete(no);
      }
    }
    // Tampilan di-update INKREMENTAL (hanya baris baru ke WS) — bukan rebuild seluruh tabel.
    if (rowMatchesFilter(rowData)) {
      filteredRows.push(rowData);
      if (filteredRows.length > 500) filteredRows = filteredRows.slice(-500);
      scheduleAppend([rowData]);
    }
  }

  // Register handler SEKALI saja, jangan berulang
  if (!onSniffRegistered && lib?.onEvent) {
    lib.onEvent("ipc_message", onSniff);
    onSniffRegistered = true;
  }

  /** Tampilkan detail paket lengkap dalam alert */
  async function viewPacketDetails(no: number) {
    const sniff = packetHistory.get(no);
    if (!sniff) return;
    if (sniff.data.length > 20) {
      sniff.data = sniff.data.slice(0, 20) + "... (truncated)";
    }

    const dataPreview = typeof sniff.data === "string"
      ? sniff.data
      : sniff.data != null
        ? JSON.stringify(sniff.data, null, 2)
        : "(empty)";
    const details = [
      `Time: ${new Date(sniff.timestamp).toLocaleString()}`,
      `Direction: ${sniff.dir === "TX" ? "⬆ Outgoing (TX)" : "⬇ Incoming (RX)"}`,
      `Interface: ${sniff.iface}`,
      `Protocol: ${sniff.protocol}`,
      `Flag: ${flagName(sniff.flag ?? 0)}`,
      `Source: ${sniff.srcAddress}:${sniff.srcPort}`,
      `Destination: ${sniff.dstAddress}:${sniff.dstPort}`,
      `Size: ${sniff.size} bytes`,
      `\n─── Payload Data (plaintext) ───\n`,
      dataPreview,
      `\n${"═".repeat(20)}\n`,
      `Raw Packet Object (JSON)\n`,
      `${"═".repeat(20)}\n`,
      JSON.stringify(sniff, null, 2),
    ].join("\n");

    await TDialogs.alert(form.screen, `🦈 Packet #${no}`, details);
  }

  // ── Clear ──
  btnClear.onClick = async () => {
    rows = [];
    filteredRows = [];
    counter = 0;
    if (appendTimer) {
      clearTimeout(appendTimer);
      appendTimer = null;
    }
    pendingAppend = [];
    void grid.setData([]);
    status.caption = "🗑 Data dibersihkan";
  };

  // ── Filter Dialog ──
  // ── Filter ──
  btnFilter.onClick = async () => {
    await showFilterDialog();
  };

  /** Dialog form untuk input filter criteria — satu halaman lengkap */
  async function showFilterDialog() {
    const overlayId = "__filter_dialog_overlay__";
    const applyId = "__filter_apply__";
    const clearId = "__filter_clear__";
    const cancelId = "__filter_cancel__";

    // Nilai sementara yang diisi user (belum di-apply sampai tombol ditekan)
    const draft = {
      dir: filterCriteria.dir,
      iface: filterCriteria.iface,
      srcAddr: filterCriteria.srcAddr.value,
      srcAddrOp: filterCriteria.srcAddr.operator,
      srcPort: filterCriteria.srcPort.value,
      srcPortOp: filterCriteria.srcPort.operator,
      dstAddr: filterCriteria.dstAddr.value,
      dstAddrOp: filterCriteria.dstAddr.operator,
      dstPort: filterCriteria.dstPort.value,
      dstPortOp: filterCriteria.dstPort.operator,
      port: filterCriteria.port.value,
      portOp: filterCriteria.port.operator,
      proto: filterCriteria.proto,
      data: filterCriteria.data,
      dataOp: filterCriteria.data.operator,
      bytes: filterCriteria.bytes.value,
      bytesOp: filterCriteria.bytes.operator,
      flag: filterCriteria.flag.value,
      flagOp: filterCriteria.flag.operator,
    };

    // ── Helper: header section ──
    const section = (text: string) => {
      const lbl = new TLabel("sec-" + text);
      lbl.caption = text;
      lbl.style = {
        fontSize: "12px",
        fontWeight: "700",
        color: "var(--accent, #4caf50)",
        marginTop: "14px",
        marginBottom: "4px",
        display: "block",
      };
      return lbl;
    };

    // ── Helper: baris field (label + input [+ operator]) ──
    const makeRow = (labelText: string, input: TComponent, op?: TComboBox) => {
      const lbl = new TLabel("lbl-" + input.id);
      lbl.caption = labelText;
      lbl.style = {
        width: "150px",
        flexShrink: "0",
        color: "var(--text-muted, #888)",
        fontSize: "13px",
        fontWeight: "600",
      };
      input.style = { ...input.style, flex: "1", width: "auto" };
      const row = HStack({}, lbl, input);
      if (op) {
        op.style = { ...op.style, width: "90px", flexShrink: "0" };
        row.add(op);
      }
      return row;
    };

    // ── Helper: combobox operator yang melacak pilihan ──
    const opCombo = (
      id: string,
      options: string[],
      current: string,
      store: (v: string) => void,
    ) => {
      const c = new TComboBox(id);
      c.items = options;
      const idx = options.indexOf(current);
      c.selectedIndex = idx >= 0 ? idx : 0;
      c.onChange = (_i: number, item: string) => store(item);
      return c;
    };

    // ── Helper: combobox pilihan tunggal ──
    const pickCombo = (
      id: string,
      options: string[],
      current: string,
      store: (v: string) => void,
    ) => {
      const c = new TComboBox(id);
      c.items = options;
      const idx = options.indexOf(current);
      c.selectedIndex = idx >= 0 ? idx : 0;
      c.onChange = (_i: number, item: string) => store(item === "(semua)" ? "" : item);
      return c;
    };

    // ── Helper: text input yang melacak nilai ──
    const edit = (id: string, value: string, placeholder: string, store: (v: string) => void) => {
      const e = new TEdit(id);
      e.text = value;
      e.placeholder = placeholder;
      e.onInput = (v: string) => store(v);
      return e;
    };

    // ── Bangun komponen ──
    const cmbDir = pickCombo("fc_dir", ["(semua)", "TX", "RX"], draft.dir, (v) => (draft.dir = v));
    const cmbIface = pickCombo("fc_iface", ["(semua)", "smqtnl0", "smqtnl1"], draft.iface, (v) => (draft.iface = v));

    const edtSrcAddr = edit("fc_src_addr", draft.srcAddr, "192.168.1.1", (v) => (draft.srcAddr = v));
    const cmbSrcAddrOp = opCombo("fc_src_addr_op", ["=", "!="], draft.srcAddrOp, (v) => (draft.srcAddrOp = v));
    const edtSrcPort = edit("fc_src_port", draft.srcPort, "5000", (v) => (draft.srcPort = v));
    const cmbSrcPortOp = opCombo("fc_src_port_op", ["=", "!="], draft.srcPortOp, (v) => (draft.srcPortOp = v));

    const edtDstAddr = edit("fc_dst_addr", draft.dstAddr, "192.168.1.100", (v) => (draft.dstAddr = v));
    const cmbDstAddrOp = opCombo("fc_dst_addr_op", ["=", "!="], draft.dstAddrOp, (v) => (draft.dstAddrOp = v));
    const edtDstPort = edit("fc_dst_port", draft.dstPort, "8000", (v) => (draft.dstPort = v));
    const cmbDstPortOp = opCombo("fc_dst_port_op", ["=", "!="], draft.dstPortOp, (v) => (draft.dstPortOp = v));

    const edtPort = edit("fc_port", draft.port, "8080", (v) => (draft.port = v));
    const cmbPortOp = opCombo("fc_port_op", ["=", "!=", "<", ">"], draft.portOp, (v) => (draft.portOp = v));

    const cmbProto = pickCombo("fc_proto", ["(semua)", "JSON", "Binary"], draft.proto, (v) => (draft.proto = v));
    const edtData = edit("fc_data", draft.data, "Data", (v) => (draft.data = v));
    const cmbDataOp = opCombo("fc_data_op", ["=", "!=", "<", ">"], draft.dataOp, (v) => (draft.dataOp = v));
    const edtBytes = edit("fc_bytes", draft.bytes, "1024", (v) => (draft.bytes = v));
    const cmbBytesOp = opCombo("fc_bytes_op", ["=", "!=", "<", ">"], draft.bytesOp, (v) => (draft.bytesOp = v));

    const edtFlag = edit("fc_flag", draft.flag, "DATA", (v) => (draft.flag = v));
    const cmbFlagOp = opCombo("fc_flag_op", ["=", "!="], draft.flagOp, (v) => (draft.flagOp = v));

    // ── Tombol aksi ──
    const btnApply = new TButton(applyId, {
      background: "var(--accent, #4caf50)",
      color: "white",
    });
    btnApply.caption = "✅ Apply Filter";

    const btnNoFilter = new TButton(clearId, {
      background: "var(--warning, #ff9800)",
      color: "white",
    });
    btnNoFilter.caption = "⚪ No Filter";

    const btnCancel = new TButton(cancelId, {
      background: "var(--danger, #f44336)",
      color: "white",
    });
    btnCancel.caption = "❌ Cancel";

    // ── Susun kartu dialog ──
    const card = new TPanel("__filter_card__", {
      width: "700px",
      maxHeight: "85%",
      background: "var(--surface, #16213e)",
      border: "2px solid var(--accent, #4caf50)",
      borderRadius: "12px",
      padding: "20px",
      overflow: "auto",
      boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
      boxSizing: "border-box",
    });

    const title = new TLabel("f-title");
    title.caption = "🔍 Filter Paket — Semua Kriteria";
    title.style = {
      fontSize: "16px",
      fontWeight: "700",
      color: "var(--accent, #4caf50)",
      marginBottom: "8px",
      paddingBottom: "12px",
      borderBottom: "1px solid var(--border, #2a3d4d)",
      display: "block",
    };
    card.add(title);

    card.add(section("📡 Network Info"));
    card.add(makeRow("Arah:", cmbDir));
    card.add(makeRow("Interface:", cmbIface));

    card.add(section("📤 Sumber (Source)"));
    card.add(makeRow("IP Address:", edtSrcAddr, cmbSrcAddrOp));
    card.add(makeRow("Port:", edtSrcPort, cmbSrcPortOp));

    card.add(section("📥 Tujuan (Destination)"));
    card.add(makeRow("IP Address:", edtDstAddr, cmbDstAddrOp));
    card.add(makeRow("Port:", edtDstPort, cmbDstPortOp));

    card.add(section("🔌 Port (Dst)"));
    card.add(makeRow("Port:", edtPort, cmbPortOp));

    card.add(section("📊 Data"));
    card.add(makeRow("Protokol:", cmbProto));
    card.add(makeRow("Data:", edtData, cmbDataOp));
    card.add(makeRow("Bytes:", edtBytes, cmbBytesOp));

    card.add(section("🚩 Flag"));
    card.add(makeRow("Flag:", edtFlag, cmbFlagOp));

    // ── Baris tombol aksi (ditambahkan ke card!) ──
    const btnRow = HStack({}, Spacer(), btnApply, btnNoFilter, btnCancel);
    btnRow.style = {
      display: "flex",
      gap: "8px",
      alignItems: "center",
      justifyContent: "flex-end",
      borderTop: "1px solid var(--border, #2a3d4d)",
      paddingTop: "14px",
      marginTop: "16px",
    };
    card.add(btnRow);

    // ── Overlay full-screen ──
    const overlay = new TPanel(overlayId, {
      position: "fixed",
      inset: "0",
      zIndex: "9999999",
      background: "rgba(0,0,0,0.75)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });
    overlay.add(card);

    // ── Event handlers ──
    btnApply.onClick = async () => {
      filterCriteria.dir = draft.dir;
      filterCriteria.iface = draft.iface;
      filterCriteria.srcAddr.value = draft.srcAddr;
      filterCriteria.srcAddr.operator = draft.srcAddrOp;
      filterCriteria.srcPort.value = draft.srcPort;
      filterCriteria.srcPort.operator = draft.srcPortOp;
      filterCriteria.dstAddr.value = draft.dstAddr;
      filterCriteria.dstAddr.operator = draft.dstAddrOp;
      filterCriteria.dstPort.value = draft.dstPort;
      filterCriteria.dstPort.operator = draft.dstPortOp;
      filterCriteria.port.value = draft.port;
      filterCriteria.port.operator = draft.portOp;
      filterCriteria.proto = draft.proto;
      filterCriteria.data = draft.data;
      filterCriteria.bytes.value = draft.bytes;
      filterCriteria.bytes.operator = draft.bytesOp;
      filterCriteria.flag.value = draft.flag;
      filterCriteria.flag.operator = draft.flagOp;

      applyFilter();
      status.caption = `🔍 Filter applied (${filteredRows.length}/${rows.length} paket)`;
      try {
        await form.screen.win.unmount(overlayId);
      } catch (_) {}
    };

    btnNoFilter.onClick = async () => {
      clearFilter();
      status.caption = "🔍 Filter cleared";
      try {
        await form.screen.win.unmount(overlayId);
      } catch (_) {}
    };

    btnCancel.onClick = async () => {
      try {
        await form.screen.win.unmount(overlayId);
      } catch (_) {}
    };

    // ── Mount & bind event handlers ──
    await form.screen.win.mount(overlay.build());
    const bind = (comp: TComponent) => {
      comp.bindEventHandler(form.screen);
      comp.children.forEach(bind);
    };
    bind(overlay);
    await form.screen.win.flush();
  }

  // ── Start / Stop ──
  btnToggle.onClick = async () => {
    sniffing = !sniffing;
    const iface = IFACES[selIface.selectedIndex] || "*";
    if (sniffing) {
      currentIface = iface;
      await shell.netSnifferRegister(iface);
      btnToggle.caption = "⏹ Stop";
      status.caption =
        iface === "*" ? "🟢 Menangkap SEMUA interface..." : `🟢 Menangkap ${iface}...`;
    } else {
      await shell.netSnifferUnregister(iface);
      btnToggle.caption = "▶️ Start Sniffing";
      status.caption = "⏸ berhenti";
    }
  };

  // ── Ganti interface saat sedang sniffing → apply langsung ──
  selIface.onChange = async () => {
    if (!sniffing) return;
    const next = IFACES[selIface.selectedIndex] || "*";
    if (next === currentIface) return;
    await shell.netSnifferUnregister(currentIface);
    currentIface = next;
    await shell.netSnifferRegister(next);
    status.caption = `🟢 Ganti → ${next === "*" ? "SEMUA" : next}`;
  };

  // ── Cleanup saat window ditutup ──
  form.onClose = async () => {
    if (sniffing) {
      try {
        await shell.netSnifferUnregister(currentIface);
      } catch (_) {
        /* ignore */
      }
    }
  };

  await form.run();
});
