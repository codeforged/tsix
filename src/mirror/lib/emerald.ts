/**
 * @tsix/emerald — TSIX Emerald Widget Toolkit
 *
 * High-level GUI toolkit untuk ekosistem TSIX.
 * Dibangun di atas PixelSpace Protocol via DOME engine.
 * Setara GTK/Qt — menyediakan Screen, Window, factory functions,
 * alert(), confirm(), dan komponen UI siap pakai.
 */

import { UserLib } from "./UserLib";
import { SyscallCode } from "../../common/SyscallCode";
import {
  GUIAction,
  IDOMNode,
  IGUIPayload,
  IGUIEventIPC,
} from "../../common/GUITypes";
import { v4 as uuidv4 } from "uuid";
import { theme } from "./theme";

// ============================================================
// FACTORY FUNCTIONS — Membangun IDOMNode tree
// ============================================================

/**
 * text(): Membuat text node virtual.
 *
 * Usage: text("Hello World")
 * Hasil di browser: TextNode dengan isi "Hello World"
 */
export function text(content: string): IDOMNode {
  return {
    id: uuidv4(),
    tag: "text",
    props: { text: content },
    children: [],
  };
}

/**
 * div(): Membuat div container virtual.
 *
 * Usage: div({ id: "container" }, text("Hello"))
 */
export function div(
  props: Record<string, any> = {},
  ...children: IDOMNode[]
): IDOMNode {
  return {
    id: props.id || uuidv4(),
    tag: "div",
    props,
    children,
  };
}

/**
 * button(): Membuat button virtual.
 *
 * Usage: button({ id: "btn1", text: "Klik Saya!", color: "#4caf50" })
 *
 * Props spesial:
 * - text: teks di dalam button
 * - disabled: true/false
 * - onClickId: ID callback (di-set otomatis oleh Window.onClick)
 */
export function button(
  props: Record<string, any> = {},
  ...children: IDOMNode[]
): IDOMNode {
  const id = props.id || uuidv4();
  const hasTextProp = !!props.text;
  return {
    id,
    tag: "button",
    props: { ...props, id },
    children: children.length > 0 ? children : hasTextProp ? [] : [],
  };
}

/**
 * input(): Membuat input field virtual.
 *
 * Usage: input({ id: "email", placeholder: "Email", type: "text" })
 */
export function input(props: Record<string, any> = {}): IDOMNode {
  return {
    id: props.id || uuidv4(),
    tag: "input",
    props,
    children: [],
  };
}

/**
 * image(): Membuat <img> virtual.
 *
 * Usage:
 *   image({ src: "/path/to/image.png", alt: "Gambar", width: 200, height: 150 })
 *   image({ b64: "iVBORw0KGgo...", mime: "image/png", alt: "Icon" })
 *   image({ b64: "iVBOR...", alt: "User", style: { borderRadius: "50%", width: "48px" } })
 *
 * Props khusus:
 *   - src:      URL/path file gambar (jpg, png, gif, bmp, svg)
 *   - b64:      Base64 string gambar (akan otomatis jadi data URI)
 *   - mime:     MIME type untuk b64 (default: "image/png"). Bisa "image/jpeg", "image/gif", dll
 *   - alt:      Teks alternatif (aksesibilitas)
 *   - width:    Lebar dalam pixel (opsional)
 *   - height:   Tinggi dalam pixel (opsional)
 *
 * Props lain didukung: style, className, id, title, loading ("lazy"|"eager"), dll
 */
export function image(props: Record<string, any> = {}): IDOMNode {
  const id = props.id || uuidv4();
  const mergedProps: Record<string, any> = { ...props, id };

  // Handle b64: convert to data URI
  if (props.b64) {
    const mime = props.mime || "image/png";
    mergedProps.src = `data:${mime};base64,${props.b64}`;
    delete mergedProps.b64;
    if (mergedProps.mime) delete mergedProps.mime;
  }

  return {
    id,
    tag: "img",
    props: mergedProps,
    children: [],
  };
}

/**
 * span(): Membuat inline span virtual.
 */
export function span(
  props: Record<string, any> = {},
  ...children: IDOMNode[]
): IDOMNode {
  return {
    id: props.id || uuidv4(),
    tag: "span",
    props,
    children,
  };
}

/**
 * h1(), h2(), h3(): Heading tags.
 */
export function h1(
  props: Record<string, any> = {},
  ...children: IDOMNode[]
): IDOMNode {
  const id = props.id || uuidv4();
  return { id, tag: "h1", props: { ...props, id }, children };
}
export function h2(
  props: Record<string, any> = {},
  ...children: IDOMNode[]
): IDOMNode {
  const id = props.id || uuidv4();
  return { id, tag: "h2", props: { ...props, id }, children };
}
export function h3(
  props: Record<string, any> = {},
  ...children: IDOMNode[]
): IDOMNode {
  const id = props.id || uuidv4();
  return { id, tag: "h3", props: { ...props, id }, children };
}

/**
 * paragraph(): Membuat <p> virtual.
 */
export function paragraph(
  props: Record<string, any> = {},
  ...children: IDOMNode[]
): IDOMNode {
  return {
    id: props.id || uuidv4(),
    tag: "p",
    props,
    children,
  };
}

/**
 * textarea(): Membuat textarea multiline virtual.
 */
export function textarea(props: Record<string, any> = {}): IDOMNode {
  return {
    id: props.id || uuidv4(),
    tag: "textarea",
    props,
    children: props.text ? [text(props.text)] : [],
  };
}

/**
 * selectBox(): Membuat <select> dropdown virtual.
 *
 * Usage: selectBox({ id: "lang" }, [
 *   { value: "id", text: "Indonesia" },
 *   { value: "en", text: "English" },
 * ])
 */
export function selectBox(
  props: Record<string, any> = {},
  options: { value: string; text: string }[] = [],
): IDOMNode {
  const children: IDOMNode[] = options.map((opt) => ({
    id: uuidv4(),
    tag: "option",
    // props: { value: opt.value, text: opt.text },
    props: { value: opt.value },
    children: [text(opt.text)],
  }));
  return {
    id: props.id || uuidv4(),
    tag: "select",
    props,
    children,
  };
}

// ============================================================
// WINDOW — Siklus hidup satu jendela TSIX-GUI
// ============================================================

interface EventCallback {
  targetId: string;
  eventType: string;
  callback: (event: IGUIEventIPC) => void;
}

export interface WindowOptions {
  title: string;
  /** Ikon/emoji yang tampil di kiri judul title bar (opsional) */
  icon?: string;
  lib?: UserLib;
  fullscreen?: boolean;
  width?: number;
  height?: number;
  frameless?: boolean;
  maximizable?: boolean;
  resizable?: boolean;
  /** Posisi X window di desktop (opsional) */
  left?: number;
  /** Posisi Y window di desktop (opsional) */
  top?: number;
  /** Tengahkan window di desktop — menimpa left/top (default: false) */
  desktopCentered?: boolean;
}

// ============================================================
// KOMPONEN — Widget siap pakai untuk Window Manager
// ============================================================

/**
 * badge(): Dot indikator kecil berdenyut (pulsing dot).
 *
 * Usage:
 *   badge()                          → dot hijau default
 *   badge({ color: "#f44336" })      → dot merah
 *   badge({ pulse: false })          → static dot (no animation)
 *   badge({ size: 8 })               → custom ukuran
 *
 * CSS: butuh @keyframes tsix-pulse di stylesheet (di-inject oleh dome.ts)
 */
export function badge(props: Record<string, any> = {}): IDOMNode {
  const id = props.id || uuidv4();
  const color = props.color || "#4caf50";
  const size = (props.size || 6) + "px";
  const pulse = props.pulse !== false; // default true

  // Merge user-provided style dengan style default badge
  const userStyle = props.style || {};
  return {
    id,
    tag: "span",
    props: {
      className: pulse ? "tsix-badge tsix-badge-pulse" : "tsix-badge",
      style: {
        display: userStyle.display || "inline-block",
        width: userStyle.width || size,
        height: userStyle.height || size,
        background: userStyle.background || color,
        borderRadius: userStyle.borderRadius || "50%",
        boxShadow:
          userStyle.boxShadow || `0 0 ${(props.size || 6) * 1.5}px ${color}`,
        ...Object.fromEntries(
          Object.entries(userStyle).filter(
            ([k]) =>
              ![
                "display",
                "width",
                "height",
                "background",
                "borderRadius",
                "boxShadow",
              ].includes(k),
          ),
        ),
      },
      id,
    },
    children: [],
  };
}

/**
 * taskbarButton(): Tombol taskbar dengan icon, label, dan badge opsional.
 *
 * Usage:
 *   taskbarButton({ icon: "📝", label: "Notepad" })
 *   taskbarButton({ icon: "📝", label: "Notepad", badge: badge() })
 *   taskbarButton({ icon: "📝", label: "Notepad", badge: badge({color:"#f44336"}), active: true })
 *
 * Props khusus:
 *   - icon:    emoji/teks icon (tampil di kiri)
 *   - label:   teks label (tampil di kanan icon)
 *   - badge:   IDOMNode opsional (biasanya dari badge())
 *   - active:  true = styling aktif/selected
 */
export function taskbarButton(props: Record<string, any> = {}): IDOMNode {
  const id = props.id || uuidv4();
  const active = !!props.active;
  const children: IDOMNode[] = [];

  // Icon
  if (props.icon) {
    children.push(
      span(
        { style: { fontSize: "14px", marginRight: "4px" } },
        text(props.icon),
      ),
    );
  }

  // Label
  if (props.label) {
    children.push(
      span(
        {
          style: {
            fontSize: "11px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
        },
        text(props.label),
      ),
    );
  }

  // Badge (opsional, tampil di kanan)
  if (props.badge && typeof props.badge === "object" && props.badge.tag) {
    children.push(props.badge);
  }

  return {
    id,
    tag: "button",
    props: {
      id,
      className: active ? "tsix-taskbar-btn active" : "tsix-taskbar-btn",
      style: {
        display: "flex",
        alignItems: "center",
        gap: "4px",
        background: active ? theme.colors.accentBg : "transparent",
        color: active ? theme.colors.accent : theme.colors.textDim,
        border: "none",
        borderBottom: active
          ? `2px solid ${theme.colors.accent}`
          : "2px solid transparent",
        borderRadius: "3px",
        padding: "4px 10px",
        fontSize: "12px",
        cursor: "pointer",
        height: "28px",
        maxWidth: "160px",
        transition: "background 0.15s, border-color 0.15s",
      },
    },
    children,
  };
}

/**
 * sensorCard(): Kartu sensor IoT dengan progress bar.
 *
 * Usage:
 *   sensorCard({
 *     id: "temp", label: "Temperature", unit: "°C",
 *     icon: "🌡️", color: "#f44336", value: 45, min: 0, max: 100
 *   })
 *
 * Props:
 *   - id:       ID unik (wajib, akan dipakai untuk sv-{id} dan bar-{id})
 *   - label:    Nama sensor (e.g. "Temperature")
 *   - unit:     Satuan (e.g. "°C", "%")
 *   - icon:     Emoji/icon
 *   - color:    Warna utama (hex, e.g. "#f44336")
 *   - value:    Nilai saat ini (number). Default "—" jika undefined
 *   - min/max:  Range untuk progress bar (default 0/100)
 */
export function sensorCard(props: Record<string, any> = {}): IDOMNode {
  const id = props.id || uuidv4();
  const label = props.label || "Sensor";
  const unit = props.unit || "";
  const icon = props.icon || "📡";
  const color = props.color || "#4caf50";
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const val = props.value;

  const pct =
    val !== undefined
      ? Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100))
      : 0;

  return div(
    {
      id: `sc-${id}`,
      style: {
        flex: "1",
        minWidth: "180px",
        background: theme.colors.card,
        borderRadius: "10px",
        padding: "16px",
        border: `1px solid ${color}44`,
      },
    },
    div(
      {
        style: {
          display: "flex",
          justifyContent: "space-between",
          marginBottom: "8px",
        },
      },
      span({
        text: `${icon} ${label}`,
        style: { fontSize: "13px", color: theme.colors.textDim },
      }),
      span({
        text: unit,
        style: { fontSize: "11px", color: theme.colors.textMuted },
      }),
    ),
    span({
      id: `sv-${id}`,
      text: val !== undefined ? val.toFixed(1) : "—",
      style: {
        fontSize: "28px",
        fontWeight: "700",
        color,
        display: "block",
        marginBottom: "6px",
      },
    }),
    div(
      {
        style: {
          background: theme.colors.bgAlt,
          borderRadius: "3px",
          height: "6px",
          overflow: "hidden",
        },
      },
      div({
        id: `bar-${id}`,
        style: {
          width: `${pct}%`,
          background: color,
          height: "6px",
          borderRadius: "3px",
          transition: "width 0.3s",
        },
      }),
    ),
  );
}

/**
 * relayCard(): Kartu relay ON/OFF untuk panel kontrol.
 *
 * Usage:
 *   relayCard({ id: "fan", label: "FAN", icon: "🌀", color: "#4caf50", active: true })
 *
 * Props:
 *   - id:      ID unik (wajib, dipakai untuk rs-{id})
 *   - label:   Nama relay (e.g. "FAN")
 *   - icon:    Emoji
 *   - color:   Warna saat ON (e.g. "#4caf50")
 *   - active:  true = ON, false = OFF (default false)
 */
export function relayCard(props: Record<string, any> = {}): IDOMNode {
  const id = props.id || uuidv4();
  const label = props.label || "Relay";
  const icon = props.icon || "⚡";
  const color = props.color || "#4caf50";
  const on = !!props.active;

  return div(
    {
      id: `rc-${id}`,
      style: {
        padding: "12px",
        borderRadius: "8px",
        border: `1px solid ${on ? color : theme.colors.border}`,
        background: on ? `${color}22` : theme.colors.card,
        flex: "1",
        textAlign: "center" as any,
      },
    },
    span({
      text: `${icon} ${label}`,
      style: {
        fontSize: "13px",
        color: theme.colors.textDim,
        display: "block",
        marginBottom: "4px",
      },
    }),
    span({
      id: `rs-${id}`,
      text: on ? "🟢 ON" : "⚫ OFF",
      style: {
        color: on ? color : theme.colors.textMuted,
        fontWeight: "700" as any,
        fontSize: "14px",
      },
    }),
  );
}

// ============================================================
// SVG-ONLY BUILDERS — Untuk targeted update tanpa setContent
// ============================================================

/**
 * buildLineChartSvg(): Generate SVG string saja (tanpa wrapper card).
 * Dipakai untuk update targeted via innerHTML → gak flicker!
 *
 * NOTE: SVG pakai width="100%" height="H" — width responsif, height tetap.
 */
export function buildLineChartSvg(props: Record<string, any> = {}): string {
  const id = props.id || "chart";
  const raw = props.data || [];
  const color = props.color || "#4caf50";
  const spline = !!props.spline;
  const fill = !!props.fill;
  const W = props.width || 280;
  const H = props.height || 180;
  const pad = { t: 20, r: 12, b: 28, l: 38 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;

  const points: { x: number; y: number; label?: string }[] = [];
  for (const d of raw) {
    if (typeof d === "number") points.push({ x: points.length, y: d });
    else points.push({ x: points.length, y: d.y ?? 0, label: d.x ?? "" });
  }
  if (points.length === 0) points.push({ x: 0, y: 0 }, { x: 1, y: 0 });

  const yMin = props.min ?? Math.min(...points.map((p) => p.y));
  const yMax = props.max ?? Math.max(...points.map((p) => p.y));
  const yRange = yMax - yMin || 1;

  const toX = (i: number) =>
    pad.l + (points.length > 1 ? (i / (points.length - 1)) * pw : pw / 2);
  const toY = (v: number) => pad.t + ph - ((v - yMin) / yRange) * ph;
  const coords = points.map((p, i) => [toX(i), toY(p.y)]);

  let pathD: string;
  if (spline) {
    pathD = splinePath(coords, 0.5);
  } else {
    pathD = coords
      .map(
        (c, i) =>
          (i === 0 ? "M" : "L") + ` ${c[0].toFixed(1)} ${c[1].toFixed(1)}`,
      )
      .join(" ");
  }
  let areaD = "";
  if (fill) {
    areaD =
      pathD +
      ` L ${coords[coords.length - 1][0].toFixed(1)} ${pad.t + ph} L ${coords[0][0].toFixed(1)} ${pad.t + ph} Z`;
  }

  const lcIsLight = isLightColor(theme.colors.card);
  const lcGrid = lcIsLight ? "#00000012" : "#ffffff10";
  const lcTick = lcIsLight ? "#00000018" : "#ffffff25";

  let html = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block;overflow:hidden">`;
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + (i / 3) * ph;
    html += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="${lcGrid}" stroke-width="1"/>`;
    const val = yMin + ((3 - i) / 3) * yRange;
    html += `<text x="${pad.l - 4}" y="${y + 4}" fill="#888" font-size="9" text-anchor="end">${val % 1 === 0 ? Math.round(val) : val.toFixed(1)}</text>`;
  }
  for (
    let i = 0;
    i < points.length;
    i += Math.max(1, Math.floor(points.length / 6))
  ) {
    html += `<text x="${toX(i).toFixed(1)}" y="${H - 4}" fill="#888" font-size="8" text-anchor="middle">${points[i].label || String(i + 1)}</text>`;
  }
  html += `<clipPath id="lc-clip-${id}"><rect x="${pad.l}" y="${pad.t}" width="${pw}" height="${ph}"/></clipPath>`;
  html += `<g clip-path="url(#lc-clip-${id})">`;
  html += `<g id="lc-scroll-${id}" data-tsix-id="lc-scroll-${id}" style="transition: transform 0.25s ease-out">`;
  if (areaD)
    html += `<path id="lc-area-${id}" data-tsix-id="lc-area-${id}" d="${areaD}" fill="${color}22" stroke="none"/>`;
  html += `<path id="lc-line-${id}" data-tsix-id="lc-line-${id}" d="${pathD}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  html += `<g id="lc-dots-${id}" data-tsix-id="lc-dots-${id}">`;
  for (let di = 0; di < coords.length; di++) {
    const c = coords[di];
    const yVal = (points[di]?.y ?? 0).toFixed(1);
    html += `<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="4" fill="${color}" title="${yVal}" style="cursor:pointer"/>`;
  }
  html += `</g>`;
  html += `</g>`;
  html += `</g>`;
  html += `</svg>`;
  return html;
}

/**
 * buildRadialGaugeSvg(): Generate SVG string saja (tanpa wrapper card).
 */
export function buildRadialGaugeSvg(props: Record<string, any> = {}): string {
  const id = props.id || "gauge";
  const val = props.value ?? 0;
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const color = props.color || "#4caf50";
  const size = props.size || 120;
  const unit = props.unit || "";

  const cx = size / 2,
    cy = size / 2;
  const radius = size * 0.36;
  const strokeW = size * 0.1;
  const startAngle = -220,
    endAngle = 40;
  const range = endAngle - startAngle;
  const pct = Math.max(0, Math.min(1, (val - min) / (max - min || 1)));
  const angle = startAngle + range * pct;
  const rad = (a: number) => (a * Math.PI) / 180;
  const arcX = (a: number) => cx + radius * Math.cos(rad(a));
  const arcY = (a: number) => cy + radius * Math.sin(rad(a));
  const arcLength = (radius * Math.abs(endAngle - startAngle) * Math.PI) / 180;
  const dashOffset = arcLength * (1 - pct);

  const rgIsLight = isLightColor(theme.colors.card);
  const rgBgArc = rgIsLight ? "#00000010" : "#ffffff15";
  const rgTick = rgIsLight ? "#00000018" : "#ffffff25";
  const rgFg = rgIsLight ? "#333" : "#fff";

  let html = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="display:block;margin:0 auto;">`;
  html += `<path d="M${arcX(startAngle).toFixed(1)} ${arcY(startAngle).toFixed(1)} A${radius} ${radius} 0 1 1 ${arcX(endAngle).toFixed(1)} ${arcY(endAngle).toFixed(1)}" fill="none" stroke="${rgBgArc}" stroke-width="${strokeW}" stroke-linecap="round"/>`;
  html += `<path id="rg-arc-${id}" d="M${arcX(startAngle).toFixed(1)} ${arcY(startAngle).toFixed(1)} A${radius} ${radius} 0 1 1 ${arcX(endAngle).toFixed(1)} ${arcY(endAngle).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round" stroke-dasharray="${arcLength} ${arcLength}" stroke-dashoffset="${dashOffset}" style="transition: stroke-dashoffset 0.2s ease-out"/>`;
  for (let i = 0; i <= 10; i++) {
    const ta = startAngle + (range / 10) * i;
    const ort = radius + strokeW * 0.8;
    html += `<line x1="${arcX(ta).toFixed(1)}" y1="${arcY(ta).toFixed(1)}" x2="${(cx + ort * Math.cos(rad(ta))).toFixed(1)}" y2="${(cy + ort * Math.sin(rad(ta))).toFixed(1)}" stroke="${rgTick}" stroke-width="1"/>`;
  }
  const nl = radius * 0.7;
  html += `<g id="rg-needle-group-${id}" style="transition: transform 0.2s ease-out; transform-origin: ${cx}px ${cy}px; transform: rotate(${angle}deg)">`;
  html += `<line x1="${cx}" y1="${cy}" x2="${cx + nl}" y2="${cy}" stroke="${rgFg}" stroke-width="2" stroke-linecap="round"/>`;
  html += `</g>`;
  html += `<circle cx="${cx}" cy="${cy}" r="${size * 0.04}" fill="${rgFg}"/>`;
  html += `<text id="rg-val-${id}" x="${cx}" y="${cy + size * 0.05 + 15}" fill="${rgFg}" font-size="${size * 0.14}" font-weight="700" text-anchor="middle" dominant-baseline="middle">${val % 1 === 0 ? Math.round(val) : val.toFixed(1)}</text>`;
  html += `<text x="${cx}" y="${cy + size * 0.2 + 15}" fill="#888" font-size="${size * 0.09}" text-anchor="middle">${unit}</text>`;
  html += `</svg>`;
  return html;
}

/**
 * buildSevenSegmentHtml(): Generate HTML string saja (tanpa wrapper card).
 */
export function buildSevenSegmentHtml(props: Record<string, any> = {}): string {
  const value = props.value ?? 0;
  const digits = props.digits ?? 4;
  const decimals = props.decimals ?? 0;
  const color = props.color || "#4caf50";
  const scale = props.scale ?? 1;
  // sevenSegment offColor: kalo theme light, pake semi-transparan biar keliatan bedanya
  const isLightBg =
    theme.colors.bg.startsWith("#") && isLightColor(theme.colors.bg);
  const offColor =
    props.offColor || (isLightBg ? color + "22" : darken(color, 0.2));
  const formatted = Number(value).toFixed(decimals);
  const padded = formatted
    .padStart(digits + (decimals > 0 ? 1 : 0), " ")
    .slice(-(digits + (decimals > 0 ? 1 : 0)));
  const segMap: Record<string, string> = {
    "0": "ABCDEF",
    "1": "BC",
    "2": "ABDEG",
    "3": "ABCDG",
    "4": "BCFG",
    "5": "ACDFG",
    "6": "ACDEFG",
    "7": "ABC",
    "8": "ABCDEFG",
    "9": "ABCDFG",
    "-": "G",
    " ": "",
    ".": "",
  };
  const segDefs: Record<string, [number, number, number, number]> = {
    A: [4, 2, 26, 2],
    B: [28, 4, 28, 22],
    C: [28, 26, 28, 44],
    D: [4, 46, 26, 46],
    E: [2, 26, 2, 44],
    F: [2, 4, 2, 22],
    G: [4, 24, 26, 24],
  };
  const toUri = (s: string) => "data:image/svg+xml," + encodeURIComponent(s);
  const digW = Math.round(30 * scale);
  const digH = Math.round(50 * scale);
  const dotW = Math.round(8 * scale);

  let html = `<div style="display:flex;justify-content:center;align-items:center;gap:${Math.round(4 * scale)}px;padding:${Math.round(8 * scale)}px ${Math.round(4 * scale)}px;transform:skewX(-8deg);">`;
  for (const ch of padded) {
    if (ch === ".") {
      html += `<img src="${toUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${dotW}" height="${digH}" viewBox="0 0 8 50"><circle cx="4" cy="46" r="4" fill="${color}"/></svg>`)}" width="${dotW}" height="${digH}" style="flex-shrink:0;"/>`;
      continue;
    }
    const active = segMap[ch] || "";
    let seg = `<svg xmlns="http://www.w3.org/2000/svg" width="${digW}" height="${digH}" viewBox="0 0 30 48">`;
    for (const s of "ABCDEFG") {
      const [x1, y1, x2, y2] = segDefs[s];
      seg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${active.includes(s) ? color : offColor}" stroke-width="${Math.round(7 * scale)}" stroke-linecap="butt"/>`;
    }
    seg += `</svg>`;
    html += `<img src="${toUri(seg)}" width="${digW}" height="${digH}" style="flex-shrink:0;"/>`;
  }
  html += `</div>`;
  return html;
}

