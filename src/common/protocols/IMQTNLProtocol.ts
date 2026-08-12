/**
 * IMQTNLProtocol (Interface v1.0)
 * 
 * Abstraksi untuk packing/unpacking paket MQTNL.
 * Menjamin modularitas dan pluggable protocol support (JSON vs Binary vs v2 dll).
 */
export interface IMQTNLProtocol {
    /**
     * getName(): Nama protokol (misal: "JSON", "Binary")
     */
    getName(): string;

    /**
     * getMagicByte(): Byte pertama penanda protokol dlm byte stream.
     * JSON biasanya '[' (0x5B). Binary kita tentukan 'B' (0x42). 
     */
    getMagicChars(): number[];
    
    /**
     * getTopicPrefix(): MQTT Topic Prefix (misal: "mqtnl@1.0/", "mqtnl@1.1/")
     */
    getTopicPrefix(): string;

    /**
     * pack(): Merubah objek packet internal menjadi Buffer/String untuk dikirim.
     * Output dari sini yang akan dikirim ke MQTT broker.
     */
    pack(packet: any): Buffer | string;
    
    /**
     * unpack(): Merubah raw data yang diterima menjadi objek packet internal.
     */
    unpack(data: Buffer | string): any;
}
