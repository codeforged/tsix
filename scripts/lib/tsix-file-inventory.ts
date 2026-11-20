import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

export const INVENTORY_RELATIVE_PATH = "distro/tsix-files.json";
export const CLASSIFICATION_OVERRIDES_RELATIVE_PATH = "distro/file-classification-overrides.json";

export type FileCategory =
    | "application"
    | "asset"
    | "build-config"
    | "command"
    | "documentation"
    | "firmware"
    | "inventory"
    | "kernel"
    | "library"
    | "node-local"
    | "other"
    | "runtime"
    | "sensitive"
    | "shared-runtime"
    | "system-config"
    | "test"
    | "tooling"
    | "trust-anchor";

export type FileTarget = "firmware" | "host" | "vfs";
export type ClassificationState = "auto" | "needs-review" | "reviewed";

export interface FileClassification {
    state: ClassificationState;
    evidence: string[];
}

export interface FileRecognition {
    category: FileCategory;
    classification: FileClassification;
    targets: FileTarget[];
    tags: string[];
}

export interface InventoryFile {
    path: string;
    category: FileCategory;
    kind: "file" | "symlink";
    classification: FileClassification;
    targets: FileTarget[];
    tags?: string[];
}

export interface ClassificationOverride {
    category: FileCategory;
    reason: string;
    targets?: FileTarget[];
    tags?: string[];
}

export type ClassificationOverrides = Record<string, ClassificationOverride>;

export interface TsixFileInventory {
    schemaVersion: 2;
    sourceRoot: ".";
    includesIgnoredFiles: true;
    exclusions: string[];
    categories: Record<FileCategory, string>;
    classificationStates: Record<ClassificationState, string>;
    summary: Record<string, number>;
    classificationSummary: Record<ClassificationState, number>;
    reviewQueue: Array<{ path: string; category: FileCategory; evidence: string[] }>;
    files: InventoryFile[];
}

const CATEGORY_DESCRIPTIONS: Record<FileCategory, string> = {
    application: "Userland applications under src/mirror/opt.",
    asset: "Images, fonts, media, and other non-code assets.",
    "build-config": "Repository, compiler, package, or build configuration.",
    command: "System commands and executable userland programs.",
    documentation: "Project, API, and tutorial documentation.",
    firmware: "PlatformIO projects and embedded firmware sources.",
    inventory: "Generated distro inventory metadata.",
    kernel: "TSIX kernel and scheduler sources.",
    library: "Reusable userland libraries.",
    "node-local": "Per-node runtime state or operator-owned configuration; do not ship by default.",
    other: "Files not matched by a more specific category.",
    runtime: "Boot, worker, and virtual filesystem runtime sources.",
    sensitive: "Credentials, private keys, databases, or local secrets; never package.",
    "shared-runtime": "Shared runtime and filesystem support sources.",
    "system-config": "Default system configuration and system package metadata.",
    test: "Tests and test-only fixtures; do not package by default.",
    tooling: "Repository maintenance, build, and development scripts.",
    "trust-anchor": "Public trust material intentionally shipped with the system.",
};

const EXCLUDED_DIRECTORY_NAMES = new Set([
    ".git",
    ".idea",
    ".pio",
    ".tsix_sdk",
    ".vfs_cache",
    ".vscode",
    "build",
    "coverage",
    "dist",
    "logs",
    "node_modules",
]);

const EXCLUDED_PATHS = [
    "src/rootfs",
    "docs/jayalaras-iot",
];

const USER_DATA_DIRECTORIES = new Set([
    "src/mirror/home",
    "src/mirror/root",
]);

