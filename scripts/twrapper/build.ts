import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

interface PackageItem {
    src: string;
    dst: string;
    hostDst?: string;
    permissions?: number;
    isExecutable?: boolean;
}

interface TpkgPackage {
    name: string;
    version: string;
    description: string;
    items: PackageItem[];
    [key: string]: unknown;
}

interface Recipe {
    schemaVersion: 1;
    distro: {
        id: string;
        name: string;
        version: string;
        status: string;
        description: string;
        purpose: string[];
        features: string[];
    };
    outputDirectory: string;
    installedPackages: string[];
    repositoryPackages: string[];
}

interface OutputFile {
    bytes: Buffer;
    mode: number;
    sourcePath: string;
}

interface PreviousState {
    generatedFiles: Array<{ path: string; sha256: string }>;
}

const ROOT = path.resolve(__dirname, "../..");
const PACKAGE_MANIFEST = "src/mirror/etc/tpkg/packages.json";
const INSTALLER_FILES = [
    "LICENSE",
    "bootstrap.sh",
    "bootstrap.bat",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "scripts/install.ts",
    "scripts/lib/binary-mode.ts",
    "scripts/lib/fresh-accounts.ts",
    "scripts/lib/fresh-fstab.ts",
    "scripts/lib/text-file.ts",
    "scripts/lib/user-account.ts",
    "src/main.ts",
    "src/sysconfig.conf",
    "src/userland/WorkerEntry.js",
    "src/userland/VfsModuleResolver.js",
];
const STATE_FILE = ".twrapper-state.json";

function sha256(bytes: Buffer): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readJson(filePath: string, label: string): any {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        throw new Error(`Unable to read ${label} at ${filePath}: ${String(error)}`);
    }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
        throw new Error(`${label} must be a non-empty-string array.`);
    }
}

function parseRecipe(value: any): Recipe {
    if (value?.schemaVersion !== 1 || !value.distro || typeof value.distro !== "object") {
        throw new Error("Twrapper recipe must use schemaVersion 1 and include distro metadata.");
    }
    for (const field of ["id", "name", "version", "status", "description"]) {
        if (typeof value.distro[field] !== "string" || value.distro[field] === "") {
            throw new Error(`recipe.distro.${field} must be a non-empty string.`);
        }
    }
    assertStringArray(value.distro.purpose, "recipe.distro.purpose");
    assertStringArray(value.distro.features, "recipe.distro.features");
    assertStringArray(value.installedPackages, "recipe.installedPackages");
    assertStringArray(value.repositoryPackages, "recipe.repositoryPackages");
    if (typeof value.outputDirectory !== "string" || value.outputDirectory === "") {
        throw new Error("recipe.outputDirectory must be a non-empty string.");
    }
    const names = [...value.installedPackages, ...value.repositoryPackages];
    if (new Set(names).size !== names.length) {
        throw new Error("A package may appear only once across installedPackages and repositoryPackages.");
    }
    for (const name of names) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9+._-]*$/.test(name)) {
            throw new Error(`Invalid package name in recipe: ${name}`);
        }
    }
    return value as Recipe;
}

function assertRelativePath(value: string, label: string): string {
    const normalized = value.replace(/\\/g, "/");
    const segments = normalized.split("/");
    if (
        normalized === "" ||
        normalized.startsWith("/") ||
        normalized !== value ||
        segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
        throw new Error(`${label} must be a normalized relative path: ${value}`);
    }
    return normalized;
}