/**
 * buildIndicatorLampSvg(): Generate SVG string saja (tanpa wrapper card).
 * Return { svg, glowSize } agar label bisa di-update juga.
 */
export function buildIndicatorLampImg(props: Record<string, any> = {}): {
  innerHTML: string;
  glowSize: number;
} {
  const color = props.color || "#4caf50";
  const on = !!props.on;
  const size = props.size || 36;
  const glowSize = size * 1.8;
  const svgToUri = (s: string) => "data:image/svg+xml," + encodeURIComponent(s);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${glowSize}" height="${glowSize}" viewBox="0 0 ${glowSize} ${glowSize}">`;
  svg += `<circle cx="${glowSize / 2}" cy="${glowSize / 2}" r="${glowSize * 0.45}" fill="${on ? color + "33" : "transparent"}"/>`;
  svg += `<circle cx="${glowSize / 2}" cy="${glowSize / 2}" r="${size / 2 + 3}" fill="none" stroke="${on ? color : "#555"}" stroke-width="2"/>`;
  svg += `<circle cx="${glowSize / 2}" cy="${glowSize / 2}" r="${size / 2}" fill="${on ? color : "#333"}"/>`;
  svg += `<ellipse cx="${glowSize / 2 - size * 0.15}" cy="${glowSize / 2 - size * 0.15}" rx="${size * 0.18}" ry="${size * 0.13}" fill="rgba(255,255,255,0.25)"/>`;
  svg += `</svg>`;

  return {
    innerHTML: `<img src="${svgToUri(svg)}" width="${glowSize}" height="${glowSize}" style="display:block;margin:0 auto;"/>`,
    glowSize,
  };
}

/**
 * buildToggleSwitchSvg(): Generate SVG string saja (tanpa wrapper card).
 */
export function buildToggleSwitchSvg(props: Record<string, any> = {}): string {
  const color = props.color || "#4caf50";
  const on = !!props.on;
  const swW = props.size || 48;
  const swH = swW * 0.55;
  const knobR = swH * 0.4;
  const cx = on ? swW - swH * 0.5 : swH * 0.5;
  const offTrack = props.offTrack || "#333";
  const offKnob = props.offKnob || "#666";

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${swW}" height="${swH}" viewBox="0 0 ${swW} ${swH}">`;
  svg += `<rect x="0" y="0" width="${swW}" height="${swH}" rx="${swH / 2}" fill="${on ? color + "66" : offTrack}"/>`;
  svg += `<circle cx="${cx}" cy="${swH / 2}" r="${knobR}" fill="${on ? color : offKnob}"/>`;
  svg += `</svg>`;
  return svg;
}

/**
 * buildToggleSwitchImg(): Generate <img> innerHTML lengkap buat toggle switch SVG.
 */
export function buildToggleSwitchImg(props: Record<string, any> = {}): string {
  const svg = buildToggleSwitchSvg(props);
  const svgToUri = (s: string) => "data:image/svg+xml," + encodeURIComponent(s);
  const swW = props.size || 48;
  const swH = swW * 0.55;
  return `<img src="${svgToUri(svg)}" width="${swW}" height="${swH}" style="display:block;margin:8px auto 0;pointer-events:none;"/>`;
}

// ============================================================
// IOT WIDGETS — Line Chart, Radial Gauge, Seven-Segment, Lamp
// ============================================================

// --- SVG helper: bikin raw SVG element node ---
function svgEl(tag: string, props: Record<string, any> = {}): IDOMNode {
  return { id: props.id || uuidv4(), tag, props: { ...props }, children: [] };
}

// --- Catmull-Rom → cubic Bezier untuk spline halus ---
function splinePath(pts: number[][], tension = 0.5): string {
  if (pts.length === 0) return "";
  if (pts.length === 1)
    return `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const tx = tension / 6;
    d +=
      ` C ${(p1[0] + (p2[0] - p0[0]) * tx).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) * tx).toFixed(1)},` +
      ` ${(p2[0] - (p3[0] - p1[0]) * tx).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) * tx).toFixed(1)},` +
      ` ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/**
 * lineChart(): Line chart dengan opsi spline (kurva halus).
 *
 * Usage:
 *   lineChart({ data: [25,30,28,35,32], color: "#f44336", spline: true, fill: true })
 *   lineChart({ data: [{x:"Jan",y:10},{x:"Feb",y:25}], width: 400, height: 200 })
 *
 * Props:
 *   - data:   number[] atau {x:string,y:number}[]
 *   - color:  warna garis (default "#4caf50")
 *   - spline: true = kurva halus, false = garis lurus (default false)
 *   - fill:   true = isi area di bawah garis (default false)
 *   - width:  lebar SVG (default 280)
 *   - height: tinggi SVG (default 180)
 *   - min/max: rentang Y (auto dari data jika tidak di-set)
 *   - title:  judul chart
 */
export function lineChart(props: Record<string, any> = {}): IDOMNode {
  const id = props.id || uuidv4();
  const raw = props.data || [];
  const color = props.color || "#4caf50";
  const spline = !!props.spline;
  const fill = !!props.fill;
  const W = props.width || 280;
  const H = props.height || 180;
  const pad = { t: 20, r: 12, b: 28, l: 38 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;

  const points: { x: number; y: number; label?: string }[] = [];
  for (const d of raw) {
    if (typeof d === "number") points.push({ x: points.length, y: d });
    else points.push({ x: points.length, y: d.y ?? 0, label: d.x ?? "" });
  }
  if (points.length === 0) points.push({ x: 0, y: 0 }, { x: 1, y: 0 });

  const yMin = props.min ?? Math.min(...points.map((p) => p.y));
  const yMax = props.max ?? Math.max(...points.map((p) => p.y));
  const yRange = yMax - yMin || 1;

  const toX = (i: number) =>
    pad.l + (points.length > 1 ? (i / (points.length - 1)) * pw : pw / 2);
  const toY = (v: number) => pad.t + ph - ((v - yMin) / yRange) * ph;
  const coords = points.map((p, i) => [toX(i), toY(p.y)]);

  let pathD: string;
  if (spline) {
    pathD = splinePath(coords, 0.5);
  } else {
    pathD = coords
      .map(
        (c, i) =>
          (i === 0 ? "M" : "L") + ` ${c[0].toFixed(1)} ${c[1].toFixed(1)}`,
      )
      .join(" ");
  }
  let areaD = "";
  if (fill) {
    areaD =
      pathD +
      ` L ${coords[coords.length - 1][0].toFixed(1)} ${pad.t + ph} L ${coords[0][0].toFixed(1)} ${pad.t + ph} Z`;
  }

  const lcIsLight = isLightColor(theme.colors.card);
  const lcGrid = lcIsLight ? "#00000012" : "#ffffff10";

  // Build SVG string → render via innerHTML agar SVG namespace benar
  let html = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block;overflow:hidden">`;
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + (i / 3) * ph;
    html += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="${lcGrid}" stroke-width="1"/>`;
    const val = yMin + ((3 - i) / 3) * yRange;
    html += `<text x="${pad.l - 4}" y="${y + 4}" fill="#888" font-size="9" text-anchor="end">${val % 1 === 0 ? Math.round(val) : val.toFixed(1)}</text>`;
  }
  for (
    let i = 0;
    i < points.length;
    i += Math.max(1, Math.floor(points.length / 6))
  ) {
    html += `<text x="${toX(i).toFixed(1)}" y="${H - 4}" fill="#888" font-size="8" text-anchor="middle">${points[i].label || String(i + 1)}</text>`;
  }
  html += `<clipPath id="lc-clip-${id}"><rect x="${pad.l}" y="${pad.t}" width="${pw}" height="${ph}"/></clipPath>`;
  html += `<g clip-path="url(#lc-clip-${id})">`;
  html += `<g id="lc-scroll-${id}" data-tsix-id="lc-scroll-${id}" style="transition: transform 0.25s ease-out">`;
  if (areaD)
    html += `<path id="lc-area-${id}" data-tsix-id="lc-area-${id}" d="${areaD}" fill="${color}22" stroke="none"/>`;
  html += `<path id="lc-line-${id}" data-tsix-id="lc-line-${id}" d="${pathD}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  html += `<g id="lc-dots-${id}" data-tsix-id="lc-dots-${id}">`;
  for (let di = 0; di < coords.length; di++) {
    const c = coords[di];
    const yVal = (points[di]?.y ?? 0).toFixed(1);
    html += `<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="4" fill="${color}" title="${yVal}" style="cursor:pointer"/>`;
  }
  html += `</g>`;
  html += `</g>`;
  html += `</g>`;
  html += `</svg>`;

  return div(
    {
      id,
      style: {
        flex: "1",
        minWidth: "240px",
        background: theme.colors.card,
        borderRadius: "10px",
        padding: "14px",
        border: `1px solid ${color}44`,
        overflow: "hidden",
      },
    },
    props.title
      ? span({
          text: String(props.title),
          style: {
            fontSize: "12px",
            color: theme.colors.textDim,
            display: "block",
            marginBottom: "6px",
          },
        })
      : ({ id: uuidv4(), tag: "__empty__", props: {}, children: [] } as any),
    {
      id: `lc-html-${id}`,
      tag: "div",
      props: { innerHTML: html },
      children: [],
    },
  );
}

/**
 * radialGauge(): Gauge melingkar ala speedometer.
 *
 * Usage:
 *   radialGauge({ value: 72, min: 0, max: 100, color: "#2196f3", label: "CPU", unit: "%" })
 *
 * Props:
 *   - value:  nilai saat ini
 *   - min/max: rentang (default 0/100)
 *   - color:  warna arc (default "#4caf50")
 *   - size:   diameter (default 120)
 *   - label:  teks di bawah gauge
 *   - unit:   satuan setelah nilai
 */
export function radialGauge(props: Record<string, any> = {}): IDOMNode {
  const id = props.id || uuidv4();
  const val = props.value ?? 0;
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const color = props.color || "#4caf50";
  const size = props.size || 120;
  const label = props.label || "";
  const unit = props.unit || "";

  const cx = size / 2,
    cy = size / 2;
  const radius = size * 0.36;
  const strokeW = size * 0.1;
  const startAngle = -220,
    endAngle = 40;
  const range = endAngle - startAngle;
  const pct = Math.max(0, Math.min(1, (val - min) / (max - min || 1)));
  const angle = startAngle + range * pct;
  const rad = (a: number) => (a * Math.PI) / 180;
  const arcX = (a: number) => cx + radius * Math.cos(rad(a));
  const arcY = (a: number) => cy + radius * Math.sin(rad(a));
  const large = pct > 0.5 ? 1 : 0;
  const largeArcFix = range * pct > 180 ? 1 : 0;
  const arcLength = (radius * Math.abs(endAngle - startAngle) * Math.PI) / 180;
  const dashOffset = arcLength * (1 - pct);

  const rgIsLight = isLightColor(theme.colors.card);
  const rgBgArc = rgIsLight ? "#00000010" : "#ffffff15";
  const rgTick = rgIsLight ? "#00000018" : "#ffffff25";
  const rgFg = rgIsLight ? "#333" : "#fff";

  let html = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="display:block;margin:0 auto;">`;
  html += `<path d="M${arcX(startAngle).toFixed(1)} ${arcY(startAngle).toFixed(1)} A${radius} ${radius} 0 1 1 ${arcX(endAngle).toFixed(1)} ${arcY(endAngle).toFixed(1)}" fill="none" stroke="${rgBgArc}" stroke-width="${strokeW}" stroke-linecap="round"/>`;
  html += `<path id="rg-arc-${id}" data-tsix-id="rg-arc-${id}" d="M${arcX(startAngle).toFixed(1)} ${arcY(startAngle).toFixed(1)} A${radius} ${radius} 0 1 1 ${arcX(endAngle).toFixed(1)} ${arcY(endAngle).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round" stroke-dasharray="${arcLength} ${arcLength}" stroke-dashoffset="${dashOffset}" style="transition: stroke-dashoffset 0.2s ease-out"/>`;
  for (let i = 0; i <= 10; i++) {
    const ta = startAngle + (range / 10) * i;
    const ort = radius + strokeW * 0.8;
    html += `<line x1="${arcX(ta).toFixed(1)}" y1="${arcY(ta).toFixed(1)}" x2="${(cx + ort * Math.cos(rad(ta))).toFixed(1)}" y2="${(cy + ort * Math.sin(rad(ta))).toFixed(1)}" stroke="${rgTick}" stroke-width="1"/>`;
  }
  const nl = radius * 0.7;
  html += `<g id="rg-needle-group-${id}" data-tsix-id="rg-needle-group-${id}" style="transition: transform 0.2s ease-out; transform-origin: ${cx}px ${cy}px; transform: rotate(${angle}deg)">`;
  html += `<line x1="${cx}" y1="${cy}" x2="${cx + nl}" y2="${cy}" stroke="${rgFg}" stroke-width="2" stroke-linecap="round"/>`;
  html += `</g>`;
  html += `<circle cx="${cx}" cy="${cy}" r="${size * 0.04}" fill="${rgFg}"/>`;
  html += `<text id="rg-val-${id}" data-tsix-id="rg-val-${id}" x="${cx}" y="${cy + size * 0.05 + 15}" fill="${rgFg}" font-size="${size * 0.14}" font-weight="700" text-anchor="middle" dominant-baseline="middle">${val % 1 === 0 ? Math.round(val) : val.toFixed(1)}</text>`;
  html += `<text x="${cx}" y="${cy + size * 0.2 + 15}" fill="#888" font-size="${size * 0.09}" text-anchor="middle">${unit}</text>`;
  html += `</svg>`;

  const children: IDOMNode[] = [
    {
      id: `rg-html-${id}`,
      tag: "div",
      props: { innerHTML: html },
      children: [],
    },
  ];
  if (label)
    children.push(
      span({
        text: label,
        style: {
          fontSize: "11px",
          color: theme.colors.textDim,
          display: "block",
          textAlign: "center",
          marginTop: "6px",
        },
      }),
    );

  return div(
    {
      id,
      style: {
        flex: "1",
        minWidth: "160px",
        background: theme.colors.card,
        borderRadius: "10px",
        padding: "14px",
        border: `1px solid ${color}44`,
        textAlign: "center" as any,
        overflow: "hidden",
      },
    },
    ...children,
  );
}

/**
 * sevenSegment(): Display LED 7-segment ala kalkulator.
 *
 * Usage:
 *   sevenSegment({ value: 42.5, digits: 4, decimals: 1, color: "#4caf50" })
 *   sevenSegment({ value: 1023, digits: 4, color: "#f44336" })
 *
 * Props:
 *   - value:    angka yang ditampilkan
 *   - digits:   jumlah digit (default 4)
 *   - decimals: jumlah digit di belakang koma (default 0)
 *   - color:    warna LED saat menyala (default "#4caf50")
 *   - offColor: warna LED saat mati (default "#ffffff08")
 */
export function isLightColor(hex: string): boolean {
  if (!hex || !hex.startsWith("#")) return false;
  let r: number, g: number, b: number;
  const h = hex.slice(1);
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  } else if (h.length === 6) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else return false;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
}

/** Gelapkan warna hex, ratio 0-1 (0 = hitam, 1 = warna asli) */
function darken(hex: string, ratio = 0.15): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const dr = Math.round(r * ratio);
  const dg = Math.round(g * ratio);
  const db = Math.round(b * ratio);
  return `#${dr.toString(16).padStart(2, "0")}${dg.toString(16).padStart(2, "0")}${db.toString(16).padStart(2, "0")}`;
}

export function sevenSegment(props: Record<string, any> = {}): IDOMNode {
  const id = props.id || uuidv4();
  const value = props.value ?? 0;
  const digits = props.digits ?? 4;
  const decimals = props.decimals ?? 0;
  const color = props.color || "#4caf50";
  // sevenSegment offColor: kalo theme light, pake semi-transparan
  const isLightBg =
    theme.colors.bg.startsWith("#") && isLightColor(theme.colors.bg);
  const offColor =
    props.offColor || (isLightBg ? color + "22" : darken(color, 0.2));
  const label = props.label || "";
  const scale = props.scale ?? 1;
  const formatted = Number(value).toFixed(decimals);
  const padded = formatted
    .padStart(digits + (decimals > 0 ? 1 : 0), " ")
    .slice(-(digits + (decimals > 0 ? 1 : 0)));
  const segMap: Record<string, string> = {
    "0": "ABCDEF",
    "1": "BC",
    "2": "ABDEG",
    "3": "ABCDG",
    "4": "BCFG",
    "5": "ACDFG",
    "6": "ACDEFG",
    "7": "ABC",
    "8": "ABCDEFG",
    "9": "ABCDFG",
    "-": "G",
    " ": "",
    ".": "",
  };
  const segDefs: Record<string, [number, number, number, number]> = {
    A: [4, 2, 26, 2],
    B: [28, 4, 28, 22],
    C: [28, 26, 28, 44],
    D: [4, 46, 26, 46],
    E: [2, 26, 2, 44],
    F: [2, 4, 2, 22],
    G: [4, 24, 26, 24],
  };
  const toUri = (s: string) => "data:image/svg+xml," + encodeURIComponent(s);
  const digW = Math.round(30 * scale);
  const digH = Math.round(50 * scale);
  const dotW = Math.round(8 * scale);

  let html = `<div style="display:flex;justify-content:center;align-items:center;gap:${Math.round(4 * scale)}px;padding:${Math.round(8 * scale)}px ${Math.round(4 * scale)}px;transform:skewX(-8deg);">`;
  for (const ch of padded) {
    if (ch === ".") {
      html += `<img src="${toUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${dotW}" height="${digH}" viewBox="0 0 8 50"><circle cx="4" cy="46" r="4" fill="${color}"/></svg>`)}" width="${dotW}" height="${digH}" style="flex-shrink:0;"/>`;
      continue;
    }
    const active = segMap[ch] || "";
    let seg = `<svg xmlns="http://www.w3.org/2000/svg" width="${digW}" height="${digH}" viewBox="0 0 30 48">`;
    for (const s of "ABCDEFG") {
      const [x1, y1, x2, y2] = segDefs[s];
      seg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${active.includes(s) ? color : offColor}" stroke-width="${Math.round(7 * scale)}" stroke-linecap="butt"/>`;
    }
    seg += `</svg>`;
    html += `<img src="${toUri(seg)}" width="${digW}" height="${digH}" style="flex-shrink:0;"/>`;
  }
  html += `</div>`;

  const children: IDOMNode[] = [
    {
      id: `ss-html-${id}`,
      tag: "div",
      props: {
        innerHTML: html,
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "1",
        },
      },
      children: [],
    },
  ];
  if (label)
    children.push(
      span({
        text: label,
        style: {
          fontSize: "11px",
          color: theme.colors.textDim,
          display: "block",
          textAlign: "center",
          marginTop: "4px",
        },
      }),
    );

  const segStyle: Record<string, any> = {
    flex: "1",
    minWidth: "180px",
    background: theme.colors.bgAlt,
    borderRadius: "10px",
    padding: "12px",
    border: `1px solid ${color}44`,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  };
  if (props.height != null) segStyle.height = props.height;
  return div({ id, style: segStyle }, ...children);
}

