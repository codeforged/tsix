import { Logger } from "../common/Logger";
import { IDevice } from "./devices/IDevice";
import { Worker } from "worker_threads";
import { WorkerInitData, SyscallRequest } from "../common/IPCTypes";
import { Config } from "../common/Config";
import path from "path";

/**
 * PROCESS STATE
 */
export enum ProcessState {
    READY = "READY",
    RUNNING = "RUNNING",
    BLOCKED = "BLOCKED",
    EXITED = "EXITED"
}

/**
 * FILE DESCRIPTOR ENTRY
 */
export interface FDEntry {
    device: IDevice;
    context: any;
    flags?: string;
}

/**
 * PROCESS CONTROL BLOCK (PCB)
 * 
 * Data struktur yang menyimpan semua informasi tentang sebuah proses.
 */
export interface PCB {
    pid: number;                // ID Unik Proses
    ppid?: number;              // Parent PID — buat process tree
    name: string;               // Nama Proses (misal: "Shell")
    state: ProcessState;        // Status Saat Ini
    pc: number;                 // Program Counter (Alamat instruksi berikutnya)

    owner: string;              // User yang menjalankan (misal: "root")
    uid: number;                // User ID (Effective)
    gid: number;                // Group ID (Effective)
    ruid: number;               // Real User ID (Siapa yang aslinya nge-jalanin)
    groups: number[];           // Supplementary Groups
    suid?: number;              // Saved UID — utk restore root saat re-login (WM/login manager)
    cwd: string;               // Current Working Directory (Posisi sekarang)
    worker?: Worker;           // Raga asli proses di thread terpisah

    // FD TABLE sekarang berisi object FDEntry yang menunjuk ke Driver nyata.
    fdTable: (FDEntry | null)[];

    // Environment Variables
    env: Record<string, string>;
    exitCode?: number; // Explicit exit code set by Syscall
    ttyId?: number;    // ID Virtual Console (TTY) tempat proses ini berjalan
    uuid?: string;     // Unique Application Identity (Persistent across PID changes)
}


/**
 * SPAWN OPTIONS
 */
export interface SpawnOptions {
    appName?: string;
    appPath?: string;
    stackBkfsPath?: string;
    appContent?: string;
    args?: string[];
    fds?: IDevice[];
    cwd?: string;
    env?: Record<string, string>;
    uid?: number;
    gid?: number;
    ruid?: number;
    owner?: string;
    ttyId?: number;
    groups?: number[];
    suid?: number;
    ppid?: number;         // Parent PID — buat process tree
}

/**
 * SCHEDULER
 * 
 * Mengatur jalannya proses dan multitasking.
 */
export class Scheduler {
    private processes: PCB[] = [];
    private nextPid: number = 1;
    private ttyForegroundPids: Map<number, number> = new Map(); // mapping ttyId -> pid
    private logger: Logger;
    private syscallHandler?: (req: SyscallRequest) => Promise<any>;
    private vfsCacheProvider?: () => Record<string, string>;
    private uuidMap: Map<string, number> = new Map(); // uuid -> pid

    private waitQueue: Map<number, Array<(exitCode: number) => void>> = new Map();
    private onProcessExitCallback?: (pid: number) => void;

    constructor() {
        this.logger = new Logger("Scheduler");
        this.logger.info("Process Scheduler initialized.");
    }

    public setOnProcessExit(cb: (pid: number) => void) {
        this.onProcessExitCallback = cb;
    }

    public setSyscallHandler(handler: (req: SyscallRequest) => Promise<any>) {
        this.syscallHandler = handler;
    }

    public setVFSCacheProvider(provider: () => Record<string, string>) {
        this.vfsCacheProvider = provider;
    }

    public setForegroundProcess(pid: number | null, ttyId?: number) {
        if (pid !== null && !ttyId) {
            const pcb = this.getProcess(pid);
            ttyId = pcb?.ttyId || 1;
        }

        const targetTty = ttyId || 1;
        if (pid === null) {
            this.ttyForegroundPids.delete(targetTty);
        } else {
            this.ttyForegroundPids.set(targetTty, pid);
        }
    }

