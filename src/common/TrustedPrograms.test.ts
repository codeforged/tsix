import { describe, it, expect } from "vitest";
import { trustedHostModules } from "./TrustedPrograms";

const rootFile = (mode = 0o755) => ({ type: "FILE", uid: 0, gid: 0, mode });

describe("trustedHostModules (SEC-12, K-12)", () => {
    it("program tepercaya milik root mendapat modul yang dibutuhkannya saja", () => {
        expect(trustedHostModules("/usr/bin/tbuild.js", rootFile())).toEqual(["fs", "path", "esbuild", "os"]);
        expect(trustedHostModules("/usr/bin/tbuild.ts", rootFile())).toEqual(["fs", "path", "esbuild", "os"]);
        expect(trustedHostModules("/sbin/transpile.js", rootFile(0o744))).toEqual(["esbuild"]);
        expect(trustedHostModules("/sbin/apply-update.js", rootFile(0o744))).toEqual(["esbuild"]);
        expect(trustedHostModules("/sbin/vfs-pull.js", rootFile(0o744))).toEqual(["path"]);
        expect(trustedHostModules("/opt/dome/dome.js", rootFile())).toEqual(["esbuild"]);
        expect(trustedHostModules("/opt/mysqld/mysqld.js", rootFile())).toEqual(["mysql2", "mysql2/promise"]);
        expect(trustedHostModules("/opt/plcd/launcher.js", rootFile())).toEqual(["path", "module", "esbuild"]);
    });

    it("nama mirip di luar daftar tidak dapat apa-apa (dulu cukup mengandung 'server'/'daemon')", () => {
        expect(trustedHostModules("/home/alice/evil-daemon.js", { type: "FILE", uid: 1000, gid: 1000, mode: 0o755 })).toEqual([]);
        expect(trustedHostModules("/home/alice/myserver.js", rootFile())).toEqual([]);
        expect(trustedHostModules("/opt/lantana/lantana-dashboard-server.js", rootFile())).toEqual([]);
        expect(trustedHostModules("/tmp/usr/bin/tbuild.js", rootFile())).toEqual([]);
    });

    it("path tepercaya tapi bukan milik root, atau bisa ditulis grup/other → ditolak", () => {
        expect(trustedHostModules("/usr/bin/tbuild.js", { type: "FILE", uid: 1000, gid: 0, mode: 0o755 })).toEqual([]);
        expect(trustedHostModules("/usr/bin/tbuild.js", rootFile(0o775))).toEqual([]);
        expect(trustedHostModules("/usr/bin/tbuild.js", rootFile(0o757))).toEqual([]);
        expect(trustedHostModules("/usr/bin/tbuild.js", { type: "DIRECTORY", uid: 0, gid: 0, mode: 0o755 })).toEqual([]);
        expect(trustedHostModules("/usr/bin/tbuild.js", null)).toEqual([]);
    });
});
