import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BKFS } from "../../src/vfs/BKFS";
import { populateRootfs } from "../lib/rootfs-image";

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
    "scripts/lib/rootfs-image.ts",
    "scripts/lib/text-file.ts",
    "scripts/lib/user-account.ts",
    "src/main.ts",
    "src/sysconfig.conf",
    "src/userland/WorkerEntry.js",
    "src/userland/VfsModuleResolver.js",
];
const STATE_FILE = ".twrapper-state.json";
/** Database rootfs yang dibuat `--no-mirror` (relatif output; = `kernel.database`). */
const DB_FILE = "system.db";
const MIRROR_PREFIX = "src/mirror/";

interface BuildOptions {
    /**
     * Mode PRODUKSI: rootfs (`src/mirror/**`) TIDAK ditulis sebagai file, tapi
     * langsung ke `<output>/system.db` (BKFS). Distro tidak punya `src/mirror/`,
     * dan `scripts/install.ts` mendeteksinya sebagai mode produksi.
     */
    noMirror: boolean;
}

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

/** Sumber kebenaran versi kernel adalah `src/kernel/Kernel.ts`, bukan recipe. */
function readKernelVersion(): string {
    const kernelPath = path.join(ROOT, "src/kernel/Kernel.ts");
    const text = fs.readFileSync(kernelPath, "utf8");
    const version = text.match(/private\s+version\s*:\s*string\s*=\s*["']([^"']+)["']/)?.[1];
    if (!version) {
        throw new Error(`Tidak bisa membaca versi kernel dari ${path.relative(ROOT, kernelPath)}.`);
    }
    return version;
}

/**
 * transformSysconfig(): selaraskan identitas kernel di `src/sysconfig.conf`.
 *
 * `version` ← versi kernel (`src/kernel/Kernel.ts`) dan `distroName` ← nama distro
 * pada recipe. Mode produksi (`--no-mirror`) juga memaksa `database`/`rootType`
 * dan mematikan file log host (`[logger] logFile = none`). Baris/komentar lain
 * dan gaya EOL tidak diubah.
 */
