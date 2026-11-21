/**
 * cashew-demo2.ts — Layout Demo (Flexbox, Grid, Split, Align)
 *
 * Menunjukkan berbagai teknik layout di Cashew Framework:
 * - Grid layout
 * - Split horizontal/vertical
 * - Flexbox wrap (flow)
 * - Anchor positioning (absolute)
 * - ScrollBox
 * - GroupBox
 * - Responsive resize
 *
 * (c) 2026 TSIX Project
 */

import { Program, std } from "@tsix/Application";
import {
  TForm,
  TPanel,
  TLabel,
  TButton,
  TStatusBar,
  TScrollBox,
  TFlowPanel,
  TGridPanel,
  TSplitHorizontal,
  TSplitVertical,
  TGroupBox,
  HStack,
  VStack,
  Spacer,
} from "@tsix/cashew";

export const appMode = "gui";

export const main = Program(async () => {
  await std.log("=== Cashew Layout Demo ===");

  // ================================================================
  // FORM — pake grid 2 kolom
  // ================================================================
  const form = new TForm("🧩 Cashew Layout Demo", 780, 900);
  form.style = {
    ...form.style,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "8px",
    alignContent: "start",
  };
  form.onClose = () => std.log("[layout] Form closed");

  const status = new TStatusBar("status");
  status.text = "✅ Layout Demo Ready";
  form.add(status);

  // ================================================================
  // 1. GRID PANEL — 2 kolom otomatis
  // ================================================================
  const gridDemo = TGridPanel("demo-grid", 2, { gridColumn: "1 / -1" });
  const lblGridTitle = new TLabel("lbl-grid-title");
  lblGridTitle.caption = "📐 TGridPanel (2 kolom)";
  lblGridTitle.style = {
    gridColumn: "1 / -1",
    color: "var(--accent, #4caf50)",
    fontWeight: "700",
    fontSize: "13px",
  };
  gridDemo.add(lblGridTitle);
  const gb1 = new TButton("g-btn1");
  gb1.caption = "Item 1";
  gridDemo.add(gb1);
  const gb2 = new TButton("g-btn2");
  gb2.caption = "Item 2";
  gridDemo.add(gb2);
  const gb3 = new TButton("g-btn3");
  gb3.caption = "Item 3";
  gridDemo.add(gb3);
  const gb4 = new TButton("g-btn4");
  gb4.caption = "Item 4";
  gridDemo.add(gb4);
  form.add(gridDemo);

  // ================================================================
  // 2. FLOW PANEL — flex wrap, responsive
  // ================================================================
  const flowDemo = TFlowPanel("demo-flow");
  const lblFlow = new TLabel("lbl-flow");
  lblFlow.caption = "🌊 TFlowPanel (flex wrap)";
  lblFlow.style = {
    width: "100%",
    color: "var(--accent, #4caf50)",
    fontWeight: "700",
    fontSize: "13px",
  };
  flowDemo.add(lblFlow);
  for (let i = 1; i <= 8; i++) {
    const fb = new TButton(`f-btn${i}`, {
      marginRight: "4px",
      marginBottom: "4px",
    });
    fb.caption = `Btn ${i}`;
    flowDemo.add(fb);
  }
  form.add(flowDemo);

  // ================================================================
  // 3. SPLIT HORIZONTAL — dua panel bersebelahan
  // ================================================================
  const splitHDemo = TGroupBox("demo-splith", "↔️ TSplitHorizontal", {
    paddingTop: "12px",
    height: "160px",
    display: "flex",
    flexDirection: "column",
  });
  const leftPanel = new TPanel("left-h", {
    padding: "8px",
    minHeight: "60px",
    borderRadius: "0",
  });
  const lbl_left = new TLabel("lbl-left");
  lbl_left.caption = "Kiri";
  leftPanel.add(lbl_left);
  const centerPanel = new TPanel("center-h", {
    padding: "8px",
    minHeight: "60px",
    borderRadius: "0",
  });
  const lbl_center = new TLabel("lbl-center");
  lbl_center.caption = "Tengah";
  centerPanel.add(lbl_center);
  const rightPanel = new TPanel("right-h", {
    padding: "8px",
    minHeight: "60px",
    borderRadius: "0",
  });
  const lbl_right = new TLabel("lbl-right");
  lbl_right.caption = "Kanan";
  rightPanel.add(lbl_right);
  // 3 bagian (kiri | tengah | kanan) → 2 horizontal splitter (nesting):
  //   TSplitHorizontal( kiri , TSplitHorizontal( tengah , kanan ) )
  splitHDemo.add(
    TSplitHorizontal(
      leftPanel,
      TSplitHorizontal(centerPanel, rightPanel, "1"),
      "1",
    ),
  );
  form.add(splitHDemo);

  // ================================================================
  // 4. SPLIT VERTICAL — dua panel bertumpuk
  // ================================================================
  const splitVDemo = TGroupBox("demo-splitv", "↕️ TSplitVertical", {
    paddingTop: "12px",
    height: "150px",
    display: "flex",
    flexDirection: "column",
  });
  const topPanel = new TPanel("top-v", {
    padding: "8px",
    minHeight: "70px",
    borderRadius: "0",
  });
  const lbl_top = new TLabel("lbl-top");
  lbl_top.caption = "Atas";
  topPanel.add(lbl_top);
  const bottomPanel = new TPanel("bot-v", {
    padding: "8px",
    minHeight: "70px",
    borderRadius: "0",
  });
  const lbl_bot = new TLabel("lbl-bot");
  lbl_bot.caption = "Bawah";
  bottomPanel.add(lbl_bot);
  splitVDemo.add(TSplitVertical(topPanel, bottomPanel, "1"));
  form.add(splitVDemo);

  // ================================================================
  // 5. SCROLLBOX — scrollable container
  // ================================================================
  const scrollDemo = TScrollBox("demo-scroll", {
    gridColumn: "1 / -1",
    maxHeight: "100px",
    borderRadius: "6px",
    padding: "6px",
  });
  const lblScroll = new TLabel("lbl-scroll");
  lblScroll.caption = "📜 TScrollBox (scroll isi)";
  lblScroll.style = {
    color: "var(--accent, #4caf50)",
    fontWeight: "700",
    fontSize: "13px",
    display: "block",
    marginBottom: "4px",
  };
  scrollDemo.add(lblScroll);
  for (let i = 1; i <= 15; i++) {
    const sb = new TButton(`s-btn${i}`, {
      marginRight: "4px",
      marginBottom: "4px",
    });
    sb.caption = `Item ${i}`;
    scrollDemo.add(sb);
  }
  form.add(scrollDemo);

  // ================================================================
  // 6. ANCHOR POSITIONING — absolute
  // ================================================================
  const anchorDemo = new TPanel("demo-anchor", {
    gridColumn: "1 / -1",
    position: "relative",
    height: "80px",
    borderRadius: "6px",
  });
  const lblAnchor = new TLabel("lbl-anchor");
  lblAnchor.caption = "📍 Anchor (absolute)";
  lblAnchor.style = {
    color: "var(--accent, #4caf50)",
    fontWeight: "700",
    fontSize: "13px",
  };
  anchorDemo.add(lblAnchor);
  // Tombol anchor ke berbagai sisi
  const a1 = new TButton("a-tl", {
    position: "absolute",
    left: "4px",
    top: "24px",
    padding: "2px 8px",
    fontSize: "10px",
  });
  a1.caption = "↖ TL";
  anchorDemo.add(a1);
  const a2 = new TButton("a-tr", {
    position: "absolute",
    right: "4px",
    top: "24px",
    padding: "2px 8px",
    fontSize: "10px",
  });
  a2.caption = "TR ↗";
  anchorDemo.add(a2);
  const a3 = new TButton("a-bl", {
    position: "absolute",
    left: "4px",
    bottom: "4px",
    padding: "2px 8px",
    fontSize: "10px",
  });
  a3.caption = "↙ BL";
  anchorDemo.add(a3);
  const a4 = new TButton("a-br", {
    position: "absolute",
    right: "4px",
    bottom: "4px",
    padding: "2px 8px",
    fontSize: "10px",
  });
  a4.caption = "BR ↗";
  anchorDemo.add(a4);
  form.add(anchorDemo);

  // ================================================================
  // 7. HSTACK — quick stack
  // ================================================================
  const stackDemo = TGroupBox("demo-stack", "📦 HStack / Spacer", {
    margin: "8px 0",
    height: "125px",
  });
  const hs1 = new TButton("hs-btn1");
  hs1.caption = "Kiri";
  const hs2 = new TButton("hs-btn2");
  hs2.caption = "Tengah";
  const hs3 = new TButton("hs-btn3");
  hs3.caption = "Kanan";
  stackDemo.add(HStack({}, hs1, Spacer(), hs2, Spacer(), hs3));
  form.add(stackDemo);

  // ================================================================
  // 7. HSTACK / VSTACK — quick stack
  // ================================================================
  const stackVDemo = TGroupBox("demo-stack-v", "📦 VStack / Spacer", {
    margin: "8px 0",
    height: "150px",
  });
  const vhs1 = new TButton("vhs-btn1");
  vhs1.caption = "Atas";
  const vhs2 = new TButton("vhs-btn2");
  vhs2.caption = "Tengah";
  const vhs3 = new TButton("vhs-btn3");
  vhs3.caption = "Bawah";
  stackVDemo.add(VStack({}, vhs1, Spacer(), vhs2, Spacer(), vhs3));
  form.add(stackVDemo);

  // ================================================================
  // Status bar — di akhir biar full-width
  // ================================================================
  status.style = { ...status.style, gridColumn: "1 / -1" };

  // ================================================================
  // BINDING
  // ================================================================
  const allButtons = [
    "g-btn1",
    "g-btn2",
    "g-btn3",
    "g-btn4",
    "f-btn1",
    "f-btn2",
    "f-btn3",
    "f-btn4",
    "f-btn5",
    "f-btn6",
    "f-btn7",
    "f-btn8",
    "s-btn1",
    "s-btn2",
    "s-btn3",
    "s-btn4",
    "s-btn5",
    "s-btn6",
    "s-btn7",
    "s-btn8",
    "s-btn9",
    "s-btn10",
    "s-btn11",
    "s-btn12",
    "s-btn13",
    "s-btn14",
    "s-btn15",
    "a-tl",
    "a-tr",
    "a-bl",
    "a-br",
    "hs-btn1",
    "hs-btn2",
    "hs-btn3",
  ];

  await form.run();
});
