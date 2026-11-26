import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BKFS } from "../../src/vfs/BKFS";
import { ensureFreshAccountFiles } from "./fresh-accounts";
import { addToGroup, createUserAccount } from "./user-account";

/**
 * Akun user dari installer (`scripts/install.ts`, mode development & produksi)
 * WAJIB otomatis menjadi sudoer — `/bin/sudo` mengizinkan anggota grup `sudo`.
 */
describe("installer user account (sudoers)", () => {
    let dir: string;
    let bkfs: BKFS;

    const groupLine = (name: string) =>
        (bkfs.read("/etc/group") || "").split("\n").find((l) => l.split(":")[0] === name);
    const members = (name: string) => (groupLine(name)?.split(":")[3] ?? "").split(",").filter(Boolean);

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsix-user-account-"));
        bkfs = new BKFS(path.join(dir, "system.db"));
        ensureFreshAccountFiles(bkfs);
    });

    afterEach(() => {
        bkfs.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("user baru menjadi anggota grup sudo dan users", () => {
        createUserAccount(bkfs, "andri", "rahasia");

        expect(members("sudo")).toEqual(["andri"]);
        expect(members("users")).toEqual(["andri"]);
        expect(groupLine("sudo")).toBe("sudo:x:27:andri");
    });

    it("install diulang: tidak menduplikasi anggota, akun lama tetap dijadikan sudoer", () => {
        createUserAccount(bkfs, "andri", "rahasia");
        createUserAccount(bkfs, "andri", "lain");
        expect(members("sudo")).toEqual(["andri"]);

        // Akun yang sudah ada sebelum aturan ini (bukan sudoer) → dipastikan sudoer.
        bkfs.touch("/etc/group", "root:x:0:\nsudo:x:27:\nusers:x:100:andri\n", 0, 0, 0o644);
        createUserAccount(bkfs, "andri", "rahasia");
        expect(members("sudo")).toEqual(["andri"]);
    });

    it("grup sudo yang hilang dibuat dengan gid 27; anggota lain dipertahankan", () => {
        bkfs.touch("/etc/group", "root:x:0:\nusers:x:100:\n", 0, 0, 0o644);
        createUserAccount(bkfs, "andri", "rahasia");
        expect(groupLine("sudo")).toBe("sudo:x:27:andri");

        addToGroup(bkfs, "sudo", 27, "budi");
        expect(members("sudo")).toEqual(["andri", "budi"]);
    });
});