const TEST_DIRECTORY = /(^|\/)(test|tests|__tests__)(\/|$)/;
const TEST_FILENAME = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_LIKE_FILENAME = /(?:^|[._-])test(?:[._-]|$)/i;
const EXAMPLE_DIRECTORY = /(^|\/)(example|examples|sample|samples)(\/|$)/i;
const EXAMPLE_LIKE_FILENAME = /(?:^|[._-])(demo|example|sample)(?:[._-]|\d|$)/i;
const ASSET_EXTENSION = /\.(avif|gif|ico|jpe?g|mp3|mp4|ogg|png|svg|ttf|webp|woff2?)$/i;
const FIRMWARE_ARTIFACT_EXTENSION = /\.(bin|elf|hex|uf2)$/i;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const TDE_PIXELSPACE_FILES = new Set([
    "src/common/guitypes.ts",
    "src/kernel/guiregistry.ts",
    "src/kernel/syscalls.ts",
]);
const DESKTOP_COMPONENTS = ["dome", "asteracea", "cashew", "pistachio", "emerald"];
const TDE_COMPONENT_PATHS = [
    "src/common/asteraceapaths",
    "src/mirror/etc/asteracea",
    "src/mirror/etc/dome",
    "src/mirror/lib/cashew",
    "src/mirror/lib/dome",
    "src/mirror/lib/emerald",
    "src/mirror/lib/pistachio",
    "src/mirror/opt/asteracea",
    "src/mirror/opt/dome",
];

const FILE_CATEGORIES = new Set<FileCategory>([
    "application",
    "asset",
    "build-config",
    "command",
    "documentation",
    "firmware",
    "inventory",
    "kernel",
    "library",
    "node-local",
    "other",
    "runtime",
    "sensitive",
    "shared-runtime",
    "system-config",
    "test",
    "tooling",
    "trust-anchor",
]);

