/* ============================================================
 * DOME Client — CodeMirror
 * ============================================================
 * Modul penanganan widget <codemirror> di dome-client.
 * - Inbound: CM_SET_VALUE, CM_SET_THEME
 * - Pembuatan widget <codemirror> (dengan event cm_change, cm_save, dll)
 *   ada di buildDOM() pada dom module.
 */
(function () {
  "use strict";
  const TSIX = window.TSIX;

  function handleCMSetValue(msg) {
    const { wid, targetId, value } = msg;
    const el = TSIX.findElementById(wid, targetId);
    if (el && el._codemirror) {
      el._codemirror.setValue(value);
    }
  }

  function handleCMSetTheme(msg) {
    const { wid, targetId, theme } = msg;
    const el = TSIX.findElementById(wid, targetId);
    if (el && el._codemirror) {
      el._codemirror.setOption("theme", theme);
    }
  }

  TSIX.register("CM_SET_VALUE", handleCMSetValue);
  TSIX.register("CM_SET_THEME", handleCMSetTheme);
})();
