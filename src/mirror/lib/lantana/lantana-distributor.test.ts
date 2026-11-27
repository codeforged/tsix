/**
 * lantana-distributor.test.ts — Otorisasi command dan filter snapshot.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AcceptedReading } from "./lantana-core";

vi.mock("@tsix/Application", () => {
    const outbox: { pid: number; payload: any }[] = [];
    // PID yang sudah EXITED: kernel mengembalikan false, tidak melempar.
    const deadPids = new Set<number>();
    return {
        shell: {
            send: async (pid: number, payload: any) => {
                if (deadPids.has(pid)) return false;
                outbox.push({ pid, payload });
                return true;
            },
        },
        std: { log: async () => true },
        __outbox: outbox,
        __deadPids: deadPids,
    };
});

import * as app from "@tsix/Application";
import { DeviceBank } from "./lantana-device-bank";
import { LantanaDistributor } from "./lantana-distributor";
import { AccountManager } from "./account-manager";
import { SchemeRegistry } from "./scheme-registry";
import { PermissionPolicy } from "./permission-policy";

const outbox = (app as any).__outbox as { pid: number; payload: any }[];
const deadPids = (app as any).__deadPids as Set<number>;

const reading = (schemeId: number, value: number): AcceptedReading => ({
    readingId: `r-${schemeId}`,
    accountId: "acc",
    deviceId: "dev-1",
    schemeId,
    value,
    label: `S${schemeId}`,
    unit: "",
    receivedAt: 1000,
});

function setup() {
    const accounts = new AccountManager();
    accounts.createRoot("acc", {
        allowedQuerySchemes: [101],
        allowedCommandDevices: ["dev-1"],
    });
    accounts.createRoot("lain");

    const schemes = new SchemeRegistry();
    schemes.add({ schemeId: 101, ownerAccountId: "acc", label: "Suhu", type: "number" });
    schemes.add({ schemeId: 202, ownerAccountId: "acc", label: "Rahasia", type: "number" });

    const policy = new PermissionPolicy(accounts, schemes);
    const bank = new DeviceBank();
    bank.upsert("acc", "dev-1", { name: "Satu" }, [reading(101, 25), reading(202, 99)], { address: "10.0.0.9", port: 4100 }, 1000);

    return { distributor: new LantanaDistributor(bank, policy) };
}

describe("handleCommand", () => {
    beforeEach(() => {
        outbox.length = 0;
    });

    it("menolak command dari akun tanpa izin", async () => {
        const { distributor } = setup();
        const res = await distributor.handleCommand(77, {
            type: "LANTANA_COMMAND",
            accountId: "lain",
            deviceId: "dev-1",
            command: "RELAY_1:ON",
        });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/tidak berhak/);
    });

    it("menolak command ke device tanpa izin", async () => {
        const { distributor } = setup();
        const res = await distributor.handleCommand(77, {
            type: "LANTANA_COMMAND",
            accountId: "acc",
            deviceId: "dev-2",
            command: "RELAY_1:ON",
        });
        expect(res.ok).toBe(false);
    });

    it("mengirim command jika diizinkan dan endpoint tersedia", async () => {
        const { distributor } = setup();
        const calls: any[] = [];
        distributor.setCommandSender(async (accountId, deviceId, endpoint, command) => {
            calls.push({ accountId, deviceId, endpoint, command });
            return true;
        });

        const res = await distributor.handleCommand(77, {
            type: "LANTANA_COMMAND",
            accountId: "acc",
            deviceId: "dev-1",
            command: "RELAY_1:ON",
        });

        expect(res.ok).toBe(true);
        expect(calls).toEqual([
            {
                accountId: "acc",
                deviceId: "dev-1",
                endpoint: { address: "10.0.0.9", port: 4100 },
                command: "RELAY_1:ON",
            },
        ]);
        expect(outbox.at(-1)!.payload.type).toBe("LANTANA_COMMAND_RESULT");
    });

    it("melaporkan kegagalan pengiriman ke peminta", async () => {
        const { distributor } = setup();
        distributor.setCommandSender(async () => false);

        const res = await distributor.handleCommand(77, {
            type: "LANTANA_COMMAND",
            accountId: "acc",
            deviceId: "dev-1",
            command: "RELAY_1:ON",
        });

        expect(res.ok).toBe(false);
        expect(outbox.at(-1)!.payload.data.ok).toBe(false);
    });
});

describe("registrasi consumer", () => {
    it("menolak consumer tanpa accountId", () => {
        const { distributor } = setup();
        distributor.registerConsumer(88, "tanpa-akun");
        expect(distributor.consumerCount).toBe(0);
    });

    it("menerima consumer dengan accountId", () => {
        const { distributor } = setup();
        distributor.registerConsumer(88, "dengan-akun", "acc");
        expect(distributor.consumerCount).toBe(1);
    });

    it("membolehkan satu consumer berlangganan ke beberapa akun", async () => {
        outbox.length = 0;
        const { distributor } = setup();
        distributor.subscribeConsumer(88, "dashboard", "acc");
        distributor.subscribeConsumer(88, "dashboard", "lain");

        await distributor.broadcastBatch({
            type: "LANTANA_READING",
            accountId: "acc",
            deviceId: "dev-1",
            name: "Satu",
            category: "generic",
            receivedAt: 1000,
            dataAgeMs: 0,
            deviceStatus: "ONLINE",
            readings: [],
        });

        expect(outbox).toHaveLength(1);
        expect(outbox[0].pid).toBe(88);
    });

    it("dapat menghapus langganan satu akun tanpa menghapus akun lain", async () => {
        outbox.length = 0;
        const { distributor } = setup();
        distributor.subscribeConsumer(88, "dashboard", "acc");
        distributor.subscribeConsumer(88, "dashboard", "lain");
        distributor.unregisterConsumer(88, "acc");

        await distributor.broadcastBatch({
            type: "LANTANA_READING",
            accountId: "acc",
            deviceId: "dev-1",
            name: "Satu",
            category: "generic",
            receivedAt: 1000,
            dataAgeMs: 0,
            deviceStatus: "ONLINE",
            readings: [],
        });

        expect(outbox).toHaveLength(0);
        expect(distributor.consumerCount).toBe(1);
    });
});

describe("consumer mati", () => {
    const batch = {
        type: "LANTANA_READING" as const,
        accountId: "acc",
        deviceId: "dev-1",
        name: "Satu",
        category: "generic",
        receivedAt: 1000,
        dataAgeMs: 0,
        deviceStatus: "ONLINE" as const,
        readings: [],
    };

    beforeEach(() => {
        outbox.length = 0;
        deadPids.clear();
    });

    it("membuang consumer yang PID-nya sudah mati saat broadcast bacaan", async () => {
        const { distributor } = setup();
        distributor.registerConsumer(88, "hidup", "acc");
        distributor.registerConsumer(99, "mati", "acc");
        deadPids.add(99);

        await distributor.broadcastBatch(batch);

        expect(distributor.getConsumerPids()).toEqual([88]);
        expect(outbox.map((m) => m.pid)).toEqual([88]);
    });

    it("membuang consumer mati saat broadcast status, sekali saja per consumer", async () => {
        const { distributor } = setup();
        distributor.subscribeConsumer(99, "mati", "acc");
        distributor.subscribeConsumer(99, "mati", "lain");
        distributor.registerConsumer(88, "hidup", "acc");
        deadPids.add(99);

        await distributor.broadcastStatus(2000);

        expect(distributor.getConsumerPids()).toEqual([88]);
        expect(outbox.map((m) => m.payload.type)).toEqual(["LANTANA_DEVICE_STATUS"]);
    });

    it("membuang consumer yang mati sebelum menerima balasan snapshot", async () => {
        const { distributor } = setup();
        distributor.registerConsumer(99, "mati", "acc");
        deadPids.add(99);

        await distributor.sendSnapshot(99, "acc");

        expect(distributor.consumerCount).toBe(0);
    });
});

describe("snapshot", () => {
    it("hanya mengirim scheme yang boleh dibaca akun", async () => {
        outbox.length = 0;
        const { distributor } = setup();
        await distributor.sendSnapshot(77, "acc", "request-1");

        const reply = outbox.at(-1)!.payload;
        expect(reply.type).toBe("LANTANA_SNAPSHOT_REPLY");
        expect(reply.data.requestId).toBe("request-1");
        expect(reply.data.devices[0].readings.map((r: any) => r.schemeId)).toEqual([101, 202]);
    });

    it("akun tanpa izin query tidak menerima bacaan", async () => {
        outbox.length = 0;
        const { distributor } = setup();
        // Device milik "acc" tidak muncul untuk "lain" karena filter akun.
        await distributor.sendSnapshot(77, "lain");
        expect(outbox.at(-1)!.payload.data.devices).toEqual([]);
    });
});

describe("identitas pengirim IPC (SEC-13)", () => {
    beforeEach(() => {
        outbox.length = 0;
    });

    // Amplop kernel SEND_MSG: { fromPid, fromUser, data }. Hanya fromPid amplop
    // yang bisa dipercaya; `data` diisi bebas oleh pengirim.
    const envelope = (fromPid: number, data: any) => ({ fromPid, fromUser: "alice", data });

    it("payload.fromPid diabaikan: balasan snapshot dikirim ke PID amplop kernel", async () => {
        const { distributor } = setup();
        await distributor.onIpcMessage(envelope(42, { type: "LANTANA_SNAPSHOT", accountId: "acc", fromPid: 999 }));

        expect(outbox.map((o) => o.pid)).toEqual([42]);
    });

    it("REGISTER dengan payload.fromPid palsu → consumer terdaftar sebagai PID amplop", async () => {
        const { distributor } = setup();
        await distributor.onIpcMessage(envelope(42, { type: "LANTANA_REGISTER", name: "x", accountId: "acc", fromPid: 999 }));

        expect(distributor.getConsumerPids()).toEqual([42]);
    });

    it("UNREGISTER dengan payload.fromPid milik orang lain tidak menghapus consumer itu", async () => {
        const { distributor } = setup();
        await distributor.onIpcMessage(envelope(42, { type: "LANTANA_REGISTER", name: "korban", accountId: "acc" }));
        await distributor.onIpcMessage(envelope(66, { type: "LANTANA_UNREGISTER", fromPid: 42 }));

        expect(distributor.getConsumerPids()).toEqual([42]);
    });

    it("pesan tanpa amplop kernel diabaikan", async () => {
        const { distributor } = setup();
        await distributor.onIpcMessage({ type: "LANTANA_SNAPSHOT", accountId: "acc", fromPid: 999 });

        expect(outbox).toEqual([]);
    });
});
