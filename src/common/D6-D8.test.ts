import { describe, it, expect } from "vitest";
import { GUIAction, IDOMNode, IGUIPayload } from "./GUITypes";

// D6
describe("GUITypes (D6)", () => {
    it("D6.01 GUIAction has all required enum values", () => {
        expect(GUIAction.CREATE_WINDOW).toBe("CREATE_WINDOW");
        expect(GUIAction.DESTROY_WINDOW).toBe("DESTROY_WINDOW");
        expect(GUIAction.MOUNT_NODE).toBe("MOUNT_NODE");
        expect(GUIAction.UNMOUNT_NODE).toBe("UNMOUNT_NODE");
        expect(GUIAction.UPDATE_PROPS).toBe("UPDATE_PROPS");
    });

    it("D6.02 IDOMNode has required fields", () => {
        const node: IDOMNode = { id: "test", tag: "div", props: {}, children: [] };
        expect(node.id).toBeDefined();
        expect(node.tag).toBeDefined();
        expect(node.props).toBeDefined();
        expect(node.children).toBeDefined();
    });

    it("D6.03 IGUIPayload has required fields", () => {
        const payload: IGUIPayload = {
            syscall: "GUI_REQ",
            pid: 1, wid: "w1", action: GUIAction.CREATE_WINDOW,
        };
        expect(payload.syscall).toBe("GUI_REQ");
        expect(payload.action).toBeDefined();
        expect(payload.wid).toBeDefined();
    });

    it("D6.04 GUIAction values are unique", () => {
        const vals = Object.values(GUIAction);
        expect(new Set(vals).size).toBe(vals.length);
    });

    it("D6.05 IDOMNode children is array", () => {
        const child: IDOMNode = { id: "c", tag: "span", props: { text: "hi" }, children: [] };
        const parent: IDOMNode = { id: "p", tag: "div", props: {}, children: [child] };
        expect(Array.isArray(parent.children)).toBe(true);
        expect(parent.children.length).toBe(1);
    });
});

// D7
import { SyscallRequest, SyscallResponse, IPCEvent, WorkerInitData } from "./IPCTypes";
import { SyscallCode } from "./SyscallCode";

describe("IPCTypes (D7)", () => {
    it("D7.01 SyscallRequest has required fields", () => {
        const req: SyscallRequest = { requestId: "r1", pid: 1, code: SyscallCode.PS, args: null };
        expect(req.requestId).toBe("r1");
        expect(req.pid).toBe(1);
    });

    it("D7.02 SyscallResponse success path", () => {
        const res: SyscallResponse = { requestId: "r1", success: true, data: { pid: 1 } };
        expect(res.success).toBe(true);
        expect(res.data).toBeDefined();
    });

    it("D7.03 SyscallResponse error path", () => {
        const res: SyscallResponse = { requestId: "r1", success: false, data: null, error: "Not found" };
        expect(res.success).toBe(false);
        expect(res.error).toBe("Not found");
    });

    it("D7.04 IPCEvent has type and data", () => {
        const ev: IPCEvent = { type: "signal", data: "SIGTERM" };
        expect(ev.type).toBe("signal");
        expect(ev.data).toBe("SIGTERM");
    });

    it("D7.05 WorkerInitData has required fields", () => {
        const init: WorkerInitData = { pid: 1, appName: "test", args: [] };
        expect(init.pid).toBe(1);
        expect(init.appName).toBe("test");
        expect(Array.isArray(init.args)).toBe(true);
    });
});

// D8
import { PacketFlags } from "./PacketFlags";

describe("PacketFlags (D8)", () => {
    it("D8.01 FLAG_DATA is 0", () => {
        expect(PacketFlags.FLAG_DATA).toBe(0);
    });

    it("D8.02 no overlapping values (unique)", () => {
        const vals = Object.values(PacketFlags).filter(v => typeof v === "number");
        expect(new Set(vals).size).toBe(vals.length);
    });

    it("D8.03 PING flags exist", () => {
        expect(PacketFlags.FLAG_PING_REQUEST).toBe(1);
        expect(PacketFlags.FLAG_PING_REPLY).toBe(2);
    });

    it("D8.04 File transfer flags exist", () => {
        expect(PacketFlags.FLAG_FILE_HEADER_INFO).toBe(10);
        expect(PacketFlags.FLAG_FILE_PAYLOAD_GETFILE).toBe(12);
    });

    it("D8.05 RSA handshake flags exist", () => {
        expect(PacketFlags.RSA_HANDSHAKE_REQ).toBe(20);
        expect(PacketFlags.AUTH_FAILED).toBe(22);
    });
});
