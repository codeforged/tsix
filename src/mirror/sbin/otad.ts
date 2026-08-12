import { Program, std, fs, net, shell } from "@tsix/Application";

// MQTNL OTA Server Daemon for ESP8266/ESP32
export default Program(async (args) => {
    // 1. Daemonize (Detach from TTY)
    if (await shell.daemonize("MQTNL OTA Server Daemon")) {
        // We are now in the background
    }

    const otaPort = 4000;
    const firmwareDir = "/opt/esp-ota/firmwares";
    const AK_FILE = "/opt/esp-ota/activation-keys.txt";
    const LOG_FILE = "/opt/esp-ota/service.log";
    const DEFAULT_CHUNK_SIZE = 2048;

    const serverFd = await net.listen(otaPort);
    if (serverFd < 0) {
        await std.log("❌ Failed to bind to OTA port " + otaPort, "otad");
        return;
    }

    // AK Registry Cache
    let akCache: string[] = [];
    let akCacheLoaded = false;

    async function ensureAKCache() {
        if (akCacheLoaded) return;
        try {
            const content = await fs.readFile(AK_FILE);
            if (content) {
                akCache = content.split("\n").map(k => k.trim()).filter(k => k.length > 0);
            }
        } catch (e) { }
        akCacheLoaded = true;
    }

    async function validateAK(ak: string): Promise<boolean> {
        if (!ak || ak.length !== 6) return false;
        await ensureAKCache();
        if (akCache.includes(ak)) return true;

        // If not found, force a reload and check again (handles manual file edits)
        akCacheLoaded = false;
        await ensureAKCache();
        return akCache.includes(ak);
    }

    async function consumeAK(ak: string): Promise<boolean> {
        if (!ak) return false;
        await ensureAKCache();

        const index = akCache.indexOf(ak);
        if (index !== -1) {
            akCache.splice(index, 1); // Single-use!
            try {
                await fs.writeFile(AK_FILE, akCache.join("\n") + "\n");
                // In daemon mode, we use log instead of print to TTY
                await std.log(`[OTA] AK '${ak}' consumed. (Remaining: ${akCache.length})`, "otad");
            } catch (e) {
                await std.log(`⚠️ Warning: Failed to sync AK registry to disk!`, "otad");
            }
            return true;
        }
        return false;
    }

    await std.log(`OTA Server listening on MQTNL Port ${otaPort}`, "otad");
    await std.log(`Firmware directory: ${firmwareDir}`, "otad");

    // Upgrade MQTNL security to handle device encryption automatically
    // const KEY_HEX = "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";
    // const secureOk = await net.ioctl(serverFd, 0x1001, { port: otaPort, sessionKey: KEY_HEX });
    // if (secureOk) {
    //     await std.log("🔐 MQTNL Session Key Applied successfully.", "otad");
    // } else {
    //     await std.log("⚠️ Warning: Failed to apply MQTNL Session Key.", "otad");
    // }

    // Firmware Cache (Map by path)
    const firmwareCache = new Map<string, { buffer: Buffer, size: number, mtime: number }>();

    async function loadFirmware(targetPath: string) {
        // Basic Security: Prevent directory traversal
        if (targetPath.includes('..')) {
            await std.log(`⚠️ Security Warning: Blocked traversal attempt for ${targetPath}`, "otad");
            return null;
        }

        try {
            const stats = await fs.stat(targetPath);
            if (!stats) return null;

            const cached = firmwareCache.get(targetPath);
            if (cached && cached.size === stats.size && cached.mtime === stats.mtime) {
                return cached;
            }

            const content = await fs.readFile(targetPath);
            if (content && content.length > 0) {
                const data = {
                    buffer: Buffer.from(content, 'binary').slice(0, stats.size),
                    size: stats.size,
                    mtime: stats.mtime
                };
                firmwareCache.set(targetPath, data);
                await std.log(`📦 Firmware ${cached ? 're-cached' : 'cached'}: ${targetPath} (${data.size} bytes)`, "otad");
                return data;
            }
        } catch (e) {
            await std.log(`❌ Failed to load firmware: ${targetPath}`, "otad");
        }
        return null;
    }

    async function logEvent(mac: string, dc: string, ak: string, path: string, status: string, msg: string = "") {
        const timestamp = new Date().toISOString();
        const entry = `${timestamp},${mac || "unknown"},${dc || "unknown"},${ak || "none"},${path},${status},"${msg.replace(/"/g, '""')}"\n`;
        try {
            let content = "";
            try {
                const existing = await fs.readFile(LOG_FILE);
                if (existing) content = existing;
            } catch (e) { }
            await fs.writeFile(LOG_FILE, content + entry);
        } catch (e: any) {
            await std.log(`⚠️ Failed to write to log file: ${e.message}`, "otad");
        }
    }

    // Track progress per device
    const activeDevices = new Map<string, { offset: number, lastSeen: number, path: string, ak?: string, mac?: string, dc?: string, virtualBuffer?: Buffer, virtualSize?: number }>();

    function compareVersions(v1: string, v2: string) {
        const a = v1.split('.').map(n => parseInt(n) || 0);
        const b = v2.split('.').map(n => parseInt(n) || 0);
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if ((a[i] || 0) > (b[i] || 0)) return 1;
            if ((a[i] || 0) < (b[i] || 0)) return -1;
        }
        return 0;
    }

    // In daemon mode, we don't render progress bar to TTY, but we might log it or just skip
    // We'll skip TTY rendering for background service

    // Main event loop
    while (true) {
        try {
            const client = await net.accept(serverFd);
            let srcAddress = client.src;
            let srcPort = client.port;
            let payloadStr = client.firstPkt.data;

            // [PROTOCOL] Reliable detection: check both top-level and nested (Kernel-safe)
            const isBinarySession = !!(client.isBinary || (client.firstPkt && client.firstPkt.isBinary));
            let payload = client.firstPkt.data;

            // [SUPER BINARY DISTILLERY] Resurrect IPC Buffers
            if (payload && payload.type === "Buffer" && Array.isArray(payload.data)) {
                payload = Buffer.from(payload.data);
            } else if (typeof payload === 'string' && payload.length === 9 && payload.charCodeAt(0) === 0x52) {
                // IPC passed it as a raw string! Resurrect it using binary encoding so offset/length bytes are preserved.
                payload = Buffer.from(payload, "binary");
            }

            const pStr = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);

            // [HIGH-SPEED] ASCII Request Detection ("R <offset> <length>")
            if (pStr.startsWith("R ")) {
                const parts = pStr.split(" ");
                if (parts.length >= 3) {
                    const offset = parseInt(parts[1], 10);
                    const len = parseInt(parts[2], 10);
                    const deviceData = activeDevices.get(srcAddress);

                    if (deviceData) {
                        const fw = await loadFirmware(deviceData.path);
                        if (fw) {
                            const chunk = (deviceData.virtualBuffer || fw.buffer).slice(offset, offset + len);
                            const otaHeader = Buffer.alloc(5);
                            otaHeader.writeUInt8(0x55, 0);
                            otaHeader.writeUInt32LE(offset, 1);
                            const binaryPacket = Buffer.concat([otaHeader, chunk]);

                            await net.sendto(serverFd, srcAddress, srcPort, binaryPacket);

                            const isEof = (offset + chunk.length) >= (deviceData.virtualSize || fw.size);
                            deviceData.offset = offset + chunk.length;
                            deviceData.lastSeen = Date.now();
                            activeDevices.set(srcAddress, deviceData);

                            if (isEof) {
                                if (deviceData.ak && !deviceData.path.endsWith(".json")) {
                                    const akConsumed = await consumeAK(deviceData.ak);
                                    if (akConsumed) {
                                        await logEvent(deviceData.mac || "unknown", deviceData.dc || "general", deviceData.ak, deviceData.path, "SUCCESS");
                                        await std.log(`[OTA] AK ${deviceData.ak} consumed for ${srcAddress} (High-Speed)`, "otad");
                                    } else {
                                        await logEvent(deviceData.mac || "unknown", deviceData.dc || "general", deviceData.ak, deviceData.path, "WARNING", "AK not found during consumption");
                                    }
                                } else if (deviceData.path.endsWith(".json")) {
                                    await logEvent(deviceData.mac || "unknown", deviceData.dc || "general", deviceData.ak || "none", deviceData.path, "INFO", "Metadata fetched");
                                }
                            }

                            continue; // Fast-path: Success, move to next packet
                        }
                    }
                }
            }

            // [DEBUG-TRACE] Final inspection
            await std.log(`[DEBUG] firstPkt Keys: ${JSON.stringify(Object.keys(client.firstPkt || {}))}`, "otad");
            await std.log(`[OTA] New packet from ${srcAddress}:${srcPort} (Proto: ${isBinarySession ? 'Binary 1.1' : 'Legacy 1.0'})`, "otad");

            if (typeof payloadStr === 'string') {
                try {
                    const cleanPayload = payloadStr.replace(/[\x00-\x1F\x7F]/g, '').trim();
                    const req = JSON.parse(cleanPayload);
                    let requestedPath = req.path || "/firmware.bin";
                    const mac = req.mac || "";
                    const dc = req.dc || "general";

                    // Prepend base directory if it's not already absolute (relative to firmwareDir)
                    if (!requestedPath.startsWith(firmwareDir)) {
                        requestedPath = `${firmwareDir}${requestedPath.startsWith('/') ? '' : '/'}${requestedPath}`;
                    }

                    if (req.cmd === "ota.info") {
                        await std.log(`[OTA] Request from ${srcAddress} (${mac}) [${dc}] for ${requestedPath}`, "otad");

                        // Step 1: Just validate AK (don't consume yet)
                        if (!await validateAK(req.ak)) {
                            await std.log(`❌ REJECTED: Invalid or expired AK '${req.ak}' from ${srcAddress}`, "otad");
                            await logEvent(mac, dc, req.ak, requestedPath, "FAILED", "Invalid or expired AK");
                            const res = { cmd: "ota.error", msg: "Invalid or expired activation key" };
                            await net.sendto(serverFd, srcAddress, srcPort, JSON.stringify(res));
                            continue;
                        }

                        const fw = await loadFirmware(requestedPath);

                        if (fw) {
                            let version = "latest";
                            let finalBuffer: Buffer | null = null;
                            let finalSize = fw.size;

                            if (requestedPath.endsWith(".json")) {
                                try {
                                    const meta = JSON.parse(fw.buffer.toString());
                                    if (Array.isArray(meta)) {
                                        // 1. Filter by Device Class
                                        let matches = meta.filter(m => m.deviceClass === dc);
                                        if (matches.length === 0) {
                                            // Fallback to general or first entry if no match? 
                                            // User said: "sesuaikan firmware mana yang akan diberikan berdasarkan deviceClassnya"
                                            // So if no match, it's effectively "not found" for that device class.
                                            await std.log(`❌ REJECTED: No firmware found for deviceClass '${dc}' in ${requestedPath}`, "otad");
                                            const res = { cmd: "ota.error", msg: `No firmware found for device class: ${dc}` };
                                            await net.sendto(serverFd, srcAddress, srcPort, JSON.stringify(res));
                                            continue;
                                        }

                                        let selected: any = null;
                                        if (req.v) {
                                            // 2a. Find explicit version
                                            selected = matches.find(m => m.version === req.v);
                                            if (!selected) {
                                                await std.log(`❌ REJECTED: Version ${req.v} not found for ${dc}`, "otad");
                                                const res = { cmd: "ota.error", msg: `FW ${req.v} not found!` };
                                                await net.sendto(serverFd, srcAddress, srcPort, JSON.stringify(res));
                                                continue;
                                            }
                                        } else {
                                            // 2b. Find highest version
                                            selected = matches.sort((a, b) => compareVersions(b.version, a.version))[0];
                                        }

                                        if (selected) {
                                            version = selected.version;
                                            const jsonStr = JSON.stringify(selected);
                                            finalBuffer = Buffer.from(jsonStr);
                                            finalSize = finalBuffer.length;
                                            await std.log(`🎯 Selected firmware: ${selected.name} v${version} for ${dc}`, "otad");
                                        }
                                    } else {
                                        // Legacy single object support
                                        if (meta.version) version = meta.version;
                                    }
                                } catch (e) {
                                    await std.log(`⚠️ Failed to parse version from JSON: ${requestedPath}`, "otad");
                                }
                            }

                            // Link initial session state
                            activeDevices.set(srcAddress, {
                                offset: 0,
                                lastSeen: Date.now(),
                                path: requestedPath,
                                ak: req.ak,
                                mac: mac,
                                dc: dc,
                                virtualBuffer: finalBuffer || undefined,
                                virtualSize: finalBuffer ? finalSize : undefined
                            });

                            const res = {
                                cmd: "ota.info_res",
                                version: version,
                                size: finalSize
                            };
                            await net.sendto(serverFd, srcAddress, srcPort, JSON.stringify(res));
                        } else {
                            // If firmware not found, AK stays valid for next time
                            await logEvent(mac, dc, req.ak, requestedPath, "FAILED", "Firmware not found");
                            const res = { cmd: "ota.error", msg: "Firmware not found" };
                            await net.sendto(serverFd, srcAddress, srcPort, JSON.stringify(res));
                        }
                    }
                    else if (req.cmd === "ota.read") {
                        const offset = req.offset || 0;
                        const len = req.len || DEFAULT_CHUNK_SIZE;

                        const deviceData = activeDevices.get(srcAddress);
                        const activeData = deviceData || { offset: 0, lastSeen: Date.now(), path: requestedPath, mac: mac, dc: dc, ak: "" };
                        let buffer: any = null;
                        let size = 0;

                        if (deviceData && deviceData.virtualBuffer) {
                            buffer = deviceData.virtualBuffer;
                            size = deviceData.virtualSize || 0;
                        } else {
                            const fw = await loadFirmware(requestedPath);
                            if (fw) {
                                buffer = fw.buffer;
                                size = fw.size;
                            }
                        }

                        if (buffer) {
                            const chunk = (buffer as any).slice(offset, offset + len);
                            const isEof = (offset + chunk.length) >= size;
                            if (isBinarySession && !requestedPath.endsWith(".json")) {
                                // [HIGH-SPEED BINARY] 
                                // Send raw bytes: [0x55] [OFFSET: 4] [DATA...]
                                const otaHeader = Buffer.alloc(5);
                                otaHeader.writeUInt8(0x55, 0);
                                otaHeader.writeUInt32LE(offset, 1);

                                const binaryPacket = Buffer.concat([otaHeader, chunk]);
                                await std.log(`[OTA] Streaming Binary Chunk (offset: ${offset}, size: ${chunk.length})`, "otad");
                                await net.sendto(serverFd, srcAddress, srcPort, binaryPacket);
                            } else {
                                // [LEGACY / METADATA]
                                const b64Chunk = chunk.toString('base64');
                                const res = {
                                    cmd: "ota.data",
                                    offset: offset,
                                    data: b64Chunk,
                                    eof: isEof
                                };
                                await net.sendto(serverFd, srcAddress, srcPort, JSON.stringify(res));
                            }

                            // Update device tracking
                            activeDevices.set(srcAddress, {
                                ...activeData,
                                offset: offset + chunk.length,
                                lastSeen: Date.now()
                            });

                            if (isEof) {
                                if (activeData.ak && !requestedPath.endsWith(".json")) {
                                    const akConsumed = await consumeAK(activeData.ak);
                                    if (akConsumed) {
                                        await logEvent(activeData.mac || mac, activeData.dc || dc, activeData.ak, requestedPath, "SUCCESS");
                                        await std.log(`[OTA] AK ${activeData.ak} consumed for ${srcAddress}`, "otad");
                                    } else {
                                        await logEvent(activeData.mac || mac, activeData.dc || dc, activeData.ak, requestedPath, "WARNING", "AK not found during consumption");
                                    }
                                } else if (requestedPath.endsWith(".json")) {
                                    await logEvent(activeData.mac || mac, activeData.dc || dc, activeData.ak || "none", requestedPath, "INFO", "Metadata fetched");
                                }
                            }
                        }
                    }
                } catch (e: any) {
                    await std.log(`⚠️ JSON Parse Error from ${srcAddress}: ${e.message}. Payload: ${payloadStr}`, "otad");
                }
            } else if (Buffer.isBuffer(payloadStr)) {
                await std.log(`📦 Received Raw Buffer (${payloadStr.length} bytes) from ${srcAddress}`, "otad");
            } else {
                await std.log(`❓ Received Unknown Payload Type from ${srcAddress}`, "otad");
            }
        } catch (err: any) {
            await std.log(`[Server Error] ${err.message}`, "otad");
        }
    }
});
