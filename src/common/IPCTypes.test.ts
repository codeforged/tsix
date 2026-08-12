import { describe, it, expect } from "vitest";
import { SyscallCode } from "./SyscallCode";
import { SyscallRequest, SyscallResponse, IPCEvent, WorkerInitData } from "./IPCTypes";

describe("IPCTypes (D7)", () => {
    // ============================================================
    // D7.01: Valid IPC Message
    // ============================================================
    it("D7.01 IPC message – valid SyscallRequest format", () => {
        const req: SyscallRequest = {
            requestId: "req_abc123",
            pid: 10,
            code: SyscallCode.READ,
            args: { path: "/etc/passwd" }
        };
        expect(req.requestId).toBe("req_abc123");
        expect(req.pid).toBe(10);
        expect(req.code).toBe(SyscallCode.READ);
        expect(req.args).toEqual({ path: "/etc/passwd" });
    });

    it("D7.02 IPC message – SyscallResponse with success", () => {
        const resp: SyscallResponse = {
            requestId: "req_abc123",
            success: true,
            data: "file content"
        };
        expect(resp.success).toBe(true);
        expect(resp.data).toBe("file content");
        expect(resp.error).toBeUndefined();
    });

    it("D7.03 IPC message – SyscallResponse with error", () => {
        const resp: SyscallResponse = {
            requestId: "req_xyz",
            success: false,
            data: null,
            error: "File not found"
        };
        expect(resp.success).toBe(false);
        expect(resp.error).toBe("File not found");
    });

    it("D7.04 IPC message – IPCEvent format", () => {
        const event: IPCEvent = {
            type: "SIGTERM",
            data: { signal: 15 }
        };
        expect(event.type).toBe("SIGTERM");
        expect(event.data.signal).toBe(15);
    });

    it("D7.05 IPC message – WorkerInitData serialization roundtrip", () => {
        const initData: WorkerInitData = {
            pid: 42,
            appName: "tsh.ts",
            args: ["-c", "echo hello"],
            env: { PATH: "/bin:/usr/bin" },
            appPath: "/bin/tsh.ts"
        };
        const serialized = JSON.stringify(initData);
        const deserialized: WorkerInitData = JSON.parse(serialized);
        expect(deserialized.pid).toBe(42);
        expect(deserialized.appName).toBe("tsh.ts");
        expect(deserialized.args).toEqual(["-c", "echo hello"]);
        expect(deserialized.env!.PATH).toBe("/bin:/usr/bin");
    });
});
