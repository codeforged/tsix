import { describe, expect, it, vi } from "vitest";
import type { OSContext } from "../lib/IProgram";
import { main } from "./ls";

function makeContext(
  directories: Record<string, Array<Record<string, unknown>>>,
): OSContext {
  const fs = {
    stat: vi.fn(async (path: string) => {
      if (path === "/" || directories[path]) {
        return {
          name: path.split("/").pop() || "/",
          type: "DIRECTORY",
          mode: 0o755,
          uid: 0,
          gid: 0,
        };
      }
      return null;
    }),
    ls: vi.fn(async (path: string) =>
      (directories[path] ?? []).map((entry) => ({ uid: 0, gid: 0, ...entry })),
    ),
  } as unknown as OSContext["fs"];
  const shell = {
    getenv: vi.fn(async () => "80"),
  } as unknown as OSContext["shell"];
  return { fs, shell, std: {} as OSContext["std"], aux: {} as OSContext["aux"] };
}

describe("ls recursive listing", () => {
  it("lists nested directories with -R and skips hidden directories by default", async () => {
    const app = new main();
    const os = makeContext({
      "/tree": [
        { name: "child", type: "DIRECTORY", mode: 0o755 },
        { name: ".hidden", type: "DIRECTORY", mode: 0o755 },
        { name: "root.txt", type: "FILE", mode: 0o644, size: 12 },
      ],
      "/tree/child": [
        { name: "nested.txt", type: "FILE", mode: 0o644, size: 8 },
      ],
      "/tree/.hidden": [
        { name: "secret.txt", type: "FILE", mode: 0o644, size: 6 },
      ],
    });

    const output = await app.execute(os, ["-R", "/tree"]);

    expect(output).toContain("/tree:");
    expect(output).toContain("/tree/child:");
    expect(output).toContain("nested.txt");
    expect(output).not.toContain("/tree/.hidden:");
    expect(output).not.toContain("secret.txt");
  });

  it("supports --recursive with -a and emits headers for empty directories", async () => {
    const app = new main();
    const os = makeContext({
      "/tree": [{ name: ".hidden", type: "DIRECTORY", mode: 0o755 }],
      "/tree/.hidden": [],
    });

    const output = await app.execute(os, ["--recursive", "-a", "/tree"]);

    expect(output).toContain("/tree:");
    expect(output).toContain("/tree/.hidden:");
  });

  it("supports -A without dot entries, -d without traversing, and disables color", async () => {
    const app = new main();
    const os = makeContext({
      "/tree": [
        { name: ".hidden", type: "FILE", mode: 0o644, size: 2 },
        { name: "child", type: "DIRECTORY", mode: 0o755 },
        { name: ".", type: "DIRECTORY", mode: 0o755 },
        { name: "..", type: "DIRECTORY", mode: 0o755 },
      ],
      "/tree/child": [],
    });

    const almostAll = await app.execute(os, ["-A1", "--color=never", "/tree"]);
    expect(almostAll).toContain(".hidden");
    expect(almostAll).not.toMatch(/(^|\n)\.\.?(\n|$)/);
    expect(almostAll).not.toContain("\x1b[");

    const directoryItself = await app.execute(os, ["-dR", "--color=never", "/tree"]);
    expect(directoryItself).toBe("/tree");
    expect(os.fs.ls).toHaveBeenCalledTimes(1);
  });

  it("includes dot entries with -a without recursing into them", async () => {
    const app = new main();
    const os = makeContext({
      "/tree": [],
    });

    const output = await app.execute(os, ["-a1", "--color=never", "/tree"]);

    expect(output.split("\n")).toEqual([".", ".."]);
    expect(os.fs.ls).toHaveBeenCalledTimes(1);
  });

  it("supports human-readable long listings and natural version sorting", async () => {
    const app = new main();
    const os = makeContext({
      "/tree": [
        { name: "item10.txt", type: "FILE", mode: 0o644, size: 1536 },
        { name: "item2.txt", type: "FILE", mode: 0o644, size: 1024 },
      ],
    });

    const longListing = await app.execute(os, ["-lh", "--color=never", "/tree"]);
    expect(longListing).toContain("1.5K");
    expect(longListing).toContain("1.0K");

    const sorted = await app.execute(os, ["-1v", "--color=never", "/tree"]);
    expect(sorted.indexOf("item2.txt")).toBeLessThan(sorted.indexOf("item10.txt"));
  });
});
