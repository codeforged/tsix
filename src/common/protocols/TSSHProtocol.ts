export enum TSSHOpcode {
    HANDSHAKE_REQ  = 0x01, // Client hello
    HANDSHAKE_RESP = 0x02, // Server PubKey & Fingerprint
    KEY_EXCHANGE    = 0x03, // Client Encrypted SessionKey
    CONNECT_REQ    = 0x04, // Request TTY / Exec Command
    CONNECT_ACK    = 0x05, // Connection Accepted
    DATA           = 0x06, // Terminal I/O Stream
    RESIZE         = 0x07, // Window Resize (SIGWINCH)
    EXIT           = 0x08, // Graceful Exit
    PING           = 0x09  // Keep-alive Heartbeat
}

export enum TSSHChannel {
    CONTROL = 0x00, // Signals, Resize, Ping
    SHELL   = 0x01  // Terminal I/O Stream
}

export interface TSSHPacket {
    opcode: TSSHOpcode;
    channel: TSSHChannel;
    payload: Buffer;
}

export class TSSHProtocol {
    /**
     * Resurrect Buffer from IPC/MQTNL Kernel variations
     */
    static normalizeBuffer(raw: any): Buffer {
        if (!raw) return Buffer.alloc(0);
        if (Buffer.isBuffer(raw)) return raw;
        if (raw.type === "Buffer" && Array.isArray(raw.data)) return Buffer.from(raw.data);
        // Handle numbered-object decomposed buffers {"0":85,"1":0,...}
        if (typeof raw === "object" && typeof raw[0] === "number") {
            return Buffer.from(Object.values(raw) as number[]);
        }
        if (typeof raw === "string") {
            // Coba parse JSON dulu (buffer yang ter-stringify via loopback/JSON protocol)
            try {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.type === "Buffer" && Array.isArray(parsed.data)) {
                    return Buffer.from(parsed.data);
                }
                if (parsed && typeof parsed === "object" && typeof parsed[0] === "number") {
                    return Buffer.from(Object.values(parsed) as number[]);
                }
            } catch (_) {}
            return Buffer.from(raw, "binary");
        }
        return Buffer.alloc(0);
    }

    /**
     * Encode packet: [OPCODE: 1B] [CHANNEL: 1B] [LENGTH: 2B BE] [PAYLOAD: NB]
     */
    static pack(opcode: TSSHOpcode, channel: TSSHChannel, payload: Buffer | string = Buffer.alloc(0)): Buffer {
        const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
        const header = Buffer.alloc(4);

        header.writeUInt8(opcode, 0);
        header.writeUInt8(channel, 1);
        header.writeUInt16BE(body.length, 2);

        return Buffer.concat([header, body]);
    }

    /**
     * Decode packet from binary stream
     */
    static unpack(data: any): TSSHPacket | null {
        const buf = this.normalizeBuffer(data);
        if (buf.length < 4) return null; 

        const opcode = buf.readUInt8(0) as TSSHOpcode;
        const channel = buf.readUInt8(1) as TSSHChannel;
        const length = buf.readUInt16BE(2);

        if (buf.length < 4 + length) return null;

        const payload = buf.subarray(4, 4 + length);
        return { opcode, channel, payload };
    }
}