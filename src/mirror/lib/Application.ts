export { IProgram, OSContext } from "./IProgram";
import { IProgram, OSContext } from "./IProgram";
import { UserLib, StdLib, FsLib, ShellLib, NetworkLib } from "./UserLib";
import { DbLib } from "./DbLib";
import { RandomLib } from "./RandomLib";

/**
 * Application Framework (Ring 4)
 * v2.1: Explicit Import Architecture
 */

// Global access function for the current worker's lib
const getLib = (): UserLib => {
    const lib = (global as any)._tsixLib;
    if (!lib) throw new Error("TSIX Framework Error: UserLib not found in this thread!");
    return lib;
};

// Explicit Singleton Proxies
export const std: StdLib = new Proxy({} as StdLib, {
    get: (_, prop) => {
        const val = (getLib().std as any)[prop];
        return typeof val === "function" ? val.bind(getLib().std) : val;
    }
});

export const fs: FsLib = new Proxy({} as FsLib, {
    get: (_, prop) => {
        const val = (getLib().fs as any)[prop];
        return typeof val === "function" ? val.bind(getLib().fs) : val;
    }
});

export const shell: ShellLib = new Proxy({} as ShellLib, {
    get: (_, prop) => {
        const val = (getLib().shell as any)[prop];
        return typeof val === "function" ? val.bind(getLib().shell) : val;
    }
});

export const net: NetworkLib = new Proxy({} as NetworkLib, {
    get: (_, prop) => {
        const val = (getLib().net as any)[prop];
        return typeof val === "function" ? val.bind(getLib().net) : val;
    }
});

export const db: DbLib = new Proxy({} as DbLib, {
    get: (_, prop) => {
        const val = (getLib().db as any)[prop];
        return typeof val === "function" ? val.bind(getLib().db) : val;
    }
});

export const os = {
    get pid() { return getLib().getPid(); },
    get rand() { return new RandomLib((global as any)._tsixOsc || { std, fs, shell, aux: {} }); }
};

export type main_t = (args: string[]) => Promise<string | void>;

/**
 * Program Wrapper
 * 
 * Simple entry point adapter.
 */
export function Program(fn: main_t): any {
    return class implements IProgram {
        async execute(os: OSContext, args: string[]): Promise<string | void> {
            // Store OSContext for potential back-ref
            (global as any)._tsixOsc = os;
            try {
                return await fn(args);
            } catch (error: any) {
                // Coba kirim error ke parent (Asteracea/WM) via std.error
                try {
                    const { std } = os;
                    if (std && typeof std.error === 'function') {
                        const appName = args[0] || (global as any).__filename || 'app';
                        await std.error(
                            error.stack || error.message || String(error),
                            appName
                        );
                    }
                } catch (_) { /* std.error failure is non-fatal */ }
                throw error; // Re-throw agar WorkerEntry juga menangani
            }
        }
    };
}
