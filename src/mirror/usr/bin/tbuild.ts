import { IProgram, OSContext } from "../../lib/IProgram";

/**
 * TBUILD Utility
 * 
 * TSIX Build Tool. Transpile TypeScript (.ts) files to JavaScript (.js).
 */
export class main implements IProgram {
    private version: string = "2.1.0"; // Added minification support

    async execute({ std, fs, shell }: OSContext, args: string[]): Promise<string | void> {
        if (args.includes("--help") || args.includes("-h")) {
            return "Usage: tbuild <path_to_directory_or_file> [--no-minify]\n" +
                "       tbuild -v | --version\n\n" +
                "Transpile .ts files manually for performance.\n";
        }

        // Handle version flag
        if (args.length > 0 && (args[0] === "-v" || args[0] === "--version")) {
            return `tbuild v${this.version} (VFS-aware)\n`;
        }

        // SECURITY: tbuild requires access to host FS via esbuild and temp files
        const user = await shell.whoami();
        if (user.uid !== 0) {
            await std.print("Permission Denied: Only root can run tbuild. Use sudo.\n");
            return;
        }

        // Simple flag parsing for --minify (default is now TRUE again)
        let shouldMinify = true;
        const filteredArgs = args.filter(arg => {
            if (arg === "--no-minify") {
                shouldMinify = false;
                return false;
            }
            if (arg === "--minify") {
                shouldMinify = true;
                return false;
            }
            return true;
        });

        if (filteredArgs.length === 0) {
            return "Usage: tbuild <path_to_directory_or_file> [--no-minify]\n       tbuild -v | --version\n";
        }

        const targetPath = filteredArgs[0];

        // Memerlukan akses ke host modules (privileged)
        let hostFs: any, path: any, esbuild: any, os: any;
        try {
            hostFs = (global as any).require("fs");
            path = (global as any).require("path");
            esbuild = (global as any).require("esbuild");
            os = (global as any).require("os");
        } catch (e) {
            return "Error: tbuild requires privileged access to host modules (esbuild, fs, path, os).\n";
        }

        // Resolusi VFS path ke absolute
        let vfsTargetPath = targetPath;
        if (!targetPath.startsWith("/") && !targetPath.startsWith("~")) {
            const cwd = await shell.getcwd();
            vfsTargetPath = cwd === "/" ? "/" + targetPath : cwd + "/" + targetPath;
        }

        // Expand ~ to /root
        if (vfsTargetPath === "~" || vfsTargetPath.startsWith("~/")) {
            const home = await shell.getenv("HOME") || "/root";
            vfsTargetPath = vfsTargetPath.replace(/^~/, home);
        }

        // Check if target exists in VFS
        let stat: any;
        try {
            stat = await fs.stat(vfsTargetPath);
        } catch (e) {
            return `Error: Path not found in VFS: ${vfsTargetPath}\n`;
        }

        const filesToProcess: { vfsPath: string, fileName: string }[] = [];

        if (stat.type === "DIRECTORY") {
            // List directory and find .ts files
            const files = await fs.ls(vfsTargetPath);
            for (const file of files) {
                if (file.type === "FILE" && file.name.endsWith(".ts") && !file.name.endsWith(".d.ts")) {
                    const vfsFile = (vfsTargetPath.endsWith("/") ? vfsTargetPath : vfsTargetPath + "/") + file.name;
                    filesToProcess.push({ vfsPath: vfsFile, fileName: file.name });
                }
            }
        } else if (stat.type === "FILE") {
            if (targetPath.endsWith(".ts")) {
                const fileName = vfsTargetPath.split("/").pop() || targetPath;
                filesToProcess.push({ vfsPath: vfsTargetPath, fileName });
            } else {
                return "Error: File must be a .ts file.\n";
            }
        }

        if (filesToProcess.length === 0) {
            return "No .ts files found to transpile.\n";
        }

        await std.print(`[TBUILD] Optimizing ${shouldMinify ? "and Minifying " : ""} ${filesToProcess.length} files...\n`);

        let successCount = 0;
        let failCount = 0;

        // Create temp directory for compilation
        const tempDir = hostFs.mkdtempSync(path.join(os.tmpdir(), "tbuild-"));

        for (const item of filesToProcess) {
            const { vfsPath, fileName } = item;
            const vfsOutPath = vfsPath.replace(/\.ts$/, ".js");

            try {
                await std.print(`  -> Compiling ${fileName}... `);

                // 1. Read source from VFS (FRESH!)
                const sourceCode = await fs.readFile(vfsPath);
                if (!sourceCode || typeof sourceCode !== "string") {
                    throw new Error("Failed to read source from VFS");
                }

                // 2. Write to temp file for esbuild
                const tempInputFile = path.join(tempDir, fileName);
                const tempOutputFile = path.join(tempDir, fileName.replace(/\.ts$/, ".js"));
                hostFs.writeFileSync(tempInputFile, sourceCode, "utf-8");

                // 3. Compile with esbuild
                esbuild.buildSync({
                    entryPoints: [tempInputFile],
                    outfile: tempOutputFile,
                    bundle: false,
                    platform: "node",
                    format: "cjs",
                    target: "node20",
                    minify: shouldMinify,
                    logLevel: "error"
                });

                // 4. Read compiled output
                const compiledCode = hostFs.readFileSync(tempOutputFile, "utf-8");

                // 5. Write to VFS (FRESH!)
                await fs.writeFile(vfsOutPath, compiledCode);

                // Cleanup temp files
                hostFs.unlinkSync(tempInputFile);
                hostFs.unlinkSync(tempOutputFile);

                await std.print("DONE\n");
                successCount++;
            } catch (err: any) {
                await std.print(`FAILED: ${err.message}\n`);
                failCount++;
            }
        }

        // Cleanup temp directory
        try {
            hostFs.rmdirSync(tempDir);
        } catch (e) {
            // Ignore cleanup errors
        }

        return `\nTranspilation Complete.\nSuccess: ${successCount}\nFailed: ${failCount}\nTip: Run commands without .ts extension to use the optimized .js version.\n`;
    }
}