/**
 * indicatorLamp(): Lampu indikator ON/OFF dengan glow effect.
 *
 * Usage:
 *   indicatorLamp({ id: "lamp1", color: "#4caf50", on: true, label: "POWER" })
 *   indicatorLamp({ id: "lamp2", color: "#f44336", on: false, label: "ALARM", size: 40 })
 *
 * Props:
 *   - id:    ID unik (wajib, dipakai untuk `il-{id}`)
 *   - color: warna lampu saat ON (default "#4caf50")
 *   - on:    true = menyala, false = mati (default false)
 *   - label: teks label di bawah lampu
 *   - size:  diameter lampu dalam px (default 36)
 */
export function indicatorLamp(props: Record<string, any> = {}): IDOMNode {
  const id = props.id || uuidv4();
  const color = props.color || "#4caf50";
  const on = !!props.on;
  const label = props.label || "";
  const size = props.size || 36;
  const glowSize = size * 1.8;
  const svgToUri = (s: string) => "data:image/svg+xml," + encodeURIComponent(s);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${glowSize}" height="${glowSize}" viewBox="0 0 ${glowSize} ${glowSize}">`;
  svg += `<circle cx="${glowSize / 2}" cy="${glowSize / 2}" r="${glowSize * 0.45}" fill="${on ? color + "33" : "transparent"}"/>`;
  svg += `<circle cx="${glowSize / 2}" cy="${glowSize / 2}" r="${size / 2 + 3}" fill="none" stroke="${on ? color : "#555"}" stroke-width="2"/>`;
  svg += `<circle cx="${glowSize / 2}" cy="${glowSize / 2}" r="${size / 2}" fill="${on ? color : "#333"}"/>`;
  svg += `<ellipse cx="${glowSize / 2 - size * 0.15}" cy="${glowSize / 2 - size * 0.15}" rx="${size * 0.18}" ry="${size * 0.13}" fill="rgba(255,255,255,0.25)"/>`;
  svg += `</svg>`;

  const children: IDOMNode[] = [
    {
      id: `il-html-${id}`,
      tag: "div",
      props: {
        innerHTML: `<img src="${svgToUri(svg)}" width="${glowSize}" height="${glowSize}" style="display:block;margin:0 auto;"/>`,
      },
      children: [],
    },
  ];
  if (label)
    children.push(
      span({
        id: `il-label-${id}`,
        text: label,
        style: {
          fontSize: "11px",
          color: on ? color : theme.colors.textMuted,
          display: "block",
          textAlign: "center",
          marginTop: "6px",
          fontWeight: "600" as any,
        },
      }),
    );

  return div(
    {
      id: `il-${id}`,
      style: {
        flex: "1",
        minWidth: "100px",
        background: theme.colors.card,
        borderRadius: "10px",
        padding: "14px",
        border: `1px solid ${on ? color : theme.colors.border}44`,
        textAlign: "center" as any,
        overflow: "hidden",
      },
    },
    ...children,
  );
}

export function toggleSwitch(props: Record<string, any> = {}): IDOMNode {
  const id = props.id || uuidv4();
  const color = props.color || "#4caf50";
  const on = !!props.on;
  const label = props.label || "";
  const swW = props.size || 48;
  const swH = swW * 0.55;
  const knobR = swH * 0.4;
  const cx = on ? swW - swH * 0.5 : swH * 0.5;
  const tsIsLight = isLightColor(theme.colors.card);
  const svgToUri = (s: string) => "data:image/svg+xml," + encodeURIComponent(s);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${swW}" height="${swH}" viewBox="0 0 ${swW} ${swH}">`;
  svg += `<rect x="0" y="0" width="${swW}" height="${swH}" rx="${swH / 2}" fill="${on ? color + "66" : tsIsLight ? "#ccc" : "#333"}"/>`;
  svg += `<circle cx="${cx}" cy="${swH / 2}" r="${knobR}" fill="${on ? color : tsIsLight ? "#999" : "#666"}"/>`;
  svg += `</svg>`;

  const cardProps: Record<string, any> = {
    id: `ts-${id}`,
    style: {
      flex: "1",
      minWidth: "110px",
      background: theme.colors.card,
      borderRadius: "10px",
      padding: "14px",
      border: `1px solid ${on ? color : theme.colors.border}44`,
      textAlign: "center" as any,
      cursor: "pointer",
      overflow: "hidden",
    },
  };
  if (props.onClickId) cardProps.onClickId = props.onClickId;

  const children: IDOMNode[] = [
    {
      id: `ts-html-${id}`,
      tag: "div",
      props: {
        innerHTML: `<img src="${svgToUri(svg)}" width="${swW}" height="${swH}" style="display:block;margin:8px auto 0;pointer-events:none;"/>`,
      },
      children: [],
    },
  ];
  if (label)
    children.push(
      span({
        id: `ts-label-${id}`,
        text: label,
        style: {
          fontSize: "11px",
          color: on ? color : theme.colors.textMuted,
          display: "block",
          textAlign: "center",
          marginTop: "4px",
          fontWeight: "600" as any,
        },
      }),
    );

  return div(cardProps, ...children);
}

// ============================================================
// VERTICAL GAUGE — Tabung kaca berisi air
// ============================================================

/**
 * verticalGauge(): Tabung kaca vertikal berisi cairan.
 *
 * Usage:
 *   verticalGauge({ value: 75, color: "#2196f3", label: "Water Level" })
 *   verticalGauge({ value: 30, color: "#f44336", label: "Fuel", unit: "%" })
 *
 * Props:
 *   - value:  tinggi cairan 0-100 (default 0)
 *   - color:  warna cairan (default "#2196f3")
 *   - label:  teks di bawah tabung
 *   - unit:   satuan (default "%")
 *   - bg:     warna background tabung (default "#ffffff08")
 *   - w:      lebar tabung px (default 48)
 *   - h:      tinggi tabung px (default 160)
 */
export function verticalGauge(props: Record<string, any> = {}): IDOMNode {
  const id = props.id || uuidv4();
  const value = Math.max(0, Math.min(100, props.value ?? 0));
  const color = props.color || "#2196f3";
  const label = props.label || "";
  const unit = props.unit || "%";
  const bg = props.bg || "#ffffff08";
  const W = props.w || 48;
  const H = props.h || 160;
  const r = 10;
  const fillH = Math.max(0, ((H - r * 2) * value) / 100);
  const waterY = H - r - Math.min(fillH, H - r * 2);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;

  // Tube — square top, rounded bottom
  svg += `<path d="M 0,0 L ${W},0 L ${W},${H - r} Q ${W},${H} ${W - r},${H} L ${r},${H} Q 0,${H} 0,${H - r} Z" fill="${bg}" stroke="${color}44" stroke-width="1.5"/>`;

  // Water fill with transition (translateY for CSS transition compatibility)
  svg += `<defs><clipPath id="clip-${id}"><path d="M 2,2 L ${W - 2},2 L ${W - 2},${H - 2 - r} Q ${W - 2},${H - 2} ${W - 2 - r},${H - 2} L ${2 + r},${H - 2} Q 2,${H - 2} 2,${H - 2 - r} Z"/></clipPath></defs>`;
  svg += `<g clip-path="url(#clip-${id})">`;
  svg += `<rect id="wg-water-${id}" data-tsix-id="wg-water-${id}" x="2" y="0" width="${W - 4}" height="${H - 2}" fill="${color}" style="transition: transform 0.2s ease-out; transform: translateY(${waterY}px)"/>`;
  svg += `<rect id="wg-grad-${id}" data-tsix-id="wg-grad-${id}" x="2" y="0" width="${W - 4}" height="${H - 2}" fill="url(#grad-${id})" opacity="0.4" style="transition: transform 0.2s ease-out; transform: translateY(${waterY}px)"/>`;
  svg += `<defs><linearGradient id="grad-${id}" x1="0" y1="0" x2="0" y2="1">`;
  svg += `<stop offset="0%" stop-color="${darken(color, 0.7)}"/>`;
  svg += `<stop offset="100%" stop-color="${color}"/>`;
  svg += `</linearGradient></defs>`;
  svg += `<line id="wg-surface-${id}" data-tsix-id="wg-surface-${id}" x1="2" y1="0" x2="${W - 2}" y2="0" stroke="${color}" stroke-width="1.5" opacity="0.6" style="transition: transform 0.2s ease-out; transform: translateY(${waterY}px)"/>`;
  svg += `</g>`;

  // Glass reflection — square top, rounded bottom
  svg += `<path d="M 4,6 L ${4 + W * 0.22},6 L ${4 + W * 0.22},${H - 6 - r} Q ${4 + W * 0.22},${H - 6} ${4 + W * 0.22 - (r - 4)},${H - 6} L ${4 + (r - 4)},${H - 6} Q 4,${H - 6} 4,${H - 6 - r} Z" fill="rgba(255,255,255,0.08)"/>`;

  // Clip path untuk text masking — ngikutin permukaan air
  svg += `<defs><clipPath id="clip-text-${id}">`;
  svg += `<rect id="wg-clip-${id}" data-tsix-id="wg-clip-${id}" x="0" y="0" width="${W - 4}" height="${H}" style="transition: transform 0.2s ease-out; transform: translateY(${waterY}px)"/>`;
  svg += `</clipPath></defs>`;

  // Value text — dual layer untuk masking otomatis
  const textColor = theme.colors.text;
  svg += `<text id="wg-val-bg-${id}" data-tsix-id="wg-val-bg-${id}" x="${W / 2}" y="${H / 2 - 4}" fill="${textColor}" font-size="14" font-weight="700" text-anchor="middle" dominant-baseline="middle">${Math.round(value)}</text>`;
  svg += `<text id="wg-val-${id}" data-tsix-id="wg-val-${id}" x="${W / 2}" y="${H / 2 - 4}" fill="#fff" font-size="14" font-weight="700" text-anchor="middle" dominant-baseline="middle" clip-path="url(#clip-text-${id})">${Math.round(value)}</text>`;
  svg += `<text id="wg-unit-${id}" x="${W / 2}" y="${H / 2 + 14}" fill="#aaa" font-size="8" text-anchor="middle">${unit}</text>`;

  svg += `</svg>`;

  const children: IDOMNode[] = [
    {
      id: `vg-html-${id}`,
      tag: "div",
      props: { innerHTML: svg, style: { lineHeight: "0" } },
      children: [],
    },
  ];
  if (label)
    children.push(
      span({
        id: `vg-label-${id}`,
        text: label,
        style: {
          fontSize: "11px",
          color: theme.colors.textDim,
          display: "block",
          textAlign: "center",
          marginTop: "4px",
        },
      }),
    );

  return div(
    {
      id: `vg-${id}`,
      style: {
        flex: "1",
        minWidth: "80px",
        background: theme.colors.card,
        borderRadius: "10px",
        padding: "14px",
        border: `1px solid ${color}44`,
        textAlign: "center" as any,
        overflow: "hidden",
      },
    },
    ...children,
  );
}

// ============================================================
// CONNECTED VERTICAL GAUGE — self-rendering vertical gauge
// ============================================================

export class ConnectedVerticalGauge {
  public readonly wrapId: string;
  public value: number;
  private gaugeId: string;
  private color: string;
  private label: string;
  private unit: string;
  private height?: number;
  private screen: Screen | null = null;

  constructor(opts: {
    id: string;
    color: string;
    label: string;
    unit?: string;
    value?: number;
    height?: number;
  }) {
    this.gaugeId = opts.id;
    this.wrapId = `cvg-${opts.id}`;
    this.color = opts.color;
    this.label = opts.label;
    this.unit = opts.unit || "%";
    this.value = opts.value ?? 0;
    this.height = opts.height;
  }
  build(): IDOMNode {
    return div(
      {
        id: this.wrapId,
        style: this.height
          ? {
              height: this.height + "px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              overflow: "hidden",
            }
          : {},
      },
      verticalGauge({
        id: this.gaugeId,
        value: this.value,
        color: this.color,
        label: this.label,
        unit: this.unit,
      }),
    );
  }
  async mount(screen: Screen) {
    this.screen = screen;
  }
  async setValue(val: number) {
    this.value = val;
    if (this.screen) await this.render(this.screen);
  }
  private async render(s: Screen) {
    const v = Math.max(0, Math.min(100, this.value));
    const H = 160,
      r = 10;
    const fillH = Math.max(0, ((H - r * 2) * v) / 100);
    const waterY = H - r - Math.min(fillH, H - r * 2);
    const id = this.gaugeId;
    await s.update(`wg-water-${id}`, {
      style: { transform: `translateY(${waterY}px)` },
    });
    await s.update(`wg-grad-${id}`, {
      style: { transform: `translateY(${waterY}px)` },
    });
    await s.update(`wg-surface-${id}`, {
      style: { transform: `translateY(${waterY}px)` },
    });
    await s.update(`wg-val-${id}`, { text: String(Math.round(v)) });
  }
}

/**
 * buildVerticalGaugeSvg(): Generate SVG string saja (tanpa wrapper card).
 */
export function buildVerticalGaugeSvg(props: Record<string, any> = {}): string {
  const value = Math.max(0, Math.min(100, props.value ?? 0));
  const color = props.color || "#2196f3";
  const unit = props.unit || "%";
  const bg = props.bg || "#ffffff08";
  const W = props.w || 48;
  const H = props.h || 160;
  const r = 10;
  const fillH = Math.max(0, ((H - r * 2) * value) / 100);
  const waterY = H - r - Math.min(fillH, H - r * 2);
  const id = props.id || "g";

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  svg += `<path d="M 0,0 L ${W},0 L ${W},${H - r} Q ${W},${H} ${W - r},${H} L ${r},${H} Q 0,${H} 0,${H - r} Z" fill="${bg}" stroke="${color}44" stroke-width="1.5"/>`;

  if (value > 0) {
    svg += `<defs><clipPath id="bg-clip-${id}"><path d="M 2,2 L ${W - 2},2 L ${W - 2},${H - 2 - r} Q ${W - 2},${H - 2} ${W - 2 - r},${H - 2} L ${2 + r},${H - 2} Q 2,${H - 2} 2,${H - 2 - r} Z"/></clipPath></defs>`;
    svg += `<g clip-path="url(#bg-clip-${id})">`;
    svg += `<rect x="2" y="0" width="${W - 4}" height="${H - 2}" fill="${color}" style="transition: transform 0.2s ease-out; transform: translateY(${waterY}px)"/>`;
    svg += `<rect x="2" y="0" width="${W - 4}" height="${H - 2}" fill="url(#bg-grad-${id})" opacity="0.4" style="transition: transform 0.2s ease-out; transform: translateY(${waterY}px)"/>`;
    svg += `<defs><linearGradient id="bg-grad-${id}" x1="0" y1="0" x2="0" y2="1">`;
    svg += `<stop offset="0%" stop-color="${darken(color, 0.7)}"/>`;
    svg += `<stop offset="100%" stop-color="${color}"/>`;
    svg += `</linearGradient></defs>`;
    svg += `<line x1="2" y1="${waterY}" x2="${W - 2}" y2="${waterY}" stroke="${color}" stroke-width="1.5" opacity="0.6" style="transition: all 0.2s ease-out"/>`;
    svg += `</g>`;
  }

  svg += `<path d="M 4,6 L ${4 + W * 0.22},6 L ${4 + W * 0.22},${H - 6 - r} Q ${4 + W * 0.22},${H - 6} ${4 + W * 0.22 - (r - 4)},${H - 6} L ${4 + (r - 4)},${H - 6} Q 4,${H - 6} 4,${H - 6 - r} Z" fill="rgba(255,255,255,0.08)"/>`;
  svg += `<text x="${W / 2}" y="${H / 2 - 4}" fill="#fff" font-size="14" font-weight="700" text-anchor="middle" dominant-baseline="middle">${Math.round(value)}</text>`;
  svg += `<text x="${W / 2}" y="${H / 2 + 14}" fill="#aaa" font-size="8" text-anchor="middle">${unit}</text>`;
  svg += `</svg>`;
  return svg;
}

// ============================================================
// CONNECTED TOGGLE — widget self-wiring: handle klik + setContent internal
// ============================================================

export class ConnectedToggle {
  public readonly wrapId: string;
  public readonly toggleId: string;
  public on: boolean;
  private screen: Screen | null = null;
  private label: string;
  private color: string;
  private onChangeCb: (() => void) | null = null;

  constructor(opts: {
    id: string;
    label: string;
    color?: string;
    on?: boolean;
  }) {
    this.toggleId = opts.id;
    this.wrapId = `ct-${opts.id}`;
    this.label = opts.label;
    this.color = opts.color || "#4caf50";
    this.on = opts.on ?? false;
  }

  /** Build node awal (untuk mount pertama) */
  build(): IDOMNode {
    return div(
      { id: this.wrapId, onClickId: this.wrapId, style: { cursor: "pointer" } },
      toggleSwitch({
        id: this.toggleId,
        color: this.color,
        on: this.on,
        label: this.label,
      }),
    );
  }

  /** Pasang ke Screen — register onClick handler + wiring */
  async mount(screen: Screen, onChange?: () => void) {
    this.screen = screen;
    if (onChange) this.onChangeCb = onChange;
    // Handler klik: toggle state → render ulang → panggil callback
    screen.win.onClick(this.wrapId, async () => {
      this.on = !this.on;
      await this.render(screen);
      if (this.onChangeCb) this.onChangeCb();
    });
  }

  /** Set on/off dari luar (misal dari data sensor), lalu render ulang */
  async setOn(val: boolean) {
    this.on = val;
    if (this.screen) await this.render(this.screen);
  }

  /** Render ulang toggle di dalam wrapper — targeted update, NO setContent! */
  private async render(screen: Screen) {
    const { toggleId: id, color, on, label } = this;
    const swOn = on ? "🟢 ON" : "⚫ OFF";
    await screen.update(`ts-html-${id}`, {
      innerHTML: buildToggleSwitchImg({ color, on, size: 48 }),
    });
    await screen.update(`ts-label-${id}`, {
      text: label,
      style: {
        fontSize: "11px",
        color: on ? color : theme.colors.textMuted,
        display: "block",
        textAlign: "center",
        marginTop: "4px",
        fontWeight: "600" as any,
      },
    });
    await screen.update(`ts-${id}`, {
      style: {
        flex: "1",
        minWidth: "110px",
        background: theme.colors.card,
        borderRadius: "10px",
        padding: "14px",
        border: `1px solid ${on ? color : theme.colors.border}44`,
        textAlign: "center" as any,
        cursor: "pointer",
        overflow: "hidden",
      },
    });
    // Re-apply onClickId setelah update
    await screen.update(this.wrapId, { onClickId: this.wrapId });
  }
}

// ============================================================
// CONNECTED RELAY CARD — widget self-wiring tanpa click, cukup render ulang
// ============================================================

export class ConnectedRelayCard {
  public readonly wrapId: string;
  public readonly relayId: string;
  public on: boolean;
  private label: string;
  private icon: string;
  private color: string;
  private screen: Screen | null = null;

  constructor(opts: {
    id: string;
    label: string;
    icon: string;
    color: string;
    on?: boolean;
  }) {
    this.relayId = opts.id;
    this.wrapId = `cr-${opts.id}`;
    this.label = opts.label;
    this.icon = opts.icon;
    this.color = opts.color || "#4caf50";
    this.on = opts.on ?? false;
  }

  build(): IDOMNode {
    return div(
      { id: this.wrapId },
      relayCard({
        id: this.relayId,
        label: this.label,
        icon: this.icon,
        color: this.color,
        active: this.on,
      }),
    );
  }

  async mount(screen: Screen) {
    this.screen = screen;
  }

  async setOn(val: boolean) {
    this.on = val;
    if (this.screen) await this.render(this.screen);
  }

  /** Render ulang relay card — targeted update, NO setContent! */
  private async render(screen: Screen) {
    const { relayId: id, label, icon, color, on } = this;
    await screen.update(`rc-${id}`, {
      style: {
        padding: "12px",
        borderRadius: "8px",
        border: `1px solid ${on ? color : theme.colors.border}`,
        background: on ? `${color}22` : theme.colors.card,
        flex: "1",
        textAlign: "center" as any,
      },
    });
    await screen.update(`rs-${id}`, {
      text: on ? "🟢 ON" : "⚫ OFF",
      style: {
        color: on ? color : theme.colors.textMuted,
        fontWeight: "700" as any,
        fontSize: "14px",
      },
    });
  }
}

// ============================================================
// CONNECTED SENSOR CARD — self-rendering sensor card
// ============================================================

export class ConnectedSensorCard {
  public readonly wrapId: string;
  public value: number | undefined;
  private sensorId: string;
  private label: string;
  private unit: string;
  private icon: string;
  private color: string;
  private min: number;
  private max: number;
  private screen: Screen | null = null;

  constructor(opts: {
    id: string;
    label: string;
    unit: string;
    icon: string;
    color: string;
    min: number;
    max: number;
    value?: number;
  }) {
    this.sensorId = opts.id;
    this.wrapId = `cs-${opts.id}`;
    this.label = opts.label;
    this.unit = opts.unit;
    this.icon = opts.icon;
    this.color = opts.color;
    this.min = opts.min;
    this.max = opts.max;
    this.value = opts.value;
  }
  build(): IDOMNode {
    return div(
      { id: this.wrapId },
      sensorCard({
        id: this.sensorId,
        label: this.label,
        unit: this.unit,
        icon: this.icon,
        color: this.color,
        value: this.value as any,
      }),
    );
  }
  async mount(screen: Screen) {
    this.screen = screen;
  }
  async setValue(val: number) {
    this.value = val;
    if (this.screen) await this.render(this.screen);
  }
  /** Render ulang sensor card — targeted update, NO setContent! */
  private async render(s: Screen) {
    const v = this.value;
    const { sensorId: id, label, unit, icon, color, min, max } = this;
    const pct =
      v !== undefined
        ? Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100))
        : 0;
    await s.update(`sv-${id}`, { text: v !== undefined ? v.toFixed(1) : "—" });
    await s.update(`bar-${id}`, {
      style: {
        width: `${pct}%`,
        background: color,
        height: "6px",
        borderRadius: "3px",
        transition: "width 0.3s",
      },
    });
  }
}

