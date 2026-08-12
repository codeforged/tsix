# Airterm Protocol Specification

This document describes the Airterm protocol, used for secure remote terminal access over the MQTNL (Message Queue Transport Network Layer) protocol in the TSIX/NOS ecosystem.

---

## 1. Overview
Airterm provides an encrypted, authenticated, and full-duplex terminal bridge. It uses **RSA-2048 (OAEP)** for the initial key exchange and **ChaCha20-Poly1305** for symmetric data encryption.

### Core Components
- **Client**: Initiates the connection, generates the session key.
- **Server (airtermd)**: Listens on a specific MQTNL port (default: 25).
- **Handshake**: Negotiates security parameters in plain text before upgrading to an encrypted session.

---

## 2. Handshake Sequence

The handshake must occur sequentially. Until Step 4 is complete, all packets are sent as **Literal Strings (Plain Text)**.

| Step | Direction | Payload Structure | Description |
| :--- | :--- | :--- | :--- |
| **1** | C → S | `__request::key-exchange` | Client requests a handshake. |
| **2** | S → C | `__pubkey::<PEM_PUBKEY>::<FINGERPRINT>` | Server sends its RSA Public Key and its SHA256 fingerprint. |
| **3** | C → S | `__secretkey::<ENC_HEX_SESSION_KEY>` | Client generates a 32-byte Session Key, encrypts it with RSA (OAEP), and sends it as a Hex string. |
| **4** | S → C | `__status::done` | Server confirms reception and decryption of the session key. |
| **5** | C → S | `{"payload": "requestConnect"}` | **(Encrypted)** Client requests a high-level terminal session. |
| **6** | S → C | `!connectAccept!` | **(Encrypted)** Server accepts and spawns the remote shell. |

---

## 3. Cryptography Configuration

### A. Asymmetric Execution (RSA)
- **Algorithm**: RSA-2048.
- **Padding**: `RSA_PKCS1_OAEP_PADDING` (using SHA-1 or SHA-256 depending on implementation, TSIX uses standard Node.js `publicEncrypt` defaults).
- **Encoding**: Public keys are PEM-formatted. Encrypted session keys are transmitted as **HEX** strings.

### B. Symmetric Execution (ChaCha20-Poly1305)
After `__status::done`, the MQTNL driver must be upgraded using the session key.
- **Algorithm**: `chacha20-poly1305`.
- **Session Key**: 256-bit (32 bytes).
- **Nonce/IV**: 12 bytes (Generated randomly for every packet).
- **Auth Tag**: 16 bytes.
- **Packet Format (Concatenated HEX)**:
  `IV (12 bytes) + AUTH_TAG (16 bytes) + CIPHERTEXT (n bytes)`
  The entire concatenated buffer is then converted to a **HEX** string for MQTNL transmission.

---

## 4. Data Format (I/O Payloads)

Airterm uses a "Triple-Compatibility" JSON structure to support various NOS shell implementations (like `microShell`).

### Client → Server (Keystrokes)
Every keystroke is wrapped in a JSON object.

```json
{
  "payload": "io",
  "io": {
    "key": {
      "name": "r",
      "sequence": "r",
      "ctrl": false,
      "meta": false,
      "shift": false
    },
    "char": "r",
    "data": "r"
  }
}
```
- **name**: Name of the key (e.g., "Enter", "a", "\u001b[A").
- **sequence**: MANDATORY for legacy NOS. Usually the same as name or the raw escape sequence.
- **char**: Standard property for `microShell`.
- **data**: Fallback property for legacy Airterm modules.

### Server → Client (Output)
The server can send data in two ways:
1. **Raw String**: Direct terminal output (ANSI escape codes, text).
2. **JSON Wrapped**: Using `{ "payload": "io", "io": { "data": "..." } }` (Legacy compatibility).

---

## 5. Control Signals

| Signal | Mode | Description |
| :--- | :--- | :--- |
| `__termresize::<rows>,<cols>` | Encrypted JSON | Notifies the server to change the PTY size. |
| `!exit!` | Encrypted String | Sent by the server to signal session termination. |
| `Bye...\r\n` | Encrypted String | Optional human-readable exit message. |

---

## 6. Implementation Notes for Future AI
- **Enter Key**: Always normalize Enter to `\n` for `microShell` compatibility.
- **Security Context**: Ensure the network driver (MQTNL) maps the security agent to the specific `localPort` used during the handshake.
- **Binary vs Hex**: While internal libraries use Buffers, the MQTNL medium expects **String** payloads. Always convert encrypted binary to Hex before sending.