const FILE_TARGETS = new Set<FileTarget>(["firmware", "host", "vfs"]);

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativePath(filePath: string): string {
    return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function isWithin(relativePath: string, prefix: string): boolean {
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

function matchesPathPrefix(relativePath: string, prefix: string): boolean {
    return isWithin(relativePath, prefix) || relativePath.startsWith(`${prefix}.`);
}

function isSensitivePath(relativePath: string): boolean {
    const name = path.posix.basename(relativePath).toLowerCase();
    if (relativePath === "src/mirror/etc/tpkg/keys/public.pem") return false;
    if (relativePath === "src/sysconfig.conf" || relativePath === "src/sysconfig.json") {
        return true;
    }

    return (
        name === "secrets.h" ||
        name === "system.db" ||
        name === "systembak.db" ||
        name === ".npmrc" ||
        name === ".netrc" ||
        name.startsWith(".env") ||
        name.includes("credential") ||
        /\.(db|db-[^/]+|jks|key|p12|pfx|pem)$/i.test(name)
    );
}

function isNodeLocalPath(relativePath: string): boolean {
    if (
        relativePath === "src/mirror/home/.gitkeep" ||
        relativePath === "src/mirror/root/.gitkeep" ||
        relativePath === "src/mirror/etc/passwd" ||
        relativePath === "src/mirror/etc/shadow" ||
        relativePath === "src/mirror/etc/group" ||
        relativePath === "src/mirror/etc/crontab" ||
        relativePath === "src/mirror/etc/fstab.conf" ||
        relativePath === "src/mirror/etc/fstab.json" ||
        relativePath === "src/mirror/etc/tpkg/trusted_repos" ||
        isWithin(relativePath, "src/mirror/etc/tsd") ||
        isWithin(relativePath, "src/mirror/etc/packetforwarder") ||
        isWithin(relativePath, "src/mirror/etc/lantana") ||
        isWithin(relativePath, "src/mirror/var") ||
        isWithin(relativePath, "src/mirror/tmp") ||
        isWithin(relativePath, "src/mirror/dev") ||
        isWithin(relativePath, "src/mirror/proc")
    ) {
        return true;
    }
    return false;
}

function isApplicationTestArea(relativePath: string): boolean {
    return (
        isWithin(relativePath, "src/mirror/opt") &&
        TEST_DIRECTORY.test(relativePath)
    );
}

function isStrongTestPath(relativePath: string): boolean {
    if (isWithin(relativePath, "scripts/test") || isWithin(relativePath, "platformio")) {
        return true;
    }

    return [
        "src/common",
        "src/kernel",
        "src/mirror/bin",
        "src/mirror/lib",
        "src/mirror/sbin",
        "src/mirror/usr/bin",
        "src/userland",
        "src/vfs",
    ].some((prefix) => isWithin(relativePath, prefix));
}

function categoryForPath(relativePath: string, evidence: string[]): FileCategory {
    const name = path.posix.basename(relativePath);
    const lowerPath = relativePath.toLowerCase();
    const add = (category: FileCategory, reason: string): FileCategory => {
        evidence.push(reason);
        return category;
    };

    if (relativePath === INVENTORY_RELATIVE_PATH) {
        return add("inventory", "path is the generated file inventory");
    }
    if (isSensitivePath(relativePath)) {
        return add("sensitive", "file name or path matches a sensitive-data rule");
    }
    if (relativePath === "src/mirror/etc/tpkg/keys/public.pem") {
        return add("trust-anchor", "path is the explicitly public TPKG trust anchor");
    }
    if (isNodeLocalPath(relativePath)) {
        return add("node-local", "path contains per-node state or operator configuration");
    }
    if (
        isWithin(relativePath, "src/mirror/opt/esp-ota/firmwares") &&
        FIRMWARE_ARTIFACT_EXTENSION.test(name)
    ) {
        return add("firmware", "firmware artifact extension inside the ESP OTA firmware directory");
    }
    if (lowerPath.startsWith("docs/") || lowerPath.startsWith("wiki/") || /\.md$/i.test(name)) {
        if (ASSET_EXTENSION.test(name)) {
            return add("asset", "asset file inside a documentation tree");
        }
        return add("documentation", "documentation path or Markdown file");
    }
    if (ASSET_EXTENSION.test(name) || lowerPath.startsWith("shared/")) {
        return add("asset", "asset extension or shared asset directory");
    }
    if (TEST_FILENAME.test(name)) {
        return add("test", "file name uses the explicit .test or .spec source suffix");
    }
    if (TEST_DIRECTORY.test(relativePath) && isStrongTestPath(relativePath)) {
        return add("test", "test directory is inside a known source or test-tooling tree");
    }
    if (name.endsWith(".code-workspace")) {
        return add("build-config", "editor workspace configuration");
    }
    if (lowerPath.startsWith("platformio/")) {
        return add("firmware", "path is inside a PlatformIO project");
    }
    if (lowerPath.startsWith("scripts/")) {
        return add("tooling", "path is inside repository scripts");
    }
    if (lowerPath.startsWith("src/kernel/")) {
        return add("kernel", "path is inside the TSIX kernel");
    }
    if (
        lowerPath.startsWith("src/common/") ||
        lowerPath.startsWith("src/vfs/") ||
        lowerPath.startsWith("src/mirror/lib/common/")
    ) {
        return add("shared-runtime", "path is inside shared runtime or VFS support");
    }
    if (lowerPath.startsWith("src/userland/") || relativePath === "src/main.ts") {
        return add("runtime", "path is inside the boot or userland runtime");
    }
    if (
        lowerPath.startsWith("src/mirror/bin/") ||
        lowerPath.startsWith("src/mirror/sbin/") ||
        lowerPath.startsWith("src/mirror/usr/bin/") ||
        lowerPath.startsWith("src/mirror/usr/local/bin/")
    ) {
        return add("command", "path is inside a system command directory");
    }
    if (
        lowerPath.startsWith("src/mirror/lib/") ||
        lowerPath.startsWith("src/mirror/usr/lib/") ||
        lowerPath.startsWith("src/mirror/usr/local/lib/")
    ) {
        return add("library", "path is inside a system library directory");
    }
    if (lowerPath.startsWith("src/mirror/opt/")) {
        return add("application", "path is inside the VFS application directory");
    }
    if (lowerPath.startsWith("src/mirror/etc/")) {
        return add("system-config", "path is inside the VFS system configuration directory");
    }
    if (
        relativePath === "package.json" ||
        relativePath === "package-lock.json" ||
        relativePath === "tsconfig.json" ||
        relativePath === ".gitignore" ||
        relativePath === ".prettierignore" ||
        name === ".prettierrc" ||
        name.startsWith(".prettierrc.") ||
        name.endsWith(".code-workspace") ||
        relativePath.startsWith(".github/") ||
        relativePath.startsWith("distro/") ||
        /\.(config|rc)\.[^/]+$/i.test(name)
    ) {
        return add("build-config", "repository or distro build configuration");
    }
    if (relativePath === "LICENSE" || relativePath.startsWith("LICENSE.")) {
        return add("documentation", "repository license");
    }
    if (
        relativePath === "bootstrap.sh" ||
        relativePath === "bootstrap.bat" ||
        relativePath === "src/check_db.js"
    ) {
        return add("tooling", "repository maintenance utility");
    }
    return add("other", "no confident file-role recognizer matched");
}

function targetsForFile(relativePath: string): FileTarget[] {
    if (isWithin(relativePath, "platformio")) return ["firmware"];
    if (isWithin(relativePath, "src/common")) return ["host", "vfs"];
    if (isWithin(relativePath, "src/mirror")) return ["vfs"];
    if (
        isWithin(relativePath, "src/kernel") ||
        isWithin(relativePath, "src/userland") ||
        isWithin(relativePath, "src/vfs") ||
        relativePath === "src/main.ts"
    ) {
        return ["host"];
    }
    return [];
}

function importsForFile(root: string, relativePath: string, kind: InventoryFile["kind"]): string[] {
    if (
        kind !== "file" ||
        isSensitivePath(relativePath) ||
        isNodeLocalPath(relativePath) ||
        !SOURCE_EXTENSION.test(relativePath)
    ) {
        return [];
    }

    const source = fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8");
    const extension = path.extname(relativePath).toLowerCase();
    const scriptKind = extension === ".tsx"
        ? ts.ScriptKind.TSX
        : extension === ".jsx"
            ? ts.ScriptKind.JSX
            : extension === ".js" || extension === ".mjs" || extension === ".cjs"
                ? ts.ScriptKind.JS
                : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
    );
    const imports = new Set<string>();

    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            imports.add(node.moduleSpecifier.text);
        } else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
            node.arguments.length > 0 &&
            ts.isStringLiteral(node.arguments[0])
        ) {
            imports.add(node.arguments[0].text);
        } else if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument) &&
            ts.isStringLiteral(node.argument.literal)
        ) {
            imports.add(node.argument.literal.text);
        }
        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return [...imports].sort(compareStrings);
}

