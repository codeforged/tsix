/**
 * Browser adapter untuk emerald.ts
 * 
 * Menyediakan polyfill untuk dependensi Node.js yang dibutuhkan emerald.ts
 * (uuid, GUITypes) agar widget bisa di-render langsung di browser.
 */

// ============================================================
// UUID polyfill
// ============================================================
function uuidv4Polyfill(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ============================================================
// GUIAction enum (hanya yang dipake factory functions)
// ============================================================
const GUIAction = {
  CREATE_WINDOW: 1,
  DESTROY_WINDOW: 2,
  MOUNT_NODE: 3,
  UNMOUNT_NODE: 4,
  UPDATE_PROPS: 5,
  MINIMIZE_WINDOW: 6,
  RESTORE_WINDOW: 7,
  MAXIMIZE_WINDOW: 8,
  UNMAXIMIZE_WINDOW: 9,
};

// ============================================================
// Patch global
// ============================================================
(globalThis as any).___emerald_adapter = true;
(globalThis as any).uuidv4 = uuidv4Polyfill;
(globalThis as any).GUIAction = GUIAction;

// ============================================================
// Renderer: IDOMNode → DOM
// ============================================================
export function renderIDOM(node: any): HTMLElement | Text | null {
  if (node === null || node === undefined) return null;

  // innerHTML: render raw
  if (node.props?.innerHTML !== undefined) {
    const el = document.createElement(node.tag || "div");
    el.innerHTML = node.props.innerHTML;
    if (node.props.style) Object.assign(el.style, node.props.style);
    if (node.props.className) el.className = node.props.className;
    if (node.id) el.id = node.id;
    return el;
  }

  // Text node
  if (node.tag === "text") {
    return document.createTextNode(node.props?.text || "");
  }

  const el = document.createElement(node.tag || "div");
  if (node.id) el.id = node.id;

  if (node.props) {
    for (const [key, value] of Object.entries(node.props)) {
      if (key === "style" && typeof value === "object") {
        Object.assign(el.style, value);
      } else if (key === "className") {
        el.className = value as string;
      } else if (key === "text" && node.tag !== "text") {
        el.textContent = value as string;
      } else if (key === "disabled") {
        if (value) el.setAttribute("disabled", "");
        else el.removeAttribute("disabled");
      } else if (["type", "value", "placeholder", "src", "alt", "min", "max"].includes(key)) {
        el.setAttribute(key, String(value));
      } else if (key.startsWith("on") || key === "innerHTML" || key === "id") {
        // skip
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }

  if (node.children?.length) {
    for (const child of node.children) {
      const childEl = renderIDOM(child);
      if (childEl) el.appendChild(childEl);
    }
  }

  return el;
}

/**
 * Mount array of IDOMNodes ke container.
 */
export function mountAll(nodes: any[], container: HTMLElement): number {
  container.innerHTML = "";
  let count = 0;
  for (const node of nodes) {
    const el = renderIDOM(node);
    if (el) { container.appendChild(el); count++; }
  }
  return count;
}