    public getForegroundProcess(ttyId: number = 1): number | null {
        return this.ttyForegroundPids.get(ttyId) || null;
    }

    /** getChildPids(): Dapatkan semua PID yang punya ppid = parentPid */
    public getChildPids(parentPid: number): number[] {
        return this.processes
            .filter(p => p.ppid === parentPid && p.state !== ProcessState.EXITED)
            .map(p => p.pid);
    }

    /** isAncestor(): Cek apakah ancestorPid adalah orangtua/leluhur dari pid */
    public isAncestor(ancestorPid: number, pid: number): boolean {
        let currentPid = pid;
        while (currentPid > 0) {
            if (currentPid === ancestorPid) return true;
            const pcb = this.getProcess(currentPid);
            currentPid = pcb?.ppid ?? 0;
        }
        return false;
    }

    /**
     * waitpid(): Menunggu sebuah proses selesai.
     * Mengembalikan Promise yang resolve dengan exit code proses tersebut.
     */
    public async waitpid(pid: number): Promise<number> {
        const pcb = this.getProcess(pid);

        // Jika proses sudah EXITED, langsung balikin 0 (atau simpan exit code di PCB)
        if (!pcb || pcb.state === ProcessState.EXITED) {
            const code = pcb?.exitCode ?? 0;
            // Jika proses sudah EXITED, kita reap sekalian biar gak jadi zombie
            this.reap(pid);
            return code;
        }

        // Proses yang ditunggu (foreground) berhak menerima interrupt Ctrl+C
        this.setForegroundProcess(pid, pcb.ttyId);

        return new Promise((resolve) => {
            if (!this.waitQueue.has(pid)) {
                this.waitQueue.set(pid, []);
            }
            this.waitQueue.get(pid)!.push(resolve);
        });
    }

    /**
     * detach(): Pelepasan raga proses dari parent (daemonize).
     * Membuat parent yang sedang waitpid() langsung resolve.
     */
    public async detach(pid: number): Promise<boolean> {
        const pcb = this.getProcess(pid);
        if (!pcb) return false;

        this.logger.info(`Detaching PID ${pid} (${pcb.name}). Moving to background.`);

        // 1. Resolve Wait Queue (si Shell jadi gak nungguin lagi)
        if (this.waitQueue.has(pid)) {
            const waiters = this.waitQueue.get(pid)!;
            waiters.forEach(resolve => resolve(0)); // Kasih status sukses (0)
            this.waitQueue.delete(pid);
        }

        // 2. Lepas dari Foreground TTY (biar Ctrl+C gak masuk sini lagi)
        if (pcb.ttyId && this.ttyForegroundPids.get(pcb.ttyId) === pid) {
            this.ttyForegroundPids.delete(pcb.ttyId);
        }

        // 3. Clear TTY Association (Crucial for ps display)
        pcb.ttyId = undefined;

        return true;
    }