// ============================================================
// CONNECTED LINE CHART — self-rendering line chart
// ============================================================

export class ConnectedLineChart {
  public readonly wrapId: string;
  public data: number[];
  private chartId: string;
  private title: string;
  private color: string;
  private min: number;
  private max: number;
  private width: number;
  private height: number;
  private screen: Screen | null = null;

  constructor(opts: {
    id: string;
    title: string;
    color: string;
    min?: number;
    max?: number;
    width?: number;
    height?: number;
    data?: number[];
  }) {
    this.chartId = opts.id;
    this.wrapId = `cl-${opts.id}`;
    this.title = opts.title;
    this.color = opts.color;
    this.min = opts.min ?? 0;
    this.max = opts.max ?? 100;
    this.width = opts.width ?? 240;
    this.height = opts.height ?? 150;
    this.data = opts.data ?? [];
  }
  build(): IDOMNode {
    return div(
      { id: this.wrapId },
      lineChart({
        id: this.chartId,
        title: this.title,
        data: this.data,
        color: this.color,
        spline: true,
        fill: true,
        width: this.width,
        height: this.height,
        min: this.min,
        max: this.max,
      }),
    );
  }
  async mount(screen: Screen) {
    this.screen = screen;
  }
  async setData(val: number[]) {
    this.data = val;
    if (this.screen) await this.render(this.screen);
  }
  /** Render ulang line chart — targeted update innerHTML only, NO setContent! */
  private async render(s: Screen) {
    const svgStr = buildLineChartSvg({
      id: this.chartId,
      data: this.data,
      color: this.color,
      spline: true,
      fill: true,
      width: this.width,
      height: this.height,
      min: this.min,
      max: this.max,
    });
    await s.update(`lc-html-${this.chartId}`, { innerHTML: svgStr });
  }
}

// ============================================================
// CONNECTED RADIAL GAUGE — self-rendering radial gauge
// ============================================================

export class ConnectedRadialGauge {
  public readonly wrapId: string;
  public value: number;
  private gaugeId: string;
  private min: number;
  private max: number;
  private color: string;
  private label: string;
  private unit: string;
  private size: number;
  private height?: number;
  private screen: Screen | null = null;

  constructor(opts: {
    id: string;
    min: number;
    max: number;
    color: string;
    label: string;
    unit: string;
    size?: number;
    value?: number;
    height?: number;
  }) {
    this.gaugeId = opts.id;
    this.wrapId = `cg-${opts.id}`;
    this.min = opts.min;
    this.max = opts.max;
    this.color = opts.color;
    this.label = opts.label;
    this.unit = opts.unit;
    this.size = opts.size ?? 110;
    this.value = opts.value ?? 0;
    this.height = opts.height;
  }
  build(): IDOMNode {
    return div(
      {
        id: this.wrapId,
        style: this.height
          ? {
              height: this.height + "px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              overflow: "hidden",
            }
          : {},
      },
      radialGauge({
        id: this.gaugeId,
        value: this.value,
        min: this.min,
        max: this.max,
        color: this.color,
        label: this.label,
        unit: this.unit,
        size: this.size,
      }),
    );
  }
  async mount(screen: Screen) {
    this.screen = screen;
  }
  async setValue(val: number) {
    this.value = val;
    if (this.screen) await this.render(this.screen);
  }
  /** Render ulang radial gauge — targeted update via data-tsix-id, CSS transition jalan */
  private async render(s: Screen) {
    const { gaugeId: id, value: val, min, max, size } = this;
    const cx = size / 2,
      cy = size / 2;
    const radius = size * 0.36;
    const startAngle = -220,
      endAngle = 40;
    const range = endAngle - startAngle;
    const pct = Math.max(0, Math.min(1, (val - min) / (max - min || 1)));
    const angle = startAngle + range * pct;
    const arcLength =
      (radius * Math.abs(endAngle - startAngle) * Math.PI) / 180;
    const dashOffset = arcLength * (1 - pct);
    const formatted = val % 1 === 0 ? String(Math.round(val)) : val.toFixed(1);
    await s.update(`rg-arc-${id}`, {
      style: { strokeDashoffset: String(dashOffset) },
    });
    await s.update(`rg-needle-group-${id}`, {
      style: { transform: `rotate(${angle}deg)` },
    });
    await s.update(`rg-val-${id}`, { text: formatted });
  }
}

// ============================================================
// CONNECTED SEVEN SEGMENT — self-rendering 7-segment display
// ============================================================

export class ConnectedSevenSegment {
  public readonly wrapId: string;
  public value: number;
  private segId: string;
  private digits: number;
  private decimals: number;
  private color: string;
  private label: string;
  private height?: number;
  private screen: Screen | null = null;

  constructor(opts: {
    id: string;
    digits?: number;
    decimals?: number;
    color: string;
    value?: number;
    height?: number;
    label?: string;
  }) {
    this.segId = opts.id;
    this.wrapId = `cs7-${opts.id}`;
    this.digits = opts.digits ?? 4;
    this.decimals = opts.decimals ?? 0;
    this.color = opts.color;
    this.value = opts.value ?? 0;
    this.height = opts.height;
    this.label = opts.label || "";
  }
  build(): IDOMNode {
    return div(
      {
        id: this.wrapId,
        style: this.height
          ? {
              height: this.height + "px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              overflow: "hidden",
            }
          : {},
      },
      sevenSegment({
        id: this.segId,
        value: this.value,
        digits: this.digits,
        decimals: this.decimals,
        color: this.color,
        label: this.label,
      }),
    );
  }
  async mount(screen: Screen) {
    this.screen = screen;
  }
  async setValue(val: number) {
    this.value = val;
    if (this.screen) await this.render(this.screen);
  }
  /** Render ulang 7-segment — targeted update innerHTML only, NO setContent! */
  private async render(s: Screen) {
    const htmlStr = buildSevenSegmentHtml({
      value: this.value,
      digits: this.digits,
      decimals: this.decimals,
      color: this.color,
    });
    await s.update(`ss-html-${this.segId}`, { innerHTML: htmlStr });
  }
}

// ============================================================
// CONNECTED INDICATOR LAMP — self-rendering indicator lamp
// ============================================================

export class ConnectedIndicatorLamp {
  public readonly wrapId: string;
  public on: boolean;
  private lampId: string;
  private color: string;
  private label: string;
  private size: number;
  private height?: number;
  private screen: Screen | null = null;

  constructor(opts: {
    id: string;
    color: string;
    label: string;
    size?: number;
    on?: boolean;
    height?: number;
  }) {
    this.lampId = opts.id;
    this.wrapId = `cil-${opts.id}`;
    this.color = opts.color;
    this.label = opts.label;
    this.size = opts.size ?? 36;
    this.on = opts.on ?? false;
    this.height = opts.height;
  }
  build(): IDOMNode {
    return div(
      {
        id: this.wrapId,
        style: this.height
          ? {
              height: this.height + "px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              overflow: "hidden",
            }
          : {},
      },
      indicatorLamp({
        id: this.lampId,
        color: this.color,
        on: this.on,
        label: this.label,
        size: this.size,
      }),
    );
  }
  async mount(screen: Screen) {
    this.screen = screen;
  }
  async setOn(val: boolean) {
    this.on = val;
    if (this.screen) await this.render(this.screen);
  }
  /** Render ulang indicator lamp — targeted update, NO setContent! */
  private async render(s: Screen) {
    const { lampId: id, color, on, label, size } = this;
    const { innerHTML } = buildIndicatorLampImg({ color, on, size });
    await s.update(`il-html-${id}`, { innerHTML });
    await s.update(`il-label-${id}`, {
      text: label,
      style: {
        fontSize: "11px",
        color: on ? color : "#666",
        display: "block",
        textAlign: "center",
        marginTop: "6px",
        fontWeight: "600" as any,
      },
    });
    await s.update(`il-${id}`, {
      style: {
        flex: "1",
        minWidth: "100px",
        background: theme.colors.card,
        borderRadius: "10px",
        padding: "14px",
        border: `1px solid ${on ? color : theme.colors.border}44`,
        textAlign: "center" as any,
        overflow: "hidden",
      },
    });
  }
}

// ============================================================
// DATA GRID — tabel data dengan sort & variable column width
// ============================================================

/**
 * dataGrid(): Tabel data statis (tanpa interaksi sort).
 *
 * Usage:
 *   dataGrid({
 *     id: "grid1",
 *     columns: [
 *       { key: "name", label: "Nama", width: 160 },
 *       { key: "score", label: "Skor", width: "20%", align: "right" },
 *     ],
 *     data: [ { name: "A", score: 90 }, ... ],
 *   })
 *
 * Props kolom:
 *   - key:      field pada row
 *   - label:    judul kolom
 *   - width:    lebar kolom (number = px, atau string "20%")
 *   - align:    "left" | "center" | "right"
 */
export function dataGrid(props: Record<string, any> = {}): IDOMNode {
  const id = props.id || uuidv4();
  const columns: DataGridColumn[] = props.columns || [];
  const data: Record<string, any>[] = props.data || [];

  const colNodes: IDOMNode[] = columns.map((c) => ({
    id: `${id}-col-${c.key}`,
    tag: "col",
    props: c.width
      ? {
          style: {
            width: typeof c.width === "number" ? c.width + "px" : c.width,
          },
        }
      : {},
    children: [],
  }));

  const thNodes: IDOMNode[] = columns.map((c, ci) => ({
    id: `${id}-th-${c.key}`,
    tag: "th",
    props: {
      text: c.label,
      style: {
        ...(c.width
          ? { width: typeof c.width === "number" ? c.width + "px" : c.width }
          : {}),
        ...(c.align ? { textAlign: c.align } : {}),
        // Separator kolom — garis vertikal antar kolom (kecuali kolom terakhir)
        ...(ci < columns.length - 1
          ? { borderRight: `1px solid ${theme.colors.border}` }
          : {}),
        padding: "8px 12px",
        background: theme.colors.surface,
        borderBottom: `1px solid ${theme.colors.border}`,
        fontSize: "12px",
        fontWeight: "600" as any,
        color: theme.colors.text,
        whiteSpace: "nowrap",
        // Sticky header — kolom judul tetap saat body scroll
        position: "sticky",
        top: "0",
        zIndex: "1",
      },
    },
    children: [],
  }));

  const trNodes: IDOMNode[] = data.map((row, rIdx) => ({
    id: `${id}-row-${rIdx}`,
    tag: "tr",
    props: {
      style: {
        background: rIdx % 2 === 0 ? theme.colors.surface : theme.colors.card,
      },
    },
    children: columns.map((c, ci) => ({
      id: `${id}-cell-${c.key}-${rIdx}`,
      tag: "td",
      props: {
        text:
          row[c.key] !== undefined && row[c.key] !== null
            ? String(row[c.key])
            : "",
        style: {
          padding: "6px 12px",
          borderBottom: `1px solid ${theme.colors.borderLight}`,
          ...(c.align ? { textAlign: c.align } : {}),
          // Separator kolom — garis vertikal antar kolom (kecuali kolom terakhir)
          ...(ci < columns.length - 1
            ? { borderRight: `1px solid ${theme.colors.border}` }
            : {}),
        },
      },
      children: [],
    })),
  }));

  return div(
    {
      id,
      style: {
        width: "100%",
        overflow: "auto",
        borderRadius: "8px",
        border: `1px solid ${theme.colors.border}`,
      },
    },
    {
      id: `${id}-table`,
      tag: "table",
      props: {
        style: {
          width: "100%",
          borderCollapse: "separate",
          borderSpacing: "0",
          tableLayout: "fixed",
          fontSize: "13px",
        },
      },
      children: [
        {
          id: `${id}-colgroup`,
          tag: "colgroup",
          props: {},
          children: colNodes,
        },
        {
          id: `${id}-thead`,
          tag: "thead",
          props: {},
          children: [
            { id: `${id}-tr-head`, tag: "tr", props: {}, children: thNodes },
          ],
        },
        { id: `${id}-tbody`, tag: "tbody", props: {}, children: trNodes },
      ],
    },
  );
}

/**
 * ConnectedDataGrid — Tabel data interaktif: sort asc/desc + variable column width.
 *
 * Pola Connected* (self-rendering): build() → mount(screen) → setData().
 * Klik header kolom yang sortable → sort asc, klik lagi → desc.
 *
 * Usage:
 *   const grid = new ConnectedDataGrid({
 *     id: "sensor",
 *     columns: [
 *       { key: "node_id", label: "Node", width: 140 },
 *       { key: "sensor_id", label: "Sensor", width: 90 },
 *       { key: "value", label: "Nilai", width: 80, align: "right" },
 *       { key: "timestamp", label: "Waktu", width: "40%" },
 *     ],
 *   });
 *   form.add(grid.build())  // atau screen.mount(grid.build())
 *   await grid.mount(screen);
 *   await grid.setData(rows);
 */
export interface DataGridColumn {
  key: string;
  label: string;
  /** Lebar kolom: number (px) atau string CSS ("20%", "120px") */
  width?: string | number;
  /** Aktifkan sort? Default true */
  sortable?: boolean;
  /** Aktifkan resize kolom (drag tepi header)? Default true */
  resizable?: boolean;
  align?: "left" | "center" | "right";
}

export class ConnectedDataGrid {
  public readonly wrapId: string;
  public columns: DataGridColumn[];
  public data: Record<string, any>[];
  private gridId: string;
  private screen: Screen | null = null;
  private sortKey: string | null = null;
  private sortDir: "asc" | "desc" | null = null;
  private bodyId: string;
  private onSortCb: ((key: string, dir: "asc" | "desc") => void) | null = null;
  private onRowClickCb:
    | ((index: number, record: Record<string, any>) => void)
    | null = null;
  private onRowCtxCb:
    | ((
        index: number,
        record: Record<string, any>,
        x: number,
        y: number,
      ) => void)
    | null = null;
  // SELECTION — index = kunci stabil per datarow (INDEX ≠ ROW NUMBER).
  // Di-generate saat row masuk, di-cache via WeakMap (tanpa mencemari data user).
  // Record yang sama (referensi sama) → kunci sama → tahan sort & refresh.
  private selectedRowKey: number | null = null;
  private rowKeys: WeakMap<object, number> = new WeakMap();
  private nextRowKey = 1;
  private height?: number | string;
  // COLUMN WIDTH — lebar hasil drag disimpan di sini (source of truth app-side).
  // Browser memberitahu via event "col_resized" saat drag selesai; render()
  // selalu re-apply lebar ini → lebar TETAP sampai user drag lagi.
  private colWidths = new Map<string, number>();
  private renderMutex: (() => void) | null = null;
  /** Batas maksimum baris yang dipertahankan di tampilan (dipangkas dari depan). 0 = tanpa batas */
  private maxRows: number = 0;

  constructor(opts: {
    id: string;
    columns: DataGridColumn[];
    data?: Record<string, any>[];
    /** Tinggi tetap wrapper (number = px, atau string "300px") — biar scroll internal */
    height?: number | string;
    /** Batas maksimum baris di tampilan (dipangkas dari depan) — untuk mencegah payload WS membengkak */
    maxRows?: number;
  }) {
    this.gridId = opts.id;
    this.wrapId = `dg-${opts.id}`;
    this.columns = opts.columns || [];
    this.data = opts.data || [];
    this.bodyId = `dg-body-${opts.id}`;
    this.height = opts.height;
    this.maxRows = opts.maxRows ?? 0;
  }

  /** Build struktur: wrapper → table → colgroup + thead (static) + tbody (dinamis) */
  build(): IDOMNode {
    // Colgroup dibuat dua kali (header & body) — lebar harus sama & tersinkron saat resize
    const makeCols = (prefix: string): IDOMNode[] =>
      this.columns.map((c) => {
        // Lebar kolom: hasil drag (colWidths) menang atas definisi awal (c.width)
        const w = this.colWidths.get(c.key) ?? c.width;
        return {
          id: `${prefix}-col-${c.key}`,
          tag: "col",
          props: {
            "data-col-key": c.key,
            ...(w
              ? { style: { width: typeof w === "number" ? w + "px" : w } }
              : {}),
          },
          children: [],
        };
      });
    const theadCols = makeCols(`${this.wrapId}-thead`);
    const tbodyCols = makeCols(`${this.wrapId}-tbody`);

    const thNodes: IDOMNode[] = this.columns.map((c) => {
      const sortable = c.sortable !== false;
      const resizable = c.resizable !== false;
      const thId = `${this.wrapId}-th-${c.key}`;
      const lblId = `${this.wrapId}-thlbl-${c.key}`;

      // Label + handle resize (native drag di browser via data-col-resize)
      const children: IDOMNode[] = [
        {
          id: lblId,
          tag: "span",
          props: { text: c.label, style: { pointerEvents: "none" as any } },
          children: [],
        },
      ];
      if (resizable) {
        children.push({
          id: `${this.wrapId}-thres-${c.key}`,
          tag: "div",
          props: {
            "data-col-resize": "1",
            style: {
              position: "absolute",
              top: "0",
              right: "0",
              width: "6px",
              height: "100%",
              cursor: "col-resize",
              userSelect: "none" as any,
            },
          },
          children: [],
        });
      }

      return {
        id: thId,
        tag: "th",
        props: {
          // Label via child span (bukan props.text) — handle resize tetap ada saat setText
          // onClickId di set saat MOUNT — hindari bug cloneNode (app.on() setelah mount)
          ...(sortable ? { onClickId: thId } : {}),
          style: {
            ...(c.width
              ? {
                  width: typeof c.width === "number" ? c.width + "px" : c.width,
                }
              : {}),
            ...(c.align ? { textAlign: c.align } : {}),
            cursor: sortable ? "pointer" : "default",
            userSelect: "none" as any,
            padding: "8px 12px",
            background: theme.colors.surface,
            // Separator via box-shadow inset — dicat bersama elemen (bukan border tabel),
            // jadi andal repaint saat sel muncul dari luar viewport (scroll horizontal).
            boxShadow: `inset -1px 0 0 ${theme.colors.border}, inset 0 -1px 0 0 ${theme.colors.border}`,
            fontSize: "12px",
            fontWeight: "600" as any,
            color: theme.colors.text,
            whiteSpace: "nowrap",
            // Sticky header dalam satu scroll container — th tetap di atas saat body
            // scroll vertikal, dan ikut geser horizontal bareng konten (alignment
            // kolom header ↔ body dijamin karena satu container).
            position: "sticky",
            top: "0",
            zIndex: "2",
          },
        },
        children,
      };
    });

    const bodyNode: IDOMNode = {
      id: this.bodyId,
      tag: "tbody",
      props: {},
      children: [],
    };

    // CSS hover + selected — murni CSS (DOME cuma relay click/input/keydown, tak ada hover event)
    const styleNode: IDOMNode = {
      id: `${this.wrapId}-style`,
      tag: "style",
      props: {
        text: [
          `[data-tsix-id="${this.wrapId}"] .dg-row { cursor: pointer; }`,
          `[data-tsix-id="${this.wrapId}"] .dg-row td { transition: background 0.12s ease; }`,
          `[data-tsix-id="${this.wrapId}"] .dg-row:hover td { background: var(--accent-bg, rgba(76,175,80,0.16)) !important; }`,
          `[data-tsix-id="${this.wrapId}"] .dg-row.selected td { background: var(--accent-bg, rgba(76,175,80,0.32)) !important; }`,
          `[data-tsix-id="${this.wrapId}"] .dg-row.selected:hover td { background: var(--accent-bg, rgba(76,175,80,0.38)) !important; }`,
          // Separator & zebra dicat per-sel (inline background + box-shadow inset), bukan
          // border tabel — andal repaint saat sel muncul dari luar viewport saat scroll.
          `[data-tsix-id="${this.wrapId}"] .dg-row.selected td:first-child { box-shadow: inset 3px 0 0 var(--accent, #4caf50), inset -1px 0 0 ${theme.colors.border}, inset 0 -1px 0 0 ${theme.colors.borderLight}; }`,
        ].join("\n"),
      },
      children: [],
    };

    // Header & body dalam SATU scroll container; header di-pin via th sticky (top:0).
    // Kolom header & data row dijamin sejajar (lebar sama, scroll horizontal sinkron).
    const theadTable: IDOMNode = {
      id: `${this.wrapId}-thead-table`,
      tag: "table",
      props: {
        style: {
          width: "100%",
          borderCollapse: "separate",
          borderSpacing: "0",
          tableLayout: "fixed",
          fontSize: "13px",
        },
      },
      children: [
        {
          id: `${this.wrapId}-thead-colgroup`,
          tag: "colgroup",
          props: {},
          children: theadCols,
        },
        {
          id: `${this.wrapId}-thead`,
          tag: "thead",
          props: {},
          children: [
            {
              id: `${this.wrapId}-tr-head`,
              tag: "tr",
              props: {},
              children: thNodes,
            },
          ],
        },
      ],
    };

    const tbodyTable: IDOMNode = {
      id: `${this.wrapId}-tbody-table`,
      tag: "table",
      props: {
        style: {
          width: "100%",
          borderCollapse: "separate",
          borderSpacing: "0",
          tableLayout: "fixed",
          fontSize: "13px",
        },
      },
      children: [
        {
          id: `${this.wrapId}-tbody-colgroup`,
          tag: "colgroup",
          props: {},
          children: tbodyCols,
        },
        bodyNode,
      ],
    };

    return div(
      {
        id: this.wrapId,
        className: "tsix-dgrid",
        style: {
          width: "100%",
          borderRadius: "8px",
          border: `1px solid ${theme.colors.border}`,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          ...(this.height
            ? {
                height:
                  typeof this.height === "number"
                    ? this.height + "px"
                    : this.height,
              }
            : {}),
        },
      },
      div(
        {
          id: `${this.wrapId}-body-scroll`,
          className: "tsix-dgrid-body",
          // SATU scroll container untuk header + body → scroll horizontal otomatis
          // sinkron & lebar tabel sama persis (kolom header & data row selalu sejajar,
          // termasuk di ujung scroll). Header di-pin via th sticky (top:0).
          style: { flex: "1", minHeight: "0", overflow: "auto" },
        },
        styleNode,
        theadTable,
        tbodyTable,
      ),
    );
  }

