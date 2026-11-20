/* ============================================================
 * DOME Client — ResourceBank (RES)
 * ============================================================
 * Inbound: RES_LOAD { wid, key, resType, mime, data }
 *   - sfx   → Audio (data:audio/mpeg;base64)
 *   - image → Image (data:<mime>;base64)
 *   - json  → JSON.parse
 *   - text  → string
 *   - bin   → base64 string
 *
 * Client API:
 *   - TSIX.makeResBank(wid)  → { getResource(key), has(key) } (untuk NJ DDC)
 *   - TSIX.getRes(wid, key)  → resource atau undefined
 *   - TSIX.clearResByWid(wid) → hapus semua resource milik window (saat destroy)
 *
 * Cache global: window._tsixResBank[ "<wid>:<key>" ] — scoped per-window,
 * di-wipe otomatis saat window ditutup (dome-client-windows).
 */
(function () {
  "use strict";
  const TSIX = window.TSIX;
  const resCache = (window._tsixResBank = window._tsixResBank || {});

  function resKey(wid, key) {
    return wid + ":" + key;
  }

  // --- Readiness (semaphore): NJ bisa await resBank.ready(key) ---
  // readyStore[fullKey] = { promise, resolve, settled }
  const readyStore = (window._tsixResReady = window._tsixResReady || {});

  function getReady(fullKey) {
    if (!readyStore[fullKey]) {
      let resolveFn;
      const p = new Promise(function (res) {
        resolveFn = res;
      });
      readyStore[fullKey] = { promise: p, resolve: resolveFn, settled: false };
    }
    return readyStore[fullKey];
  }

  function settleReady(fullKey) {
    const e = getReady(fullKey);
    if (!e.settled) {
      e.settled = true;
      e.resolve(true);
    }
  }

  function handleResLoad(msg) {
    const { wid, key, resType, mime, data } = msg;
    if (!wid || !key || data == null) return;
    const fullKey = resKey(wid, key);
    try {
      let res;
      let readyNow = true;
      if (resType === "sfx") {
        const audio = new Audio(
          "data:" + (mime || "audio/mpeg") + ";base64," + data
        );
        audio.volume = 0.7;
        audio.load();
        res = audio;
      } else if (resType === "image") {
        const img = new Image();
        // ready ditunda sampai onload — biar NJ yang await resBank.ready()
        // dapat sinyal saat gambar benar-benar siap dipakai. Error juga
        // di-settle biar tidak hang.
        img.onload = function () {
          settleReady(fullKey);
        };
        img.onerror = function () {
          settleReady(fullKey);
        };
        img.src = "data:" + (mime || "image/png") + ";base64," + data;
        res = img;
        readyNow = false; // di-settle via onload
      } else if (resType === "json") {
        res = JSON.parse(data);
      } else if (resType === "text") {
        res = data;
      } else {
        res = data; // bin → base64 string
      }
      resCache[fullKey] = res;
      if (readyNow) settleReady(fullKey);
    } catch (e) {
      settleReady(fullKey); // parse error — lepaskan waiter biar tidak hang
    }
  }

  function getRes(wid, key) {
    return resCache[resKey(wid, key)];
  }

  // Resource bank per-window untuk NJ (DDC context).
  function makeResBank(wid) {
    return {
      getResource: function (key) {
        return getRes(wid, key);
      },
      has: function (key) {
        return getRes(wid, key) !== undefined;
      },
      // Semaphore: await resBank.ready(key) → resolve saat resource siap
      // dipakai (image: tunggu onload; sfx/text/json/bin: langsung).
      ready: function (key) {
        return getReady(resKey(wid, key)).promise;
      },
    };
  }

  // Hapus semua resource milik window (key "<wid>:...") — dipanggil saat destroy.
  function clearResByWid(wid) {
    const prefix = wid + ":";
    Object.keys(resCache).forEach(function (k) {
      if (k.indexOf(prefix) === 0) {
        const r = resCache[k];
        try {
          if (r && typeof r.pause === "function") r.pause();
        } catch (_) {}
        delete resCache[k];
      }
    });
    // Bersihkan juga readiness store milik window ini (lepaskan waiter)
    Object.keys(readyStore).forEach(function (k) {
      if (k.indexOf(prefix) === 0) {
        settleReady(k);
        delete readyStore[k];
      }
    });
  }

  TSIX.getRes = getRes;
  TSIX.makeResBank = makeResBank;
  TSIX.clearResByWid = clearResByWid;
  TSIX.register("RES_LOAD", handleResLoad);
})();
