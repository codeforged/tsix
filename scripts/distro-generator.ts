import * as path from "path";
import { generateDistro, previewDistro } from "./lib/distro-generator";

interface CliOptions {
    manifest: string;
    check: boolean;
}

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {
        manifest: "distro/manifests/iot-edition.json",
        check: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === "--manifest") {
            const value = argv[++index];
            if (!value) throw new Error("--manifest requires a path.");
            options.manifest = value;
        } else if (argument === "--check") {
            options.check = true;
        } else if (argument === "--help" || argument === "-h") {
            console.log(`Usage: npm run distro:generate -- [options]

  --manifest <path>  Source manifest relative to the repository root
  --check            Validate and preview without copying files`);
            process.exit(0);
        } else {
            throw new Error(`Unknown option: ${argument}`);
        }
    }
    return options;
}

function main(): void {
    const root = path.resolve(__dirname, "..");
    const options = parseArgs(process.argv.slice(2));
    if (options.check) {
        const preview = previewDistro(root, options.manifest);
        console.log(`[distro:generate] ${preview.distroName}: ${preview.fileCount} source files`);
        console.log(`[distro:generate] output: ${preview.outputDirectory}`);
        return;
    }
    const result = generateDistro(root, options.manifest);
    console.log(`[distro:generate] ${result.distroName}: ${result.fileCount} source files copied`);
    console.log(`[distro:generate] output: ${result.outputDirectory}`);
    console.log(`[distro:generate] manifest: ${path.relative(root, result.manifestPath).replace(/\\/g, "/")}`);
}

try {
    main();
} catch (error) {
    console.error(`[distro:generate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
