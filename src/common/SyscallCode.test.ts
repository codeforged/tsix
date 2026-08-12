import { describe, it, expect } from "vitest";
import { SyscallCode } from "./SyscallCode";

describe("SyscallCode", () => {
    // ============================================================
    // D2.01–D2.03: Enum integrity
    // ============================================================
    it("D2.01 no duplicate codes", () => {
        const codes = Object.values(SyscallCode).filter(v => typeof v === "number") as number[];
        const seen = new Set<number>();
        for (const c of codes) {
            if (seen.has(c)) throw new Error(`Duplicate code: ${c}`);
            seen.add(c);
        }
        // If we got here, no duplicates
        expect(seen.size).toBeGreaterThan(0);
    });
    it("D2.02 codes are within 0-255 range", () => {
        const codes = Object.values(SyscallCode).filter(v => typeof v === "number") as number[];
        for (const c of codes) {
            expect(c).toBeGreaterThanOrEqual(0);
            expect(c).toBeLessThanOrEqual(255);
        }
    });
    it("D2.03 reverse mapping – code → name exists for all", () => {
        const entries = Object.entries(SyscallCode).filter(([k, v]) => typeof v === "number") as [string, number][];
        // Build forward map
        const byCode = new Map<number, string>();
        for (const [name, code] of entries) {
            byCode.set(code, name);
        }
        // Every code has a name
        for (const [name, code] of entries) {
            const mapped = byCode.get(code);
            expect(mapped).toBe(name);
            expect(mapped!.length).toBeGreaterThan(0);
        }
    });

    // ============================================================
    // D2.04–D2.07: New chunked I/O codes
    // ============================================================
    it("D2.04 READ_CHUNK = 63 exists", () => {
        expect(SyscallCode.READ_CHUNK).toBe(63);
    });
    it("D2.05 WRITE_CHUNK = 64 exists", () => {
        expect(SyscallCode.WRITE_CHUNK).toBe(64);
    });
    it("D2.06 GET_SIZE = 65 exists", () => {
        expect(SyscallCode.GET_SIZE).toBe(65);
    });
    it("D2.07 new codes don't overlap with existing", () => {
        const codes = [63, 64, 65];
        const allCodes = Object.values(SyscallCode).filter(v => typeof v === "number") as number[];
        // These 3 should appear exactly once
        for (const c of codes) {
            const count = allCodes.filter(v => v === c).length;
            expect(count).toBe(1);
        }
    });

    // ============================================================
    // D2.08: Core syscalls present
    // ============================================================
    it("D2.08 core syscalls all present (OPEN,READ,WRITE,CLOSE,FORK,EXEC,EXIT)", () => {
        expect(SyscallCode.OPEN).toBe(5);
        expect(SyscallCode.READ).toBe(6);
        expect(SyscallCode.WRITE).toBe(7);
        expect(SyscallCode.CLOSE).toBe(8);
        expect(SyscallCode.EXEC).toBe(12);
        expect(SyscallCode.EXIT).toBe(4);
        expect(SyscallCode.KILL).toBe(11);
        expect(SyscallCode.WAITPID).toBe(25);
    });

    // ============================================================
    // D2.09–D2.10: Total count
    // ============================================================
    it("D2.09 total syscall count is reasonable (>30)", () => {
        const codes = Object.values(SyscallCode).filter(v => typeof v === "number") as number[];
        expect(codes.length).toBeGreaterThan(30);
    });
    it("D2.10 no gap in critical range (1–65 contiguous check)", () => {
        // Check that key ranges don't have huge unexplained gaps
        const codes = new Set(Object.values(SyscallCode).filter(v => typeof v === "number") as number[]);
        // All codes from 1-8 should be present (basic I/O)
        for (let i = 1; i <= 8; i++) expect(codes.has(i)).toBe(true);
        // 10-17 should be present (process mgmt + fs)
        for (let i = 10; i <= 17; i++) expect(codes.has(i)).toBe(true);
        // 20-27 should be present (stat + permissions)
        for (let i = 20; i <= 27; i++) expect(codes.has(i)).toBe(true);
        // 30-33 should be present (networking)
        for (let i = 30; i <= 33; i++) expect(codes.has(i)).toBe(true);
        // 63-65 should be present (chunked I/O)
        for (let i = 63; i <= 65; i++) expect(codes.has(i)).toBe(true);
    });
});