function tagsForFile(
    relativePath: string,
    imports: string[],
): { tags: string[]; evidence: string[] } {
    const lowerPath = relativePath.toLowerCase();
    const tags = new Set<string>();
    const evidence: string[] = [];
    const isSharedPersonalAsset = lowerPath.startsWith("shared/");
    const isTdeComponent = TDE_PIXELSPACE_FILES.has(lowerPath) ||
        TDE_COMPONENT_PATHS.some((prefix) => matchesPathPrefix(lowerPath, prefix));

    if (
        lowerPath.startsWith("src/mirror/lib/lantana/") ||
        lowerPath.startsWith("src/mirror/opt/lantana/") ||
        lowerPath.startsWith("wiki/lantana")
    ) {
        tags.add("iot");
        tags.add("lantana");
        evidence.push("domain inferred from the Lantana source path");
    }
    if (isTdeComponent) {
        tags.add("tde");
        tags.add("desktop");
        evidence.push("path belongs to a TSIX Desktop Environment component");
    }
    if (!isSharedPersonalAsset) {
        for (const component of DESKTOP_COMPONENTS) {
            if (lowerPath.includes(component)) {
                tags.add("desktop");
                tags.add(component);
                evidence.push(`domain inferred from the ${component} component path`);
            }
        }
    }
    if (TDE_PIXELSPACE_FILES.has(lowerPath)) {
        tags.add("pixelspace");
    }
    if (lowerPath.startsWith("platformio/")) {
        tags.add("firmware");
        tags.add("iot");
        evidence.push("domain inferred from the PlatformIO project path");
    }
    if (lowerPath.startsWith("src/mirror/opt/esp32-demo/")) {
        tags.add("iot");
        tags.add("esp32");
        evidence.push("domain inferred from the ESP32 demo path");
    }
    if (lowerPath.startsWith("src/mirror/opt/esp-ota/")) {
        tags.add("iot");
        tags.add("esp32");
        evidence.push("domain inferred from the ESP OTA application path");
    }
    if (lowerPath.startsWith("src/mirror/opt/azalea-dashboard/")) {
        tags.add("iot");
        tags.add("azalea");
        tags.add("dashboard");
        evidence.push("domain inferred from the Azalea dashboard path");
    }

    for (const moduleName of imports) {
        const lowerModuleName = moduleName.toLowerCase();
        if (lowerModuleName.includes("lantana")) {
            tags.add("iot");
            tags.add("lantana");
            evidence.push("domain inferred from a Lantana import");
        }
        if (lowerModuleName.includes("mqtnl")) {
            tags.add("iot");
            tags.add("mqtnl");
            evidence.push("domain inferred from an MQTNL import");
        }
        if (lowerModuleName.includes("esp32")) {
            tags.add("iot");
            tags.add("esp32");
            evidence.push("domain inferred from an ESP32 import");
        }
        for (const component of DESKTOP_COMPONENTS) {
            if (lowerModuleName.includes(component)) {
                tags.add("desktop-dependent");
                tags.add(component);
                evidence.push(`desktop dependency inferred from a ${component} import`);
            }
        }
    }

    return {
        tags: [...tags].sort(compareStrings),
        evidence: [...new Set(evidence)].sort(compareStrings),
    };
}

