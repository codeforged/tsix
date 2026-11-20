/**
 * GUITypes.ts — RFC-TSIX-002
 *
 * (Mirror copy for VFS resolution via @common/GUITypes)
 * Kontrak data untuk subsistem TSIX-GUI (DOM-Based Remote Rendering).
 */

export enum GUIAction {
  CREATE_WINDOW = "CREATE_WINDOW",
  DESTROY_WINDOW = "DESTROY_WINDOW",
  MOUNT_NODE = "MOUNT_NODE",
  UNMOUNT_NODE = "UNMOUNT_NODE",
  UPDATE_PROPS = "UPDATE_PROPS",
  REGISTER_DAEMON = "REGISTER_DAEMON",
}

export interface IDOMNode {
  id: string;
  tag: string;
  props: Record<string, any>;
  children: IDOMNode[];
}

export interface IGUIPayload {
  syscall: "GUI_REQ";
  pid: number;
  wid: string;
  action: GUIAction;
  targetId?: string;
  node?: IDOMNode;
  props?: Record<string, any>;
}

export interface IBrowserEvent {
  wid: string;
  targetId: string;
  eventType:
    | "click"
    | "input"
    | "keydown"
    | "keyup"
    | "kb_key"
    | "close_window"
    | "focus";
  value?: string | number;
}

export interface IGUIEventIPC {
  type: "GUI_EVENT";
  wid: string;
  targetId: string;
  eventType: string;
  value?: any;
}

export interface IWindowEntry {
  wid: string;
  pid: number;
  title: string;
  zIndex: number;
  focused: boolean;
  wsClientId?: string;
  createdAt: number;
}
