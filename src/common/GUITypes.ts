/**
 * GUITypes.ts — RFC-TSIX-002
 *
 * Kontrak data untuk subsistem TSIX-GUI (DOM-Based Remote Rendering).
 * Semua interface di sini adalah KONSTITUSI — tidak boleh diubah sembarangan
 * tanpa persetujuan RFC.
 */

// ============================================================
// SECTION 1: GUI Actions (5 operasi yang diizinkan)
// ============================================================

export enum GUIAction {
  CREATE_WINDOW = "CREATE_WINDOW",
  DESTROY_WINDOW = "DESTROY_WINDOW",
  MOUNT_NODE = "MOUNT_NODE",
  UNMOUNT_NODE = "UNMOUNT_NODE",
  UPDATE_PROPS = "UPDATE_PROPS",
  MINIMIZE_WINDOW = "MINIMIZE_WINDOW",
  RESTORE_WINDOW = "RESTORE_WINDOW",
  MAXIMIZE_WINDOW = "MAXIMIZE_WINDOW",
  UNMAXIMIZE_WINDOW = "UNMAXIMIZE_WINDOW",
  REGISTER_DAEMON = "REGISTER_DAEMON",
  REGISTER_WM = "REGISTER_WM",
}

// ============================================================
// SECTION 2: Virtual DOM Node (pohon UI di memori Worker)
// ============================================================

export interface IDOMNode {
  /** ID unik elemen (contoh: "btn_submit_1"). Wajib unik dalam satu window. */
  id: string;

  /**
   * Tag HTML virtual.
   * "button", "div", "text", "input", "span", "textarea", "select", "img"
   * Khusus "text": akan menjadi TextNode di browser (bukan element).
   */
  tag: string;

  /**
   * Properti elemen.
   * Contoh: { text: "Login", color: "#4caf50", disabled: false }
   * Untuk event handler, gunakan: { onClickId: "callback_abc123" }
   *    - onClickId akan didaftarkan oleh @tsix/gui dan browser
   *      akan mengirim IBrowserEvent saat diklik.
   */
  props: Record<string, any>;

  /** Child nodes. Rekursif. */
  children: IDOMNode[];
}

// ============================================================
// SECTION 3: Payload Outbound (Userland → Kernel → gued → Browser)
// ============================================================

export interface IGUIPayload {
  /** Identifikasi syscall. HARUS "GUI_REQ". */
  syscall: "GUI_REQ";

  /** PID pengirim. Diisi ulang oleh Kernel (jangan percaya userland). */
  pid: number;

  /** Window ID target. */
  wid: string;

  /** Aksi yang diminta. */
  action: GUIAction;

  /**
   * ID node target (untuk MOUNT_NODE, UNMOUNT_NODE, UPDATE_PROPS).
   * - MOUNT_NODE: targetId adalah ID parent tempat node akan dipasang.
   * - UNMOUNT_NODE: targetId adalah ID node yang akan dilepas.
   * - UPDATE_PROPS: targetId adalah ID node yang propertinya diubah.
   */
  targetId?: string;

  /** Data node (untuk CREATE_WINDOW dan MOUNT_NODE). */
  node?: IDOMNode;

  /**
   * Diff properties (untuk UPDATE_PROPS).
   * Hanya kirim properti yang BERUBAH, bukan seluruh props.
   * Contoh: { text: "Sudah Diklik!", disabled: true }
   */
  props?: Record<string, any>;
}

// ============================================================
// SECTION 4: Event Inbound (Browser → gued → Kernel → Worker)
// ============================================================

/**
 * Format yang dikirim Browser via WebSocket ke gued.
 */
export interface IBrowserEvent {
  /** Window ID tempat event terjadi. */
  wid: string;

  /** ID elemen yang memicu event (data-tsix-id). */
  targetId: string;

  /** Tipe event. */
  eventType:
  | "click"
  | "input"
  | "keydown"
  | "close_window"
  | "focus"
  | "minimize_window"
  | "restore_window"
  | "maximize_window"
  | "unmaximize_window"
  | "term_resize"
  | "term_input"
  | "cm_change";
  /** Payload tambahan (misal: isi text input). */
  value?: string | number;
}

/**
 * Format IPC yang diteruskan gued ke Worker Aplikasi via Kernel.
 * Diterima oleh @tsix/gui sebagai event "GUI_EVENT".
 */
export interface IGUIEventIPC {
  /** Tipe event (konstan: "GUI_EVENT"). */
  type: "GUI_EVENT";

  /** Window ID. */
  wid: string;

  /** ID elemen yang memicu event. */
  targetId: string;

  /** Tipe event. */
  eventType: string;

  /** Payload tambahan. */
  value?: any;
}

// ============================================================
// SECTION 5: Internal Kernel/gued (Window Registry)
// ============================================================

/**
 * Entry dalam Window Registry milik GUIRegistry (Kernel)
 * dan gued (Daemon).
 */
export interface IWindowEntry {
  /** Window ID unik. */
  wid: string;

  /** PID pemilik jendela. */
  pid: number;

  /** Judul jendela (tampil di title bar). */
  title: string;

  /** Posisi Z (semakin tinggi = semakin depan). */
  zIndex: number;

  /** Apakah jendela ini sedang dalam state focused? */
  focused: boolean;

  /** WebSocket client ID (ID koneksi browser yang menampilkan jendela ini). */
  wsClientId?: string;

  /** Timestamp saat jendela dibuat. */
  createdAt: number;
}
