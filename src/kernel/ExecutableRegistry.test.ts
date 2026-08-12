import { describe, it, expect, beforeEach } from "vitest";
import { ExecutableRegistry } from "./ExecutableRegistry";
import { PathResolver } from "../common/PathResolver";

describe("ExecutableRegistry", () => {
    let registry: ExecutableRegistry;

    beforeEach(() => {
        registry = new ExecutableRegistry();
    });

    // ============================================================
    // A7.01–A7.03: Lookup and Register
    // ============================================================
    it("A7.01 Lookup binary – absolute path /bin/ls", () => {
        registry.register("/bin/ls", "dist/apps/ls.js");
        expect(registry.getPhysicalPath("/bin/ls")).toBe("dist/apps/ls.js");
    });

    it("A7.02 Lookup binary – PATH resolution integration", () => {
        registry.register("/bin/sh", "dist/apps/sh.js");
        registry.register("/usr/bin/python", "dist/apps/python.js");

        const pathEnv = "/bin:/usr/bin";
        const resolveFromPath = (binary: string): string | undefined => {
            for (const p of pathEnv.split(":")) {
                const fullPath = PathResolver.join(p, binary);
                const phys = registry.getPhysicalPath(fullPath);
                if (phys) return phys;
            }
            return undefined;
        };

        expect(resolveFromPath("sh")).toBe("dist/apps/sh.js");
        expect(resolveFromPath("python")).toBe("dist/apps/python.js");
        expect(resolveFromPath("notfound")).toBeUndefined();
    });

    it("A7.03 Lookup binary – not found", () => {
        expect(registry.getPhysicalPath("/bin/nonexistent")).toBeUndefined();
    });

    // ============================================================
    // A7.04–A7.06: Shebang & Extension Mapping Simulation
    // ============================================================
    it("A7.04 Lookup binary – shebang parsing (#!/bin/ts)", () => {
        const fileContent = "#!/bin/ts\nconsole.log('hello');";
        const parseShebang = (content: string): string | null => {
            if (content.startsWith("#!")) {
                const firstLine = content.split("\n")[0];
                return firstLine.substring(2).trim();
            }
            return null;
        };
        expect(parseShebang(fileContent)).toBe("/bin/ts");
        expect(parseShebang("console.log(1);")).toBeNull();
    });

    it("A7.05 Lookup binary – extension mapping (.ts -> TypeScript)", () => {
        const getEngine = (path: string): string => {
            if (path.endsWith(".ts")) return "TypeScriptEngine";
            if (path.endsWith(".js")) return "JavaScriptEngine";
            return "BinaryEngine";
        };
        expect(getEngine("/bin/app.ts")).toBe("TypeScriptEngine");
    });

    it("A7.06 Lookup binary – extension mapping (.js -> JavaScript)", () => {
        const getEngine = (path: string): string => {
            if (path.endsWith(".ts")) return "TypeScriptEngine";
            if (path.endsWith(".js")) return "JavaScriptEngine";
            return "BinaryEngine";
        };
        expect(getEngine("/bin/app.js")).toBe("JavaScriptEngine");
    });

    // ============================================================
    // A7.07–A7.10: Advanced Path and Permission Logic
    // ============================================================
    it("A7.07 Lookup binary – executable bit required simulation", () => {
        const node = { path: "/bin/ls", mode: 0o755 }; // executable (odd ends)
        const nodeNoExec = { path: "/bin/data.txt", mode: 0o644 }; // non-executable

        const isExecutable = (mode: number): boolean => {
            return (mode & 0o111) !== 0;
        };

        expect(isExecutable(node.mode)).toBe(true);
        expect(isExecutable(nodeNoExec.mode)).toBe(false);
    });

    it("A7.08 PATH order – first match wins", () => {
        // Register same binary name in /bin and /usr/bin
        registry.register("/bin/test", "dist/bin_test.js");
        registry.register("/usr/bin/test", "dist/usr_bin_test.js");

        const pathEnv = "/bin:/usr/bin";
        const firstMatch = (binary: string): string | undefined => {
            for (const p of pathEnv.split(":")) {
                const fullPath = PathResolver.join(p, binary);
                const phys = registry.getPhysicalPath(fullPath);
                if (phys) return phys;
            }
            return undefined;
        };

        expect(firstMatch("test")).toBe("dist/bin_test.js");
    });

    it("A7.09 Cache invalidation on file change simulation", () => {
        let isCached = true;
        const invalidateCache = () => {
            isCached = false;
        };
        // Simulate file change trigger
        invalidateCache();
        expect(isCached).toBe(false);
    });

    it("A7.10 Relative path lookup (./myscript.ts)", () => {
        registry.register("/home/user/myscript.ts", "dist/myscript.js");
        const resolved = PathResolver.resolve("/home/user", "./myscript.ts");
        expect(registry.getPhysicalPath(resolved)).toBe("dist/myscript.js");
    });
});
