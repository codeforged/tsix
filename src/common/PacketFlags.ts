/**
 * MQTNL PACKET FLAGS (Standard v1.0)
 */
export enum PacketFlags {
    FLAG_DATA = 0,
    FLAG_PING_REQUEST = 1,
    FLAG_PING_REPLY = 2,
    FLAG_BROADCAST_PING = 3,
    FLAG_BROADCAST_REPLY = 4,

    // File Transfer (Legacy/Extended)
    FLAG_FILE_HEADER_INFO = 10,
    FLAG_FILE_HEADER_GETFILE = 11,
    FLAG_FILE_PAYLOAD_GETFILE = 12,
    FLAG_FILE_LIST_RESPONSE = 13,
    FLAG_FILE_PUT_SUCCESS = 14,

    // Airterm V2 Handshake (Phase A)
    RSA_HANDSHAKE_REQ = 20,
    RSA_HANDSHAKE_ACK = 21,
    AUTH_FAILED = 22
}