  /** Pasang ke Screen — bind header click (listener sudah ada dari onClickId mount-time) */
  async mount(
    screen: Screen,
    onSort?: (key: string, dir: "asc" | "desc") => void,
    onRowClick?: (index: number, record: Record<string, any>) => void,
    onRowContextMenu?: (
      index: number,
      record: Record<string, any>,
      x: number,
      y: number,
    ) => void,
  ): Promise<void> {
    this.screen = screen;
    this.onSortCb = onSort || null;
    this.onRowClickCb = onRowClick || null;
    this.onRowCtxCb = onRowContextMenu || null;
    for (const c of this.columns) {
      if (c.sortable === false) continue;
      const thId = `${this.wrapId}-th-${c.key}`;
      screen.win.bindHandler(thId, "click", () => {
        void this.toggleSort(c.key);
      });
    }
    // Dengarkan notifikasi lebar kolom hasil drag dari browser (dome-client).
    // targetId = wrapId grid ini; eventType "col_resized".
    screen.win.bindHandler(this.wrapId, "col_resized", (ev: any) => {
      try {
        const v =
          typeof ev?.value === "string" ? JSON.parse(ev.value) : ev?.value;
        if (v && v.key && v.width != null) {
          this.colWidths.set(v.key, Number(v.width));
          void this.applyColWidths();
        }
      } catch (_) {
        /* parse gagal — abaikan */
      }
    });
    // Catatan: scroll header ↔ body tidak perlu di-sync manual — keduanya berada
    // dalam satu scroll container (body-scroll), jadi otomatis sinkron.
    await this.render();
  }

  /** Ganti seluruh data lalu render ulang */
  async setData(data: Record<string, any>[]): Promise<void> {
    const changed = data !== this.data;
    this.data = Array.isArray(data) ? [...data] : [];
    // Array baru → reset cursor. Refresh pakai array yang sama → kunci stabil tetap, seleksi dipertahankan.
    if (changed) this.selectedRowKey = null;
    if (this.screen) await this.render();
  }

  /**
   * appendData(): Tambah data baru SECARA INKREMENTAL.
   *
   * Hanya baris-baris BARU yang dikirim ke browser (mount per baris) —
   * TANPA rebuild seluruh tbody. Ini yang membuat traffic WS tetap kecil
   * meskipun data terus bertambah (tidak "bedol desa" tiap paket masuk).
   *
   * Jika ada sort aktif → fallback ke render penuh agar urutan tetap benar.
   * Jika jumlah baris melebihi cap (maxRows) → baris tertua dipangkas dari
   * depan & DOM-nya di-unmount (id baris berbasis row-key stabil).
   *
   * @param records Baris-baris baru (ditempelkan di belakang urutan tampil)
   */
  async appendData(records: Record<string, any>[]): Promise<void> {
    if (!records || records.length === 0) return;

    // Sort aktif → urutan tampil harus benar → render penuh (jarang, aksi eksplisit user)
    if (this.sortKey) {
      this.data.push(...records);
      if (this.maxRows && this.data.length > this.maxRows)
        this.data = this.data.slice(-this.maxRows);
      await this.render();
      return;
    }

    if (!this.screen) {
      this.data.push(...records);
      if (this.maxRows && this.data.length > this.maxRows)
        this.data = this.data.slice(-this.maxRows);
      return;
    }
    const s = this.screen;

    // Serialkan dengan render lain (mutex) — cegah race setContent vs mount
    if (this.renderMutex) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!this.renderMutex) resolve();
          else setTimeout(check, 10);
        };
        check();
      });
    }
    let mutex_resolved = false;
    this.renderMutex = () => {
      mutex_resolved = true;
    };

    try {
      // 1. Pangkas baris tertua jika melebihi cap — catat key untuk unmount DOM
      const droppedKeys: number[] = [];
      const trim = () => {
        while (this.maxRows && this.data.length > this.maxRows) {
          const removed = this.data.shift()!;
          const rk = this.rowKeys.get(removed);
          if (rk !== undefined) {
            droppedKeys.push(rk);
            this.rowKeys.delete(removed);
          }
        }
      };
      trim();
      const baseIdx = this.data.length;
      this.data.push(...records);
      trim(); // jika batch melebihi cap, pangkas kelebihannya juga

      // 2. Mount HANYA baris baru yang masih bertahan (tidak ikut terpangkas)
      let newIdx = baseIdx;
      for (const rec of records) {
        if (this.data.indexOf(rec) === -1) continue; // ikut terpangkas — skip
        const key = this.getRowKey(rec);
        const rowId = `${this.wrapId}-row-${key}`;
        const node = this.buildRowNode(rec, key, newIdx);
        await s.win.mount(node, this.bodyId);
        s.win.bindHandler(rowId, "click", () => {
          void this.selectRowByKey(key);
        });
        s.win.bindHandler(rowId, "contextmenu", (ev: any) => {
          let x = 0,
            y = 0;
          try {
            const p = JSON.parse(ev?.value || "{}");
            x = p.x || 0;
            y = p.y || 0;
          } catch (_) {
            /* parse gagal */
          }
          if (this.onRowCtxCb) this.onRowCtxCb(key, { ...rec }, x, y);
        });
        newIdx++;
      }

      // 3. Unmount DOM baris yang terpangkas
      for (const rk of droppedKeys) {
        try {
          await s.win.unmount(`${this.wrapId}-row-${rk}`);
        } catch (_) {
          /* sudah tidak ada */
        }
      }
    } finally {
      this.renderMutex = null;
    }
  }

  /** Bangun node <tr> untuk satu datarow — id berbasis row-key stabil. */
  private buildRowNode(
    row: Record<string, any>,
    key: number,
    rIdx: number,
  ): IDOMNode {
    const rowId = `${this.wrapId}-row-${key}`;
    return {
      id: rowId,
      tag: "tr",
      props: {
        className: "dg-row" + (this.selectedRowKey === key ? " selected" : ""),
        onClickId: rowId,
        onContextMenuId: rowId,
        // Background & separator kini di level td (tiap sel mandiri) — lihat td style.
      },
      children: this.columns.map((c) => ({
        id: `${this.wrapId}-cell-${c.key}-${key}`,
        tag: "td",
        props: {
          text:
            row[c.key] !== undefined && row[c.key] !== null
              ? String(row[c.key])
              : "",
          style: {
            padding: "6px 12px",
            // Zebra + separator dicat BERSAMA sel (bg + box-shadow inset) — bukan border
            // tabel, jadi andal repaint saat sel muncul dari luar viewport (scroll).
            background:
              rIdx % 2 === 0 ? theme.colors.surface : theme.colors.card,
            boxShadow: `inset -1px 0 0 ${theme.colors.border}, inset 0 -1px 0 0 ${theme.colors.borderLight}`,
            ...(c.align ? { textAlign: c.align } : {}),
          },
        },
        children: [],
      })),
    };
  }

  /** Ganti definisi kolom lalu render ulang */
  async setColumns(columns: DataGridColumn[]): Promise<void> {
    this.columns = columns || [];
    if (this.screen) await this.render();
  }

  /** Klik header: toggle sort asc ↔ desc */
  async toggleSort(key: string): Promise<void> {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
    } else {
      this.sortKey = key;
      this.sortDir = "asc";
    }
    if (this.onSortCb && this.sortDir) this.onSortCb(key, this.sortDir);
    await this.render();
  }

  /** State sort saat ini */
  get sort(): { key: string; dir: "asc" | "desc" } | null {
    return this.sortKey && this.sortDir
      ? { key: this.sortKey, dir: this.sortDir }
      : null;
  }

  // ============================================================
  // SELECTION — cursor berbasis row-key stabil (INDEX ≠ ROW NUMBER)
  // ============================================================

  /**
   * Kunci stabil baris yang dipilih (di-generate saat row masuk, cache WeakMap).
   * TIDAK berubah oleh sort/refresh — ini primary key datarow di sistem datagrid.
   * -1 jika tak ada seleksi / kunci sudah tidak ada di data.
   */
  get selectedIndex(): number {
    return this.findByKey(this.selectedRowKey) !== null
      ? (this.selectedRowKey as number)
      : -1;
  }

  /** Rekaman baris yang dipilih (copy, bukan referensi internal) */
  get selectedRecord(): Record<string, any> | null {
    const rec = this.findByKey(this.selectedRowKey);
    return rec ? { ...rec } : null;
  }

  /**
   * Ambil data row berdasarkan row-key (index stabil).
   * index = kunci yang di-generate saat row masuk, BUKAN nomor baris tampil.
   * Return shallow copy — mutasi luar tidak merusak data internal.
   */
  getRecord(index: number): Record<string, any> | null {
    const rec = this.findByKey(index);
    return rec ? { ...rec } : null;
  }

  /** Programmatic select berdasarkan row-key. index = -1 → clear. */
  async setSelectedIndex(index: number): Promise<void> {
    const prevKey = this.selectedRowKey;
    this.selectedRowKey = this.findByKey(index) ? index : null;
    await this.applySelectionVisual(prevKey, this.selectedRowKey);
  }

  /** Hapus seleksi */
  async clearSelection(): Promise<void> {
    if (this.selectedRowKey === null) return;
    const prevKey = this.selectedRowKey;
    this.selectedRowKey = null;
    await this.applySelectionVisual(prevKey, null);
  }

  /**
   * Update visual seleksi TANPA rebuild tbody.
   * Cukup ganti className pada baris lama (lepas "selected") dan baris baru
   * (dapat "selected") — menghindari setContent yang me-reset scroll ke atas.
   */
  private async applySelectionVisual(
    prevKey: number | null,
    nextKey: number | null,
  ): Promise<void> {
    if (!this.screen) return;
    const s = this.screen;

    const patch: Array<{ id: string; selected: boolean }> = [];
    if (prevKey !== null && prevKey !== nextKey) {
      patch.push({ id: `${this.wrapId}-row-${prevKey}`, selected: false });
    }
    if (nextKey !== null) {
      patch.push({ id: `${this.wrapId}-row-${nextKey}`, selected: true });
    }

    for (const p of patch) {
      await s.update(p.id, {
        className: "dg-row" + (p.selected ? " selected" : ""),
      });
    }
  }

  /**
   * Generate (atau ambil cache) kunci stabil untuk sebuah datarow.
   * Referensi object yang sama → kunci yang sama (tahan sort & refresh).
   */
  private getRowKey(rec: object): number {
    let k = this.rowKeys.get(rec);
    if (k === undefined) {
      k = this.nextRowKey++;
      this.rowKeys.set(rec, k);
    }
    return k;
  }

  /** Cari datarow berdasarkan row-key-nya (dalam urutan tampil saat ini) */
  private findByKey(key: number | null): Record<string, any> | null {
    if (key === null) return null;
    const rows = this.getSortedRows();
    return rows.find((r) => this.getRowKey(r) === key) || null;
  }

  /** Internal — klik baris (via row-key stabil): seleksi tahan sort/refresh */
  private async selectRowByKey(key: number): Promise<void> {
    const rec = this.findByKey(key);
    if (!rec) return;
    const prevKey = this.selectedRowKey;
    this.selectedRowKey = key;
    if (this.onRowClickCb) this.onRowClickCb(key, { ...rec });
    await this.applySelectionVisual(prevKey, key);
  }

  // ============================================================
  // INTERNAL — render
  // ============================================================

  private getSortedRows(): Record<string, any>[] {
    if (!this.sortKey) return [...this.data];
    const key = this.sortKey;
    const dir = this.sortDir === "desc" ? -1 : 1;
    return [...this.data].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === "number" && typeof bv === "number")
        return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  private async render(): Promise<void> {
    // Tunggu render sebelumnya selesai — hindari race condition
    if (this.renderMutex) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!this.renderMutex) resolve();
          else setTimeout(check, 10);
        };
        check();
      });
    }

    // Set mutex
    let mutex_resolved = false;
    this.renderMutex = () => {
      mutex_resolved = true;
    };

    try {
      if (!this.screen) return;
      const s = this.screen;

      // 1. Urutkan data
      const rows = this.getSortedRows();

      // 2. Rebuild tbody via setContent (clear + mount)
      const trNodes: IDOMNode[] = rows.map((row, rIdx) =>
        this.buildRowNode(row, this.getRowKey(row), rIdx),
      );

      await s.setContent(this.bodyId, ...trNodes);

      // 2b. Bind click tiap row (id berbasis row-key stabil)
      for (const row of rows) {
        const key = this.getRowKey(row);
        const rowId = `${this.wrapId}-row-${key}`;
        s.win.bindHandler(rowId, "click", () => {
          void this.selectRowByKey(key);
        });
      }

      // 2c. Bind contextmenu tiap row
      for (const row of rows) {
        const key = this.getRowKey(row);
        const rowId = `${this.wrapId}-row-${key}`;
        s.win.bindHandler(rowId, "contextmenu", (ev: any) => {
          let x = 0,
            y = 0;
          try {
            const p = JSON.parse(ev?.value || "{}");
            x = p.x || 0;
            y = p.y || 0;
          } catch (_) {
            /* parse gagal */
          }
          if (this.onRowCtxCb) this.onRowCtxCb(key, { ...row }, x, y);
        });
      }

      // 3. Update indikator header
      for (const c of this.columns) {
        const lblId = `${this.wrapId}-thlbl-${c.key}`;
        const indicator =
          this.sortKey === c.key ? (this.sortDir === "asc" ? " ▲" : " ▼") : "";
        await s.setText(lblId, c.label + indicator);
      }

      // 4. Re-apply lebar kolom
      await this.applyColWidths();
    } finally {
      this.renderMutex = null;
    }
  }

  /**
   * Terapkan lebar kolom hasil drag ke semua colgroup (header + body) + th.
   * Targeted update (tanpa setContent) — aman dipanggil berulang kali.
   */
  private async applyColWidths(): Promise<void> {
    if (!this.screen) return;
    const s = this.screen;
    for (const [key, w] of this.colWidths) {
      const width = typeof w === "number" ? w + "px" : String(w);
      for (const prefix of [`${this.wrapId}-thead`, `${this.wrapId}-tbody`]) {
        await s.update(`${prefix}-col-${key}`, { style: { width } });
      }
      await s.update(`${this.wrapId}-th-${key}`, { style: { width } });
    }
  }
}

// ============================================================
// CONNECTED TABULATOR — Data grid via Tabulator v6 (browser-side)
// ============================================================

/**
 * ConnectedTabulator — DataGrid berbasis Tabulator v6 (browser-side widget).
 *
 * TIDAK menggantikan ConnectedDataGrid — widget BARU dengan API yang sama.
 * Semua render (sort, resize kolom, selection, scroll) ditangani Tabulator
 * di sisi browser (pola custom widget ala codemirror/xterm/lightweight-charts).
 * App hanya mengirim data: shell.send(domePid) → dome.ts relay → browser.
 *
 * Keuntungan vs ConnectedDataGrid (render virtual-DOM app-side):
 *  - Bebas dari bug render/setContent/race-condition yang dulu.
 *  - Traffic IPC jauh lebih kecil: data dikirim sekali, render di browser.
 *
 * Usage (Emerald):
 *   const grid = new ConnectedTabulator({ id: "sensor", columns, data });
 *   await app.mount(grid.build());
 *   await grid.mount(app, onSort, onRowClick, onRowContextMenu);
 *   await grid.setData(rows);          // ganti data penuh
 *   await grid.appendData(newRows);    // tambah inkremental
 *
 * API SAMA dengan ConnectedDataGrid → cashew TTabulatorGrid tinggal
 * membungkus class ini tanpa mengubah aplikasi consumer.
 */
export class ConnectedTabulator {
  public readonly wrapId: string;
  public columns: DataGridColumn[];
  public data: Record<string, any>[];
  private gridId: string;
  private screen: Screen | null = null;
  private lib: any = null;
  private domePid = 0;
  // Antrean pesan yang belum bisa dikirim karena PID DOME belum ter-resolve
  // (race mount vs setData/refresh di pola cashew). Di-flush saat pid siap.
  private pendingDome: { type: string; extra: Record<string, any> }[] = [];
  private sortKey: string | null = null;
  private sortDir: "asc" | "desc" | null = null;
  private onSortCb: ((key: string, dir: "asc" | "desc") => void) | null = null;
  private onRowClickCb:
    | ((index: number, record: Record<string, any>) => void)
    | null = null;
  private onRowCtxCb:
    | ((
        index: number,
        record: Record<string, any>,
        x: number,
        y: number,
      ) => void)
    | null = null;
  private onSelChangeCb:
    | ((index: number, record: Record<string, any> | null) => void)
    | null = null;
  // SELECTION — index = kunci stabil per datarow (INDEX ≠ ROW NUMBER).
  // Di-generate app-side via WeakMap, ditandai ke browser lewat field
  // `_tsixKey` (objek user tidak pernah dimutasi).
  private selectedRowKey: number | null = null;
  private rowKeys: WeakMap<object, number> = new WeakMap();
  private nextRowKey = 1;
  private height?: number | string;
  private maxRows = 0;
  private selectable: boolean;

  constructor(opts: {
    id: string;
    columns: DataGridColumn[];
    data?: Record<string, any>[];
    /** Tinggi tetap wrapper (number = px, atau string "300px"). Tanpa ini: auto + scroll internal */
    height?: number | string;
    /** Batas maksimum baris di tampilan (dipangkas dari depan) */
    maxRows?: number;
    /** Aktifkan seleksi baris (single) — default true */
    selectable?: boolean;
  }) {
    this.gridId = opts.id;
    this.wrapId = `tb-${opts.id}`;
    this.columns = opts.columns || [];
    this.data = opts.data || [];
    this.height = opts.height;
    this.maxRows = opts.maxRows ?? 0;
    this.selectable = opts.selectable !== false;
  }

  /** Bangun node <tabulator> — browser menginisialisasi dari props saat mount. */
  build(): IDOMNode {
    return {
      id: this.wrapId,
      tag: "tabulator",
      props: {
        cols: this.columns,
        data: this.decorateRows(this.data),
        height: this.height,
        selectable: this.selectable,
        maxRows: this.maxRows,
      },
      children: [],
    };
  }

  /** Pasang ke Screen — bind event handler browser → app + resolve PID DOME. */
  async mount(
    screen: Screen,
    onSort?: (key: string, dir: "asc" | "desc") => void,
    onRowClick?: (index: number, record: Record<string, any>) => void,
    onRowContextMenu?: (
      index: number,
      record: Record<string, any>,
      x: number,
      y: number,
    ) => void,
    onSelectionChange?: (
      index: number,
      record: Record<string, any> | null,
    ) => void,
  ): Promise<void> {
    this.screen = screen;
    this.onSortCb = onSort || null;
    this.onRowClickCb = onRowClick || null;
    this.onRowCtxCb = onRowContextMenu || null;
    this.onSelChangeCb = onSelectionChange || null;
    this.lib = (global as any)._tsixLib;
    const w = screen.win;

    // Event dari browser (dome-client-tabulator.js → GUI_EVENT → bindHandler)
    w.bindHandler(this.wrapId, "tb_sort", (ev: any) => {
      try {
        const v = JSON.parse(ev?.value || "{}");
        if (v.key && v.dir) {
          const prev = `${this.sortKey}:${this.sortDir}`;
          this.sortKey = v.key;
          this.sortDir = v.dir;
          // Jangan double-fire jika ini echo dari toggleSort() programmatic
          if (this.onSortCb && `${v.key}:${v.dir}` !== prev) {
            this.onSortCb(v.key, v.dir);
          }
        }
      } catch (_) {
        /* parse gagal — abaikan */
      }
    });
    w.bindHandler(this.wrapId, "tb_rowclick", (ev: any) => {
      try {
        const v = JSON.parse(ev?.value || "{}");
        if (v.key != null && this.onRowClickCb) {
          const rec = this.getRecord(Number(v.key));
          if (rec) this.onRowClickCb(Number(v.key), rec);
        }
      } catch (_) {
        /* parse gagal — abaikan */
      }
    });
    w.bindHandler(this.wrapId, "tb_contextmenu", (ev: any) => {
      try {
        const v = JSON.parse(ev?.value || "{}");
        if (v.key != null && this.onRowCtxCb) {
          const rec = this.getRecord(Number(v.key));
          if (rec) this.onRowCtxCb(Number(v.key), rec, v.x || 0, v.y || 0);
        }
      } catch (_) {
        /* parse gagal — abaikan */
      }
    });
    w.bindHandler(this.wrapId, "tb_select", (ev: any) => {
      try {
        const v = JSON.parse(ev?.value || "{}");
        this.selectedRowKey = v.key != null ? Number(v.key) : null;
        if (this.onSelChangeCb) {
          this.onSelChangeCb(this.selectedIndex, this.selectedRecord);
        }
      } catch (_) {
        /* parse gagal — abaikan */
      }
    });

    // Resolve PID DOME (relay app → browser via shell.send — pola TChart).
    // Dipanggil sekali di mount supaya pid segera siap; sendToDome tetap
    // meng-queue pesan jika pid belum ter-resolve (race dengan refresh()).
    await this.ensureDomePid();

    // Pasang warna theme aktif ke grid (browser) + ikuti perubahan theme.
    await this.sendTheme();
    this.lib?.onEvent?.("ipc_message", this.onThemeMsg);
  }