export function recognizeFile(filePath: string, imports: string[] = []): FileRecognition {
    const relativePath = normalizeRelativePath(filePath);
    const evidence: string[] = [];
    const category = categoryForPath(relativePath, evidence);
    const ambiguousAppTestArea = isApplicationTestArea(relativePath);
    const name = path.posix.basename(relativePath);
    const testLikeName = TEST_LIKE_FILENAME.test(name) && !TEST_FILENAME.test(name);
    const exampleLike = EXAMPLE_DIRECTORY.test(relativePath) || EXAMPLE_LIKE_FILENAME.test(name);
    const domain = tagsForFile(relativePath, imports);
    let state: ClassificationState = category === "other" ? "needs-review" : "auto";

    if (ambiguousAppTestArea) {
        state = "needs-review";
        evidence.push("VFS test/demo directory may contain distributable examples; human review required");
    } else if (testLikeName) {
        state = "needs-review";
        evidence.push("test-like name lacks an explicit .test or .spec suffix; human review required");
    }
    if (exampleLike) {
        state = "needs-review";
        domain.tags.push("example");
        domain.tags.sort(compareStrings);
        evidence.push("example/demo/sample marker requires a human packaging decision");
    }

    evidence.push(...domain.evidence);

    return {
        category,
        classification: {
            state,
            evidence: [...new Set(evidence)].sort(compareStrings),
        },
        targets: targetsForFile(relativePath),
        tags: domain.tags,
    };
}

export function classifyFile(filePath: string): FileCategory {
    return recognizeFile(filePath).category;
}

function shouldExcludePath(relativePath: string): boolean {
    const name = path.posix.basename(relativePath);
    const rootTestMount = !relativePath.includes("/") && name.startsWith("test-mount");
    const distroRelativePath = isWithin(relativePath, "distro")
        ? relativePath.slice("distro/".length)
        : "";
    const isDistroSourceFile =
        distroRelativePath === "tsix-files.json" ||
        distroRelativePath === "file-classification-overrides.json" ||
        distroRelativePath === "manifest.json" ||
        distroRelativePath.startsWith("manifests/");
    return (
        EXCLUDED_PATHS.some((excludedPath) => isWithin(relativePath, excludedPath)) ||
        (distroRelativePath !== "" && !isDistroSourceFile) ||
        name === ".DS_Store" ||
        name === ".piopm" ||
        name.startsWith("._") ||
        name === "Thumbs.db" ||
        name.endsWith(".tsbuildinfo") ||
        name.endsWith(".log") ||
        rootTestMount
    );
}

