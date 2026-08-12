import { describe, it, expect } from "vitest";
import {
    GUIAction,
    IDOMNode,
    IGUIPayload,
    IGUIEventIPC,
    IBrowserEvent
} from "./GUITypes";

describe("GUITypes (D6)", () => {
    // ============================================================
    // D6.01: IDOMNode
    // ============================================================
    it("D6.01 IDOMNode – required fields validation", () => {
        const node: IDOMNode = {
            id: "btn_submit_1",
            tag: "button",
            props: { text: "Login", disabled: false },
            children: []
        };
        expect(node.id).toBe("btn_submit_1");
        expect(node.tag).toBe("button");
        expect(node.props.text).toBe("Login");
        expect(node.children).toHaveLength(0);
    });

    it("D6.02 IGUIPayload – required fields validation", () => {
        const payload: IGUIPayload = {
            syscall: "GUI_REQ",
            pid: 101,
            wid: "w1",
            action: GUIAction.CREATE_WINDOW
        };
        expect(payload.syscall).toBe("GUI_REQ");
        expect(payload.pid).toBe(101);
        expect(payload.wid).toBe("w1");
        expect(payload.action).toBe(GUIAction.CREATE_WINDOW);
    });

    it("D6.03 IGUIEventIPC – required fields validation", () => {
        const event: IGUIEventIPC = {
            type: "GUI_EVENT",
            wid: "w1",
            targetId: "btn_1",
            eventType: "click"
        };
        expect(event.type).toBe("GUI_EVENT");
        expect(event.wid).toBe("w1");
        expect(event.targetId).toBe("btn_1");
    });

    it("D6.04 GUIAction – all enum values valid", () => {
        expect(GUIAction.CREATE_WINDOW).toBe("CREATE_WINDOW");
        expect(GUIAction.DESTROY_WINDOW).toBe("DESTROY_WINDOW");
        expect(GUIAction.MOUNT_NODE).toBe("MOUNT_NODE");
        expect(GUIAction.UNMOUNT_NODE).toBe("UNMOUNT_NODE");
        expect(GUIAction.UPDATE_PROPS).toBe("UPDATE_PROPS");
        expect(GUIAction.MINIMIZE_WINDOW).toBe("MINIMIZE_WINDOW");
        expect(GUIAction.RESTORE_WINDOW).toBe("RESTORE_WINDOW");
        expect(GUIAction.MAXIMIZE_WINDOW).toBe("MAXIMIZE_WINDOW");
        expect(GUIAction.UNMAXIMIZE_WINDOW).toBe("UNMAXIMIZE_WINDOW");
    });

    it("D6.05 Type guards – IDOMNode with nested children", () => {
        const parent: IDOMNode = {
            id: "div_root",
            tag: "div",
            props: { style: "color:red" },
            children: [
                {
                    id: "span_1",
                    tag: "span",
                    props: { text: "Hello" },
                    children: []
                }
            ]
        };
        expect(parent.children).toHaveLength(1);
        expect(parent.children[0].id).toBe("span_1");
        expect(parent.children[0].tag).toBe("span");
    });
});
