/**
 * pistachio/treeview.ts — Navigasi pohon beranak (akun → grup → entri).
 *
 * Baris dirender ulang lewat `host.setContent` setiap kali expand/collapse
 * berubah, jadi kedalaman baris tidak perlu dihitung manual oleh pemakai.
 *
 * (c) 2026 TSIX Project
 */

import { TComponent, TNode, TOptions, TScreenPort, TStyle } from "./core";

const TEXT_DIM = "var(--text-dim, #ccc)";
const TEXT_MUTED = "var(--text-muted, #8b97a6)";
const ACCENT = "var(--accent, #4caf50)";
const BORDER = "1px solid var(--border, rgba(255,255,255,0.12))";

/** Satu simpul pohon. `children` membuat baris bisa di-expand. */
export interface TTreeNode {
  id: string;
  label: string;
  icon?: string;
  /** Teks kecil di kanan label (mis. jumlah item atau ID). */
  hint?: string;
  /** Data bebas pemakai aplikasi (record, indeks, dsb). */
  data?: unknown;
  children?: TTreeNode[];
  /** Terbuka sejak awal. */
  expanded?: boolean;
}

export interface TTreeViewOptions extends TOptions {
  nodes?: TTreeNode[];
  /** Lebar lekukan per level (px). */
  indent?: number;
}

interface TreeRow {
  node: TTreeNode;
  depth: number;
}

export class TTreeView extends TComponent {
  public onSelect: ((node: TTreeNode) => void) | null = null;
  public onToggle: ((node: TTreeNode, expanded: boolean) => void) | null = null;

  private _nodes: TTreeNode[];
  private readonly _expanded = new Set<string>();
  private readonly _indent: number;
  private _selectedId: string | null = null;

  constructor(
    idOrOpts?: string | TTreeViewOptions,
    opts?: TTreeViewOptions,
  ) {
    super(idOrOpts, opts, ["nodes", "indent"]);
    this.tag = "div";
    const o = this.options as TTreeViewOptions;
    this._nodes = [...(o.nodes ?? [])];
    this._indent = o.indent ?? 14;
    for (const node of this._nodes) this.seedExpanded(node);
    this.style = {
      flex: "1",
      minHeight: "0",
      overflowY: "auto",
      width: "100%",
      minWidth: "0",
      padding: "4px",
      background: "var(--surface, rgba(0,0,0,0.2))",
      border: BORDER,
      borderRadius: "6px",
      ...this.style,
    };
  }

  get nodes(): readonly TTreeNode[] {
    return this._nodes;
  }

  get selectedId(): string | null {
    return this._selectedId;
  }

  get selectedNode(): TTreeNode | null {
    return this._selectedId ? this.findNode(this._selectedId) : null;
  }

  get expandedIds(): string[] {
    return [...this._expanded];
  }

  /** Baris yang benar-benar terlihat (induk terbuka). */
  get rows(): ReadonlyArray<{ node: TTreeNode; depth: number }> {
    return this.flatten();
  }

  /** Ganti isi pohon; id yang masih ada mempertahankan state buka/tutup. */
  async setNodes(nodes: TTreeNode[]): Promise<void> {
    this._nodes = [...nodes];
    const alive = new Set<string>();
    for (const node of this._nodes) this.collectIds(node, alive);
    for (const id of [...this._expanded]) {
      if (!alive.has(id)) this._expanded.delete(id);
    }
    if (this._selectedId && !alive.has(this._selectedId)) {
      this._selectedId = null;
    }
    for (const node of this._nodes) this.seedExpanded(node);
    await this.rerender();
  }

  /** Pilih simpul (dan buka induknya) tanpa mengubah data pohon. */
  async select(id: string | null, notify = true): Promise<void> {
    if (id === null) {
      this._selectedId = null;
      this.applySelection();
      return;
    }
    const node = this.findNode(id);
    if (!node) return;

    let openedAncestor = false;
    for (const ancestor of this.ancestorsOf(id)) {
      if (!this._expanded.has(ancestor.id)) {
        this._expanded.add(ancestor.id);
        openedAncestor = true;
      }
    }
    this._selectedId = id;
    if (openedAncestor) await this.rerender();
    else this.applySelection();
    if (notify) this.onSelect?.(node);
  }

