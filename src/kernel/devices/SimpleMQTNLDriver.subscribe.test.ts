import { describe, it, expect, vi } from "vitest";

/**
 * SEC-21a — subscribe sempit.
 *
 * Dulu driver subscribe `${prefix}#` untuk setiap protocol, sehingga setiap
 * node menerima salinan SEMUA paket semua node di broker (lalu membuangnya
 * di software). Cukup alamat sendiri + broadcast, sama seperti firmware
 * tsixlib (`mqtnl@1.x/<id>` dan `mqtnl@1.x/*`).
 */

const subscribed: string[] = [];
const handlers: Record<string, (...a: any[]) => void> = {};

vi.mock("mqtt", () => ({
    connect: vi.fn(() => ({
        connected: true,
        on: (ev: string, cb: (...a: any[]) => void) => {
            handlers[ev] = cb;
        },
        subscribe: (t: string) => {
            subscribed.push(t);
        },
        publish: () => undefined,
    })),
}));

import { SimpleMQTNLDriver } from "./SimpleMQTNLDriver";

describe("SimpleMQTNLDriver — subscribe sempit (SEC-21a)", () => {
    it("tidak ada wildcard '#'; ada <prefix><alamat> dan <prefix>* untuk tiap protocol", () => {
        subscribed.length = 0;
        const drv = new SimpleMQTNLDriver("smqtnl0", "mqtt://dummy", "kebun");
        drv.init({ syslog: () => undefined } as any);
        handlers["connect"]();

        expect(subscribed.some((t) => t.includes("#"))).toBe(false);
        for (const prefix of ["mqtnl@1.0/", "mqtnl@1.1/", "mqtnl@1.2/"]) {
            expect(subscribed).toContain(`${prefix}kebun`);
            expect(subscribed).toContain(`${prefix}*`);
        }
    });
});

describe("SimpleMQTNLDriver — kredensial broker (SEC-21b)", () => {
    it("username/password diteruskan ke mqtt.connect, dan tidak muncul di log", async () => {
        const mqtt: any = await import("mqtt");
        const spy = mqtt.connect;
        const logs: string[] = [];
        const drv = new SimpleMQTNLDriver("smqtnl0", "mqtts://u1:urlpass@broker.example:8883", "kebun", {
            username: "kebun",
            password: "s3cr3t",
        });
        drv.init({ syslog: (m: string) => logs.push(m) } as any);

        const opts = spy.mock.calls.at(-1)?.[1] as any;
        expect(opts?.username).toBe("kebun");
        expect(opts?.password).toBe("s3cr3t");
        expect(logs.join("\n")).not.toContain("s3cr3t");
        expect(logs.join("\n")).not.toContain("urlpass");
        expect(logs.join("\n")).toContain("broker.example");
    });
});