    /**
     * kill(): Mengirim signal ke proses.
     */
    public async kill(pid: number, signal: number = 9, exitCode: number = 0): Promise<boolean> {
        const pcb = this.getProcess(pid);
        if (!pcb || !pcb.worker) return false;

        this.logger.warn(`Sending Signal ${signal} to PID ${pid} (${pcb.name})`);

        if (signal === 9) { // SIGKILL (Hard Kill)
            if (pcb.worker) {
                await pcb.worker.terminate().catch(() => { });
            }
            return true;
        }

        if (signal === 2) { // SIGINT (Ctrl+C)
            // Send event first to allow graceful handling
            const eventSent = this.sendEvent(pid, "signal", "SIGINT");

            // If no listener handled it, terminate after a brief delay
            // This preserves default Unix behavior: unhandled SIGINT = process exit
            setTimeout(async () => {
                const stillRunning = this.getProcess(pid);
                if (stillRunning && stillRunning.state !== ProcessState.EXITED && stillRunning.worker) {
                    this.logger.debug(`PID ${pid} did not handle SIGINT, terminating...`);
                    stillRunning.worker.terminate().catch(() => { });
                }
            }, 100); // 100ms grace period for handler to respond

            return eventSent;
        }

        if (signal === 19) { // SIGSTOP (Pause)
            pcb.state = ProcessState.BLOCKED;
            this.logger.info(`Process [${pid}] ${pcb.name} PAUSED (SIGSTOP)`);
            return this.sendEvent(pid, "signal", "SIGSTOP");
        }

        if (signal === 18) { // SIGCONT (Resume)
            pcb.state = ProcessState.RUNNING;
            this.logger.info(`Process [${pid}] ${pcb.name} RESUMED (SIGCONT)`);
            return this.sendEvent(pid, "signal", "SIGCONT");
        }

        if (signal === 15) { // SIGTERM (15)
            const eventSent = this.sendEvent(pid, "signal", "SIGTERM");
            setTimeout(async () => {
                const stillRunning = this.getProcess(pid);
                if (stillRunning && stillRunning.state !== ProcessState.EXITED && stillRunning.worker) {
                    this.logger.debug(`PID ${pid} did not handle SIGTERM, terminating...`);
                    stillRunning.worker.terminate().catch(() => { });
                }
            }, 300);
            return eventSent;
        }

        // Generic Signal Handling (HUP, USR1, etc)
        const sigNames: Record<number, string> = { 1: "SIGHUP", 10: "SIGUSR1", 12: "SIGUSR2" };
        const sigName = sigNames[signal] || `SIG${signal}`;
        return this.sendEvent(pid, "signal", sigName);
    }

    /**
     * sendInterruptSignal(): Mengirim SIGINT ke proses foreground pada TTY tertentu.
     */
    public async sendInterruptSignal(ttyId: number = 1): Promise<boolean> {
        const fgPid = this.ttyForegroundPids.get(ttyId);
        if (!fgPid) return false;

        const pcb = this.getProcess(fgPid);
        if (!pcb) return false;

        this.logger.info(`Interrupting Foreground PID ${fgPid} on TTY${ttyId}...`);
        const success = await this.kill(fgPid, 2);
        return success;
    }

    /**
     * createProcess(): Membuat proses baru.
     */
    public createProcess(name: string, options: SpawnOptions = {}): PCB | null {
        const pcb: PCB = {
            pid: this.nextPid++,
            name: name,
            state: ProcessState.READY,
            pc: 0,
            owner: options.owner || "root",
            uid: options.uid ?? 0,
            gid: options.gid ?? 0,
            ruid: options.ruid ?? (options.uid ?? 0),
            groups: options.groups ?? [],
            // Saved UID default = identitas proses itu sendiri, supaya app biasa
            // TIDAK bisa escalate (hanya proses yang tadi root yang punya
            // savedUid=0 → bisa balik ke root via setuid(0)).
            suid: options.suid ?? options.uid ?? 0,
            cwd: options.cwd ?? "/",
            fdTable: [],
            env: options.env ?? {},
            ttyId: options.ttyId,
            ppid: options.ppid ?? 0,
        };

        // Initialize FDs (0=stdin, 1=stdout, 2=stderr)
        if (options.fds && options.fds.length >= 3) {
            pcb.fdTable = [
                { device: options.fds[0], context: "", flags: "r" },
                { device: options.fds[1], context: "", flags: "w" },
                { device: options.fds[2], context: "", flags: "w" }
            ];
        }

        this.processes.push(pcb);

        if (options.appName || options.appPath) {
            this.spawnWorker(pcb, options);
        }

        return pcb;
    }