function resolveInsideRoot(relativePath: string): string {
    const target = path.resolve(ROOT, ...assertRelativePath(relativePath, "source path").split("/"));
    const relative = path.relative(ROOT, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Path escapes the project root: ${relativePath}`);
    }
    let current = ROOT;
    for (const segment of relative.split(path.sep)) {
        current = path.join(current, segment);
        if (fs.lstatSync(current).isSymbolicLink()) {
            throw new Error(`Refusing symlink source path: ${current}`);
        }
    }
    return target;
}

function addSource(
    outputs: Map<string, OutputFile>,
    sourceRelative: string,
    outputRelative: string = sourceRelative,
    replaceExisting: boolean = false,
): void {
    const sourcePath = assertRelativePath(sourceRelative, "source path");
    const destinationPath = assertRelativePath(outputRelative, "output path");
    const source = resolveInsideRoot(sourcePath);
    const stats = fs.lstatSync(source);
    if (!stats.isFile()) throw new Error(`Source is not a regular file: ${sourcePath}`);
    const bytes = fs.readFileSync(source);
    const previous = outputs.get(destinationPath);
    if (previous) {
        if (!previous.bytes.equals(bytes)) {
            if (replaceExisting) {
                outputs.set(destinationPath, { bytes, mode: stats.mode & 0o777, sourcePath });
                return;
            }
            throw new Error(`Conflicting package payloads target the same path: ${destinationPath}`);
        }
        return;
    }
    outputs.set(destinationPath, { bytes, mode: stats.mode & 0o777, sourcePath });
}

function sourcePathForVfs(vfsPath: string): string {
    if (!vfsPath.startsWith("/") || vfsPath.split("/").includes("..")) {
        throw new Error(`Package src must be a normalized absolute VFS path: ${vfsPath}`);
    }
    if (vfsPath.startsWith("/hostsrc/")) return `src/${vfsPath.slice("/hostsrc/".length)}`;
    if (vfsPath.startsWith("/lib/common/")) return `src/common/${vfsPath.slice("/lib/common/".length)}`;
    return `src/mirror/${vfsPath.slice(1)}`;
}

function targetPathForItem(item: PackageItem): string {
    if (item.src.startsWith("/hostsrc/")) {
        if (!item.hostDst) throw new Error(`Host source has no hostDst: ${item.src}`);
        return assertRelativePath(item.hostDst, "package hostDst");
    }
    return `src/mirror/${assertRelativePath(item.dst.slice(1), "package dst")}`;
}

function validatePackage(pkg: TpkgPackage, name: string): void {
    if (pkg.name !== name || !Array.isArray(pkg.items) || pkg.items.length === 0) {
        throw new Error(`Invalid or empty package definition: ${name}`);
    }
    for (const item of pkg.items) {
        if (
            !item ||
            typeof item.src !== "string" ||
            !item.src.startsWith("/") ||
            typeof item.dst !== "string" ||
            !item.dst.startsWith("/") ||
            item.dst.split("/").includes("..")
        ) {
            throw new Error(`Invalid item in package '${name}'.`);
        }
    }
}

function selectedPackages(manifest: any, names: string[]): TpkgPackage[] {
    const packages = new Map<string, TpkgPackage>();
    if (!Array.isArray(manifest?.packages)) throw new Error("TPKG package manifest has no packages array.");
    for (const pkg of manifest.packages as TpkgPackage[]) {
        if (packages.has(pkg.name)) throw new Error(`Duplicate package name in TPKG manifest: ${pkg.name}`);
        packages.set(pkg.name, pkg);
    }
    return names.map((name) => {
        const pkg = packages.get(name);
        if (!pkg) throw new Error(`Package '${name}' is not defined in ${PACKAGE_MANIFEST}.`);
        validatePackage(pkg, name);
        return pkg;
    });
}

function copyPackagePayload(outputs: Map<string, OutputFile>, packages: TpkgPackage[]): void {
    for (const pkg of packages) {
        for (const item of pkg.items) {
            if (item.src === "/etc/tpkg/packages.json") continue;
            addSource(outputs, sourcePathForVfs(item.src), targetPathForItem(item));
            if (item.hostDst && !item.src.startsWith("/hostsrc/")) {
                addSource(outputs, sourcePathForVfs(item.src), item.hostDst);
            }
        }
    }
}

function stageRepositoryPackages(outputs: Map<string, OutputFile>, packages: TpkgPackage[]): TpkgPackage[] {
    return packages.map((pkg) => {
        const staged: TpkgPackage = { ...pkg, items: [] };
        for (const item of pkg.items) {
            if (item.hostDst) assertRelativePath(item.hostDst, "package hostDst");
            const sourceRelative = item.src.startsWith("/hostsrc/")
                ? assertRelativePath(item.src.slice("/hostsrc/".length), "host package src")
                : assertRelativePath(item.src.slice(1), "package src");
            const stagedVfsPath = `/var/lib/tpkg/repo/${pkg.name}/${sourceRelative}`;
            const stagedOutputPath = `src/mirror${stagedVfsPath}`;
            addSource(outputs, sourcePathForVfs(item.src), stagedOutputPath);
            staged.items.push({ ...item, src: stagedVfsPath });
        }
        return staged;
    });
}

function walkFiles(directory: string, base: string = ""): string[] {
    const result: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const relative = base ? `${base}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) result.push(...walkFiles(absolute, relative));
        else if (entry.isFile() && /\.(ts|js|json)$/.test(entry.name) && !/\.(test|spec)\.(ts|js)$/.test(entry.name)) {
            result.push(relative);
        }
    }
    return result.sort();
}

