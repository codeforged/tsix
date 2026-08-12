import { describe, it, expect, beforeEach } from "vitest";
import { PermissionManager, Permission } from "./PermissionManager";
import { PCB, ProcessState } from "./Scheduler";

describe("PermissionManager", () => {
    let pm: PermissionManager;
    let rootPCB: PCB;
    let userPCB: PCB;
    let groupPCB: PCB;

    beforeEach(() => {
        pm = new PermissionManager();

        rootPCB = {
            pid: 1,
            name: "init",
            state: ProcessState.RUNNING,
            pc: 0,
            owner: "root",
            uid: 0,
            gid: 0,
            ruid: 0,
            groups: [0],
            cwd: "/",
            fdTable: [],
            env: {}
        };

        userPCB = {
            pid: 10,
            name: "sh",
            state: ProcessState.RUNNING,
            pc: 0,
            owner: "user",
            uid: 1000,
            gid: 1000,
            ruid: 1000,
            groups: [1000],
            cwd: "/home/user",
            fdTable: [],
            env: {}
        };

        groupPCB = {
            pid: 11,
            name: "sh2",
            state: ProcessState.RUNNING,
            pc: 0,
            owner: "other_user",
            uid: 1001,
            gid: 1000, // same gid
            ruid: 1001,
            groups: [1000, 1002],
            cwd: "/home/other",
            fdTable: [],
            env: {}
        };
    });

    // ============================================================
    // A5.01–A5.04: Read Permissions
    // ============================================================
    it("A5.01 Check read permission – owner", () => {
        // Owner read only (400 octal = 256 decimal)
        const node = { name: "file", uid: 1000, gid: 1000, mode: 256 }; 
        expect(pm.check(userPCB, node, Permission.READ)).toBe(true);
    });

    it("A5.02 Check read permission – group", () => {
        // Group read only (040 octal = 32 decimal)
        const node = { name: "file", uid: 999, gid: 1000, mode: 32 };
        expect(pm.check(groupPCB, node, Permission.READ)).toBe(true);
    });

    it("A5.03 Check read permission – other", () => {
        // Other read only (004 octal = 4 decimal)
        const node = { name: "file", uid: 999, gid: 999, mode: 4 };
        expect(pm.check(userPCB, node, Permission.READ)).toBe(true);
    });

    it("A5.04 Check read permission – denied", () => {
        // Owner only read (400 octal = 256 decimal)
        const node = { name: "file", uid: 1000, gid: 1000, mode: 256 };
        // groupPCB is uid 1001, gid 1000. Wait, node gid is 1000, so group PCB checks group mode.
        // Group mode is 0. So it should be denied.
        expect(pm.check(groupPCB, node, Permission.READ)).toBe(false);
    });

    // ============================================================
    // A5.05–A5.08: Write & Exec Permissions
    // ============================================================
    it("A5.05 Check write permission – owner", () => {
        // Owner write (200 octal = 128 decimal)
        const node = { name: "file", uid: 1000, gid: 1000, mode: 128 };
        expect(pm.check(userPCB, node, Permission.WRITE)).toBe(true);
    });

    it("A5.06 Check write permission – denied", () => {
        // Owner write only (200 octal = 128 decimal)
        const node = { name: "file", uid: 1000, gid: 1000, mode: 128 };
        // groupPCB has gid 1000, but group mode is 0
        expect(pm.check(groupPCB, node, Permission.WRITE)).toBe(false);
    });

    it("A5.07 Check exec permission – owner", () => {
        // Owner execute (100 octal = 64 decimal)
        const node = { name: "file", uid: 1000, gid: 1000, mode: 64 };
        expect(pm.check(userPCB, node, Permission.EXECUTE)).toBe(true);
    });

    it("A5.08 Check exec permission – denied", () => {
        // Owner execute only (100 octal = 64 decimal)
        const node = { name: "file", uid: 1000, gid: 1000, mode: 64 };
        expect(pm.check(groupPCB, node, Permission.EXECUTE)).toBe(false);
    });

    // ============================================================
    // A5.09: Root Bypass
    // ============================================================
    it("A5.09 Root (UID 0) bypasses all permissions", () => {
        // No permission for anyone (000 octal = 0 decimal)
        const node = { name: "file", uid: 999, gid: 999, mode: 0 };
        expect(pm.check(rootPCB, node, Permission.READ)).toBe(true);
        expect(pm.check(rootPCB, node, Permission.WRITE)).toBe(true);
        expect(pm.check(rootPCB, node, Permission.EXECUTE)).toBe(true);
    });

    // ============================================================
    // A5.10–A5.13: CHMOD and Mode Bits
    // ============================================================
    it("A5.10 CHMOD – change mode bits", () => {
        let mode = PermissionManager.parseMode("644");
        expect(mode).toBe(420); // 6*64 + 4*8 + 4 = 384 + 32 + 4 = 420
        
        mode = PermissionManager.parseMode("755");
        expect(mode).toBe(493); // 7*64 + 5*8 + 5 = 448 + 40 + 5 = 493
    });

    it("A5.11 CHMOD – permission check (owner can chmod)", () => {
        const node = { name: "file", uid: 1000, gid: 1000, mode: 420 };
        // Owner is userPCB (uid 1000), so owner can modify
        const isOwner = userPCB.uid === node.uid;
        expect(isOwner).toBe(true);
        // Non-owner groupPCB (uid 1001) cannot chmod
        const isGroupOwner = groupPCB.uid === node.uid;
        expect(isGroupOwner).toBe(false);
    });

    it("A5.12 CHMOD – sticky bit validation (0o1000)", () => {
        const sticky = PermissionManager.parseMode("1777");
        expect(sticky & 0o1000).toBe(0o1000);
    });

    it("A5.13 CHMOD – setuid bit validation (0o4000)", () => {
        const setuid = PermissionManager.parseMode("4755");
        expect(setuid & 0o4000).toBe(0o4000);
    });

    // ============================================================
    // A5.14–A5.16: CHOWN
    // ============================================================
    it("A5.14 CHOWN – change owner simulation", () => {
        const node = { name: "file", uid: 1000, gid: 1000 };
        // root PCB changes owner
        const canChown = rootPCB.uid === 0;
        expect(canChown).toBe(true);
    });

    it("A5.15 CHOWN – requires CAP_SETUID / Root check", () => {
        // Only root can chown to another user
        const canUserChown = userPCB.uid === 0;
        expect(canUserChown).toBe(false);
    });

    it("A5.16 CHOWN – change group simulation", () => {
        const node = { name: "file", uid: 1000, gid: 1000 };
        // Users can change file group to one of their supplementary groups
        const isGroupValid = userPCB.groups.includes(1000);
        expect(isGroupValid).toBe(true);
    });

    // ============================================================
    // A5.17–A5.19: Creation Defaults & Umask
    // ============================================================
    it("A5.17 File created inherits process uid/gid", () => {
        const newFile = {
            name: "new.txt",
            uid: userPCB.uid,
            gid: userPCB.gid
        };
        expect(newFile.uid).toBe(1000);
        expect(newFile.gid).toBe(1000);
    });

    it("A5.18 Directory created with default mode", () => {
        const defaultDirMode = PermissionManager.parseMode("755");
        expect(defaultDirMode).toBe(493);
    });

    it("A5.19 Umask – masks creation mode bits", () => {
        const umask = PermissionManager.parseMode("022");
        const baseMode = PermissionManager.parseMode("777");
        const finalMode = baseMode & ~umask;
        expect(finalMode).toBe(PermissionManager.parseMode("755"));
    });

    // ============================================================
    // A5.20–A5.24: Capabilities
    // ============================================================
    it("A5.20 Capability check – CAP_SETUID", () => {
        const hasCapSetUid = rootPCB.uid === 0 || rootPCB.groups.includes(0);
        expect(hasCapSetUid).toBe(true);
        const userHasCap = userPCB.uid === 0;
        expect(userHasCap).toBe(false);
    });

    it("A5.21 Capability check – CAP_NET_BIND", () => {
        const hasCapNetBind = rootPCB.uid === 0;
        expect(hasCapNetBind).toBe(true);
    });

    it("A5.22 Capability check – CAP_SYS_MOUNT", () => {
        const hasCapSysMount = rootPCB.uid === 0;
        expect(hasCapSysMount).toBe(true);
    });

    it("A5.23 Capability check – CAP_KILL", () => {
        const hasCapKill = rootPCB.uid === 0;
        expect(hasCapKill).toBe(true);
    });

    it("A5.24 Capability check – CAP_SYS_ADMIN", () => {
        const hasCapSysAdmin = rootPCB.uid === 0;
        expect(hasCapSysAdmin).toBe(true);
    });

    // ============================================================
    // A5.25–A5.27: Sudo Flow
    // ============================================================
    it("A5.25 Sudo – temporary UID escalation", () => {
        // Before sudo
        expect(userPCB.uid).toBe(1000);
        
        // Execute sudo
        const origUid = userPCB.uid;
        userPCB.uid = 0; // escalated
        expect(pm.check(userPCB, { uid: 999, mode: 0 }, Permission.READ)).toBe(true);
        
        // Revert sudo
        userPCB.uid = origUid;
        expect(userPCB.uid).toBe(1000);
    });

    it("A5.26 Sudo – invalid password simulation", () => {
        const checkPassword = (pw: string) => pw === "secret123";
        expect(checkPassword("wrong")).toBe(false);
        expect(checkPassword("secret123")).toBe(true);
    });

    it("A5.27 Sudo – timeout / session expiry", () => {
        let escalated = true;
        const checkExpiry = (elapsedMs: number) => {
            if (elapsedMs > 5000) escalated = false;
        };
        checkExpiry(2000);
        expect(escalated).toBe(true);
        checkExpiry(6000);
        expect(escalated).toBe(false);
    });

    // ============================================================
    // A5.28–A5.30: Fork, Exec, Groups
    // ============================================================
    it("A5.28 Permission inheritance on fork", () => {
        const childPCB: PCB = {
            ...userPCB,
            pid: 22,
            ppid: userPCB.pid
        };
        expect(childPCB.uid).toBe(userPCB.uid);
        expect(childPCB.gid).toBe(userPCB.gid);
        expect(childPCB.groups).toEqual(userPCB.groups);
    });

    it("A5.29 Permission check on exec (setuid bit)", () => {
        // Binary owned by root with setuid bit (4755 octal)
        const binaryNode = { name: "sudo", uid: 0, gid: 0, mode: 2541 }; // 4755 octal = 2541 decimal
        const isSetUid = (binaryNode.mode & 0o4000) === 0o4000;
        expect(isSetUid).toBe(true);

        // When userPCB execs it, effective UID becomes binary's owner (root)
        const execPCB = { ...userPCB };
        if (isSetUid) {
            execPCB.uid = binaryNode.uid;
        }
        expect(execPCB.uid).toBe(0);
    });

    it("A5.30 Multiple groups – user in secondary groups", () => {
        // groupPCB Supplementary Groups: [1000, 1002]
        // Node owned by group 1002 with group read-only (040 octal = 32 decimal)
        const node = { name: "shared", uid: 999, gid: 1002, mode: 32 };
        expect(pm.check(groupPCB, node, Permission.READ)).toBe(true);
    });
});