function collectFileEntries(root: string): InventoryFile[] {
    const collected: InventoryFile[] = [];

    const createEntry = (relativePath: string, kind: InventoryFile["kind"]): InventoryFile => {
        const imports = importsForFile(root, relativePath, kind);
        const recognition = recognizeFile(relativePath, imports);
        return {
            path: relativePath,
            category: recognition.category,
            kind,
            classification: recognition.classification,
            targets: recognition.targets,
            ...(recognition.tags.length > 0 ? { tags: recognition.tags } : {}),
        };
    };

    const walk = (directory: string, relativeDirectory = ""): void => {
        if (USER_DATA_DIRECTORIES.has(relativeDirectory)) {
            const placeholders = [
                `${relativeDirectory}/.gitkeep`,
                `${relativeDirectory}/kakang/.gitkeep`,
            ];
            for (const relativePath of placeholders) {
                const placeholderPath = path.join(root, ...relativePath.split("/"));
                if (!fs.existsSync(placeholderPath) || !fs.statSync(placeholderPath).isFile()) continue;
                collected.push(createEntry(relativePath, "file"));
            }
            return;
        }

        const entries = fs.readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => compareStrings(left.name, right.name));
        for (const entry of entries) {
            const relativePath = relativeDirectory
                ? `${relativeDirectory}/${entry.name}`
                : entry.name;
            const absolutePath = path.join(directory, entry.name);
            if (shouldExcludePath(relativePath)) continue;

            if (entry.isDirectory()) {
                if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
                walk(absolutePath, relativePath);
                continue;
            }

            if (!entry.isFile() && !entry.isSymbolicLink()) continue;
            collected.push(createEntry(relativePath, entry.isSymbolicLink() ? "symlink" : "file"));
        }
    };

    walk(root);

    if (!collected.some((entry) => entry.path === INVENTORY_RELATIVE_PATH)) {
        collected.push(createEntry(INVENTORY_RELATIVE_PATH, "file"));
    }

    return collected.sort((left, right) => compareStrings(left.path, right.path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileCategory(value: unknown): value is FileCategory {
    return typeof value === "string" && FILE_CATEGORIES.has(value as FileCategory);
}

function isFileTarget(value: unknown): value is FileTarget {
    return typeof value === "string" && FILE_TARGETS.has(value as FileTarget);
}

function parseTargets(value: unknown, pathName: string): FileTarget[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        throw new Error(`Invalid target override for ${pathName}.`);
    }
    const targets = value.filter(isFileTarget);
    if (targets.length !== value.length) {
        throw new Error(`Invalid target override for ${pathName}.`);
    }
    return [...new Set(targets)].sort(compareStrings);
}

function parseTags(value: unknown, pathName: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        throw new Error(`Invalid tag override for ${pathName}.`);
    }
    const tags = value.filter(
        (tag): tag is string => typeof tag === "string" && tag.trim().length > 0,
    );
    if (tags.length !== value.length) {
        throw new Error(`Invalid tag override for ${pathName}.`);
    }
    return [...new Set(tags)].sort(compareStrings);
}