    private spawnWorker(pcb: PCB, options: SpawnOptions) {
        const cfg = Config.get();
        const workerData: WorkerInitData = {
            pid: pcb.pid,
            appName: options.appName || pcb.name,
            args: options.args || [],
            appPath: options.appPath,
            stackBkfsPath: options.stackBkfsPath,
            appContent: options.appContent,
            env: pcb.env,
            vfsCache: this.vfsCacheProvider ? this.vfsCacheProvider() : {}
        };
        const workerPath = path.resolve(__dirname, cfg.scheduler.workerEntryPath);
        // Deteksi apakah ini file JS untuk jalur cepat (JS-Direct)
        // Jika appPath kosong (VFS Content), cek appName atau nama prosesnya.
        const isJs = (options.appPath || options.appName || pcb.name)?.toLowerCase().endsWith(".js");
        const method = isJs ? "JS-Direct (FAST)" : "TS-Transpile";
        this.logger.info(`Spawning Worker for ${pcb.name} (PID: ${pcb.pid}) [Method: ${method}]`);

        const execArgv = ["--enable-source-maps"];
        if (!isJs) {
            const esbuildRegister = require.resolve("esbuild-register");
            const tsconfigPaths = require.resolve("tsconfig-paths/register");
            execArgv.push("-r", esbuildRegister, "-r", tsconfigPaths);
        }

        pcb.worker = new Worker(workerPath, {
            workerData,
            execArgv
        });

        pcb.state = ProcessState.RUNNING;

        // Dengarkan Syscall dari Worker
        pcb.worker.on("message", async (request: SyscallRequest) => {
            if (this.syscallHandler) {
                try {
                    const result = await this.syscallHandler(request);
                    if (pcb.worker) {
                        pcb.worker.postMessage({
                            requestId: request.requestId,
                            success: true,
                            data: result
                        });
                    }
                } catch (error: any) {
                    if (pcb.worker) {
                        pcb.worker.postMessage({
                            requestId: request.requestId,
                            success: false,
                            error: error.message
                        });
                    }
                }
            }
        });

        pcb.worker.on("error", (err) => {
            this.logger.error(`Worker [${pcb.pid}] Crash Error: ${err.message}`);
            pcb.state = ProcessState.EXITED;
        });

        pcb.worker.on("exit", (code) => {
            // If it was a reexec, we don't trigger the exit logic yet
            if (pcb.state === (ProcessState as any).REEXECING) return;

            pcb.state = ProcessState.EXITED;

            // Use explicit exitCode if set (from EXIT syscall), otherwise use worker exit code
            const finalCode = pcb.exitCode !== undefined ? pcb.exitCode : (code || 0);

            if (finalCode !== 0 && finalCode !== 1 && finalCode !== null) {
                this.logger.error(`Process [${pcb.pid}] ${pcb.name} terminated abnormally (Code: ${finalCode})`);
            } else {
                this.logger.debug(`Process [${pcb.pid}] ${pcb.name} exited gracefully (Code: ${finalCode}).`);
            }

            // Global Cleanup Hook (reset terminal, close FDs, etc)
            if (this.onProcessExitCallback) {
                this.onProcessExitCallback(pcb.pid);
            }

            // Auto-reparent orphans: semua child dari proses yang exit → init (PID 1)
            const allProcs = Array.from(this.processes.values());
            const orphans = allProcs.filter((p: PCB) => p.ppid === pcb.pid && p.state !== ProcessState.EXITED);
            for (const orphan of orphans) {
                orphan.ppid = 1;
                this.logger.info(`[REPARENT] Auto-reparent orphan PID ${orphan.pid} (${orphan.name}) to init (PID 1)`);
            }

            // Notify Wait Queue
            if (this.waitQueue.has(pcb.pid)) {
                const waiters = this.waitQueue.get(pcb.pid)!;
                waiters.forEach(resolve => resolve(finalCode));
                this.waitQueue.delete(pcb.pid);
                // Jika ada yang nunggu (waitpid), kita bisa reap sekarang
                this.reap(pcb.pid);
            } else {
                this.logger.warn(`Process [${pcb.pid}] became a ZOMBIE (Needs waitpid)`);
            }

            // Jika proses foreground yang mati, kembalikan ke NULL
            if (this.getForegroundProcess(pcb.ttyId) === pcb.pid) {
                this.setForegroundProcess(null, pcb.ttyId);
            }
        });
    }