  /**
   * Kirim warna theme aktif ke browser (TB_THEME → scoped CSS vars grid).
   * Grid ikut theme bahkan sebelum root CSS var ter-set (self-sufficient).
   */
  private async sendTheme(): Promise<void> {
    const c: any = (theme as any).colors || {};
    await this.sendToDome("TB_THEME", {
      colors: {
        bg: c.bg,
        surface: c.surface,
        accent: c.accent,
        text: c.text,
        textDim: c.textDim,
        textMuted: c.textMuted,
        borderColor: c.border,
        accentBg: c.accentBg,
      },
    });
  }

  /** Saat theme berubah (app lain panggil theme.switchTo) → re-push warna. */
  private onThemeMsg = (msg: any): void => {
    const ev = msg?.data || msg;
    if (ev?.type === "THEME_CHANGED") void this.sendTheme();
  };

  /** Kirim pesan ke browser via DOME (pola TChart/uPlot). */
  private async sendToDome(
    type: string,
    extra: Record<string, any> = {},
  ): Promise<void> {
    if (!this.screen || !this.lib?.shell) return;
    // PID belum diketahui → antre dulu; ensureDomePid akan flush saat siap.
    if (!this.domePid) {
      this.pendingDome.push({ type, extra });
      await this.ensureDomePid();
      return;
    }
    await this._rawSend(type, extra);
  }

  private async _rawSend(
    type: string,
    extra: Record<string, any>,
  ): Promise<void> {
    if (!this.domePid || !this.screen || !this.lib?.shell) return;
    try {
      await this.lib.shell.send(this.domePid, {
        type,
        wid: this.screen.wid,
        targetId: this.wrapId,
        ...extra,
      });
    } catch (_) {
      /* serialization error — skip */
    }
  }

  /** Resolve PID DOME dari ps(); flush pesan yang sempat terantre. */
  private async ensureDomePid(): Promise<number> {
    if (this.domePid) return this.domePid;
    try {
      const ps = await this.lib?.shell?.ps?.();
      const dome = (ps || []).find((p: any) => p.name?.includes("dome"));
      this.domePid = dome ? dome.pid : 0;
      if (this.domePid) {
        const q = this.pendingDome;
        this.pendingDome = [];
        for (const m of q) await this._rawSend(m.type, m.extra);
      }
    } catch (_) {
      /* DOME mungkin belum running */
    }
    return this.domePid;
  }

  /** Ganti seluruh data lalu kirim ke browser. */
  async setData(data: Record<string, any>[]): Promise<void> {
    const changed = data !== this.data;
    this.data = Array.isArray(data) ? [...data] : [];
    // Array baru → reset cursor. Refresh pakai array sama → kunci stabil, seleksi dipertahankan.
    if (changed) this.selectedRowKey = null;
    await this.sendToDome("TB_DATA", { rows: this.decorateRows(this.data) });
    if (!changed && this.selectedRowKey != null) {
      await this.sendToDome("TB_SELECT", { key: this.selectedRowKey });
    }
  }

  /**
   * appendData(): Tambah data baru SECARA INKREMENTAL.
   * Hanya baris BARU yang dikirim ke browser (TB_APPEND → Tabulator.addData) —
   * tanpa rebuild grid. Render tetap di browser, jadi sangat hemat IPC.
   * Jika melebihi maxRows → baris tertua dipangkas & grid di-replace penuh.
   */
  async appendData(records: Record<string, any>[]): Promise<void> {
    if (!records || records.length === 0) return;
    const newRows = Array.isArray(records) ? [...records] : [];
    this.data.push(...newRows);
    if (this.maxRows && this.data.length > this.maxRows) {
      this.data = this.data.slice(-this.maxRows);
      await this.sendToDome("TB_DATA", { rows: this.decorateRows(this.data) });
      return;
    }
    await this.sendToDome("TB_APPEND", { rows: this.decorateRows(newRows) });
  }

  /** Ganti definisi kolom lalu kirim ke browser. */
  async setColumns(columns: DataGridColumn[]): Promise<void> {
    this.columns = columns || [];
    await this.sendToDome("TB_COLS", { cols: this.columns });
  }

  /** Sort programmatic (dari app): toggle asc ↔ desc, lalu kirim ke browser. */
  async toggleSort(key: string): Promise<void> {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
    } else {
      this.sortKey = key;
      this.sortDir = "asc";
    }
    if (this.onSortCb && this.sortDir) this.onSortCb(key, this.sortDir);
    await this.sendToDome("TB_SORT", { key, dir: this.sortDir });
  }

  /** State sort saat ini. */
  get sort(): { key: string; dir: "asc" | "desc" } | null {
    return this.sortKey && this.sortDir
      ? { key: this.sortKey, dir: this.sortDir }
      : null;
  }

  // ============================================================
  // SELECTION — cursor berbasis row-key stabil (INDEX ≠ ROW NUMBER)
  // ============================================================

  /** Kunci stabil baris yang dipilih; -1 jika tak ada. */
  get selectedIndex(): number {
    return this.findByKey(this.selectedRowKey) !== null
      ? (this.selectedRowKey as number)
      : -1;
  }

  /** Rekaman baris yang dipilih (copy, tanpa field internal). */
  get selectedRecord(): Record<string, any> | null {
    const rec = this.findByKey(this.selectedRowKey);
    return rec ? { ...rec } : null;
  }

  /** Ambil data row berdasarkan row-key (index stabil). Return shallow copy. */
  getRecord(index: number): Record<string, any> | null {
    const rec = this.findByKey(index);
    return rec ? { ...rec } : null;
  }

  /** Semua data saat ini (copy, tanpa field internal). */
  getData(): Record<string, any>[] {
    return this.data.map((r) => ({ ...r }));
  }

  /** Programmatic select berdasarkan row-key. index = -1 → clear. */
  async setSelectedIndex(index: number): Promise<void> {
    this.selectedRowKey = this.findByKey(index) ? index : null;
    await this.sendToDome("TB_SELECT", { key: this.selectedRowKey });
  }

  /** Hapus seleksi. */
  async clearSelection(): Promise<void> {
    this.selectedRowKey = null;
    await this.sendToDome("TB_CLEAR_SELECT", {});
  }

  /** Hancurkan grid di browser. */
  async destroy(): Promise<void> {
    await this.sendToDome("TB_DESTROY", {});
  }

  // ============================================================
  // INTERNAL
  // ============================================================

  /**
   * Salin baris + tempel `_tsixKey` (kunci stabil). Objek asli user tidak
   * pernah dimutasi — kunci di-cache via WeakMap, jadi tahan sort/refresh.
   */
  private decorateRows(rows: Record<string, any>[]): Record<string, any>[] {
    return rows.map((r) => ({ ...r, _tsixKey: this.getRowKey(r) }));
  }

  /** Generate (atau ambil cache) kunci stabil untuk sebuah datarow. */
  private getRowKey(rec: object): number {
    let k = this.rowKeys.get(rec);
    if (k === undefined) {
      k = this.nextRowKey++;
      this.rowKeys.set(rec, k);
    }
    return k;
  }

  /** Cari datarow berdasarkan row-key-nya (dalam urutan data saat ini). */
  private findByKey(key: number | null): Record<string, any> | null {
    if (key === null) return null;
    return this.data.find((r) => this.getRowKey(r) === key) || null;
  }
}

export function slider(props: Record<string, any> = {}): IDOMNode {
  const id = props.id || uuidv4();
  const min = props.min ?? 0;
  const max = props.max ?? 2000;
  const step = props.step ?? 1;

  // Pastikan value awal tidak melenceng dari rentang min & max
  const rawValue = props.value ?? min;
  const value = Math.min(Math.max(rawValue, min), max);

  const color = props.color || "#2196f3";
  const label = props.label || "";
  const unit = props.unit || "";
  const inputId = `sl-input-${id}`;

  const children: IDOMNode[] = [];

  if (label) {
    children.push(
      span({
        text: label,
        style: {
          fontSize: "11px",
          color: theme.colors.textDim,
          display: "block",
          textAlign: "center",
          marginBottom: "6px",
        },
      }),
    );
  }

  children.push({
    id: inputId,
    tag: "input",
    props: {
      id: inputId,
      type: "range",
      value: String(value),
      min: String(min),
      max: String(max),
      step: String(step),
      onInputId: inputId,
      style: {
        width: "100%",
        height: "24px",
        accentColor: color,
        cursor: "pointer",
      },
    },
    children: [],
  });

  children.push(
    span({
      id: `sl-val-${id}`,
      text:
        (value % 1 === 0 ? String(Math.round(value)) : value.toFixed(1)) + unit,
      style: {
        fontSize: "12px",
        color: theme.colors.textDim,
        display: "block",
        textAlign: "center",
        marginTop: "4px",
        fontWeight: "700" as any,
      },
    }),
  );

  return div(
    {
      id: `sl-${id}`,
      style: {
        flex: "1",
        minWidth: "180px",
        background: theme.colors.card,
        borderRadius: "10px",
        padding: "14px",
        border: `1px solid ${color}44`,
      },
    },
    ...children,
  );
}

/**
 * splitTitleIcon(): Pisahkan ikon dari judul window untuk title bar.
 * - icon eksplisit → dipakai langsung (judul tidak diubah)
 * - tanpa icon, tapi judul diawali emoji → emoji jadi icon, judul dibersihkan
 * - selain itu → default "▶️" (biar semua window punya ikon)
 */
function splitTitleIcon(
  title: string,
  explicitIcon?: string,
): { icon: string; title: string } {
  if (explicitIcon) return { icon: explicitIcon, title };
  const t = (title || "App").trim();
  if (t.length === 0) return { icon: "▶️", title: t };
  const first = t.codePointAt(0)!;
  const isEmojiLike =
    (first >= 0x1f000 && first <= 0x1faff) || // Emoji (📊📁🔥 dst)
    (first >= 0x2600 && first <= 0x27bf) || // Misc Symbols + Dingbats (✏️⚙️)
    (first >= 0x2b00 && first <= 0x2bff) || // Arrows / misc
    first === 0xfe0f; // variation selector (warna emoji)
  if (!isEmojiLike) return { icon: "▶️", title: t };
  // Konsumsi emoji + variation selector (✏️ = U+270F + U+FE0F)
  let len = String.fromCodePoint(first).length;
  let cp = t.codePointAt(len);
  while (cp === 0xfe0f || cp === 0x20e3) {
    len += 1;
    cp = t.codePointAt(len);
  }
  const icon = t.slice(0, len);
  const rest = t.slice(len).trim();
  return { icon, title: rest || "App" };
}

export class Window {
  /** Window ID (unik, auto-generated) */
  public readonly wid: string;

  /** PID proses ini */
  private pid: number;

  /** Virtual DOM internal — state tree UI */
  private vdom: Map<string, IDOMNode> = new Map();

  /** Event handlers yang terdaftar (targetId → eventType → callback) */
  private handlers: Map<string, Map<string, EventCallback>> = new Map();

  /** Dispatch function untuk syscall */
  private _dispatch: (code: SyscallCode, args: any) => Promise<any>;

  /** Reference ke UserLib agar bisa mengirim IPC ke parent */
  private lib?: UserLib;

  /** Batch queue — perubahan yang menunggu di-flush */
  private dirtyProps: Map<string, Record<string, any>> = new Map();
  private batchPromise: Promise<void> | null = null;
  private batchTimer: any = null;

  /** Apakah window sudah di-destroy? */
  private destroyed: boolean = false;

  /**
   * CONSTRUCTOR — Kirim CREATE_WINDOW ke Kernel.
   *
   * Mendukung dua pola pemanggilan:
   *
   * 1. Object-based (recommended):
   *    new Window({ title: "My App", width: 800, height: 600, resizable: true })
   *
   * 2. Positional (legacy, tetap didukung):
   *    new Window("My App", lib, false, 800, 600, false, true, true)
   */
  constructor(opts: WindowOptions);
  constructor(
    title: string,
    lib?: UserLib,
    fullscreen?: boolean,
    width?: number,
    height?: number,
    frameless?: boolean,
    maximizable?: boolean,
    resizable?: boolean,
  );
  constructor(
    titleOrOpts: string | WindowOptions,
    lib?: UserLib,
    fullscreen = false,
    width?: number,
    height?: number,
    frameless = false,
    maximizable = true,
    resizable = true,
  ) {
    // Detect: jika arg pertama object dengan property "title", gunakan object pattern
    let _title: string;
    let _lib: UserLib | undefined;
    let _fullscreen: boolean;
    let _width: number | undefined;
    let _height: number | undefined;
    let _frameless: boolean;
    let _maximizable: boolean;
    let _resizable: boolean;
    let _icon: string | undefined;
    let _left: number | undefined;
    let _top: number | undefined;
    let _desktopCentered: boolean;

    if (
      typeof titleOrOpts === "object" &&
      titleOrOpts !== null &&
      "title" in titleOrOpts
    ) {
      const opts = titleOrOpts as WindowOptions;
      _title = opts.title;
      _icon = opts.icon;
      _lib = opts.lib;
      _fullscreen = opts.fullscreen ?? false;
      _width = opts.width;
      _height = opts.height;
      _frameless = opts.frameless ?? false;
      _maximizable = opts.maximizable ?? true;
      _resizable = opts.resizable ?? true;
      _left = opts.left;
      _top = opts.top;
      _desktopCentered = opts.desktopCentered ?? false;
    } else {
      _title = titleOrOpts as string;
      _icon = undefined;
      _lib = lib;
      _fullscreen = fullscreen;
      _width = width;
      _height = height;
      _frameless = frameless;
      _maximizable = maximizable;
      _resizable = resizable;
      _left = undefined;
      _top = undefined;
      _desktopCentered = false;
    }

    // Pisahkan ikon title bar: icon eksplisit → dipakai; else emoji awal judul;
    // else default 🪟. Judul tampilan dibersihkan dari emoji pendahulunya
    // (title asli tetap dipakai untuk event ke taskbar).
    const _split = splitTitleIcon(_title, _icon);
    const _displayTitle = _split.title;
    const _displayIcon = _split.icon;

    this.wid = uuidv4();

    if (_lib) {
      this.pid = _lib.getPid();
      this.lib = _lib;
      this._dispatch = (code, args) => (_lib as any).dispatch(code, args);
    } else {
      const globalLib = (global as any)._tsixLib as UserLib;
      if (!globalLib)
        throw new Error(
          "@tsix/emerald: UserLib not found! Are you running in TSIX Worker?",
        );
      this.pid = globalLib.getPid();
      this.lib = globalLib;
      this._dispatch = (code, args) => (globalLib as any).dispatch(code, args);
    }

    this.sendImmediate(GUIAction.CREATE_WINDOW, undefined, {
      id: this.wid,
      tag: "window",
      props: {
        title: _displayTitle,
        icon: _displayIcon,
        fullscreen: _fullscreen,
        width: _width,
        height: _height,
        frameless: _frameless,
        maximizable: _maximizable,
        resizable: _resizable,
        posX: _left,
        posY: _top,
        centered: _desktopCentered,
      },
      children: [],
    });

    // Daftarkan listener untuk event dari gued
    this.setupEventListener();
    void this.notifyParentWindowCreated(_title);
  }

  // ============================================================
  // PUBLIC API — MOUNT & UPDATE
  // ============================================================

  /**
   * mount(): Pasang pohon node ke window.
   *
   * Ini akan mengirim MOUNT_NODE ke Kernel → gued → Browser.
   *
   * @param node Pohon IDOMNode yang akan dipasang
   * @param parentId ID parent tempat node akan dipasang (default: root window)
   */
  public async mount(node: IDOMNode, parentId?: string): Promise<void> {
    this.ensureAlive();
    this.vdom.set(node.id, node);

    await this.sendImmediate(GUIAction.MOUNT_NODE, parentId, node);
  }

  /**
   * updateProps(): Update properti sebuah node.
   *
   * Ini di-BATCH: perubahan dikumpulkan dulu, lalu di-flush
   * di akhir async tick. Mencegah flooding IPC.
   *
   * @param targetId ID node yang akan di-update
   * @param props Properti yang berubah (hanya diff!)
   */
  public async updateProps(
    targetId: string,
    props: Record<string, any>,
  ): Promise<void> {
    this.ensureAlive();

    // Merge dengan dirty props yang sudah ada
    const existing = this.dirtyProps.get(targetId) || {};
    this.dirtyProps.set(targetId, { ...existing, ...props });

    // Schedule flush
    this.scheduleFlush();
  }

  /**
   * unmount(): Lepas node dari window.
   */
  public async unmount(targetId: string): Promise<void> {
    this.ensureAlive();
    this.vdom.delete(targetId);
    await this.sendImmediate(GUIAction.UNMOUNT_NODE, targetId);
  }

  // ============================================================
  // PUBLIC API — EVENT HANDLING
  // ============================================================

  /**
   * onClick(): Daftarkan handler untuk event click.
   *
   * @param targetId ID elemen yang akan didengarkan
   * @param callback Fungsi yang dipanggil saat event terjadi
   */
  public onClick(
    targetId: string,
    callback: (event: IGUIEventIPC) => void,
  ): void {
    this.registerHandler(targetId, "click", callback);
    // Kirim onClickId ke browser agar event listener terpasang
    this.updateProps(targetId, { onClickId: targetId });
  }

  /**
   * onInput(): Daftarkan handler untuk event input.
   */
  public onInput(
    targetId: string,
    callback: (event: IGUIEventIPC) => void,
  ): void {
    this.registerHandler(targetId, "input", callback);
    this.updateProps(targetId, { onInputId: targetId });
  }

  /**
   * onKeydown(): Daftarkan handler untuk event keydown.
   */
  public onKeydown(
    targetId: string,
    callback: (event: IGUIEventIPC) => void,
  ): void {
    this.registerHandler(targetId, "keydown", callback);
    this.updateProps(targetId, { onKeydownId: targetId });
  }

  /**
   * onClose(): Daftarkan handler saat window ditutup.
   */
  public onClose(callback: (event: IGUIEventIPC) => void): void {
    this.registerHandler("__window__", "close_window", callback);
  }

  /**
   * setContent(): Ganti seluruh isi container dengan children baru.
   * Satu operasi atomik — clear dulu, lalu isi ulang.
   * Gak perlu unmount manual.
   *
   * @param containerId ID container yang akan diisi ulang
   * @param children Node-node baru
   */
  public async setContent(
    containerId: string,
    ...children: IDOMNode[]
  ): Promise<void> {
    this.ensureAlive();
    // 1. Clear container via innerHTML
    await this.sendImmediate(GUIAction.UPDATE_PROPS, containerId, undefined, {
      innerHTML: "",
    });
    // 2. Mount each child sequentially
    for (const child of children) {
      await this.sendImmediate(GUIAction.MOUNT_NODE, containerId, child);
    }
  }

  // ============================================================
  // PUBLIC API — LIFECYCLE
  // ============================================================

