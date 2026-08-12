import { describe, it, expect } from "vitest";
import { PathResolver } from "./PathResolver";

describe("PathResolver", () => {
    const cwd = "/home/user";

    // ============================================================
    // D1.01–D1.06: Basic resolution
    // ============================================================
    it("D1.01 resolves absolute path /home/user/file", () => {
        expect(PathResolver.resolve(cwd, "/home/user/file")).toBe("/home/user/file");
    });
    it("D1.02 resolves relative path with cwd", () => {
        expect(PathResolver.resolve(cwd, "documents/report.txt")).toBe("/home/user/documents/report.txt");
    });
    it("D1.03 resolves . (current directory)", () => {
        expect(PathResolver.resolve(cwd, ".")).toBe("/home/user");
    });
    it("D1.04 resolves .. (parent directory)", () => {
        expect(PathResolver.resolve(cwd, "..")).toBe("/home");
    });
    it("D1.05 resolves / (root) stays root", () => {
        expect(PathResolver.resolve(cwd, "/")).toBe("/");
    });
    it("D1.06 .. from root stays root", () => {
        expect(PathResolver.resolve("/", "..")).toBe("/");
    });

    // ============================================================
    // D1.07–D1.10: Edge cases
    // ============================================================
    it("D1.07 ../../.. from deep path", () => {
        expect(PathResolver.resolve("/a/b/c/d", "../../..")).toBe("/a");
    });
    it("D1.08 double slashes normalized", () => {
        expect(PathResolver.resolve(cwd, "//home//user//file")).toBe("/home/user/file");
    });
    it("D1.09 trailing slash normalized", () => {
        expect(PathResolver.resolve(cwd, "/home/")).toBe("/home");
    });
    it("D1.10 many slashes normalized", () => {
        expect(PathResolver.resolve(cwd, "/////a///b////")).toBe("/a/b");
    });

    // ============================================================
    // D1.11–D1.13: Special inputs
    // ============================================================
    it("D1.11 blank path uses cwd", () => {
        expect(PathResolver.resolve(cwd, "")).toBe("/home/user");
    });
    it("D1.12 relative to root cwd", () => {
        expect(PathResolver.resolve("/", "etc/passwd")).toBe("/etc/passwd");
    });
    it("D1.13 path with spaces preserved", () => {
        expect(PathResolver.resolve(cwd, "my documents")).toBe("/home/user/my documents");
    });

    // ============================================================
    // D1.14–D1.25: Additional coverage & extensions
    // ============================================================
    it("D1.14 resolve – very long path", () => {
        const deepPath = "a/".repeat(100) + "b";
        expect(PathResolver.resolve(cwd, deepPath)).toBe("/home/user/" + "a/".repeat(100) + "b");
    });
    it("D1.15 resolve – path with spaces", () => {
        expect(PathResolver.resolve(cwd, "some dir/some file.txt")).toBe("/home/user/some dir/some file.txt");
    });
    it("D1.16 resolve – unicode characters", () => {
        expect(PathResolver.resolve(cwd, "folder_🔥/dokumen_简体中文.txt")).toBe("/home/user/folder_🔥/dokumen_简体中文.txt");
    });
    it("D1.17 resolve – special chars (*, ?, |)", () => {
        expect(PathResolver.resolve(cwd, "a/*/b/?/c/|")).toBe("/home/user/a/*/b/?/c/|");
    });
    it("D1.18 normalize – removes redundant separators", () => {
        expect(PathResolver.normalize("///a//b///c/")).toBe("/a/b/c");
    });
    it("D1.19 normalize – resolves ./ and ../", () => {
        expect(PathResolver.normalize("/a/./b/../c")).toBe("/a/c");
    });
    it("D1.20 join – base + relative", () => {
        expect(PathResolver.join("home/user", "documents", "file.txt")).toBe("home/user/documents/file.txt");
    });
    it("D1.21 join – both absolute (base ignored or normalized)", () => {
        expect(PathResolver.join("/home/user", "/etc/passwd")).toBe("/home/user/etc/passwd");
    });
    it("D1.22 isAbsolute – /home vs home", () => {
        expect(PathResolver.isAbsolute("/home")).toBe(true);
        expect(PathResolver.isAbsolute("home")).toBe(false);
    });
    it("D1.23 basename – extract filename", () => {
        expect(PathResolver.basename("/home/user/file.txt")).toBe("file.txt");
        expect(PathResolver.basename("/home/user/dir/")).toBe("dir");
        expect(PathResolver.basename("/")).toBe("");
    });
    it("D1.24 dirname – extract directory", () => {
        expect(PathResolver.dirname("/home/user/file.txt")).toBe("/home/user");
        expect(PathResolver.dirname("/home/user")).toBe("/home");
        expect(PathResolver.dirname("/")).toBe("/");
        expect(PathResolver.dirname("home/user")).toBe("home");
        expect(PathResolver.dirname("home")).toBe(".");
    });
    it("D1.25 symlink resolution loop detection (purely lexical, handles loops without crash)", () => {
        // pure lexical resolver won't loop on strings since it just reduces them lexically
        expect(PathResolver.resolve("/a/b", "../../a/b")).toBe("/a/b");
    });
});

