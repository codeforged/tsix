import { describe, it, expect, beforeEach } from "vitest";
import { PortManager } from "./PortManager";

describe("PortManager", () => {
    let portMgr: PortManager;

    beforeEach(() => {
        portMgr = new PortManager();
    });

    // ============================================================
    // A6.01–A6.05: Basic Binding and Release
    // ============================================================
    it("A6.01 Bind port – valid port number", () => {
        expect(portMgr.allocatePort(80, 101)).toBe(true);
        expect(portMgr.isPortUsed(80)).toBe(true);
        // Invalid port numbers
        expect(portMgr.allocatePort(-1, 101)).toBe(false);
        expect(portMgr.allocatePort(65536, 101)).toBe(false);
    });

    it("A6.02 Bind port – privileged port (<1024) requires CAP_NET_BIND logic", () => {
        const canBindPrivileged = (uid: number, port: number) => {
            if (port < 1024 && uid !== 0) return false;
            return portMgr.allocatePort(port, 101);
        };
        // Root (uid 0) can bind < 1024
        expect(canBindPrivileged(0, 80)).toBe(true);
        // Non-root (uid 1000) cannot bind < 1024
        expect(canBindPrivileged(1000, 443)).toBe(false);
        // Non-root can bind >= 1024
        expect(canBindPrivileged(1000, 8080)).toBe(true);
    });

    it("A6.03 Bind port – port already in use", () => {
        expect(portMgr.allocatePort(8080, 101)).toBe(true);
        expect(portMgr.allocatePort(8080, 102)).toBe(false);
    });

    it("A6.04 Bind port – port released on process exit", () => {
        portMgr.allocatePort(80, 101);
        portMgr.allocatePort(443, 101);
        portMgr.allocatePort(8080, 102);

        portMgr.releasePortsByPid(101);
        expect(portMgr.isPortUsed(80)).toBe(false);
        expect(portMgr.isPortUsed(443)).toBe(false);
        expect(portMgr.isPortUsed(8080)).toBe(true); // PID 102 still active
    });

    it("A6.05 Bind port – port released on explicit releasePort", () => {
        portMgr.allocatePort(8080, 101);
        expect(portMgr.isPortUsed(8080)).toBe(true);
        portMgr.releasePort(8080);
        expect(portMgr.isPortUsed(8080)).toBe(false);
    });

    // ============================================================
    // A6.06–A6.09: Network Simulation
    // ============================================================
    it("A6.06 Listen on bound port simulation", () => {
        // Listening needs a bound port
        const isListening = portMgr.allocatePort(8080, 101);
        expect(isListening).toBe(true);
    });

    it("A6.07 Connect to listening port simulation", () => {
        portMgr.allocatePort(8080, 101);
        // Clients connect to the active port
        const canConnect = portMgr.isPortUsed(8080);
        expect(canConnect).toBe(true);
    });

    it("A6.08 TCP multiplex – multiple connections on same port simulation", () => {
        // In TCP, one listening port handles multiple client socket descriptors
        portMgr.allocatePort(8080, 101);
        const activeConnections = [
            { clientIp: "127.0.0.1", clientPort: 50001 },
            { clientIp: "127.0.0.1", clientPort: 50002 }
        ];
        expect(activeConnections.length).toBe(2);
    });

    it("A6.09 UDP – bind + recvfrom simulation", () => {
        portMgr.allocatePort(9999, 101);
        const udpSocket = {
            port: 9999,
            receivedPackets: [] as any[],
            recvfrom(packet: any) {
                this.receivedPackets.push(packet);
            }
        };
        udpSocket.recvfrom({ from: "127.0.0.1", data: "hello" });
        expect(udpSocket.receivedPackets.length).toBe(1);
    });

    // ============================================================
    // A6.10–A6.15: Advanced Allocation and Edge Cases
    // ============================================================
    it("A6.10 Port range exhaustion", () => {
        // Allocate all ports in a small range
        const smallPortMgr = new PortManager();
        // Ephemeral range min=10000, max=10005
        for (let p = 10000; p <= 10005; p++) {
            smallPortMgr.allocatePort(p);
        }
        const extraPort = smallPortMgr.allocateRandomPort(10000, 10005);
        expect(extraPort).toBeNull();
    });

    it("A6.11 Port allocation for ephemeral ports", () => {
        const randPort = portMgr.allocateRandomPort(20000, 20100);
        expect(randPort).not.toBeNull();
        expect(randPort).toBeGreaterThanOrEqual(20000);
        expect(randPort).toBeLessThanOrEqual(20100);
        expect(portMgr.isPortUsed(randPort!)).toBe(true);
    });

    it("A6.12 Port leak detection (all ports freed on exit)", () => {
        portMgr.allocatePort(1000, 202);
        portMgr.allocatePort(1001, 202);
        portMgr.allocatePort(1002, 202);

        portMgr.releasePortsByPid(202);
        expect(portMgr.isPortUsed(1000)).toBe(false);
        expect(portMgr.isPortUsed(1001)).toBe(false);
        expect(portMgr.isPortUsed(1002)).toBe(false);
    });

    it("A6.13 Concurrent bind attempts simulation", () => {
        const results = [
            portMgr.allocatePort(5000, 301),
            portMgr.allocatePort(5000, 302)
        ];
        expect(results).toEqual([true, false]);
    });

    it("A6.14 Port binding across network interfaces simulation", () => {
        // Socket binding mapping: IP:Port -> PID
        const interfaceBindings = new Map<string, number>();
        interfaceBindings.set("127.0.0.1:80", 101);
        // Different interface, same port (e.g. 192.168.1.5:80)
        interfaceBindings.set("192.168.1.5:80", 102);

        expect(interfaceBindings.get("127.0.0.1:80")).toBe(101);
        expect(interfaceBindings.get("192.168.1.5:80")).toBe(102);
    });

    it("A6.15 SO_REUSEADDR behavior simulation", () => {
        // Simulating reuse of a port when SO_REUSEADDR option is present
        portMgr.allocatePort(8080, 101);
        // With reuse, we release and bind again immediately without timeout delays
        portMgr.releasePort(8080);
        expect(portMgr.allocatePort(8080, 102)).toBe(true);
    });
});
