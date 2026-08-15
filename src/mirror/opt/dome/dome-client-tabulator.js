/* ============================================================
 * DOME Client — Tabulator Data Grid
 * ============================================================
 * Widget datagrid berbasis Tabulator v6 (browser-side).
 * Semua render (sort, resize kolom, selection, scroll) ditangani
 * Tabulator sendiri → app hanya kirim data, tidak perlu setContent
 * per-baris seperti ConnectedDataGrid lama.
 *
 * - Inbound (app → browser via relay dome.ts):
 *     TB_DATA, TB_APPEND, TB_COLS, TB_SORT, TB_SELECT,
 *     TB_CLEAR_SELECT, TB_DESTROY
 * - Outbound (browser → app via GUI_EVENT → Window.bindHandler):
 *     tb_sort, tb_rowclick, tb_contextmenu, tb_select
 * - State grid per (wid, targetId) disimpan privat di modul ini.
 */
(function () {
  "use strict";
  const TSIX = window.TSIX;

  const _grids = {};

  const _tabKey = (wid, targetId) => wid + "_" + targetId;

  // Konversi DataGridColumn[] (emerald) → definisi kolom Tabulator
  function toTabColumns(cols) {
    return (cols || []).map((c) => {
      const col = {
        title: c.label || c.key || "",
        field: c.key,
        headerSort: c.sortable !== false,
        resizable: c.resizable !== false,
      };
      if (c.width != null) col.width = c.width;
      if (c.align) col.hozAlign = c.align;
      return col;
    });
  }

  // ============================================================
  // THEME — grid ikut theme TSIX aktif
  // ============================================================
  // CSS hasil kompilasi Tabulator v6 pakai warna hardcoded (bukan CSS vars),
  // jadi di-override di sini: warna grid dipetakan ke CSS variable theme TSIX
  // (--bg, --surface, --accent, dll — di-set di root oleh WINDOW_THEME).
  //
  // Urutan resolusi: var(--tb-*) [warna eksplisit dari app via TB_THEME,
  // scoped per-grid] → var(--root) [theme aktif global] → fallback dark.
  function ensureThemeCss() {
    if (document.getElementById("tsix-tabulator-theme")) return;
    const st = document.createElement("style");
    st.id = "tsix-tabulator-theme";
    st.textContent = [
      ".tabulator {",
      "  background-color: var(--tb-bg, var(--bg, #0d1b2a)) !important;",
      "  border-color: var(--tb-border, var(--border, rgba(255,255,255,0.12))) !important;",
      "  color: var(--tb-text, var(--text, #e0e0e0)) !important;",
      "}",
      ".tabulator .tabulator-header,",
      ".tabulator .tabulator-header .tabulator-col {",
      "  background-color: var(--tb-surface, var(--surface, #16213e)) !important;",
      "  border-right-color: var(--tb-border, var(--border, rgba(255,255,255,0.12))) !important;",
      "}",
      ".tabulator .tabulator-header {",
      "  border-bottom-color: var(--tb-border, var(--border, rgba(255,255,255,0.12))) !important;",
      "  color: var(--tb-text-dim, var(--text-dim, #ccc)) !important;",
      "}",
      ".tabulator .tabulator-tableholder .tabulator-table {",
      "  background-color: var(--tb-bg, var(--bg, #0d1b2a)) !important;",
      "  color: var(--tb-text, var(--text, #e0e0e0)) !important;",
      "}",
      ".tabulator .tabulator-row {",
      "  background-color: var(--tb-bg, var(--bg, #0d1b2a)) !important;",
      "  color: var(--tb-text, var(--text, #e0e0e0)) !important;",
      "}",
      // Zebra: baris genap pakai surface
      ".tabulator .tabulator-row.tabulator-row-even {",
      "  background-color: var(--tb-surface, var(--surface, #16213e)) !important;",
      "}",
      ".tabulator .tabulator-row.tabulator-selectable:hover {",
      "  background-color: var(--tb-accent-bg, var(--accent-bg, rgba(76,175,80,0.16))) !important;",
      "}",
      ".tabulator .tabulator-row.tabulator-selected,",
      ".tabulator .tabulator-row.tabulator-selected:hover {",
      "  background-color: var(--tb-accent-bg, var(--accent-bg, rgba(76,175,80,0.32))) !important;",
      "}",
      ".tabulator .tabulator-cell {",
      "  border-right-color: var(--tb-border, var(--border, rgba(255,255,255,0.12))) !important;",
      "}",
      // Panah sort: aktif = accent, inactive = muted
      ".tabulator .tabulator-col[aria-sort='ascending'] .tabulator-arrow,",
      ".tabulator .tabulator-col[aria-sort='descending'] .tabulator-arrow {",
      "  border-top-color: var(--tb-accent, var(--accent, #4caf50)) !important;",
      "  border-bottom-color: var(--tb-accent, var(--accent, #4caf50)) !important;",
      "  color: var(--tb-accent, var(--accent, #4caf50)) !important;",
      "}",
      ".tabulator .tabulator-col[aria-sort='none'] .tabulator-arrow {",
      "  border-bottom-color: var(--tb-text-muted, var(--text-muted, #888)) !important;",
      "}",
      ".tabulator .tabulator-placeholder .tabulator-placeholder-contents {",
      "  color: var(--tb-text-muted, var(--text-muted, #888)) !important;",
      "}",
      ".tabulator .tabulator-footer {",
      "  background-color: var(--tb-surface, var(--surface, #16213e)) !important;",
      "  border-top-color: var(--tb-border, var(--border, rgba(255,255,255,0.12))) !important;",
      "  color: var(--tb-text-muted, var(--text-muted, #888)) !important;",
      "}",
    ].join("\n");
    document.head.appendChild(st);
  }

  // TB_THEME — warna eksplisit dari app (ConnectedTabulator.mount), di-scope
  // ke wrapper grid via var --tb-* (diwariskan ke .tabulator di dalamnya).
  function handleTheme(msg) {
    const el = TSIX.findElementById(msg.wid, msg.targetId);
    if (!el) {
      // Wrapper mungkin belum selesai di-mount — retry singkat
      setTimeout(() => handleTheme(msg), 100);
      return;
    }
    const c = msg.colors || {};
    const or = (v, f) => (v ? v : f);
    el.style.setProperty("--tb-bg", or(c.bg, "var(--bg)"));
    el.style.setProperty("--tb-surface", or(c.surface, "var(--surface)"));
    el.style.setProperty("--tb-accent", or(c.accent, "var(--accent)"));
    el.style.setProperty("--tb-text", or(c.text, "var(--text)"));
    el.style.setProperty("--tb-text-dim", or(c.textDim, "var(--text-dim)"));
    el.style.setProperty("--tb-text-muted", or(c.textMuted, "var(--text-muted)"));
    el.style.setProperty("--tb-border", or(c.borderColor, "var(--border)"));
    el.style.setProperty("--tb-accent-bg", or(c.accentBg, "var(--accent-bg)"));
  }

  // ---- INISIALISASI (dipanggil buildDOM untuk tag "tabulator") ----
  function initTabulator(el, wid, props) {
    const targetId = el._tabNodeId;
    const k = _tabKey(wid, targetId);

    if (typeof Tabulator === "undefined") {
      el.textContent = "⏳ Loading Tabulator...";
      setTimeout(() => initTabulator(el, wid, props), 500);
      return;
    }

    // Bersihkan grid lama jika ada (re-init / reconnect)
    if (_grids[k]) {
      try { _grids[k].destroy(); } catch (_) { }
      delete _grids[k];
    }

    ensureThemeCss();
    el.innerHTML = "";
    el.style.overflow = "hidden";
    el.style.minWidth = "0";

    const opts = {
      data: (props.data || []).slice(),
      columns: toTabColumns(props.cols || []),
      layout: "fitColumns",
      resizableColumns: true,
      movableColumns: false,
      headerSort: true,
      columnHeaderSortMulti: false,
      placeholder: "No data",
      ...(props.height != null
        ? {
            height:
              typeof props.height === "number"
                ? props.height + "px"
                : props.height,
          }
        : { maxHeight: "100%" }),
      ...(props.selectable !== false
        ? { selectableRows: 1, selectableRowsHighlight: true }
        : { selectableRows: false }),
    };

    const table = new Tabulator(el, opts);
    _grids[k] = table;
    table._tsixWid = wid;
    table._tsixTargetId = targetId;

    // ---- OUTBOUND — event browser → app (via TSIX.send → GUI_EVENT) ----
    table.on("dataSorted", (sorters) => {
      const s = sorters && sorters[0];
      TSIX.send({
        wid,
        targetId,
        eventType: "tb_sort",
        value: JSON.stringify({ key: s ? s.field : "", dir: s ? s.dir : "" }),
      });
    });

    table.on("rowClick", (e, row) => {
      TSIX.send({
        wid,
        targetId,
        eventType: "tb_rowclick",
        value: JSON.stringify({ key: row.getData()._tsixKey }),
      });
    });

    table.on("rowContextMenu", (e, row) => {
      TSIX.send({
        wid,
        targetId,
        eventType: "tb_contextmenu",
        value: JSON.stringify({
          key: row.getData()._tsixKey,
          x: e.clientX,
          y: e.clientY,
        }),
      });
    });

    table.on("rowSelected", (row) => {
      TSIX.send({
        wid,
        targetId,
        eventType: "tb_select",
        value: JSON.stringify({ key: row.getData()._tsixKey }),
      });
    });

    table.on("rowDeselected", () => {
      if (table.getSelectedRows().length === 0) {
        TSIX.send({
          wid,
          targetId,
          eventType: "tb_select",
          value: JSON.stringify({ key: null }),
        });
      }
    });
  }

  // ============================================================
  // INBOUND — app → browser (relay dari dome.ts)
  // ============================================================

  // Akses grid dengan retry — aman kalau TB_* tiba sebelum initTabulator
  // selesai (race mount vs setData di sisi app/cashew).
  function withGrid(msg, fn, retries = 30) {
    const t = _grids[_tabKey(msg.wid, msg.targetId)];
    if (t) { fn(t, msg); return; }
    if (retries > 0) setTimeout(() => withGrid(msg, fn, retries - 1), 100);
  }

  function handleData(msg) {
    withGrid(msg, (t, m) => t.setData((m.rows || []).slice()));
  }

  function handleAppend(msg) {
    withGrid(msg, (t, m) => t.addData((m.rows || []).slice(), true));
  }

  function handleCols(msg) {
    withGrid(msg, (t, m) => t.setColumns(toTabColumns(m.cols || [])));
  }

  function handleSort(msg) {
    withGrid(msg, (t, m) => {
      if (m.key && m.dir) t.setSort([{ column: m.key, dir: m.dir }]);
    });
  }

  function selectRowByKey(t, key) {
    const rows = t.getRows();
    const target = rows.find((r) => r.getData()._tsixKey === key);
    if (target) t.selectRow(target);
  }

  function handleSelect(msg) {
    withGrid(msg, (t, m) => {
      if (m.key != null) selectRowByKey(t, m.key);
      else t.deselectRow();
    });
  }

  function handleClearSelect(msg) {
    withGrid(msg, (t) => t.deselectRow());
  }

  function handleDestroy(msg) {
    const k = _tabKey(msg.wid, msg.targetId);
    const t = _grids[k];
    if (!t) return;
    try { t.destroy(); } catch (_) { }
    delete _grids[k];
  }

  // Ekspor init ke TSIX — dipanggil buildDOM (dome-client-dom.js)
  TSIX.initTabulator = initTabulator;

  TSIX.register("TB_THEME", handleTheme);
  TSIX.register("TB_DATA", handleData);
  TSIX.register("TB_APPEND", handleAppend);
  TSIX.register("TB_COLS", handleCols);
  TSIX.register("TB_SORT", handleSort);
  TSIX.register("TB_SELECT", handleSelect);
  TSIX.register("TB_CLEAR_SELECT", handleClearSelect);
  TSIX.register("TB_DESTROY", handleDestroy);
})();
