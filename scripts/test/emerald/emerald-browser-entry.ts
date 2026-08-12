/**
 * Entry point untuk browser build emerald.ts
 * 
 * Patch global dependencies lalu re-export semua widget.
 */

// ============================================================
// 1. Patch uuid — ganti dengan polyfill sederhana
// ============================================================
const __uuid_counter = [0,0,0,0];
function simpleUuid() {
  const d = Date.now().toString(36);
  const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  const i = () => (++__uuid_counter[3]) & 0xffff;
  return `${d}-${r()}-4${r().slice(1)}-a${r().slice(1)}-${r()}${i().toString(16).padStart(4, '0')}`;
}

// Replace uuid module before anything else imports it
(globalThis as any).require = (id: string) => {
  if (id === 'uuid') return { v4: simpleUuid };
  if (id === 'module') return { _load() {}, _nodeModulePaths() { return []; } };
  return {};
};

// ============================================================
// 2. Patch GUITypes — definisikan ulang di global
// ============================================================
(globalThis as any).___GUIAction = {
  CREATE_WINDOW: 1, DESTROY_WINDOW: 2, MOUNT_NODE: 3,
  UNMOUNT_NODE: 4, UPDATE_PROPS: 5, MINIMIZE_WINDOW: 6,
  RESTORE_WINDOW: 7, MAXIMIZE_WINDOW: 8, UNMAXIMIZE_WINDOW: 9,
};

// ============================================================
// 3. Import emerald — semua widget factory & SVG builders
// ============================================================
// NOTE: esbuild akan resolve path relatif dari sini ke src/mirror/lib/emerald.ts
// Kita set tsconfig-paths dan alias saat build.