    public async reexec(pid: number, appPath: string, args: string[]): Promise<boolean> {
        const pcb = this.getProcess(pid);
        if (!pcb || !pcb.worker) return false;

        this.logger.info(`Re-executing PID ${pid} with ${appPath}`);

        // 1. Mark as Re-execing to prevent 'exit' hook cleanup
        (pcb as any).state = "REEXECING"; // Custom transient state

        // 2. Terminate current worker (Non-blocking to caller)
        pcb.worker.terminate().catch(() => { });
        pcb.worker = undefined;

        // 3. Update PCB info
        pcb.name = path.basename(appPath);
        pcb.state = ProcessState.READY;
        pcb.exitCode = undefined;

        // 4. Spawn new worker
        this.spawnWorker(pcb, { appPath, args });

        return true;
    }

    /**
     * setProcessIdentity(): Memasang UUID permanen ke sebuah PID.
     * Mengembalikan false jika UUID sudah dipakai oleh proses aktif lain.
     */
    public setProcessIdentity(pid: number, uuid: string): boolean {
        // Cek apakah UUID sudah ada dan dipakai oleh proses lain yang aktif
        if (this.uuidMap.has(uuid) && this.uuidMap.get(uuid) !== pid) {
            const existingPid = this.uuidMap.get(uuid)!;
            const existingPcb = this.getProcess(existingPid);
            if (existingPcb && existingPcb.state !== ProcessState.EXITED) {
                this.logger.warn(`Failed to set identity: UUID ${uuid} already held by PID ${existingPid}`);
                return false;
            }
        }

        const pcb = this.getProcess(pid);
        if (!pcb) return false;

        // Jika pcb sebelumnya punya uuid lain, hapus dari map
        if (pcb.uuid && this.uuidMap.has(pcb.uuid)) {
            this.uuidMap.delete(pcb.uuid);
        }

        pcb.uuid = uuid;
        this.uuidMap.set(uuid, pid);
        this.logger.info(`PID ${pid} identified as ${uuid}`);
        return true;
    }

    public getPidByIdentity(uuid: string): number | undefined {
        const pid = this.uuidMap.get(uuid);
        if (pid !== undefined) {
            const pcb = this.getProcess(pid);
            if (pcb && pcb.state !== ProcessState.EXITED) return pid;
            // Clean up stale entry if found
            this.uuidMap.delete(uuid);
        }
        return undefined;
    }

    public getProcess(pid: number): PCB | undefined {
        return this.processes.find(p => p.pid === pid);
    }

    public listProcesses(): PCB[] {
        return this.processes;
    }

    /**
     * reap(): Membersihkan PCB dari memory setelah proses EXITED.
     * Dipanggil setelah waitpid() selesai atau jika proses tidak punya waiter.
     */
    public reap(pid: number): void {
        const index = this.processes.findIndex(p => p.pid === pid);
        if (index !== -1) {
            const pcb = this.processes[index];
            if (pcb.state === ProcessState.EXITED) {
                this.logger.debug(`Reaping Process ${pcb.name} (PID ${pid}). Memory freed.`);

                // Remove from uuidMap if registered
                if (pcb.uuid && this.uuidMap.get(pcb.uuid) === pid) {
                    this.uuidMap.delete(pcb.uuid);
                    this.logger.debug(`UUID ${pcb.uuid} released from PID ${pid}`);
                }

                this.processes.splice(index, 1);
            }
        }
    }

    /**
     * sendEvent(): Mengirim notifikasi asinkron ke worker (Kernel -> User push).
     */
    public sendEvent(pid: number, type: string, data: any): boolean {
        const pcb = this.getProcess(pid);
        if (pcb && pcb.worker && pcb.state !== ProcessState.EXITED) {
            pcb.worker.postMessage({ type, data });
            return true;
        }
        return false;
    }

    /**
     * broadcastEvent(): Mengirim event ke SEMUA proses yang aktif.
     */
    public broadcastEvent(type: string, data: any): void {
        this.processes.forEach(pcb => {
            if (pcb.worker && pcb.state !== ProcessState.EXITED) {
                pcb.worker.postMessage({ type, data });
            }
        });
    }
}