function transformSysconfig(bytes: Buffer, recipe: Recipe, kernelVersion: string, noMirror: boolean = false): Buffer {
    const text = bytes.toString("utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    // Kunci yang diganti, per bagian.
    const updates: Record<string, Record<string, string>> = {
        kernel: {
            version: kernelVersion,
            distroName: recipe.distro.name,
            // Produksi: root WAJIB dari database yang dibuat builder — tidak ada
            // src/mirror untuk rootType `host`.
            ...(noMirror ? { database: DB_FILE, rootType: "bkfs" } : {}),
        },
        // Produksi: log debug host (`jsix.log`) dimatikan — lihat
        // `isLogFileDisabled()` di src/common/Logger.ts.
        ...(noMirror ? { logger: { logFile: "none" } } : {}),
    };
    const seen = new Set<string>();
    let section = "";

    const out = lines.map((line) => {
        const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (sectionMatch) {
            section = sectionMatch[1].trim().toLowerCase();
            return line;
        }
        const sectionUpdates = updates[section];
        if (!sectionUpdates) return line;
        const kv = line.match(/^(\s*)([A-Za-z0-9_.]+)(\s*=\s*)(.*)$/);
        if (!kv) return line;
        const key = kv[2];
        if (!(key in sectionUpdates)) return line;
        seen.add(`${section}.${key}`);
        return `${kv[1]}${key}${kv[3]}${sectionUpdates[key]}`;
    });

    for (const [name, sectionUpdates] of Object.entries(updates)) {
        for (const key of Object.keys(sectionUpdates)) {
            if (!seen.has(`${name}.${key}`)) {
                throw new Error(`sysconfig.conf: kunci '${key}' tidak ditemukan di bagian [${name}].`);
            }
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

function readme(recipe: Recipe, noMirror: boolean = false): Buffer {
    const productionNote =
        `> **Production image.** The root filesystem is prebuilt in \`${DB_FILE}\` (BKFS); ` +
        "there is no `src/mirror/`. `npm run tsix:install` detects this and only configures " +
        "the node (hostname, users, root password) — it does not ask for a database file. " +
        "Programs are shipped as compiled `.js` only (no TypeScript sources, no sourcemaps), " +
        "except the framework libraries in `/lib`; install a package with `tpkg install <pkg> --source` " +
        "to get its sources.";
    const text = [
        `# ${recipe.distro.name}`,
        "",
        recipe.distro.description,
        "",
        ...(noMirror ? [productionNote, ""] : []),
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

function buildPlan(recipePath: string, options: BuildOptions = { noMirror: false }) {
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
        bytes: transformSysconfig(sysconfig.bytes, recipe, readKernelVersion(), options.noMirror),
    });

    const readmeBytes = readme(recipe, options.noMirror);
    outputs.set("README.md", { bytes: readmeBytes, mode: 0o644, sourcePath: "generated" });
    return {
        recipe,
        outputs,
        options,
        outputDirectory: resolveOutputDirectory(recipe.outputDirectory),
    };
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

/** Penanda identitas image di VFS (gaya /etc/os-release). */
const RELEASE_PATH = "/etc/tsix-release";

/**
 * releaseFile(): isi `/etc/tsix-release` untuk image produksi.
 *
 * `VARIANT=production` = rootfs hanya ada di `system.db`, host TIDAK punya
 * `src/mirror/`. tpkg memakainya untuk tidak menyinkronkan `hostDst` ber-awalan
 * `src/mirror/` ke host (yang akan memunculkan lagi `src/mirror/` dan membuat
 * install.ts salah mendeteksi mode) dan untuk memasang file itu sebagai `.js`.
 */
function releaseFile(recipe: Recipe, kernelVersion: string): string {
    const quote = (v: string) => `"${String(v).replace(/["\\]/g, "\\$&")}"`;
    return [
        "# /etc/tsix-release — image identity (written by twrapper; do not edit).",
        "# VARIANT=production: the root filesystem lives in system.db only (no src/mirror/ on the host).",
        `NAME=${quote(recipe.distro.name)}`,
        `ID=${recipe.distro.id}`,
        `VERSION=${quote(recipe.distro.version)}`,
        `KERNEL=${quote(kernelVersion)}`,
        "VARIANT=production",
        "",
    ].join("\n");
}

/** pruneEmptyDirs(): hapus direktori kosong dari `start` naik sampai `stop` (eksklusif). */
function pruneEmptyDirs(start: string, stop: string): void {
    let dir = start;
    while (dir.startsWith(`${stop}${path.sep}`) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
    }
}

/** removeDatabaseFiles(): DB SQLite + sisa WAL/SHM-nya. */
function removeDatabaseFiles(dbPath: string): void {
    for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    }
}

/**
 * buildRootfsDatabase(): `--no-mirror` — tulis rootfs ke `<output>/system.db`.
 *
 * File `src/mirror/**` dari rencana build ditaruh di direktori staging
 * sementara (di luar output), lalu diisikan ke BKFS baru dengan
 * `populateRootfs()` — implementasi yang SAMA dengan `scripts/install.ts`,
 * sehingga hasilnya identik dengan instalasi mode development. Ditulis ke file
 * sementara lalu di-rename: build yang gagal tidak meninggalkan DB setengah jadi.
 *
 * Akun root sengaja dibiarkan TERKUNCI; password ditetapkan oleh
 * `npm run tsix:install` di node tujuan.
 */
function buildRootfsDatabase(
    outputDirectory: string,
    mirrorFiles: Array<[string, OutputFile]>,
    release: string,
): Buffer {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "twrapper-rootfs-"));
    const dbPath = path.join(outputDirectory, DB_FILE);
    const temporary = `${dbPath}.twrapper-tmp`;
    try {
        for (const [relative, file] of mirrorFiles) {
            const absolute = path.join(stage, ...relative.slice(MIRROR_PREFIX.length).split("/"));
            fs.mkdirSync(path.dirname(absolute), { recursive: true });
            fs.writeFileSync(absolute, file.bytes, { mode: file.mode });
        }

        removeDatabaseFiles(temporary);
        const bkfs = new BKFS(temporary);
        try {
            // Image produksi = untuk end user: program `.js` saja tanpa sourcemap
            // (kecuali /lib & /var/lib/tpkg/repo — lihat rootfs-image `keepsSource`).
            const { rootPasswordSeeded } = populateRootfs(
                bkfs,
                stage,
                path.join(outputDirectory, "src", "common"),
                "TWRAPPER",
                { binaryOnly: true },
            );
            if (!rootPasswordSeeded) {
                throw new Error("Production image must not ship /etc/shadow; root has to stay locked until install.");
            }
            // Penanda image produksi — dibaca tpkg (VFS tidak bisa melihat apakah
            // host punya src/mirror/). Lihat `releaseFile()`.
            bkfs.touch(RELEASE_PATH, release, 0, 0, 0o644);
        } finally {
            // close() = checkpoint WAL → system.db kembali SATU file utuh.
            bkfs.close();
        }

        removeDatabaseFiles(dbPath);
        fs.renameSync(temporary, dbPath);
        return fs.readFileSync(dbPath);
    } catch (error) {
        removeDatabaseFiles(temporary);
        throw error;
    } finally {
        fs.rmSync(stage, { recursive: true, force: true });
    }
}

function writePlan(plan: ReturnType<typeof buildPlan>): void {
    const outputDirectory = plan.outputDirectory;
    const noMirror = plan.options.noMirror;
    const exists = fs.existsSync(outputDirectory);
    const previous = exists ? readPreviousState(outputDirectory) : undefined;
    if (exists && !previous && fs.readdirSync(outputDirectory).length > 0) {
        throw new Error(`Refusing to overwrite unmanaged output directory: ${outputDirectory}`);
    }
    if (previous) verifyOwnedOutput(outputDirectory, previous);
    fs.mkdirSync(outputDirectory, { recursive: true });

    // --no-mirror: rootfs → system.db, bukan file di src/mirror/.
    const mirrorFiles = noMirror ? [...plan.outputs].filter(([relative]) => relative.startsWith(MIRROR_PREFIX)) : [];
    const fileOutputs = noMirror
        ? new Map([...plan.outputs].filter(([relative]) => !relative.startsWith(MIRROR_PREFIX)))
        : plan.outputs;

    if (noMirror) {
        const dbPath = path.join(outputDirectory, DB_FILE);
        const owned = previous?.generatedFiles.some((entry) => entry.path === DB_FILE);
        if (fs.existsSync(dbPath) && !owned) {
            throw new Error(
                `Refusing to overwrite unmanaged ${DB_FILE} in ${outputDirectory} (created by an install?). Move it away first.`,
            );
        }
    }

    const nextPaths = new Set(fileOutputs.keys());
    if (noMirror) nextPaths.add(DB_FILE);
    for (const file of previous?.generatedFiles ?? []) {
        if (nextPaths.has(file.path)) continue;
        const absolute = path.join(outputDirectory, ...file.path.split("/"));
        if (file.path === DB_FILE) removeDatabaseFiles(absolute);
        else if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
        // Pindah dev → produksi: pohon src/mirror/ lama jangan tinggal sebagai folder kosong.
        pruneEmptyDirs(path.dirname(absolute), outputDirectory);
    }

    const generatedFiles: PreviousState["generatedFiles"] = [];
    for (const [relative, file] of fileOutputs) {
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

    // Setelah src/common tertulis (populateRootfs menyalinnya ke /lib/common).
    if (noMirror) {
        const dbBytes = buildRootfsDatabase(outputDirectory, mirrorFiles, releaseFile(plan.recipe, readKernelVersion()));
        generatedFiles.push({ path: DB_FILE, sha256: sha256(dbBytes) });
        console.log(
            `[twrapper] rootfs: ${mirrorFiles.length} files -> ${DB_FILE} (${(dbBytes.length / 1024).toFixed(0)} KB)`,
        );
    }
    const state = { generatedFiles };
    fs.writeFileSync(path.join(outputDirectory, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function main(): void {
    const args = process.argv.slice(2);
    let recipePath = "scripts/twrapper/imut.json";
    let check = false;
    let noMirror = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--recipe") {
            const value = args[++index];
            if (!value) throw new Error("--recipe requires a path.");
            recipePath = value;
        } else if (arg === "--check") {
            check = true;
        } else if (arg === "--no-mirror") {
            noMirror = true;
        } else if (arg === "--help" || arg === "-h") {
            console.log("Usage: npm run distro:twrapper -- [--recipe <path>] [--check] [--no-mirror]");
            console.log("");
            console.log("  --no-mirror  Production image: write the root filesystem straight into");
            console.log(`               distro/<target>/${DB_FILE} (BKFS) instead of src/mirror/.`);
            console.log("               install.ts then only configures the node (no database prompt).");
            return;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    const absoluteRecipe = path.resolve(ROOT, recipePath);
    const plan = buildPlan(absoluteRecipe, { noMirror });
    const fileCount = plan.outputs.size;
    const size = [...plan.outputs.values()].reduce((total, file) => total + file.bytes.length, 0);
    console.log(`[twrapper] ${plan.recipe.distro.name}: ${fileCount} files (${(size / 1024).toFixed(0)} KB)`);
    console.log(`[twrapper] installed packages: ${plan.recipe.installedPackages.join(", ")}`);
    console.log(`[twrapper] repository packages: ${plan.recipe.repositoryPackages.join(", ")}`);
    console.log(`[twrapper] output: ${path.relative(ROOT, plan.outputDirectory).replace(/\\/g, "/")}`);
    console.log(
        `[twrapper] mode: ${noMirror ? `production (--no-mirror -> ${DB_FILE})` : "development (src/mirror/)"}`,
    );
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