export function readClassificationOverrides(root: string): ClassificationOverrides {
    const filePath = path.join(path.resolve(root), CLASSIFICATION_OVERRIDES_RELATIVE_PATH);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing classification overrides file: ${CLASSIFICATION_OVERRIDES_RELATIVE_PATH}`);
    }

    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.overrides)) {
        throw new Error(`Invalid classification overrides schema: ${CLASSIFICATION_OVERRIDES_RELATIVE_PATH}`);
    }

    const overrides: ClassificationOverrides = {};
    for (const [filePathKey, value] of Object.entries(parsed.overrides)) {
        const segments = filePathKey.split(/[\\/]+/);
        if (
            filePathKey !== normalizeRelativePath(filePathKey) ||
            filePathKey.length === 0 ||
            segments.some((segment) => segment === ".." || segment.length === 0)
        ) {
            throw new Error(`Invalid path in classification overrides: ${filePathKey}`);
        }
        if (!isRecord(value) || !isFileCategory(value.category)) {
            throw new Error(`Invalid category override for ${filePathKey}.`);
        }
        const allowedKeys = new Set(["category", "reason", "targets", "tags"]);
        if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
            throw new Error(`Unknown override field for ${filePathKey}.`);
        }
        if (typeof value.reason !== "string" || value.reason.trim().length === 0) {
            throw new Error(`A non-empty review reason is required for ${filePathKey}.`);
        }

        overrides[filePathKey] = {
            category: value.category,
            reason: value.reason.trim(),
            targets: parseTargets(value.targets, filePathKey),
            tags: parseTags(value.tags, filePathKey),
        };
    }
    return overrides;
}

function applyOverrides(
    files: InventoryFile[],
    overrides: ClassificationOverrides,
): InventoryFile[] {
    const pendingPaths = new Set(Object.keys(overrides));
    const updatedFiles = files.map((file) => {
        const override = overrides[file.path];
        if (!override) return file;
        pendingPaths.delete(file.path);

        const lowersSafety =
            (file.category === "sensitive" && override.category !== "sensitive") ||
            ((file.category === "node-local" || file.category === "trust-anchor") &&
                override.category !== file.category &&
                override.category !== "sensitive");
        if (lowersSafety) {
            throw new Error(`Unsafe category override for ${file.path}.`);
        }

        return {
            ...file,
            category: override.category,
            targets: override.targets ?? file.targets,
            tags: override.tags ?? file.tags,
            classification: {
                state: "reviewed" as const,
                evidence: [
                    ...file.classification.evidence,
                    `human review: ${override.reason}`,
                ].sort(compareStrings),
            },
        };
    });

    if (pendingPaths.size > 0) {
        throw new Error(`Classification overrides reference missing files: ${[...pendingPaths].sort(compareStrings).join(", ")}`);
    }
    return updatedFiles;
}

export function buildInventory(
    root: string,
    overrides: ClassificationOverrides = {},
): TsixFileInventory {
    const files = applyOverrides(collectFileEntries(path.resolve(root)), overrides);
    const summary: Record<string, number> = {};
    const classificationSummary: Record<ClassificationState, number> = {
        auto: 0,
        "needs-review": 0,
        reviewed: 0,
    };
    for (const file of files) {
        summary[file.category] = (summary[file.category] ?? 0) + 1;
        classificationSummary[file.classification.state] += 1;
    }

    return {
        schemaVersion: 2,
        sourceRoot: ".",
        includesIgnoredFiles: true,
        exclusions: [
            ".git/",
            "node_modules/",
            "dist/",
            "build/",
            "coverage/",
            ".vfs_cache/",
            ".tsix_sdk/",
            ".pio/",
            "logs/",
            "src/rootfs/",
            "docs/jayalaras-iot/",
            "src/mirror/home/** (only .gitkeep placeholders)",
            "src/mirror/root/** (only .gitkeep placeholders)",
            ".vscode/",
            ".idea/",
            "distro/<generated distro name>/",
            ".DS_Store, .piopm, AppleDouble (._*), Thumbs.db, *.tsbuildinfo, *.log, test-mount*/",
        ],
        categories: CATEGORY_DESCRIPTIONS,
        classificationStates: {
            auto: "Recognized by deterministic path, type, or source-import evidence.",
            "needs-review": "Ambiguous or unknown; do not package until a human override exists.",
            reviewed: "Classification explicitly approved in file-classification-overrides.json.",
        },
        summary: Object.fromEntries(
            Object.entries(summary).sort(([left], [right]) => compareStrings(left, right)),
        ),
        classificationSummary,
        reviewQueue: files
            .filter((file) => file.classification.state === "needs-review")
            .map(({ path: filePath, category, classification }) => ({
                path: filePath,
                category,
                evidence: classification.evidence,
            })),
        files,
    };
}

export function writeInventory(root: string): TsixFileInventory {
    const absoluteRoot = path.resolve(root);
    const outputPath = path.join(absoluteRoot, INVENTORY_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const overrides = readClassificationOverrides(absoluteRoot);
    const inventory = buildInventory(absoluteRoot, overrides);
    fs.writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
    return inventory;
}
