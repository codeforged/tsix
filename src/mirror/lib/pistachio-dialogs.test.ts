import { describe, expect, it, vi } from "vitest";
import { TDialogs, TForm, TOpenDialog, TSaveDialog } from "@tsix/pistachio";

function fakeOwner() {
  const screen = {
    alert: vi.fn(async (_title: string, _message?: string) => {}),
    confirm: vi.fn(
      async (_title: string, _message: string, _buttons: string[]) => "Ya",
    ),
    question: vi.fn(
      async (_title: string, _message: string, _defaultValue: string) => "budi",
    ),
    openFileDialog: vi.fn(
      async (_fs: unknown, _opts: Record<string, unknown>) => ({
        path: "/docs/a.txt",
        filename: "a.txt",
        directory: "/docs",
      }),
    ),
    saveFileDialog: vi.fn(
      async (_fs: unknown, _opts: Record<string, unknown>) => ({
        path: "/docs/b.txt",
        filename: "b.txt",
        directory: "/docs",
      }),
    ),
  };

  return { owner: { screen } as any, screen };
}

describe("TDialogs", () => {
  it("alert passes title and message", async () => {
    const { owner, screen } = fakeOwner();
    await TDialogs.alert(owner, "Info", "Halo");

    expect(screen.alert).toHaveBeenCalledWith("Info", "Halo");
  });

  it("alert forwards width options for long content", async () => {
    const { owner, screen } = fakeOwner();
    await TDialogs.alert(owner, "AccessKey", "abc123", { width: "auto" });

    expect(screen.alert).toHaveBeenCalledWith("AccessKey", "abc123", {
      width: "auto",
    });
  });

  it("confirm returns the clicked button label", async () => {
    const { owner, screen } = fakeOwner();
    const answer = await TDialogs.confirm(owner, "Hapus?", "Yakin?", [
      "Ya",
      "Batal",
    ]);

    expect(answer).toBe("Ya");
    expect(screen.confirm).toHaveBeenCalledWith("Hapus?", "Yakin?", [
      "Ya",
      "Batal",
    ]);
  });

  it("input returns the typed value", async () => {
    const { owner, screen } = fakeOwner();
    const value = await TDialogs.input(owner, "Nama", "Masukkan nama", "dunia");

    expect(value).toBe("budi");
    expect(screen.question).toHaveBeenCalledWith(
      "Nama",
      "Masukkan nama",
      "dunia",
    );
  });
});

describe("TOpenDialog & TSaveDialog", () => {
  it("TOpenDialog forwards its options and result", async () => {
    const { owner, screen } = fakeOwner();
    const dialog = new TOpenDialog({
      title: "Pilih",
      startDir: "/docs",
      filter: ["txt"],
    });

    const result = await dialog.execute(owner);

    expect(result?.path).toBe("/docs/a.txt");
    expect(screen.openFileDialog).toHaveBeenCalledWith(expect.anything(), {
      title: "Pilih",
      startDir: "/docs",
      filter: ["txt"],
    });
  });

  it("TSaveDialog forwards defaultName", async () => {
    const { owner, screen } = fakeOwner();
    const dialog = new TSaveDialog({ title: "Simpan", defaultName: "b.txt" });

    const result = await dialog.execute(owner);

    expect(result?.filename).toBe("b.txt");
    expect(screen.saveFileDialog).toHaveBeenCalledWith(expect.anything(), {
      title: "Simpan",
      startDir: undefined,
      defaultName: "b.txt",
    });
  });

  it("returns null when the user cancels", async () => {
    const { owner, screen } = fakeOwner();
    screen.openFileDialog.mockResolvedValueOnce(null as any);

    const result = await new TOpenDialog().execute(owner);

    expect(result).toBeNull();
  });
});

describe("dialog file sebagai komponen non-visual (P1-5, K6)", () => {
  it("execute() tanpa owner memakai form tempat dialog dipasang", async () => {
    const { screen } = fakeOwner();
    const form = new TForm({ id: "frm-dlg" });
    (form as any)._screen = screen; // seperti setelah run()
    const open = new TOpenDialog({ id: "dlg-open", title: "Buka", filter: ["txt"] });
    const save = new TSaveDialog("dlg-save", { defaultName: "b.txt" });
    form.add(open);
    form.add(save);

    expect(open.isVisual).toBe(false);
    expect(form.byId("dlg-open")).toBe(open);
    expect(form.build().children).toEqual([]);
    expect(await open.execute()).toMatchObject({ path: "/docs/a.txt" });
    expect(screen.openFileDialog).toHaveBeenCalledWith(expect.anything(), {
      title: "Buka",
      startDir: undefined,
      filter: ["txt"],
    });
    expect(await save.execute()).toMatchObject({ path: "/docs/b.txt" });
    expect(screen.saveFileDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ defaultName: "b.txt" }),
    );
  });

  it("NOT_MOUNTED bila form belum run() atau dialog tidak di form", async () => {
    const form = new TForm({ id: "frm-idle" });
    const inForm = new TOpenDialog("dlg-a");
    form.add(inForm);
    await expect(inForm.execute()).rejects.toMatchObject({ code: "NOT_MOUNTED" });
    await expect(new TSaveDialog("dlg-b").execute()).rejects.toMatchObject({
      code: "NOT_MOUNTED",
      componentId: "dlg-b",
    });
  });
});
