/**
 * Emerald browser bundle entry point.
 * Mengimpor semua widget & factory functions dari emerald.ts asli
 * dan menambahkan DOM renderer untuk test di browser.
 */

import {
  text, div, button, input, image, span,
  h1, h2, h3, paragraph, textarea, selectBox,
  badge, taskbarButton, sensorCard, relayCard,
  lineChart, radialGauge, sevenSegment,
  indicatorLamp, toggleSwitch, slider,
  buildLineChartSvg, buildRadialGaugeSvg,
  buildSevenSegmentHtml, buildIndicatorLampImg,
  buildToggleSwitchSvg, buildToggleSwitchImg,
  ConnectedToggle, ConnectedRelayCard, ConnectedSensorCard,
  ConnectedLineChart, ConnectedRadialGauge,
  ConnectedSevenSegment, ConnectedIndicatorLamp,
  verticalGauge, ConnectedVerticalGauge, buildVerticalGaugeSvg,
} from "@tsix/emerald";

// ============================================================
// DOM Renderer — converts IDOMNode → real DOM elements
// ============================================================

/**
 * Render satu IDOMNode ke DOM element.
 */
export function renderIDOM(node: any): HTMLElement | Text | null {
  if (!node) return null;

  // innerHTML: render raw HTML
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
      } else if (["type", "value", "placeholder", "src", "alt", "min", "max", "width", "height"].includes(key)) {
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
 * Returns jumlah node yang berhasil di-render.
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

// Expose semuanya ke global untuk akses dari inline script HTML
(globalThis as any).Emerald = {
  text, div, button, input, image, span,
  h1, h2, h3, paragraph, textarea, selectBox,
  badge, taskbarButton, sensorCard, relayCard,
  lineChart, radialGauge, sevenSegment,
  indicatorLamp, toggleSwitch, slider,
  verticalGauge, ConnectedVerticalGauge, buildVerticalGaugeSvg,
  buildLineChartSvg, buildRadialGaugeSvg,
  buildSevenSegmentHtml, buildIndicatorLampImg,
  buildToggleSwitchSvg, buildToggleSwitchImg,
  ConnectedToggle, ConnectedRelayCard, ConnectedSensorCard,
  ConnectedLineChart, ConnectedRadialGauge,
  ConnectedSevenSegment, ConnectedIndicatorLamp,
  renderIDOM, mountAll, version: "emerald-bundle",
};
