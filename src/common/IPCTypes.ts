import { SyscallCode } from "./SyscallCode";

/**
 * IPC PACKET TYPES
 * 
 * Digunakan untuk komunikasi antara Main Thread (Kernel) 
 * dan Worker Thread (Aplikasi User).
 */

export interface SyscallRequest {
    requestId: string;
    pid: number;
    code: SyscallCode;
    args: any;
}

export interface SyscallResponse {
    requestId: string;
    success: boolean;
    data: any;
    error?: string;
}

/**
 * IPC EVENT (Kernel -> Worker Push Notification)
 */
export interface IPCEvent {
    type: string;
    data: any;
}

/**
 * INIT DATA
 * Data awal yang dikirim Kernel ke Worker saat baru lahir.
 */
export interface WorkerInitData {
    pid: number;
    appName: string;
    args: string[];
    appPath?: string;
    stackBkfsPath?: string;
    appContent?: string;
    env?: Record<string, string>;
    vfsCache?: Record<string, string>;
}