  async expand(id: string): Promise<void> {
    const node = this.findNode(id);
    if (!node?.children?.length || this._expanded.has(id)) return;
    this._expanded.add(id);
    await this.rerender();
    this.onToggle?.(node, true);
  }

  async collapse(id: string): Promise<void> {
    const node = this.findNode(id);
    if (!node?.children?.length || !this._expanded.has(id)) return;
    this._expanded.delete(id);
    await this.rerender();
    this.onToggle?.(node, false);
  }

  async toggle(id: string): Promise<void> {
    const node = this.findNode(id);
    if (!node?.children?.length) return;
    if (this._expanded.has(id)) await this.collapse(id);
    else await this.expand(id);
  }

  async expandAll(): Promise<void> {
    for (const node of this.allNodes()) {
      if (node.children?.length) this._expanded.add(node.id);
    }
    await this.rerender();
  }

  async collapseAll(): Promise<void> {
    this._expanded.clear();
    await this.rerender();
  }

  isExpanded(id: string): boolean {
    return this._expanded.has(id);
  }

  build(): TNode {
    const rows = this.flatten();
    return {
      id: this.id,
      tag: this.tag,
      props: { ...this.props, style: { ...this.style } },
      children: rows.map((row) => this.rowNode(row)),
    };
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    this.bindRows();
  }

  private rowNode(row: TreeRow): TNode {
    const rowId = this.rowIdOf(row.node);
    const node = row.node;
    const hasChildren = Boolean(node.children?.length);
    const open = hasChildren && this._expanded.has(node.id);
    const selected = node.id === this._selectedId;

    return {
      id: rowId,
      tag: "div",
      props: { onClickId: rowId, style: this.rowStyle(row, selected) },
      children: [
        {
          id: this.toggleIdOf(node),
          tag: "span",
          props: {
            ...(hasChildren ? { onClickId: this.toggleIdOf(node) } : {}),
            text: hasChildren ? (open ? "▾" : "▸") : "",
            style: this.chevronStyle(hasChildren),
          },
          children: [],
        },
        ...(node.icon
          ? [
              {
                id: this.iconIdOf(node),
                tag: "span",
                props: { text: node.icon, style: this.iconStyle() },
                children: [],
              },
            ]
          : []),
        {
          id: this.labelIdOf(node),
          tag: "span",
          props: { text: node.label, style: this.labelStyle() },
          children: [],
        },
        ...(node.hint
          ? [
              {
                id: this.hintIdOf(node),
                tag: "span",
                props: { text: node.hint, style: this.hintStyle() },
                children: [],
              },
            ]
          : []),
      ],
    };
  }

  /** Id DOM stabil per simpul (bukan per indeks) supaya klik tidak salah baris. */
  private keyOf(node: TTreeNode): string {
    return encodeURIComponent(node.id);
  }

  private rowIdOf(node: TTreeNode): string {
    return `${this.id}_r_${this.keyOf(node)}`;
  }

  private toggleIdOf(node: TTreeNode): string {
    return `${this.id}_t_${this.keyOf(node)}`;
  }

  private iconIdOf(node: TTreeNode): string {
    return `${this.id}_i_${this.keyOf(node)}`;
  }

  private labelIdOf(node: TTreeNode): string {
    return `${this.id}_l_${this.keyOf(node)}`;
  }

  private hintIdOf(node: TTreeNode): string {
    return `${this.id}_h_${this.keyOf(node)}`;
  }

  private rowStyle(row: TreeRow, selected: boolean): TStyle {
    return {
      display: "flex",
      alignItems: "center",
      gap: "5px",
      padding: "4px 6px",
      paddingLeft: `${6 + row.depth * this._indent}px`,
      borderRadius: "4px",
      cursor: "pointer",
      fontSize: "12px",
      fontWeight: selected ? "600" : "400",
      color: selected ? ACCENT : TEXT_DIM,
      background: selected
        ? "var(--accent-bg, rgba(76,175,80,0.15))"
        : "transparent",
    };
  }

