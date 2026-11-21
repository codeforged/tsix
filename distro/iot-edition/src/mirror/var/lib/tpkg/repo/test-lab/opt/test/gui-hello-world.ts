import { Program, std, shell } from "@tsix/Application";
import { Screen, div, button, paragraph } from "@tsix/emerald";
import { theme } from "@tsix/theme";

export const appMode = "gui";

export const main = Program(async (args: string[]) => {
  const domeuuid = "da8711c2-5ca9-4f00-ad13-f1226f95594c";
  await theme.loadCurrent();
  theme.watch();

  try {
    await shell.send(domeuuid, { type: "ping" });
  } catch (e) {
    await std.error("[gui-hello-world] DOME identity not found. Please start DOME first.");
    // throw new Error("[gui-hello-world] DOME identity not found. Please start DOME first.");
    return;
  }

  const app = new Screen({
    title: "Hello World",
    width: 400,
    height: 200,
    maximizable: false,
    frameless: false,
  });

  await app.mount(div({ id: "root", text: "Hello world" },
    div({},
      button({
        id: "btn1", text: "Test button",
        style: {
          background: theme.colors.buttonBg, color: theme.colors.info,
          border: `1px solid ${theme.colors.info}`, borderRadius: theme.sizes.borderRadiusSm,
          padding: "6px 16px", cursor: "pointer", fontSize: theme.sizes.fontSizeSm, fontWeight: "600",
        },
      }),
    )
  ));

  setTimeout(async () => {
    try {
      await shell.send(domeuuid, { type: "WINDOW_TITLE", wid: app.wid, title: "New Title" });
    } catch (e) {
      await std.error("[gui-hello-world] Failed to send WINDOW_TITLE event to DOME: " + e, "gui-hello-world");
    }
  }, 0);
  await app.loopUntilClose();
});