function transformPackageJson(bytes: Buffer): Buffer {
    const pkg = JSON.parse(bytes.toString("utf8"));
    if (!pkg.scripts || typeof pkg.scripts.install !== "string") {
        throw new Error("Root package.json must define scripts.install for distro bootstrap.");
    }
    if (pkg.scripts["tsix:install"] !== undefined) {
        throw new Error("Root package.json already defines scripts.tsix:install.");
    }
    pkg.scripts["tsix:install"] = pkg.scripts.install;
    delete pkg.scripts.install;
    return Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

/**
 * readKernelIdentity(): ambil `codename` dan `version` dari `src/kernel/Kernel.ts`.
 *
 * Sumber kebenaran versi kernel adalah kode kernel itu sendiri (bukan recipe),
 * jadi `sysconfig.conf` pada image selalu konsisten dengan `Kernel.ts`.
 */
function readKernelIdentity(): { codename: string; version: string } {
    const kernelPath = path.join(ROOT, "src/kernel/Kernel.ts");
    const text = fs.readFileSync(kernelPath, "utf8");
    const version = text.match(/private\s+version\s*:\s*string\s*=\s*["']([^"']+)["']/)?.[1];
    const codename = text.match(/private\s+codename\s*:\s*string\s*=\s*["']([^"']+)["']/)?.[1];
    if (!version || !codename) {
        throw new Error(`Tidak bisa membaca codename/version kernel dari ${path.relative(ROOT, kernelPath)}.`);
    }
    return { codename, version };
}

/**
 * transformSysconfig(): selaraskan identitas kernel di `src/sysconfig.conf`.
 *
 * `version` ← versi kernel (`src/kernel/Kernel.ts`) dan `distroName` ← codename
 * kernel, supaya image melaporkan versi kernel yang benar-benar dibangun.
 * Baris/komentar lain dan gaya EOL tidak diubah.
 */
function transformSysconfig(bytes: Buffer, identity: { codename: string; version: string }): Buffer {
    const text = bytes.toString("utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const updates: Record<string, string> = {
        version: identity.version,
        distroName: identity.codename,
    };
    const seen = new Set<string>();
    let section = "";

    const out = lines.map((line) => {
        const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (sectionMatch) {
            section = sectionMatch[1].trim().toLowerCase();
            return line;
        }
        if (section !== "kernel") return line;
        const kv = line.match(/^(\s*)([A-Za-z0-9_.]+)(\s*=\s*)(.*)$/);
        if (!kv) return line;
        const key = kv[2];
        if (!(key in updates)) return line;
        seen.add(key);
        return `${kv[1]}${key}${kv[3]}${updates[key]}`;
    });

    for (const key of Object.keys(updates)) {
        if (!seen.has(key)) {
            throw new Error(`sysconfig.conf: kunci '${key}' tidak ditemukan di bagian [kernel].`);
        }
    }
    return Buffer.from(out.join(eol), "utf8");
}

/**
 * buildPathEntries(): susun daftar PATH dari paket yang benar-benar terpasang.
 *
 * Dimulai dari direktori sistem standar, lalu menambahkan:
 *   - direktori file `isExecutable` milik paket;
 *   - direktori aplikasi `/opt/<app>` (satu level di bawah /opt) — HANYA untuk
 *     paket yang ada di image, jadi `/opt/test` tidak muncul di distro yang
 *     tidak memasang `test-lab`.
 */
function buildPathEntries(packages: TpkgPackage[]): string[] {
    const entries: string[] = ["/bin", "/sbin", "/usr/bin", "/usr/local/bin"];
    const add = (dir: string) => {
        if (!entries.includes(dir)) entries.push(dir);
    };
    const optDirs = new Set<string>();

    for (const pkg of packages) {
        for (const item of pkg.items ?? []) {
            const dst = item.dst;
            if (typeof dst !== "string" || !dst.startsWith("/")) continue;
            const dir = dst.substring(0, dst.lastIndexOf("/")) || "/";
            if (/^\/opt\/[^/]+$/.test(dir)) optDirs.add(dir);
            if (item.isExecutable) add(dir);
        }
    }
    for (const dir of [...optDirs].sort()) add(dir);
    return entries;
}

/**
 * transformProfile(): ganti baris `export PATH=...` di `/etc/profile` dengan
 * PATH hasil `buildPathEntries()`. Baris lain & gaya EOL dipertahankan.
 */
function transformProfile(bytes: Buffer, pathEntries: string[]): Buffer {
    const text = bytes.toString("utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const line = `export PATH=${pathEntries.join(":")}`;
    const lines = text.split(/\r?\n/);
    let replaced = false;
    const out = lines.map((l) => {
        if (/^\s*export\s+PATH=/.test(l)) {
            replaced = true;
            return line;
        }
        return l;
    });
    if (!replaced) out.push(line);
    return Buffer.from(out.join(eol), "utf8");
}

function readme(recipe: Recipe): Buffer {
    const text = [
        `# ${recipe.distro.name}`,
        "",
        recipe.distro.description,
        "",
        "## Install",
        "",
        "```sh",
        "npm install",
        "npm run tsix:install",
        "```",
        "",
        "Start TSIX from the host shell:",
        "",
        "```sh",
        "./bootstrap.sh",
        "```",
        "",
        "```bat",
        "bootstrap.bat",
        "```",
        "",
        "## Local TPKG lab",
        "",
        "The image includes coreutils (`ls`, `clear`, and more), `tbuild`, the TPKG client, and a local repository server. `tpkgd` starts at boot. `procutils`, `nettools`, `hello-world`, `display-drivers`, and `joystick-driver` are staged in the repository for installation tests.",
        "",
        "```sh",
        "sudo tpkg update",
        "sudo tpkg info procutils",
        "sudo tpkg install procutils",
        "ps",
        "sudo mem",
        "sudo tpkg install nettools",
        "sudo tpkg install display-drivers",
        "sudo reboot",
        "sudo tpkg install joystick-driver",
        "sudo reboot",
        "sudo tpkg info hello-world",
        "sudo tpkg download hello-world",
        "sudo tpkg verify hello-world",
        "sudo tpkg install hello-world",
        "```",
        "",
        "## Installed packages",
        "",
        ...recipe.installedPackages.map((name) => `- ${name}`),
        "",
        "## Repository packages",
        "",
        ...recipe.repositoryPackages.map((name) => `- ${name}`),
        "",
        "This is a draft test image. Package source files are staged under `/var/lib/tpkg/repo` so the test package is available to `tpkgd` without being preinstalled.",
        "",
    ].join("\n");
    return Buffer.from(text, "utf8");
}

function resolveOutputDirectory(relative: string): string {
    const normalized = assertRelativePath(relative, "recipe.outputDirectory");
    const absolute = path.resolve(ROOT, normalized);
    if (!absolute.startsWith(`${path.resolve(ROOT, "distro")}${path.sep}`)) {
        throw new Error("Twrapper outputDirectory must be inside distro/.");
    }
    return absolute;
}

function buildPlan(recipePath: string) {
    const recipe = parseRecipe(readJson(recipePath, "Twrapper recipe"));
    const sourceManifest = readJson(path.join(ROOT, PACKAGE_MANIFEST), "TPKG package manifest");
    const installed = selectedPackages(sourceManifest, recipe.installedPackages);
    const repository = selectedPackages(sourceManifest, recipe.repositoryPackages);
    const outputs = new Map<string, OutputFile>();

    copyPackagePayload(outputs, installed);

    addSource(outputs, "scripts/twrapper/rootfs/etc/profile", "src/mirror/etc/profile", true);
    addSource(outputs, "scripts/twrapper/rootfs/etc/rc.local", "src/mirror/etc/rc.local", true);
    addSource(outputs, "scripts/twrapper/rootfs/etc/tpkg/config.json", "src/mirror/etc/tpkg/config.json", true);

    // PATH di /etc/profile mengikuti paket yang benar-benar terpasang:
    // /opt/<app> hanya dimasukkan bila paket aplikasi itu ikut di image.
    const profile = outputs.get("src/mirror/etc/profile");
    if (profile) {
        outputs.set("src/mirror/etc/profile", {
            ...profile,
            bytes: transformProfile(profile.bytes, buildPathEntries(installed)),
        });
    }

    for (const source of INSTALLER_FILES) addSource(outputs, source);
    for (const relative of walkFiles(path.join(ROOT, "src/common"))) {
        addSource(outputs, `src/common/${relative}`);
    }
    for (const relative of walkFiles(path.join(ROOT, "src/vfs"))) {
        addSource(outputs, `src/vfs/${relative}`);
    }

    const stagedRepository = stageRepositoryPackages(outputs, repository);
    const repositoryManifest = {
        version: sourceManifest.version ?? "1.0",
        packages: stagedRepository,
    };
    const catalogBytes = Buffer.from(`${JSON.stringify(repositoryManifest, null, 4)}\n`, "utf8");
    outputs.set("src/mirror/etc/tpkg/packages.json", {
        bytes: catalogBytes,
        mode: 0o644,
        sourcePath: PACKAGE_MANIFEST,
    });

    const packageJson = outputs.get("package.json");
    if (!packageJson) throw new Error("Bootstrap package.json was not included.");
    outputs.set("package.json", {
        ...packageJson,
        bytes: transformPackageJson(packageJson.bytes),
    });

    // Selaraskan identitas distro (version + distroName) di sysconfig.conf.
    const sysconfig = outputs.get("src/sysconfig.conf");
    if (!sysconfig) throw new Error("src/sysconfig.conf was not included.");
    outputs.set("src/sysconfig.conf", {
        ...sysconfig,
        bytes: transformSysconfig(sysconfig.bytes, readKernelIdentity()),
    });

    const readmeBytes = readme(recipe);
    outputs.set("README.md", { bytes: readmeBytes, mode: 0o644, sourcePath: "generated" });
    return { recipe, outputs, outputDirectory: resolveOutputDirectory(recipe.outputDirectory) };
}

function readPreviousState(outputDirectory: string): PreviousState | undefined {
    const filePath = path.join(outputDirectory, STATE_FILE);
    if (!fs.existsSync(filePath)) return undefined;
    const state = readJson(filePath, "Twrapper output state");
    if (!Array.isArray(state.generatedFiles)) throw new Error("Invalid Twrapper output state.");
    return state as PreviousState;
}

function verifyOwnedOutput(outputDirectory: string, previous: PreviousState): void {
    for (const entry of previous.generatedFiles) {
        const relative = assertRelativePath(entry.path, "previous generated path");
        const absolute = path.resolve(outputDirectory, ...relative.split("/"));
        if (!absolute.startsWith(`${outputDirectory}${path.sep}`)) {
            throw new Error(`Previous generated path escapes output: ${entry.path}`);
        }
        if (!fs.existsSync(absolute)) continue;
        if (!fs.lstatSync(absolute).isFile() || sha256(fs.readFileSync(absolute)) !== entry.sha256) {
            throw new Error(`Refusing to overwrite modified or unverified generated file: ${entry.path}`);
        }
    }
}

function writePlan(plan: ReturnType<typeof buildPlan>): void {
    const outputDirectory = plan.outputDirectory;
    const exists = fs.existsSync(outputDirectory);
    const previous = exists ? readPreviousState(outputDirectory) : undefined;
    if (exists && !previous && fs.readdirSync(outputDirectory).length > 0) {
        throw new Error(`Refusing to overwrite unmanaged output directory: ${outputDirectory}`);
    }
    if (previous) verifyOwnedOutput(outputDirectory, previous);
    fs.mkdirSync(outputDirectory, { recursive: true });

    const nextPaths = new Set(plan.outputs.keys());
    for (const file of previous?.generatedFiles ?? []) {
        if (nextPaths.has(file.path)) continue;
        const absolute = path.join(outputDirectory, ...file.path.split("/"));
        if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
    }

    const generatedFiles: PreviousState["generatedFiles"] = [];
    for (const [relative, file] of plan.outputs) {
        const absolute = path.join(outputDirectory, ...relative.split("/"));
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        if (fs.existsSync(absolute) && !previous?.generatedFiles.some((entry) => entry.path === relative)) {
            if (sha256(fs.readFileSync(absolute)) !== sha256(file.bytes)) {
                throw new Error(`Refusing to overwrite unmanaged output file: ${relative}`);
            }
        }
        const temporary = `${absolute}.twrapper-tmp`;
        fs.writeFileSync(temporary, file.bytes, { mode: file.mode });
        fs.chmodSync(temporary, file.mode);
        fs.renameSync(temporary, absolute);
        generatedFiles.push({ path: relative, sha256: sha256(file.bytes) });
    }
    const state = { generatedFiles };
    fs.writeFileSync(path.join(outputDirectory, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function main(): void {
    const args = process.argv.slice(2);
    let recipePath = "scripts/twrapper/imut.json";
    let check = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--recipe") {
            const value = args[++index];
            if (!value) throw new Error("--recipe requires a path.");
            recipePath = value;
        } else if (arg === "--check") {
            check = true;
        } else if (arg === "--help" || arg === "-h") {
            console.log("Usage: npm run distro:twrapper -- [--recipe <path>] [--check]");
            return;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    const absoluteRecipe = path.resolve(ROOT, recipePath);
    const plan = buildPlan(absoluteRecipe);
    const fileCount = plan.outputs.size;
    const size = [...plan.outputs.values()].reduce((total, file) => total + file.bytes.length, 0);
    console.log(`[twrapper] ${plan.recipe.distro.name}: ${fileCount} files (${(size / 1024).toFixed(0)} KB)`);
    console.log(`[twrapper] installed packages: ${plan.recipe.installedPackages.join(", ")}`);
    console.log(`[twrapper] repository packages: ${plan.recipe.repositoryPackages.join(", ")}`);
    console.log(`[twrapper] output: ${path.relative(ROOT, plan.outputDirectory).replace(/\\/g, "/")}`);
    if (check) return;
    writePlan(plan);
    console.log("[twrapper] build complete");
}

try {
    main();
} catch (error) {
    console.error(`[twrapper] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
