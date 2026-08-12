/**
 * TSD - TSIX Software Distribution
 * 
 * Common types and interfaces shared between tsd (client) and tsdd (server).
 */

/**
 * File entry in a distribution package
 */
export interface TsdFileEntry {
    src: string;        // Source path on server (absolute or relative to packages root)
    dst: string;        // Destination path on client (must be absolute, no .. traversal)
    permissions?: number; // Optional: chmod mode (e.g., 0o755)
    isExecutable?: boolean; // Mark as executable
}

/**
 * Manifest for a software distribution package
 */
export interface TsdManifest {
    // Identity
    name: string;           // Package name (alphanumeric + - only)
    version: string;        // Semantic version (e.g., 1.2.3)
    description: string;    // Short description
    author?: string;        // Author name

    // Content
    files: TsdFileEntry[];

    // Post-install
    onInstall?: string;     // Script to run after installation (path in rootfs)
    undoScript?: string;    // Script to run on rollback/uninstall

    // Metadata
    dependencies?: string[]; // Future: dependency list
    requiresReboot?: boolean;
    minVersion?: string;    // Minimum TSIX version required

    // Integrity (set by server)
    signature?: string;     // RSA signature of manifest
    checksum?: string;      // SHA-256 of all file contents
}

/**
 * Installation package with files
 */
export interface TsdPackage {
    manifest: TsdManifest;
    files: TsdPackageFile[];
}

export interface TsdPackageFile {
    path: string;          // Destination path
    content: string;       // File content (base64 or utf-8)
    size: number;
}

/**
 * Message types for MQTNL protocol
 */
export type TsdMessageType =
    | "handshake"
    | "handshake_ack"
    | "list_request"
    | "list_reply"
    | "info_request"
    | "info_reply"
    | "get_package"
    | "package_reply"
    | "get_diff"           // Differential update
    | "diff_reply"
    | "error"
    | "ack";

export interface TsdMessage {
    type: TsdMessageType;
    [key: string]: any;
}

/**
 * Handshake messages (plaintext RSA exchange)
 */
export interface HandshakeMessage {
    type: "handshake";
    publicKey: string;      // Client's RSA public key
    clientVersion: string;  // TSD protocol version
}

export interface HandshakeAckMessage {
    type: "handshake_ack";
    sessionKey: string;                  // Encrypted session key (RSA)
    publicKey: string;                   // Server's RSA public key
    fingerprint: string;                 // SHA-256 fingerprint
    serverVersion: string;
}

/**
 * List request/reply
 */
export interface ListRequestMessage {
    type: "list_request";
}

export interface ListReplyMessage {
    type: "list_reply";
    packages: Array<{
        name: string;
        version: string;
        description: string;
        author?: string;
    }>;
    signature: string;  // Signed by server
}

/**
 * Package info request/reply
 */
export interface InfoRequestMessage {
    type: "info_request";
    name: string;
}

export interface InfoReplyMessage {
    type: "info_reply";
    manifest: TsdManifest;
    signature: string;
}

/**
 * Full package download
 */
export interface GetPackageMessage {
    type: "get_package";
    name: string;
    version: string;
}

export interface PackageReplyMessage {
    type: "package_reply";
    manifest: TsdManifest;
    files: Array<{
        path: string;
        content: string;    // Base64 encoded
        size: number;
    }>;
    signature: string;      // Signature of all file hashes
}

/**
 * Differential update (delta transfer)
 */
export interface GetDiffMessage {
    type: "get_diff";
    name: string;
    fromVersion: string;
    toVersion: string;
}

export interface DiffReplyMessage {
    type: "diff_reply";
    name: string;
    fromVersion: string;
    toVersion: string;
    added: TsdPackageFile[];
    changed: TsdPackageFile[];
    removed: string[];      // Paths to remove
    signature: string;
}

/**
 * Error response
 */
export interface ErrorMessage {
    type: "error";
    message: string;
    suggestions?: string[]; // For typos, etc.
    code?: string;          // Error code
}

/**
 * Server configuration
 */
export interface TsddConfig {
    port: number;                      // MQTNL port (default 80)
    keysPath: string;                  // Path to RSA keys
    manifestsPath: string;             // Path to package manifests
    packagesPath: string;              // Path to files to distribute
    sessionTTL: number;               // Session timeout in ms
    maxBundleSize: number;            // Max bytes per package
    maxConnections: number;           // Max concurrent clients
    enableLogging: boolean;
}

/**
 * Client configuration
 */
export interface TsdConfig {
    cacheDir: string;                  // Package cache
    trustedRepos: string;              // Fingerprint whitelist
    configFile: string;               // Config storage
    maxRetries: number;               // Retry attempts
    retryBackoff: number;             // Backoff in ms
    timeoutHandshake: number;
    timeoutPackage: number;
    installDir: string;               // Where to install/stage files
}

/**
 * Installation state for atomic operations
 */
export interface TsdInstallState {
    packageName: string;
    version: string;
    stagedDir: string;              // Temp directory for staging
    files: Map<string, string>;     // path -> originalContent (for rollback)
    manifest?: TsdManifest;         // Package manifest for rollback and metadata
    status: "pending" | "staged" | "installed" | "rolled_back";
    startTime: number;
    endTime?: number;
}

/**
 * Session info on server
 */
export interface TsddSession {
    sessionKey: Buffer | string;
    clientFingerprint: string;
    createdAt: number;
    lastActivity: number;
    clientPubKey: string;
}

/**
 * Statistics/metrics
 */
export interface TsdMetrics {
    totalDownloads: number;
    totalInstalls: number;
    failedInstalls: number;
    rolledBack: number;
    cacheHits: number;
    averageDownloadTime: number;
}