  private chevronStyle(clickable: boolean): TStyle {
    return {
      width: "12px",
      minWidth: "12px",
      textAlign: "center",
      fontSize: "10px",
      color: TEXT_MUTED,
      cursor: clickable ? "pointer" : "default",
    };
  }

  private iconStyle(): TStyle {
    return {
      width: "16px",
      minWidth: "16px",
      textAlign: "center",
      fontSize: "12px",
    };
  }

  private labelStyle(): TStyle {
    return {
      flex: "1",
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    };
  }

  private hintStyle(): TStyle {
    return { fontSize: "10px", color: TEXT_MUTED };
  }

  private flatten(
    nodes: readonly TTreeNode[] = this._nodes,
    depth = 0,
    out: TreeRow[] = [],
  ): TreeRow[] {
    for (const node of nodes) {
      out.push({ node, depth });
      if (node.children?.length && this._expanded.has(node.id)) {
        this.flatten(node.children, depth + 1, out);
      }
    }
    return out;
  }

  /** Perbarui highlight tanpa membangun ulang baris. */
  private applySelection(): void {
    const host = this.host;
    if (!host) return;
    for (const row of this.flatten()) {
      void host.update(this.rowIdOf(row.node), {
        style: this.rowStyle(row, row.node.id === this._selectedId),
      });
    }
  }

  private async rerender(): Promise<void> {
    const host = this.host;
    if (!host?.setContent) return;
    await host.setContent(this.id, ...this.build().children);
    this.bindRows();
  }

  private bindRows(): void {
    const host = this.host;
    if (!host) return;
    for (const row of this.flatten()) {
      host.on(this.rowIdOf(row.node), "click", () =>
        this.handleRowClick(row.node),
      );
      if (row.node.children?.length) {
        host.on(this.toggleIdOf(row.node), "click", () =>
          void this.toggle(row.node.id),
        );
      }
    }
  }

  private handleRowClick(node: TTreeNode): void {
    // Klik simpul beranak langsung membuka anak-anaknya; klik item memilihnya.
    const openNow =
      Boolean(node.children?.length) && !this._expanded.has(node.id);
    if (openNow) this._expanded.add(node.id);
    this._selectedId = node.id;

    // Pemberitahuan pemilihan tidak menunggu render ulang pohon, sehingga
    // panel langsung menampilkan form walaupun DOM sedang di-update.
    this.onSelect?.(node);

    if (openNow) void this.rerender();
    else this.applySelection();
  }

  private seedExpanded(node: TTreeNode): void {
    if (node.expanded && node.children?.length) this._expanded.add(node.id);
    for (const child of node.children ?? []) this.seedExpanded(child);
  }

  private allNodes(
    nodes: readonly TTreeNode[] = this._nodes,
    out: TTreeNode[] = [],
  ): TTreeNode[] {
    for (const node of nodes) {
      out.push(node);
      if (node.children) this.allNodes(node.children, out);
    }
    return out;
  }

  private collectIds(node: TTreeNode, out: Set<string>): void {
    out.add(node.id);
    for (const child of node.children ?? []) this.collectIds(child, out);
  }

  private findNode(
    id: string,
    nodes: readonly TTreeNode[] = this._nodes,
  ): TTreeNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      const nested = this.findNode(id, node.children ?? []);
      if (nested) return nested;
    }
    return null;
  }

  /** Rantai induk dari akar sampai tepat di atas simpul `id`. */
  private ancestorsOf(id: string): TTreeNode[] {
    const trail: TTreeNode[] = [];
    const walk = (nodes: readonly TTreeNode[]): boolean => {
      for (const node of nodes) {
        if (node.id === id) return true;
        trail.push(node);
        if (node.children?.length && walk(node.children)) return true;
        trail.pop();
      }
      return false;
    };
    return walk(this._nodes) ? [...trail] : [];
  }
}
