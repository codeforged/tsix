/**
 * EXECUTABLE REGISTRY
 * 
 * Ibarat tabel pemetaan antara nama binary di simulator 
 * dengan lokasi file fisik di host (Node.js).
 */
export class ExecutableRegistry {
    private apps: Map<string, string> = new Map();

    constructor() {
        // Registrasi default akan dilakukan oleh Kernel saat boot
    }

    public register(vfsPath: string, physicalPath: string) {
        this.apps.set(vfsPath, physicalPath);
    }

    public getPhysicalPath(vfsPath: string): string | undefined {
        return this.apps.get(vfsPath);
    }

    public listApps(): string[] {
        return Array.from(this.apps.keys());
    }
}

