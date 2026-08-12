/* ============================================================
 * DOME Client — Lightweight Charts
 * ============================================================
 * Modul penanganan widget chart di dome-client.
 * - Inbound: CHART_INIT, CHART_DATA, CHART_DESTROY
 * - State chart per (wid, targetId) disimpan privat di modul ini.
 */
(function () {
  "use strict";
  const TSIX = window.TSIX;

  const _charts = {};
  const _chartSeries = {};

  function handleChartInit(msg, retries = 30) {
    const { wid, targetId, opts } = msg;
    const el = TSIX.findElementById(wid, targetId);
    if (!el) {
      if (retries > 0) {
        setTimeout(() => handleChartInit(msg, retries - 1), 200);
      }
      return;
    }
    if (typeof LightweightCharts === "undefined") {
      el.textContent = "⏳ Loading Lightweight Charts...";
      if (retries > 0) {
        setTimeout(() => handleChartInit(msg, retries - 1), 500);
      } else {
        el.textContent = "❌ Lightweight Charts gagal load";
      }
      return;
    }
    const key = wid + "_" + targetId;
    const old = _charts[key];

    // Bersihkan chart lama DAN observer-nya jika ada
    if (old) {
      if (old._tsixObserver) {
        old._tsixObserver.disconnect();
      }
      old.remove();
      delete _charts[key];
      delete _chartSeries[key];
    }

    el.innerHTML = "";

    // FIX "Canvas Lock": Paksa container agar bisa mengecil bebas tanpa terganjal canvas di dalamnya
    el.style.overflow = "hidden";
    el.style.minWidth = "0";

    try {
      // Baca CSS variable dari theme aktif
      const root = document.documentElement;
      const bg = root.style.getPropertyValue("--bg").trim() || "#1a1a2e";
      const textCol =
        root.style.getPropertyValue("--text").trim() || "#e0e0e0";
      const accent =
        root.style.getPropertyValue("--accent").trim() || "#4caf50";
      const gridCol =
        root.style.getPropertyValue("--border").trim() ||
        "rgba(255,255,255,0.1)";

      // Inisialisasi awal dengan ukuran sekecil mungkin agar container parent bisa menentukan ukuran aslinya terlebih dahulu
      const chart = LightweightCharts.createChart(el, {
        width: 10,
        height: el.clientHeight || 160,
        layout: {
          background: { type: "solid", color: bg },
          textColor: textCol,
          fontSize: 10,
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: gridCol },
          horzLines: { color: gridCol },
        },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: {
          scaleMargins: { top: 0.15, bottom: 0.15 },
          borderVisible: false,
          ...(opts.minValue !== undefined ? { minValue: opts.minValue } : {}),
          ...(opts.maxValue !== undefined ? { maxValue: opts.maxValue } : {}),
        },
        timeScale: {
          timeVisible: true,
          secondsVisible: true,
          borderVisible: false,
        },
      });

      // Multi-series support
      const seriesMap = {};
      if (opts.series && opts.series.length > 0) {
        for (const s of opts.series) {
          // Create separate price scale if series has custom ID
          if (s.priceScaleId && s.priceScaleId !== "right") {
            chart.priceScale(s.priceScaleId).applyOptions({
              scaleMargins: { top: 0.15, bottom: 0.15 },
              ...(s.minValue !== undefined ? { minValue: s.minValue } : {}),
              ...(s.maxValue !== undefined ? { maxValue: s.maxValue } : {}),
            });
          }
          seriesMap[s.key] = chart.addSeries(LightweightCharts.LineSeries, {
            priceScaleId: s.priceScaleId || "right",
            color: s.color || opts.color || "#f44336",
            lineWidth: 2,
            lastValueVisible: true,
            priceLineVisible: false,
            crosshairMarkerVisible: true,
            crosshairMarkerRadius: 4,
          });
        }
      } else {
        // Single series (backward compatible)
        seriesMap._single = chart.addSeries(LightweightCharts.LineSeries, {
          color: opts.color || "#f44336",
          lineWidth: 2,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
        });
      }

      _charts[key] = chart;
      _chartSeries[key] = seriesMap;

      // Fungsi resize menggunakan requestAnimationFrame
      const doResize = (forcedWidth, forcedHeight) => {
        requestAnimationFrame(() => {
          try {
            // Ambil ukuran kontainer pembungkus yang sebenarnya saat ini
            const w = forcedWidth || Math.floor(el.getBoundingClientRect().width);
            const h =
              forcedHeight || Math.floor(el.getBoundingClientRect().height);
            if (w > 0 && h > 0) {
              chart.resize(w, h);
            }
          } catch (_) {}
        });
      };

      // Gunakan ResizeObserver untuk memantau perubahan ukuran div pembungkus secara real-time
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          // Fallback untuk cross-browser compatibility ukuran contentRect
          const rect = entry.contentRect;
          const width = Math.floor(rect.width);
          const height = Math.floor(rect.height);

          if (width > 0 && height > 0) {
            doResize(width, height);
          }
        }
      });

      // Mulai mengamati element
      observer.observe(el);

      // Simpan referensi ke objek chart agar bisa dibersihkan saat re-init berikutnya
      chart._tsixObserver = observer;
      chart._tsixResizeFn = doResize;

      // Trigger resize pertama kali agar langsung mengikuti ukuran asli container
      doResize();
    } catch (e) {
      el.textContent = "❌ " + e.message;
      console.error("[chart] Init error:", e);
    }
  }

  function handleChartData(msg) {
    const { wid, targetId, data } = msg;
    const key = wid + "_" + targetId;
    const seriesMap = _chartSeries[key];
    if (!seriesMap) return;

    // Multi-series format: { x: [...], series: { cpu: [...], mem: [...] } }
    if (
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      data.x &&
      data.series
    ) {
      const xData = data.x;
      for (const sk of Object.keys(data.series)) {
        const s = seriesMap[sk];
        if (!s) continue;
        const yData = data.series[sk];
        const lcData = [];
        for (let i = 0; i < xData.length; i++) {
          lcData.push({ time: xData[i], value: yData[i] });
        }
        s.setData(lcData);
      }
    } else {
      // Single series (backward compatible): data = [xTimestamps[], yValues[]]
      const xData = data?.[0] || [];
      const yData = data?.[1] || [];
      if (xData.length === 0) return;
      const s = seriesMap._single;
      if (!s) return;
      const lcData = [];
      for (let i = 0; i < xData.length; i++) {
        lcData.push({ time: xData[i], value: yData[i] });
      }
      s.setData(lcData);
    }
  }

  function handleChartDestroy(msg) {
    const { wid, targetId } = msg;
    const key = wid + "_" + targetId;
    const chart = _charts[key];
    if (chart) {
      if (chart._tsixResizeFn && window._tsixChartResizeHandler) {
        window._tsixChartResizeHandler.delete(chart._tsixResizeFn);
      }
      chart.remove();
      delete _charts[key];
      delete _chartSeries[key];
    }
  }

  TSIX.register("CHART_INIT", handleChartInit);
  TSIX.register("CHART_DATA", handleChartData);
  TSIX.register("CHART_DESTROY", handleChartDestroy);
})();