  /**
   * close(): Hancurkan window.
   *
   * Kirim DESTROY_WINDOW, bersihkan handler, cegah memory leak.
   */
  public async close(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    // Flush pending changes dulu
    await this.flushNow();

    // Kirim DESTROY_WINDOW
    await this.sendImmediate(GUIAction.DESTROY_WINDOW);
    await this.notifyParentWindowEvent("GUI_WINDOW_CLOSED", { wid: this.wid });

    // Bersihkan handler (Piagam Antigonon Aturan 3)
    this.handlers.clear();
    this.vdom.clear();
    this.dirtyProps.clear();

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * minimize(): Sembunyikan window (iconify).
   * Window tetap hidup, bisa di-restore.
   */
  public async minimize(targetWid?: string): Promise<void> {
    this.ensureAlive();
    await this.sendGuiAction(targetWid || this.wid, GUIAction.MINIMIZE_WINDOW);
    await this.notifyParentWindowEvent("GUI_WINDOW_MINIMIZED", {
      wid: targetWid || this.wid,
    });
  }

  /**
   * restore(): Kembalikan window yang di-minimize.
   */
  public async restore(targetWid?: string): Promise<void> {
    this.ensureAlive();
    await this.sendGuiAction(targetWid || this.wid, GUIAction.RESTORE_WINDOW);
    await this.notifyParentWindowEvent("GUI_WINDOW_RESTORED", {
      wid: targetWid || this.wid,
    });
  }

  /**
   * maximize(): Perbesar window ke ukuran penuh viewport.
   */
  public async maximize(targetWid?: string): Promise<void> {
    this.ensureAlive();
    await this.sendGuiAction(targetWid || this.wid, GUIAction.MAXIMIZE_WINDOW);
    await this.notifyParentWindowEvent("GUI_WINDOW_MAXIMIZED", {
      wid: targetWid || this.wid,
    });
  }

  /**
   * unmaximize(): Kembalikan window dari state maximized ke ukuran sebelumnya.
   */
  public async unmaximize(targetWid?: string): Promise<void> {
    this.ensureAlive();
    await this.sendGuiAction(
      targetWid || this.wid,
      GUIAction.UNMAXIMIZE_WINDOW,
    );
    await this.notifyParentWindowEvent("GUI_WINDOW_UNMAXIMIZED", {
      wid: targetWid || this.wid,
    });
  }

  /**
   * sendGuiAction(): Kirim GUI action ke wid target tertentu.
   * Berguna untuk window manager yang mengontrol window aplikasi lain.
   */
  public async sendGuiAction(
    targetWid: string,
    action: GUIAction,
    targetId?: string,
    props?: Record<string, any>,
    node?: IDOMNode,
  ): Promise<any> {
    this.ensureAlive();
    return await this.sendImmediate(action, targetId, node, props, targetWid);
  }

  /**
   * flush(): Kirim semua UPDATE_PROPS yang tertunda sekarang juga.
   * Berguna setelah batch register onClick/onInput.
   */
  public async flush(): Promise<void> {
    await this.flushNow();
  }

  // ============================================================
  // PUBLIC API — RAW EVENT HANDLER (tanpa updateProps)
  // ============================================================

  /**
   * bindHandler(): Daftarkan handler event tanpa mengirim updateProps ke browser.
   * Berguna untuk elemen yang SUDAH memiliki listener dari mount props.
   *
   * @param targetId ID elemen
   * @param eventType "click" | "input" | "keydown"
   * @param callback Fungsi yang dipanggil saat event terjadi
   */
  public bindHandler(
    targetId: string,
    eventType: string,
    callback: (event: IGUIEventIPC) => void,
  ): void {
    this.registerHandler(targetId, eventType, callback);
  }

  // ============================================================
  // PRIVATE — Batching Engine
  // ============================================================

  /**
   * scheduleFlush(): Jadwalkan flush di akhir async tick.
   */
  private scheduleFlush(): void {
    if (this.batchPromise) return; // Sudah dijadwalkan

    this.batchPromise = new Promise<void>((resolve) => {
      this.batchTimer = setTimeout(async () => {
        await this.flushNow();
        resolve();
      }, 0); // 0ms = akhir tick ini
    });
  }

  /**
   * flushNow(): Kirim semua UPDATE_PROPS yang tertunda.
   */
  private async flushNow(): Promise<void> {
    if (this.dirtyProps.size === 0) return;

    const entries = Array.from(this.dirtyProps.entries());

    // Kirim satu per satu (atau bisa di-bundle nanti untuk optimasi)
    for (const [targetId, props] of entries) {
      await this.sendImmediate(
        GUIAction.UPDATE_PROPS,
        targetId,
        undefined,
        props,
      );
    }

    this.dirtyProps.clear();
    this.batchPromise = null;
    this.batchTimer = null;
  }

  /**
   * sendImmediate(): Kirim GUI_REQ langsung ke Kernel.
   */
  private async sendImmediate(
    action: GUIAction,
    targetId?: string,
    node?: IDOMNode,
    props?: Record<string, any>,
    targetWid?: string,
  ): Promise<any> {
    const payload: IGUIPayload = {
      syscall: "GUI_REQ",
      pid: this.pid,
      wid: targetWid || this.wid,
      action,
      targetId,
      node,
      props,
    };

    return await this._dispatch(SyscallCode.GUI_REQ, payload);
  }

  // ============================================================
  // PRIVATE — Event Handling
  // ============================================================

  private registerHandler(
    targetId: string,
    eventType: string,
    callback: (event: IGUIEventIPC) => void,
  ): void {
    if (!this.handlers.has(targetId)) {
      this.handlers.set(targetId, new Map());
    }
    this.handlers
      .get(targetId)!
      .set(eventType, { targetId, eventType, callback });
  }

  private setupEventListener(): void {
    const lib = (global as any)._tsixLib as UserLib;
    if (!lib) return;

    // gued mengirim event via shell.send() → SEND_MSG syscall → "ipc_message"
    lib.onEvent("ipc_message", (msg: any) => {
      // Unwrap: SEND_MSG membungkus data di { fromPid, fromUser, data }
      const event: IGUIEventIPC = msg?.data || msg;
      if (!event || event.type !== "GUI_EVENT") return;

      // Hanya proses event untuk window ini
      if (event.wid !== this.wid) return;

      const targetHandlers = this.handlers.get(event.targetId);
      if (targetHandlers) {
        const handler = targetHandlers.get(event.eventType);
        if (handler) {
          try {
            handler.callback(event);
          } catch (e) {
            console.error(
              `[@tsix/gui] Error in event handler for ${event.targetId}/${event.eventType}:`,
              e,
            );
          }
        }
      }

      // Lifecycle events from browser titlebar / parent requests
      if (
        event.eventType === "close_window" &&
        event.targetId === "__window__"
      ) {
        this.close().catch(() => {});
      } else if (
        event.eventType === "minimize_window" &&
        event.targetId === "__window__"
      ) {
        this.minimize(this.wid).catch(() => {});
      } else if (
        event.eventType === "restore_window" &&
        event.targetId === "__window__"
      ) {
        this.restore(this.wid).catch(() => {});
      } else if (
        event.eventType === "maximize_window" &&
        event.targetId === "__window__"
      ) {
        this.maximize(this.wid).catch(() => {});
      } else if (
        event.eventType === "unmaximize_window" &&
        event.targetId === "__window__"
      ) {
        this.unmaximize(this.wid).catch(() => {});
      }
    });
  }

  private async notifyParentWindowCreated(title: string): Promise<void> {
    await this.notifyParentWindowEvent("GUI_WINDOW_CREATED", {
      wid: this.wid,
      pid: this.pid,
      title,
    });
  }

  private async notifyParentWindowEvent(
    type: string,
    payload: Record<string, any>,
  ): Promise<void> {
    if (!this.lib?.shell?.send) return;
    try {
      const parentPid = await this.lib.getParentPid();
      if (!parentPid) return;
      await this.lib.shell.send(parentPid, {
        type,
        ...payload,
      });
    } catch (e) {
      // Ignore parent notification failures; window still works.
    }

    // Juga kirim ke Asteracea WM (untuk aplikasi yang di-run via terminal/shell)
    // Baca PID Asteracea dari file yang ditulis saat WM startup.
    try {
      const wmPidRaw = await this.lib.fs.readFile("/opt/asteracea/wm-pid");
      if (wmPidRaw) {
        const wmPid = parseInt(wmPidRaw.trim());
        const myPid = this.lib.getPid();
        if (wmPid && wmPid !== myPid) {
          // Hanya kirim jika belom dikirim ke parent di atas
          try {
            const ppid = await this.lib.getParentPid();
            if (wmPid !== ppid) {
              await this.lib.shell.send(wmPid, { type, ...payload });
            }
          } catch (_) {
            await this.lib.shell.send(wmPid, { type, ...payload });
          }
        }
      }
    } catch (_) {
      // Asteracea tidak running, no-op
    }
  }

  private ensureAlive(): void {
    if (this.destroyed) {
      throw new Error(`@tsix/gui: Window '${this.wid}' has been destroyed.`);
    }
  }

  /**
   * confirm(): Tampilkan dialog konfirmasi dengan beberapa tombol.
   * Returns label tombol yang diklik user.
   *
   * Usage:
   *   const ans = await win.confirm("Trust aplikasi ini?", "pesan", ["✅ Ya", "🚫 Tidak"]);
   *   if (ans === "✅ Ya") { ... }
   */
  public async confirm(
    title: string,
    message: string,
    buttons: string[] = ["OK", "Cancel"],
  ): Promise<string> {
    const overlayId = `__confirm_overlay_${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    const btnsId = `${overlayId}_btns`;

    const btnStyle = (isPrimary: boolean) => ({
      background: isPrimary ? "var(--accent, #4caf50)" : "transparent",
      color: isPrimary ? "white" : "var(--text-muted, #888)",
      border: isPrimary
        ? "none"
        : "1px solid var(--border, rgba(255,255,255,0.12))",
      padding: "8px 20px",
      borderRadius: "6px",
      cursor: "pointer",
      fontSize: "13px",
      fontWeight: "600",
      margin: "0 4px",
    });

    const btnNodes: IDOMNode[] = buttons.map((label, i) => {
      const id = `${btnsId}_${i}`;
      return button({
        id,
        text: label,
        style: btnStyle(i === 0),
        onClickId: id,
      });
    });

    // Mount overlay
    await this.mount(
      div(
        {
          id: overlayId,
          style: {
            position: "absolute",
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            background: "rgba(0,0,0,0.05)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "9999",
            pointerEvents: "auto", // overlay layer global pointerEvents none
          },
        },
        div(
          {
            id: `${overlayId}_box`,
            style: {
              background: "var(--surface, #16213e)",
              border: "1px solid var(--accent, #4caf50)",
              borderRadius: "12px",
              padding: "32px",
              minWidth: "300px",
              maxWidth: "420px",
              textAlign: "center",
              boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
              pointerEvents: "auto",
            },
          },
          span({
            id: `${overlayId}_icon`,
            text: "⚠️",
            style: {
              fontSize: "40px",
              display: "block",
              marginBottom: "10px",
            },
          }),
          h2({
            id: `${overlayId}_title`,
            text: title,
            style: {
              color: "var(--text, #e0e0e0)",
              fontSize: "18px",
              marginBottom: "6px",
            },
          }),
          paragraph({
            id: `${overlayId}_msg`,
            text: message || "",
            style: {
              color: "var(--text-dim, #ccc)",
              fontSize: "13px",
              marginBottom: "20px",
              whiteSpace: "pre-wrap",
            },
          }),
          div(
            {
              id: btnsId,
              style: { display: "flex", justifyContent: "center", gap: "4px" },
            },
            ...btnNodes,
          ),
        ),
      ),
      // Mount ke overlay layer global (di atas SEMUA window, z-index tertinggi)
      "launcher-overlay",
    );

    // Wait for any button click
    return new Promise<string>((resolve) => {
      for (let i = 0; i < buttons.length; i++) {
        const label = buttons[i];
        const btnId = `${btnsId}_${i}`;
        this.onClick(btnId, async () => {
          try {
            await this.unmount(overlayId);
          } catch (e) {
            /* ignore */
          }
          resolve(label);
        });
      }
      void this.flush();
    });
  }

  /**
   * alert(): Tampilkan modal dialog dengan pesan dan tombol OK.
   * Returns Promise yang resolve saat user klik OK.
   *
   * Usage:
   *   await win.alert("File berhasil disimpan!");
   *   await win.alert("Error!", "Gagal menyimpan file.");
   */
  public async alert(title: string, message?: string): Promise<void> {
    const suffix = Math.random().toString(36).slice(2, 7);
    const overlayId = `__alert_overlay_${suffix}`;
    const btnId = `${overlayId}_btn`;

    await this.mount(
      div(
        {
          id: overlayId,
          style: {
            position: "absolute",
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            background: "rgba(0,0,0,0.05)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "9999",
            pointerEvents: "auto", // overlay layer global pointerEvents none
          },
        },
        div(
          {
            id: `${overlayId}_box`,
            style: {
              background: "var(--surface, #16213e)",
              border: "1px solid var(--accent, #4caf50)",
              borderRadius: "12px",
              padding: "32px",
              minWidth: "280px",
              maxWidth: "400px",
              textAlign: "center",
              boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
              pointerEvents: "auto",
            },
          },
          span({
            id: `${overlayId}_icon`,
            text: "💬",
            style: { fontSize: "40px", display: "block", marginBottom: "10px" },
          }),
          h2({
            id: `${overlayId}_title`,
            text: title || "Info",
            style: {
              color: "var(--text, #e0e0e0)",
              fontSize: "18px",
              marginBottom: "6px",
            },
          }),
          paragraph({
            id: `${overlayId}_msg`,
            text: message || "",
            style: {
              color: "var(--text-dim, #ccc)",
              fontSize: "13px",
              marginBottom: "20px",
              textAlign: "left",
              whiteSpace: "pre-wrap",
            },
          }),
          button({
            id: btnId,
            text: "OK",
            style: {
              background: "var(--accent, #4caf50)",
              color: "white",
              border: "none",
              padding: "8px 36px",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "14px",
              fontWeight: "600",
            },
          }),
        ),
      ),
      // Mount ke overlay layer global (di atas SEMUA window, z-index tertinggi)
      "launcher-overlay",
    );

    return new Promise<void>((resolve) => {
      this.onClick(btnId, async () => {
        try {
          await this.unmount(overlayId);
        } catch (e) {
          /* ignore */
        }
        resolve();
      });
      void this.flush();
    });
  }

  /**
   * question(): Tampilkan modal dialog dengan input field.
   * Returns value yang diinput user, atau null jika Cancel.
   *
   * Usage:
   *   const nama = await win.question("Rename File", "Nama baru:", "default.txt");
   *   if (nama !== null) { await rename(nama); }
   */
  public async question(
    title: string,
    message: string,
    defaultValue: string = "",
  ): Promise<string | null> {
    const suffix = Math.random().toString(36).slice(2, 7);
    const overlayId = `__question_overlay_${suffix}`;
    const btnOkId = `${overlayId}_ok`;
    const btnCancelId = `${overlayId}_cancel`;
    const inputId = `${overlayId}_input`;

    let resultValue = defaultValue;

    await this.mount(
      div(
        {
          id: overlayId,
          style: {
            position: "absolute",
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            background: "rgba(0,0,0,0.05)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "9999",
            pointerEvents: "auto", // overlay layer global pointerEvents none
          },
        },
        div(
          {
            id: `${overlayId}_box`,
            style: {
              background: "var(--surface, #16213e)",
              border: "1px solid var(--accent, #4caf50)",
              borderRadius: "12px",
              padding: "32px",
              minWidth: "320px",
              maxWidth: "420px",
              boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
              pointerEvents: "auto",
            },
          },
          span({
            id: `${overlayId}_icon`,
            text: "✏️",
            style: {
              fontSize: "40px",
              display: "block",
              marginBottom: "10px",
              textAlign: "center",
            },
          }),
          h2({
            id: `${overlayId}_title`,
            text: title,
            style: {
              color: "var(--text, #e0e0e0)",
              fontSize: "18px",
              marginBottom: "6px",
            },
          }),
          paragraph({
            id: `${overlayId}_msg`,
            text: message || "",
            style: {
              color: "var(--text-dim, #ccc)",
              fontSize: "13px",
              marginBottom: "16px",
            },
          }),
          input({
            id: inputId,
            type: "text",
            value: defaultValue,
            onInputId: inputId,
            onKeydownId: inputId,
            style: {
              width: "100%",
              padding: "8px 12px",
              fontSize: "14px",
              background: "var(--input-bg, rgba(255,255,255,0.06))",
              color: "var(--text, #e0e0e0)",
              border: "1px solid var(--border, rgba(255,255,255,0.12))",
              borderRadius: "6px",
              marginBottom: "20px",
              outline: "none",
            },
          }),
          div(
            {
              id: `${overlayId}_btns`,
              style: {
                display: "flex",
                justifyContent: "flex-end",
                gap: "8px",
              },
            },
            button({
              id: btnCancelId,
              text: "Cancel",
              style: {
                background: "transparent",
                color: "var(--text-muted, #888)",
                border: "1px solid var(--border, rgba(255,255,255,0.12))",
                padding: "8px 20px",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: "600",
              },
            }),
            button({
              id: btnOkId,
              text: "OK",
              style: {
                background: "var(--accent, #4caf50)",
                color: "white",
                border: "none",
                padding: "8px 24px",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: "600",
              },
            }),
          ),
        ),
      ),
      // Mount ke overlay layer global (di atas SEMUA window, z-index tertinggi)
      "launcher-overlay",
    );

    return new Promise<string | null>((resolve) => {
      this.bindHandler(inputId, "input", (ev: any) => {
        if (ev.value !== undefined) resultValue = String(ev.value);
      });
      this.bindHandler(inputId, "keydown", (ev: any) => {
        if (ev.value === "Enter") {
          this.unmount(overlayId).catch(() => {});
          resolve(resultValue);
        }
      });
      this.onClick(btnOkId, async () => {
        try {
          await this.unmount(overlayId);
        } catch (_) {}
        resolve(resultValue);
      });
      this.onClick(btnCancelId, async () => {
        try {
          await this.unmount(overlayId);
        } catch (_) {}
        resolve(null);
      });
      void this.flush();
    });
  }
}

// ============================================================
// SCREEN — High-level GUI helper (no more mount/unmount pain)
// ============================================================

/**
 * Screen adalah wrapper tingkat tinggi untuk Window.
 * Handle mount, setContent, event binding, dan flush otomatis.
 *
 * Usage (object-based, recommended):
 *   const app = new Screen({ title: "My App", width: 800, height: 600 });
 *   await app.mount(div({id:"root"}, ...));       // mount ke window
 *   await app.on("btn-ok", "click", () => { ... }); // bind event
 *   await app.setContent("list", ...children);     // clear + isi ulang
 *   await app.loopUntilClose();                     // stay alive
 *
 * Usage (positional, legacy):
 *   const app = new Screen("My App", undefined, false, 800, 600);
 */
export interface ScreenOptions {
  title: string;
  /** Ikon/emoji yang tampil di kiri judul title bar (opsional) */
  icon?: string;
  lib?: UserLib;
  fullscreen?: boolean;
  width?: number;
  height?: number;
  resizable?: boolean;
  frameless?: boolean;
  maximizable?: boolean;
  /** Posisi X window di desktop (opsional) */
  left?: number;
  /** Posisi Y window di desktop (opsional) */
  top?: number;
  /** Tengahkan window di desktop — menimpa left/top (default: false) */
  desktopCentered?: boolean;
}

export class Screen {
  public readonly win: Window;
  public running: boolean = true;
  private _state: Record<string, any> = {};
  private _timers: ReturnType<typeof setInterval>[] = [];

  constructor(opts: ScreenOptions);
  constructor(
    title: string,
    lib?: UserLib,
    fullscreen?: boolean,
    width?: number,
    height?: number,
    resizable?: boolean,
    frameless?: boolean,
    maximizable?: boolean,
  );
  constructor(
    titleOrOpts: string | ScreenOptions,
    lib?: UserLib,
    fullscreen = false,
    width?: number,
    height?: number,
    resizable = true,
    frameless = false,
    maximizable = true,
  ) {
    if (
      typeof titleOrOpts === "object" &&
      titleOrOpts !== null &&
      "title" in titleOrOpts
    ) {
      const opts = titleOrOpts as ScreenOptions;
      const {
        title,
        icon: ic = undefined,
        lib: l,
        fullscreen: fs = false,
        width: w,
        height: h,
        resizable: rz = true,
        frameless: fl = false,
        maximizable: mx = true,
        left: lx,
        top: ty,
        desktopCentered: dc = false,
      } = opts;
      this.win = new Window({
        title,
        icon: ic,
        lib: l,
        fullscreen: fs,
        width: w,
        height: h,
        frameless: fl,
        maximizable: mx,
        resizable: rz,
        left: lx,
        top: ty,
        desktopCentered: dc,
      });
    } else {
      this.win = new Window(
        titleOrOpts as string,
        lib,
        fullscreen,
        width,
        height,
        frameless,
        maximizable,
        resizable,
      );
    }
  }

  /** Dapatkan Window ID */
  get wid(): string {
    return this.win.wid;
  }

  // ============================================================
  // STATE
  // ============================================================
  get state(): Record<string, any> {
    return this._state;
  }
  setState(patch: Record<string, any>) {
    Object.assign(this._state, patch);
  }

  // ============================================================
  // MANAGED TIMERS — auto-clear on close, no leak
  // ============================================================
  setInterval(cb: () => void, ms: number): ReturnType<typeof setInterval> {
    const id = setInterval(() => {
      if (this.running) cb();
    }, ms);
    this._timers.push(id);
    return id;
  }
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => {
      if (this.running) cb();
    }, ms);
    this._timers.push(id);
    return id;
  }

  // ============================================================
  // MOUNT — pasang node ke window (tanpa targetId = root)
  // ============================================================
  async mount(node: IDOMNode, parentId?: string) {
    return this.win.mount(node, parentId);
  }

  // ============================================================
  // SET CONTENT — clear container + isi ulang (no numpuk!)
  // ============================================================
  async setContent(containerId: string, ...children: IDOMNode[]) {
    return this.win.setContent(containerId, ...children);
  }

  // ============================================================
  // ON — bind event handler (auto-flush)
  // ============================================================
  async on(
    targetId: string,
    event: "click" | "input" | "keydown" | "close",
    cb: (ev: IGUIEventIPC) => void,
  ) {
    if (event === "click") this.win.onClick(targetId, cb);
    else if (event === "input") this.win.onInput(targetId, cb);
    else if (event === "keydown") this.win.onKeydown(targetId, cb);
    else if (event === "close") this.win.onClose(cb);
    await this.win.flush();
  }

  // ============================================================
  // UPDATE — update props on an element
  // ============================================================
  async update(targetId: string, props: Record<string, any>) {
    return this.win.updateProps(targetId, props);
  }

  // ============================================================
  // VISIBILITY — show/hide elements (convenience wrapper)
  // ============================================================
  /** Singkatnya: app.setVisible("btn-disconnect", true/false) */
  async setVisible(targetId: string, visible: boolean) {
    return this.win.updateProps(targetId, {
      style: { display: visible ? "" : "none" },
    });
  }

  /** Singkatnya: app.setEnabled("btn-send", true/false) */
  async setEnabled(targetId: string, enabled: boolean) {
    if (enabled) {
      return this.win.updateProps(targetId, { disabled: undefined });
    } else {
      return this.win.updateProps(targetId, { disabled: "" });
    }
  }

  // ============================================================
  // LOOP — stay alive sampai window ditutup atau running=false
  // ============================================================
  async loopUntilClose() {
    this.win.onClose(() => {
      this.running = false;
    });
    while (this.running) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    await this.win.close();
  }

  /** Tutup screen */
  async close() {
    this.running = false;
    for (const id of this._timers) clearInterval(id);
    this._timers = [];
    await this.win.close();
  }

  // ============================================================
  // CONVENIENCE HELPERS — No more copy-paste style objects!
  // ============================================================

  /** Sembunyikan elemen */
  async hide(targetId: string) {
    return this.update(targetId, { style: { display: "none" } });
  }

  /** Tampilkan elemen */
  async show(targetId: string, display: string = "block") {
    return this.update(targetId, { style: { display } });
  }

  /** Disable elemen */
  async disable(targetId: string) {
    return this.update(targetId, { disabled: "" });
  }

  /** Enable elemen */
  async enable(targetId: string) {
    return this.update(targetId, { disabled: undefined });
  }

  /** Update text shortcut */
  async setText(targetId: string, text: string) {
    return this.update(targetId, { text });
  }

  /** Update style shortcut (merge, gak replace!) */
  async setStyle(targetId: string, style: Record<string, any>) {
    return this.update(targetId, { style });
  }

  /**
   * Kirim desktop notification ke Asteracea WM.
   * Gak perlu kirim UUID manual — cukup panggil ini dari app manapun.
   *
   * Usage:
   *   await app.notifyDesktop("🔥 Alert", "Temperature above threshold!");
   *   await app.notifyDesktop("✅ Done", "File berhasil disalin.");
   */
  async notifyDesktop(title: string, message: string) {
    try {
      const shell = (global as any)._tsixLib?.shell;
      if (!shell?.send) return;
      const AST_UUID = "3ec3ffe9-e0a6-411f-b7e3-c9ff0b00556c";
      await shell.send(AST_UUID, {
        type: "DESKTOP_NOTIF",
        title,
        message,
        timestamp: Date.now(),
      });
    } catch (_) {
      /* Asteracea might not be running */
    }
  }

  /** Minimize window */
  async minimize() {
    return this.win.minimize();
  }
  /** Restore window */
  async restore() {
    return this.win.restore();
  }
  /** Maximize window */
  async maximize() {
    return this.win.maximize();
  }
  /** Unmaximize window */
  async unmaximize() {
    return this.win.unmaximize();
  }

  // ============================================================
  // IMAGE — update image src dari file path
  // ============================================================
  /**
   *
   * @param fsLib
   * @param elementId
   * @param filePath
   *
   * Usage: await app.updateImageFromFile(fs, "img1", "/path/to/image.jpg");
   */

  async updateImageFromFile(fsLib: any, elementId: string, filePath: string) {
    const raw = await fsLib.readFile(filePath);
    if (!raw) {
      throw new Error(`[img2b64] ❌ Cannot read: ${filePath}`);
    } else {
      // Convert ke base64 via Node.js Buffer
      const b64Content = Buffer.from(raw, "latin1").toString("base64");
      await this.update(elementId, {
        src: `data:image/jpeg;base64,${b64Content}`,
      });
    }
  }

  // ============================================================
  // ALERT / MODAL — tampilkan pesan popup dengan OK button
  // ============================================================
  /**
   * alert(): Tampilkan modal dialog dengan pesan dan tombol OK.
   * Returns Promise yang resolve saat user klik OK.
   *
   * Usage:
   *   await app.alert("File berhasil disimpan!");
   *   await app.alert("Error!", "Gagal menyimpan file.");
   */
  async alert(title: string, message?: string): Promise<void> {
    // Delegasi ke Window.alert — implementasi ada di level Window.
    return await this.win.alert(title, message);
  }

  /**
   * confirm(): Tampilkan dialog konfirmasi dengan beberapa tombol.
   * Returns label tombol yang diklik user.
   *
   * Usage:
   *   const ans = await app.confirm("Hapus file?", "Data tidak bisa dikembalikan.", ["Yes", "No"]);
   *   if (ans === "Yes") { ... }
   *
   *   const ans = await app.confirm("Simpan perubahan?", "", ["Yes", "No", "Cancel"]);
   */
  async confirm(
    title: string,
    message: string,
    buttons: string[] = ["OK", "Cancel"],
  ): Promise<string> {
    // Delegasi ke Window.confirm — implementasi dialog ada di level Window
    // (bisa dipakai siapa pun yang punya Window, termasuk Asteracea WM).
    return await this.win.confirm(title, message, buttons);
  }

  // ============================================================
  // QUESTION DIALOG — input field dengan OK/Cancel
  // ============================================================
  /**
   * question(): Tampilkan modal dialog dengan input field.
   * Returns value yang diinput user, atau null jika Cancel.
   *
   * Usage:
   *   const nama = await app.question("Rename File", "Nama baru:", "default.txt");
   *   if (nama !== null) { await rename(nama); }
   */
  async question(
    title: string,
    message: string,
    defaultValue: string = "",
  ): Promise<string | null> {
    // Delegasi ke Window.question — implementasi dialog ada di level Window.
    return await this.win.question(title, message, defaultValue);
  }

  // ============================================================
  // FILE DIALOGS — Open & Save File
  // ============================================================

  /**
   * FSDialogResult: Return type untuk openFileDialog & saveFileDialog.
   * null  → user tekan Cancel
   * object → user pilih file
   */
  async openFileDialog(
    fs: any,
    opts?: { title?: string; startDir?: string; filter?: string[] },
  ): Promise<{ path: string; filename: string; directory: string } | null> {
    // File dialog tetap di Screen (implementasi `_fileDialog` di sini).
    return this._fileDialog(fs, "open", opts);
  }

  async saveFileDialog(
    fs: any,
    opts?: { title?: string; startDir?: string; defaultName?: string },
  ): Promise<{ path: string; filename: string; directory: string } | null> {
    // File dialog tetap di Screen (implementasi `_fileDialog` di sini).
    return this._fileDialog(fs, "save", opts);
  }

  private async _fileDialog(
    fs: any,
    mode: "open" | "save",
    opts?: {
      title?: string;
      startDir?: string;
      filter?: string[];
      defaultName?: string;
    },
  ): Promise<{ path: string; filename: string; directory: string } | null> {
    const title =
      opts?.title || (mode === "open" ? "📂 Open File" : "💾 Save File");
    const startDir =
      opts?.startDir ||
      (await (async () => {
        try {
          const lib = (global as any)._tsixLib;
          return (await lib?.shell?.getenv("HOME")) || "/";
        } catch {
          return "/";
        }
      })());
    const filter = opts?.filter || [];
    const defaultName = opts?.defaultName || "";

    const pf = mode === "open" ? "__ofd_" : "__sfd_";
    const overlayId = pf + "overlay";
    const isWebkit =
      typeof CSS !== "undefined" &&
      CSS.supports?.("backdrop-filter", "blur(1px)")
        ? false
        : true;
    const treeBoxId = pf + "tree";
    const fileListId = pf + "list";
    const pathBarId = pf + "path";
    const fnameInputId = pf + "fname";
    const btnOkId = pf + "btn_ok";
    const btnCancelId = pf + "btn_cancel";
    const statusId = pf + "status";

    let currentDir = startDir;
    let selectedFile = mode === "save" && defaultName ? defaultName : "";
    let entries: any[] = [];

    const icon = (e: any) => (e.type === "DIRECTORY" ? "📁" : "📄");
    const sz = (e: any) => {
      if (e.type === "DIRECTORY") return "<DIR>";
      const s = e.size || 0;
      return s < 1024
        ? s + " B"
        : s < 1048576
          ? (s / 1024).toFixed(1) + " KB"
          : (s / 1048576).toFixed(1) + " MB";
    };

    const getStyle = (key: string, ...args: any[]): Record<string, any> => {
      const styles: Record<string, Record<string, any>> = {
        overlay: {
          position: "absolute",
          top: "0",
          left: "0",
          right: "0",
          bottom: "0",
          background: "rgba(0,0,0,0.05)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: "9999",
          pointerEvents: "auto", // overlay layer global pointerEvents none
        },
        box: {
          background: "var(--bg, #0d1b2a)",
          border: "1px solid var(--accent, #4caf50)",
          borderRadius: "12px",
          width: "680px",
          height: "520px",
          maxHeight: "520px",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 12px 48px rgba(0,0,0,0.7)",
          overflow: "hidden",
          pointerEvents: "auto",
        },
        header: {
          padding: "12px 16px",
          borderBottom: "1px solid var(--border, rgba(255,255,255,0.12))",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        },
        body: {
          display: "flex",
          flex: "1",
          overflow: "hidden",
          minHeight: "0",
        },
        treePanel: {
          width: "200px",
          minWidth: "160px",
          borderRight: "1px solid var(--border, rgba(255,255,255,0.12))",
          overflowY: "auto",
          padding: "6px",
          background: "var(--button-bg, #0f3460)",
        },
        filePanel: {
          flex: "1",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        },
        fileList: { flex: "1", overflowY: "auto", padding: "4px" },
        footer: {
          padding: "10px 16px",
          borderTop: "1px solid var(--border, rgba(255,255,255,0.12))",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        },
        btnOk: {
          background: "var(--accent, #4caf50)",
          color: "white",
          border: "none",
          padding: "6px 20px",
          borderRadius: "6px",
          cursor: "pointer",
          fontSize: "12px",
          fontWeight: "600",
        },
        btnCancel: {
          background: "transparent",
          color: "var(--text-muted, #888)",
          border: "1px solid var(--border, rgba(255,255,255,0.12))",
          padding: "6px 16px",
          borderRadius: "6px",
          cursor: "pointer",
          fontSize: "12px",
        },
        treeItem: {
          padding: "2px " + (args[0] * 12 + 4) + "px",
          fontSize: "13px",
          cursor: "pointer",
          color: args[1] ? "var(--accent, #4caf50)" : "var(--text-dim, #ccc)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        },
        fileRow: {
          display: "flex",
          alignItems: "center",
          padding: "3px 8px",
          background: args[0]
            ? "var(--accent-bg, rgba(76,175,80,0.15))"
            : "transparent",
          borderRadius: "4px",
          marginBottom: "1px",
          cursor: "pointer",
          fontSize: "12px",
          fontFamily: "monospace",
          color: args[1] ? "var(--accent, #4caf50)" : "var(--text, #e0e0e0)",
        },
        pathBar: {
          padding: "6px 10px",
          borderBottom: "1px solid var(--border, rgba(255,255,255,0.12))",
          fontSize: "11px",
          fontFamily: "monospace",
          color: "var(--text-dim, #ccc)",
          background: "var(--button-bg, #0f3460)",
        },
      };
      return styles[key] || {};
    };

    const self = this;

    // ---- BUILD UI ----
    await this.mount(
      div(
        { id: overlayId, style: getStyle("overlay") },
        div(
          { id: pf + "box", style: getStyle("box") },
          div(
            { style: getStyle("header") },
            h3({
              text: title,
              style: {
                margin: "0",
                fontSize: "15px",
                color: theme.colors.accent,
              },
            }),
          ),
          div(
            { style: getStyle("body") },
            div({ id: treeBoxId, style: getStyle("treePanel") }),
            div(
              { style: getStyle("filePanel") },
              div(
                { style: getStyle("pathBar") },
                span({ id: pathBarId, text: "📂 " + (currentDir || "/") }),
              ),
              div({ id: fileListId, style: getStyle("fileList") }),
            ),
          ),
          div(
            { style: getStyle("footer") },
            mode === "save"
              ? input({
                  id: fnameInputId,
                  type: "text",
                  value: defaultName,
                  placeholder: "Nama file...",
                  style: {
                    flex: "1",
                    padding: "5px 8px",
                    fontSize: "12px",
                    background: theme.colors.inputBg,
                    color: theme.colors.text,
                    border: `1px solid ${theme.colors.inputBorder}`,
                    borderRadius: "4px",
                  },
                })
              : span({
                  id: statusId,
                  text: "",
                  style: {
                    flex: "1",
                    fontSize: "11px",
                    color: "#888",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  },
                }),
            span({ style: { flex: "1" } }),
            button({
              id: btnOkId,
              text: mode === "open" ? "📂 Open" : "💾 Save",
              style: getStyle("btnOk"),
            }),
            button({
              id: btnCancelId,
              text: "Cancel",
              style: getStyle("btnCancel"),
            }),
          ),
        ),
      ),
    );

    // ---- REFRESH FILE LIST ----
    async function refreshFileList() {
      await self.update(pathBarId, { text: "📂 " + (currentDir || "/") });
      try {
        entries = (await fs.ls(currentDir)) || [];
        entries.sort((a: any, b: any) => {
          if (a.type !== b.type) return a.type === "DIRECTORY" ? -1 : 1;
          return (a.name || "").localeCompare(b.name || "");
        });
      } catch (e: any) {
        entries = [];
        await self.update(statusId, { text: "⚠️ " + (e.message || "Error") });
      }
      if (filter.length > 0 && mode === "open") {
        entries = entries.filter(
          (e: any) =>
            e.type === "DIRECTORY" ||
            filter.some((ext: string) =>
              (e.name || "").toLowerCase().endsWith(ext.toLowerCase()),
            ),
        );
      }
      const rows: IDOMNode[] = [];
      if (currentDir !== "/") {
        rows.push(
          div(
            { id: pf + "up", style: getStyle("fileRow", false, true) },
            span({ text: "📁 ..", style: { flex: "1", fontWeight: "700" } }),
          ),
        );
      }
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const rid = pf + "frow_" + i;
        const isSel = e.name === selectedFile && e.type !== "DIRECTORY";
        rows.push(
          div(
            {
              id: rid,
              style: getStyle("fileRow", isSel, e.type === "DIRECTORY"),
            },
            span({ text: icon(e) + " " + e.name, style: { flex: "1" } }),
            span({
              text: sz(e),
              style: {
                color: theme.colors.textMuted,
                fontSize: "10px",
                marginLeft: "8px",
              },
            }),
          ),
        );
      }
      await self.setContent(fileListId, ...rows);
      // Bind clicks
      if (currentDir !== "/") {
        await self.on(pf + "up", "click", async () => {
          const parts = currentDir.replace(/\/$/, "").split("/");
          parts.pop();
          currentDir = parts.join("/") || "/";
          selectedFile = "";
          await refreshFileList();
        });
      }
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const rid = pf + "frow_" + i;
        await self.on(rid, "click", async () => {
          if (e.type === "DIRECTORY") {
            currentDir = currentDir.replace(/\/$/, "") + "/" + e.name;
            selectedFile = "";
            await refreshFileList();
          } else {
            selectedFile = e.name;
            if (mode === "save") {
              await self.update(fnameInputId, { value: e.name });
            }
            await refreshFileList();
          }
        });
      }
    }

    // ---- REFRESH TREE (collapsed by default) ----
    const expandedNodes = new Set<string>();

    async function refreshTree() {
      const items: IDOMNode[] = [];
      const rootExpanded = expandedNodes.has("/");

      // Root
      items.push(
        div(
          {
            id: pf + "tree_root",
            style: getStyle("treeItem", 0, currentDir === "/"),
          },
          span({ text: (rootExpanded ? "📂" : "📁") + " /" }),
        ),
      );

      // Render expanded branches
      async function renderChildren(dir: string, depth: number) {
        if (depth > 8) return;
        try {
          const l = (await fs.ls(dir)) || [];
          for (const d of l
            .filter((e: any) => e.type === "DIRECTORY")
            .sort((a: any, b: any) =>
              (a.name || "").localeCompare(b.name || ""),
            )) {
            const fp = dir.replace(/\/$/, "") + "/" + d.name;
            const tid = pf + "tree_" + fp.replace(/\//g, "_");
            const exp = expandedNodes.has(fp);
            items.push(
              div(
                {
                  id: tid,
                  style: getStyle("treeItem", depth, currentDir === fp),
                },
                span({ text: (exp ? "📂" : "📁") + " " + d.name }),
              ),
            );
            if (exp) await renderChildren(fp, depth + 1);
          }
        } catch (e) {
          /* skip */
        }
      }
      if (rootExpanded) await renderChildren("/", 1);

      await self.setContent(treeBoxId, ...items);

      // Bind root click — toggle expand
      await self.on(pf + "tree_root", "click", async () => {
        currentDir = "/";
        selectedFile = "";
        if (expandedNodes.has("/")) expandedNodes.delete("/");
        else expandedNodes.add("/");
        await refreshFileList();
        await refreshTree();
      });

      // Bind directory toggles
      async function bindToggles(dir: string, depth: number) {
        if (depth > 8) return;
        try {
          const l = (await fs.ls(dir)) || [];
          for (const d of l
            .filter((e: any) => e.type === "DIRECTORY")
            .sort((a: any, b: any) =>
              (a.name || "").localeCompare(b.name || ""),
            )) {
            const fp = dir.replace(/\/$/, "") + "/" + d.name;
            const tid = pf + "tree_" + fp.replace(/\//g, "_");
            await self.on(tid, "click", async () => {
              currentDir = fp;
              selectedFile = "";
              if (expandedNodes.has(fp)) expandedNodes.delete(fp);
              else expandedNodes.add(fp);
              await refreshFileList();
              await refreshTree();
            });
            if (expandedNodes.has(fp)) await bindToggles(fp, depth + 1);
          }
        } catch (e) {
          /* skip */
        }
      }
      await bindToggles("/", 1);
    }

    // ---- INIT ----
    // Expand root by default so user sees top-level dirs immediately
    expandedNodes.add("/");
    await refreshFileList();
    await refreshTree();

    if (mode === "save") {
      await this.on(fnameInputId, "input", (ev: any) => {
        if (ev.value !== undefined) selectedFile = String(ev.value);
      });
    }

    // ---- RESULT ----
    return new Promise<{
      path: string;
      filename: string;
      directory: string;
    } | null>(async (resolve) => {
      await this.on(btnOkId, "click", async () => {
        const fname = selectedFile;
        if (!fname) {
          await self.update(statusId, {
            text: "⚠️ Pilih atau ketik nama file!",
          });
          return;
        }
        const fullPath = currentDir.replace(/\/$/, "") + "/" + fname;
        try {
          await this.win.unmount(overlayId);
        } catch (e) {
          /* ignore */
        }
        resolve({
          path: fullPath,
          filename: fname,
          directory: currentDir.replace(/\/$/, ""),
        });
      });
      await this.on(btnCancelId, "click", async () => {
        try {
          await this.win.unmount(overlayId);
        } catch (e) {
          /* ignore */
        }
        resolve(null);
      });
    });
  }
}

// ============================================================
// KEYBOARD — event handler keyboard global (saat window AKTIF)
// ------------------------------------------------------------
// Komponen reusable utk baca keyboard di aplikasi GUI. Fokus
// dikelola otomatis oleh DOME di browser (pola DDC):
//   - Saat attach() → elemen penangkap tersembunyi di-fokus,
//     jadi panah/spasi langsung kedengaran tanpa klik dulu.
//   - Saat user klik di mana pun DALAM window → fokus kembali ke
//     penangkap (kecuali klik di input teks), jadi keyboard tetap
//     jalan selama window aktif.
//   - Klik di luar window → fokus pindah → keyboard mati otomatis.
//
// Pemakaian:
//   import { Keyboard } from "@tsix/emerald";
//   const kb = new Keyboard(app.win);
//   kb.on((e) => {
//     if (!e.down || e.repeat) return;      // sekali per tekan
//     if (e.key === "ArrowDown") ...
//   });
//   await kb.attach();
//   await app.loopUntilClose();
//   await kb.detach();
// ============================================================
export interface IGUIKeyEvent {
  /** Nama tombol (e.key): "ArrowDown", "a", "Enter", dst. */
  key: string;
  /** Kode fisik (e.code): "ArrowDown", "KeyA", "Enter", dst. */
  code: string;
  /** true = keydown, false = keyup. */
  down: boolean;
  /** true jika tombol ditahan (auto-repeat). */
  repeat: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export interface KeyboardOptions {
  /** ID elemen penangkap (default: "__kb_capture__"). */
  targetId?: string;
}

export class Keyboard {
  public readonly targetId: string;
  private win: Window;
  private attached = false;
  private listeners = new Set<(ev: IGUIKeyEvent) => void>();

  constructor(win: Window, opts: KeyboardOptions = {}) {
    this.win = win;
    this.targetId = opts.targetId || "__kb_capture__";
  }

  /** Daftarkan listener. Kembalikan fungsi untuk menghapus. */
  on(cb: (ev: IGUIKeyEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Hapus semua listener. */
  clear(): void {
    this.listeners.clear();
  }

  get isAttached(): boolean {
    return this.attached;
  }

  /**
   * Pasang komponen: mount elemen penangkap tersembunyi, bind handler,
   * lalu minta DOME fokus + kelola fokus. Aman dipanggil berulang.
   */
  async attach(): Promise<void> {
    if (this.attached) return;
    this.attached = true;

    // Elemen penangkap — tak terlihat, focusable via JS, tak intercept klik.
    await this.win.mount(
      div({
        id: this.targetId,
        tabIndex: "-1",
        onKbId: this.targetId,
        style: {
          position: "absolute",
          width: "1px",
          height: "1px",
          opacity: "0",
          pointerEvents: "none",
          outline: "none",
          overflow: "hidden",
        },
      }),
    );

    // Event "kb_key" dari browser: { key, code, down, repeat, ctrl, shift, alt }
    this.win.bindHandler(this.targetId, "kb_key", (ev: any) =>
      this.dispatch(ev),
    );
    await this.win.flush();

    // Minta DOME: fokus penangkap + refokus saat mousedown di window.
    await this.sendCapture("KEYBOARD_ATTACH");
  }

  /** Lepas komponen: berhenti kelola fokus + unmount elemen penangkap. */
  async detach(): Promise<void> {
    if (!this.attached) return;
    this.attached = false;
    await this.sendCapture("KEYBOARD_DETACH");
    try {
      await this.win.unmount(this.targetId);
    } catch (_) {
      /* elemen sudah hilang */
    }
  }

  /** Fokuskan penangkap lagi (mis. setelah dialog ditutup). */
  async focus(): Promise<void> {
    if (!this.attached) return;
    await this.sendCapture("KEYBOARD_ATTACH");
  }

  /** Kirim instruksi ke DOME (KEYBOARD_ATTACH / KEYBOARD_DETACH). */
  private async sendCapture(type: string): Promise<void> {
    const lib = (global as any)._tsixLib;
    if (!lib?.shell?.send) return;
    try {
      const ps = await lib.shell.ps();
      const domePid =
        (ps.find((p: any) => p.name?.includes("dome")) || {}).pid || 0;
      if (!domePid) return;
      await lib.shell.send(domePid, {
        type,
        wid: this.win.wid,
        targetId: this.targetId,
      });
    } catch (_) {
      /* dome belum siap — skip */
    }
  }

  private dispatch(ev: any): void {
    if (this.listeners.size === 0) return;
    let data: Record<string, any> = {};
    if (typeof ev?.value === "string") {
      try {
        data = JSON.parse(ev.value);
      } catch (_) {
        data = { key: ev.value };
      }
    } else if (ev?.value && typeof ev.value === "object") {
      data = ev.value;
    }
    const k: IGUIKeyEvent = {
      key: data.key ?? "",
      code: data.code ?? "",
      down: data.down !== false,
      repeat: !!data.repeat,
      ctrl: !!data.ctrl,
      shift: !!data.shift,
      alt: !!data.alt,
    };
    for (const cb of this.listeners) {
      try {
        cb(k);
      } catch (e) {
        console.error("[Keyboard] listener error:", e);
      }
    }
  }
}
