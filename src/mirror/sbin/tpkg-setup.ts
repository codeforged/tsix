import { UserLib } from "../lib/UserLib";

/**
 * TPKG-SETUP - Mempersiapkan repository lokal untuk demo/testing.
 */
export class Main {
    async execute(lib: UserLib, args: string[]) {
        await lib.std.print("Setting up test repository...\n");

        const repoPath = "/etc/tpkg";
        if (!await this.exists(lib, repoPath)) {
            await lib.fs.mkdir(repoPath);
        }

        // 1. Buat file sampel yang akan dipaketkan
        const sampleBin = "/opt/test/hello-pkg.ts";
        const sampleContent = `
import { UserLib } from "../lib/UserLib";
export class Main {
    async execute(lib: UserLib, args: string[]) {
        await lib.std.print("Hello from a package installed via TPKG! 📦\\n");
    }
}
        `;
        // Pastikan /opt/test ada (lokasi script test/demo)
        if (!await this.exists(lib, "/opt/test")) {
            await lib.fs.mkdir("/opt/test");
        }
        await lib.fs.writeFile(sampleBin, sampleContent);
        await lib.fs.chmod(sampleBin, 493);

        const sampleConfig = "/etc/pkg-demo.conf";
        await lib.fs.writeFile(sampleConfig, "version=1.0\nmode=demo");

        // 2. Buat Manifest (packages.json)
        const manifest = {
            version: "1.0",
            packages: [
                {
                    name: "hello-world",
                    version: "1.0.0",
                    description: "Sample package for TPKG testing",
                    author: "Antigravity",
                    needReboot: false,
                    onAfterDownload: "/opt/test/hello-pkg.ts",
                    items: [
                        { src: sampleBin, dst: "/opt/test/hello-pkg.ts" },
                        { src: sampleConfig, dst: "/etc/pkg-demo.conf" }
                    ]
                }
            ]
        };

        await lib.fs.writeFile(`${repoPath}/packages.json`, JSON.stringify(manifest, null, 2));
        await lib.std.print("✅ Test repository ready.\n");
        await lib.std.print("You can now run 'tpkgd' and then 'tpkg update localhost'.\n");
    }

    private async exists(lib: UserLib, path: string): Promise<boolean> {
        try {
            const s = await lib.fs.stat(path);
            return !!s;
        } catch (e) {
            return false;
        }
    }
}
