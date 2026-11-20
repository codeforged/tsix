import { afterEach, describe, expect, it } from "vitest";
import { BKFS } from "../../src/vfs/BKFS";
import { ensureFreshAccountFiles } from "./fresh-accounts";

describe("fresh account bootstrap", () => {
    let bkfs: BKFS | undefined;

    afterEach(() => {
        bkfs?.close();
        bkfs = undefined;
    });

    it("creates a locked root account and secure root home when templates are absent", () => {
        bkfs = new BKFS(":memory:");

        expect(ensureFreshAccountFiles(bkfs)).toBe(true);
        expect(bkfs.read("/etc/passwd")).toBe("root:x:0:0:root:/root:/bin/tsh.js\n");
        expect(bkfs.read("/etc/group")).toBe("root:x:0:\nsudo:x:27:\nusers:x:100:\n");
        expect(bkfs.read("/etc/shadow")).toBe("root:!:0:0:99999:7:::\n");
        expect(bkfs.stat("/etc/shadow")?.mode).toBe(0o640);
        expect(bkfs.stat("/root")?.mode).toBe(0o700);
        expect(ensureFreshAccountFiles(bkfs)).toBe(false);
    });

    it("preserves existing account files", () => {
        bkfs = new BKFS(":memory:");
        bkfs.mkdir("/etc");
        bkfs.touch("/etc/passwd", "operator passwd\n");
        bkfs.touch("/etc/group", "operator group\n");
        bkfs.touch("/etc/shadow", "root:existing-hash\n");

        expect(ensureFreshAccountFiles(bkfs)).toBe(false);
        expect(bkfs.read("/etc/passwd")).toBe("operator passwd\n");
        expect(bkfs.read("/etc/group")).toBe("operator group\n");
        expect(bkfs.read("/etc/shadow")).toBe("root:existing-hash\n");
    });
});
