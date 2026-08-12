/**
 * gui-chat — TSIX IPC Chat Demo
 *
 * Kirim/terima pesan antar window aplikasi via WID + SEND_MSG.
 *
 * Usage:
 *   gui-chat <targetWid>           → kirim pesan ke target window
 *   gui-chat                       → launch aja, nunggu pesan masuk
 *
 * Contoh:
 *   # Buka terminal 1:
 *   gui-chat
 *     → Chat [e3f2a1b4-c...] ready
 *
 *   # Buka terminal 2:
 *   gui-chat e3f2a1b4-c...
 *     → Chat [f8b2c3d1-a...] targeting: e3f2a1b4-c...
 */

import { Program, std, shell } from "@tsix/Application";
import { Screen, div, span, h1, h2, button, input, text } from "@tsix/emerald";
import { theme } from "@tsix/theme";
export const appMode = "gui";
export const main = Program(async (_args: string[]) => {
  await theme.loadCurrent();
  theme.watch();

  const app = new Screen({
    title: "💬 TSIX Chat",
    width: 420,
    height: 500,
    resizable: true,
  });

  // Register identity biar bisa terima shell.send(uuid, msg) dari app lain
  try {
    await shell.registerIdentity(app.wid);
    await std.log(`[gui-chat] Identity registered: ${app.wid}`);
  } catch (e: any) {
    await std.log(`[gui-chat] Identity registration failed: ${e.message}`);
  }

  // --- State ---
  let targetWid: string | null = null;
  let chatLog = "";
  let inputText = "";
  let connectInput = "";

  const log = async (prefix: string, msg: string) => {
    const time = new Date().toLocaleTimeString();
    chatLog += `[${time}] ${prefix}: ${msg}\n`;
    if (chatLog.length > 4000) chatLog = chatLog.slice(-4000);
    await app.update("chat-log", { text: chatLog });
    await app.update("chat-scroll", { scrollTop: 999999 });
  };

  // Apply theme to window chrome
  const ps = await shell.ps();
  const domePid = (ps.find((p: any) => p.name.includes("dome")) || {}).pid || 0;
  if (domePid) await theme.applyToDome(domePid, app.wid);

  // --- Mount UI ---
  await app.mount(
    div(
      {
        id: "root",
        style: {
          padding: "12px",
          height: "100%",
          background: theme.colors.bg,
          color: theme.colors.text,
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        },
      },
      // Header
      div(
        {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexShrink: "0",
          },
        },
        h1({
          text: "💬 TSIX Chat",
          style: { fontSize: "18px", color: theme.colors.accent, margin: "0" },
        }),
        span({
          id: "status",
          text: "🔴 Not Connected",
          style: { fontSize: "11px", color: theme.colors.danger },
        }),
      ),
      // Connect row
      div(
        {
          id: "connect-row",
          style: { display: "flex", gap: "8px", flexShrink: "0" },
        },
        input({
          id: "connect-input",
          type: "text",
          placeholder: "Paste target WID here...",
          value: "",
          onInputId: "connect-input",
          style: {
            flex: "1",
            background: theme.colors.inputBg,
            color: theme.colors.text,
            border: "1px solid " + theme.colors.inputBorder,
            borderRadius: "6px",
            padding: "8px 10px",
            fontSize: "12px",
            outline: "none",
            fontFamily: "monospace",
          },
        }),
        button({
          id: "btn-connect",
          text: "🔌 Connect",
          style: {
            background: theme.colors.info,
            color: "white",
            border: "none",
            borderRadius: "6px",
            padding: "8px 14px",
            cursor: "pointer",
            fontSize: "12px",
            fontWeight: "700",
            whiteSpace: "nowrap",
          },
        }),
      ),
      // Chat log area
      div(
        {
          id: "chat-scroll",
          style: {
            flex: "1",
            background: theme.colors.bgAlt,
            borderRadius: "8px",
            padding: "10px",
            overflowY: "auto",
            fontSize: "12px",
            fontFamily: "'Courier New', monospace",
            color: theme.colors.textDim,
            minHeight: "200px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          },
        },
        span({
          id: "chat-log",
          text:
            "⏳ TSIX Chat ready.\nMy WID: " +
            app.wid +
            "\n───────────────\nPaste target WID & click Connect to start.\n",
        }),
      ),
      // Message input row
      div(
        { style: { display: "flex", gap: "8px", flexShrink: "0" } },
        input({
          id: "msg-input",
          type: "text",
          placeholder: "Type a message...",
          value: "",
          onInputId: "msg-input",
          onKeydownId: "msg-input",
          disabled: "",
          style: {
            flex: "1",
            background: theme.colors.inputBg,
            color: theme.colors.textDim,
            border: "1px solid " + theme.colors.inputBorder,
            borderRadius: "6px",
            padding: "8px 10px",
            fontSize: "13px",
            outline: "none",
          },
        }),
        button({
          id: "btn-send",
          text: "📤 Send",
          disabled: "",
          style: {
            background: theme.colors.buttonBg,
            color: theme.colors.textMuted,
            border: "none",
            borderRadius: "6px",
            padding: "8px 16px",
            cursor: "not-allowed",
            fontSize: "13px",
            fontWeight: "700",
          },
        }),
      ),
      // Info bar
      span({
        id: "info-bar",
        text: `My WID: ${app.wid}`,
        style: {
          fontSize: "10px",
          color: theme.colors.textMuted,
          flexShrink: "0",
          textAlign: "center" as any,
        },
      }),
    ),
  );

  let connected = false;

  // --- Connect / Disconnect (single button toggle) ---
  app.win.onClick("btn-connect", async () => {
    if (connected) {
      // --- DISCONNECT ---
      targetWid = null;
      connected = false;
      await app.update("msg-input", {
        disabled: "",
        style: {
          flex: "1",
          background: "#0f3460",
          color: "#555",
          border: "1px solid #333",
          borderRadius: "6px",
          padding: "8px 10px",
          fontSize: "13px",
          outline: "none",
        },
      });
      await app.update("btn-send", {
        disabled: "",
        style: {
          background: "#333",
          color: "#555",
          border: "none",
          borderRadius: "6px",
          padding: "8px 16px",
          cursor: "not-allowed",
          fontSize: "13px",
          fontWeight: "700",
        },
      });
      await app.update("btn-connect", { text: "🔌 Connect" });
      await app.update("connect-input", { value: "" });
      await app.update("status", {
        text: "🔴 Not Connected",
        style: { fontSize: "11px", color: "#f44336" },
      });
      await app.update("connect-input", {
        style: {
          flex: "1",
          background: "#0f3460",
          color: "#e0e0e0",
          border: "1px solid #333",
          borderRadius: "6px",
          padding: "8px 10px",
          fontSize: "12px",
          outline: "none",
          fontFamily: "monospace",
        },
      });
      await app.update("info-bar", { text: `My WID: ${app.wid}` });
      await log("🔌 SYS", "Disconnected");
      return;
    }

    // --- CONNECT ---
    const raw = connectInput.trim();
    if (!raw) {
      await app.alert("No WID", "Paste a target WID first!");
      return;
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        raw,
      )
    ) {
      await app.alert("Invalid WID", "That doesn't look like a valid UUID.");
      return;
    }
    if (raw === app.wid) {
      await app.alert("Self-Chat?", "Can't connect to your own WID!");
      return;
    }

    // Verify target is reachable
    try {
      await shell.send(raw, { type: "ping" });
    } catch (e: any) {
      await app.alert(
        "Not Reachable",
        "Target WID not registered.\nMake sure the other chat is running.",
      );
      return;
    }

    targetWid = raw;
    connected = true;
    await app.update("btn-connect", {
      text: "❌ Disconnect",
      style: {
        background: "#f4433688",
        color: "#f44336",
        border: "none",
        borderRadius: "6px",
        padding: "8px 14px",
        cursor: "pointer",
        fontSize: "12px",
        fontWeight: "700",
        whiteSpace: "nowrap",
      },
    });
    await app.update("status", {
      text: `🟢 Connected → ${raw.substring(0, 8)}...`,
      style: { fontSize: "11px", color: "#4caf50" },
    });
    await app.update("connect-input", {
      disabled: "",
      style: {
        flex: "1",
        background: "#0a1a0a",
        color: "#4caf50",
        border: "1px solid #4caf5088",
        borderRadius: "6px",
        padding: "8px 10px",
        fontSize: "12px",
        outline: "none",
        fontFamily: "monospace",
      },
    });
    await app.update("msg-input", {
      disabled: undefined,
      style: {
        flex: "1",
        background: "#0f3460",
        color: "#e0e0e0",
        border: "1px solid #333",
        borderRadius: "6px",
        padding: "8px 10px",
        fontSize: "13px",
        outline: "none",
      },
    });
    await app.update("btn-send", {
      disabled: undefined,
      style: {
        background: "#4caf50",
        color: "white",
        border: "none",
        borderRadius: "6px",
        padding: "8px 16px",
        cursor: "pointer",
        fontSize: "13px",
        fontWeight: "700",
      },
    });
  });

  // --- Kirim pesan ---
  const sendMessage = async () => {
    if (!inputText.trim()) return;
    if (!targetWid) {
      await app.alert("No Connection", "Connect to a target WID first!");
      return;
    }
    try {
      await shell.send(targetWid, {
        type: "CHAT_MSG",
        // type: "DESKTOP_NOTIF",
        fromWid: app.wid,
        text: inputText.trim(),
        timestamp: Date.now(),
      });
      await log("📤 ME", inputText.trim());
      await app.update("msg-input", { value: "" });
      inputText = "";
    } catch (e: any) {
      await log("❌ ERR", e.message || "Send failed");
    }
  };

  // --- Event: Connect input text ---
  app.win.bindHandler("connect-input", "input", (ev: any) => {
    connectInput = ev?.value || "";
  });

  // --- Event: Message input text ---
  app.win.bindHandler("msg-input", "input", (ev: any) => {
    inputText = ev?.value || "";
  });

  // --- Event: Enter key → send ---
  app.win.bindHandler("msg-input", "keydown", (ev: any) => {
    if (ev?.value === "Enter") sendMessage().catch(() => {});
  });

  // --- Event: Send button ---
  app.win.onClick("btn-send", () => sendMessage().catch(() => {}));

  // --- Listener: terima pesan dari aplikasi lain ---
  const AST_UUID = "3ec3ffe9-e0a6-411f-b7e3-c9ff0b00556c";
  const lib = (global as any)._tsixLib;
  if (lib?.onEvent) {
    lib.onEvent("ipc_message", async (msg: any) => {
      const payload = msg?.data || msg;
      if (payload?.type !== "CHAT_MSG") return;
      if (payload.fromWid === app.wid) return;

      const time = new Date(payload.timestamp).toLocaleTimeString();
      const shortId = (payload.fromWid || "?").substring(0, 8);
      await log(`📥 [${shortId}]`, payload.text || "(empty)");

      // Kirim desktop notification ke Asteracea
      // try {
      //     await shell.send(AST_UUID, {
      //         type: "DESKTOP_NOTIF",
      //         title: `💬 Chat from ${shortId}...`,
      //         message: payload.text || "(empty)",
      //     });
      // } catch (_) { /* Asteracea might not be running */ }
      app.notifyDesktop(
        `💬 Chat from ${shortId}...`,
        payload.text || "(empty)",
        { duration: 5000, position: "ne" },
      );
      await app.update("status", {
        text: `📥 Last: ${shortId}...`,
        style: { fontSize: "11px", color: "#4caf50" },
      });
    });
  }

  await app.win.flush();
  await app.loopUntilClose();
});
