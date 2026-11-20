import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
    ClassificationState,
    FileCategory,
    FileTarget,
    InventoryFile,
} from "./tsix-file-inventory";

const FILE_CATEGORIES = new Set<string>([
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
const CLASSIFICATION_STATES = new Set<string>(["auto", "needs-review", "reviewed"]);
const FILE_TARGETS = new Set<string>(["firmware", "host", "vfs"]);
const ALWAYS_PROTECTED_CATEGORIES = new Set<FileCategory>(["node-local", "sensitive", "test"]);
const PACKAGE_SCRIPT_TRANSFORM = "rename-install-lifecycle-script";

interface DistroSelection {
    match: "any";
    exactPathsOverrideCategoryExclusions: boolean;
    include: {
        categories: FileCategory[];
        tags: string[];
        paths: string[];
    };
    exclude: {
        categories: FileCategory[];
        protectedCategories: FileCategory[];
        classificationStates: ClassificationState[];
        tags: string[];
        pathPrefixes: string[];
    };
}

interface DistroDefinition {
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
    sourceInventory: string;
    outputDirectory: string;
    layout: "preserve-source-path";
    installation: {
        entrypoint: string;
        npmScriptName: string;
        rootAccountBootstrap: string;
    };
    selection: DistroSelection;
    releaseNotes: string[];
}

interface InventorySource {
    schemaVersion: 2;
    files: InventoryFile[];
}

interface ResolvedFile extends Omit<InventoryFile, "path"> {
    sourcePath: string;
    destinationPath: string;
    sourceSha256: string;
    sha256: string;
    transform?: string;
}

interface GeneratedFile {
    path: string;
    sha256: string;
}

interface ResolvedDistroManifest {
    schemaVersion: 1;
    generationStatus: "complete";
    distro: DistroDefinition["distro"];
    sourceManifest: string;
    sourceInventory: string;
    outputDirectory: string;
    layout: DistroDefinition["layout"];
    installation: DistroDefinition["installation"];
    selection: DistroSelection;
    resolution: {
        inventorySchemaVersion: 2;
        summary: {
            fileCount: number;
            byCategory: Record<string, number>;
        };
        generatedFiles: GeneratedFile[];
    };
    files: ResolvedFile[];
    releaseNotes: string[];
}

interface GenerationPlan {
    root: string;
    definition: DistroDefinition;
    outputDirectory: string;
    manifestPath: string;
    sourceManifestRelativePath: string;
    sourceInventoryRelativePath: string;
    files: Array<{
        inventoryFile: InventoryFile;
        sourcePath: string;
        destinationPath: string;
        outputBytes: Buffer;
        resolvedFile: ResolvedFile;
    }>;
    readmeBytes: Buffer;
    baseManifest: Omit<ResolvedDistroManifest, "generationStatus">;
}

interface PreviousOutput {
    path: string;
    sha256?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFileCategory(value: unknown): value is FileCategory {
    return typeof value === "string" && FILE_CATEGORIES.has(value);
}

function isClassificationState(value: unknown): value is ClassificationState {
    return typeof value === "string" && CLASSIFICATION_STATES.has(value);
}

function isFileTarget(value: unknown): value is FileTarget {
    return typeof value === "string" && FILE_TARGETS.has(value);
}

function isInventoryFile(value: unknown): value is InventoryFile {
    if (!isRecord(value) || typeof value.path !== "string" || !isFileCategory(value.category)) {
        return false;
    }
    if (value.kind !== "file" && value.kind !== "symlink") return false;
    if (!isRecord(value.classification) || !isClassificationState(value.classification.state)) {
        return false;
    }
    if (!isStringArray(value.classification.evidence)) return false;
    if (!Array.isArray(value.targets) || !value.targets.every(isFileTarget)) return false;
    return value.tags === undefined || isStringArray(value.tags);
}

function assertRecordStrings(
    value: unknown,
    fields: string[],
    label: string,
): asserts value is Record<string, unknown> {
    if (!isRecord(value)) throw new Error(`${label} must be an object.`);
    for (const field of fields) {
        if (typeof value[field] !== "string" || value[field] === "") {
            throw new Error(`${label}.${field} must be a non-empty string.`);
        }
    }
}

function requiredString(value: Record<string, unknown>, field: string, label: string): string {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string" || fieldValue === "") {
        throw new Error(`${label}.${field} must be a non-empty string.`);
    }
    return fieldValue;
}

function assertRelativePath(value: string, label: string): string {
    const normalized = value.replace(/\\/g, "/");
    const segments = normalized.split("/");
    if (
        normalized === "" ||
        path.posix.isAbsolute(normalized) ||
        normalized !== value ||
        segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
        throw new Error(`${label} must be a normalized relative path: ${value}`);
    }
    return normalized;
}

function resolveProjectPath(root: string, baseDirectory: string, relativePath: string, label: string): string {
    if (
        relativePath === "" ||
        relativePath.includes("\\") ||
        path.posix.isAbsolute(relativePath) ||
        path.win32.isAbsolute(relativePath)
    ) {
        throw new Error(`${label} must be a relative POSIX path: ${relativePath}`);
    }
    const resolved = path.resolve(baseDirectory, relativePath);
    const relativeToRoot = path.relative(root, resolved);
    if (
        relativeToRoot === "" ||
        relativeToRoot === ".." ||
        relativeToRoot.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeToRoot)
    ) {
        throw new Error(`${label} must resolve to a non-root path inside the project: ${relativePath}`);
    }
    return resolved;
}

function readJson(filePath: string, label: string): unknown {
    let text: string;
    try {
        text = fs.readFileSync(filePath, "utf8");
    } catch (error) {
        throw new Error(`Unable to read ${label} at ${filePath}: ${String(error)}`);
    }
    try {
        return JSON.parse(text) as unknown;
    } catch (error) {
        throw new Error(`Invalid JSON in ${label} at ${filePath}: ${String(error)}`);
    }
}

function parseDefinition(value: unknown): DistroDefinition {
    if (!isRecord(value) || value.schemaVersion !== 1) {
        throw new Error("Distro source manifest must use schemaVersion 1.");
    }
    const distro = value.distro;
    assertRecordStrings(distro, ["id", "name", "version", "status", "description"], "distro");
    if (!isStringArray(distro.purpose) || !isStringArray(distro.features)) {
        throw new Error("distro.purpose and distro.features must be string arrays.");
    }
    const installationValue = value.installation;
    assertRecordStrings(installationValue, [
        "entrypoint",
        "npmScriptName",
        "rootAccountBootstrap",
    ], "installation");
    const installation = installationValue;
    const npmScriptName = requiredString(installation, "npmScriptName", "installation");
    if (npmScriptName === "install") {
        throw new Error("installation.npmScriptName cannot be 'install' because npm runs it as a lifecycle hook.");
    }
    if (!/^[a-zA-Z0-9:_-]+$/.test(npmScriptName)) {
        throw new Error("installation.npmScriptName contains unsupported characters.");
    }
    const selection = value.selection;
    if (!isRecord(selection) || selection.match !== "any" ||
        selection.exactPathsOverrideCategoryExclusions !== true) {
        throw new Error("selection must use match='any' and explicit exact-path precedence.");
    }
    const include = selection.include;
    const exclude = selection.exclude;
    if (!isRecord(include) || !isRecord(exclude)) {
        throw new Error("selection.include and selection.exclude must be objects.");
    }
    if (
        !Array.isArray(include.categories) || !include.categories.every(isFileCategory) ||
        !isStringArray(include.tags) || !isStringArray(include.paths) ||
        !Array.isArray(exclude.categories) || !exclude.categories.every(isFileCategory) ||
        !Array.isArray(exclude.protectedCategories) ||
        !exclude.protectedCategories.every(isFileCategory) ||
        !Array.isArray(exclude.classificationStates) ||
        !exclude.classificationStates.every(isClassificationState) ||
        !isStringArray(exclude.tags) || !isStringArray(exclude.pathPrefixes)
    ) {
        throw new Error("selection contains invalid category, tag, path, or classification-state lists.");
    }
    for (const category of exclude.protectedCategories) {
        if (!exclude.categories.includes(category)) {
            throw new Error(`Protected category '${category}' must also appear in exclude.categories.`);
        }
    }
    if (value.layout !== "preserve-source-path") {
        throw new Error("Only layout='preserve-source-path' is supported.");
    }
    assertRecordStrings(value, ["sourceInventory", "outputDirectory"], "manifest");
    const sourceInventory = requiredString(value, "sourceInventory", "manifest");
    const outputDirectory = requiredString(value, "outputDirectory", "manifest");
    if (!isStringArray(value.releaseNotes)) {
        throw new Error("releaseNotes must be a string array.");
    }
    return {
        schemaVersion: 1,
        distro: {
            id: requiredString(distro, "id", "distro"),
            name: requiredString(distro, "name", "distro"),
            version: requiredString(distro, "version", "distro"),
            status: requiredString(distro, "status", "distro"),
            description: requiredString(distro, "description", "distro"),
            purpose: distro.purpose,
            features: distro.features,
        },
        sourceInventory,
        outputDirectory,
        layout: "preserve-source-path",
        installation: {
            entrypoint: requiredString(installation, "entrypoint", "installation"),
            npmScriptName,
            rootAccountBootstrap: requiredString(installation, "rootAccountBootstrap", "installation"),
        },
        selection: {
            match: "any",
            exactPathsOverrideCategoryExclusions: true,
            include: {
                categories: include.categories,
                tags: include.tags,
                paths: include.paths.map((item) => assertRelativePath(item, "selection.include.paths")),
            },
            exclude: {
                categories: exclude.categories,
                protectedCategories: exclude.protectedCategories,
                classificationStates: exclude.classificationStates,
                tags: exclude.tags,
                pathPrefixes: exclude.pathPrefixes.map((item) =>
                    assertRelativePath(item, "selection.exclude.pathPrefixes"),
                ),
            },
        },
        releaseNotes: value.releaseNotes,
    };
}

function parseInventory(value: unknown): InventorySource {
    if (
        !isRecord(value) ||
        value.schemaVersion !== 2 ||
        !Array.isArray(value.files) ||
        !value.files.every(isInventoryFile)
    ) {
        throw new Error("Source inventory must use schemaVersion 2 and contain valid file records.");
    }
    return { schemaVersion: 2, files: value.files };
}

function isWithin(relativePath: string, prefix: string): boolean {
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

function sha256(bytes: Buffer): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertNoSymlinkSegments(root: string, target: string): void {
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Path escapes its trusted root: ${target}`);
    }
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        if (!fs.existsSync(current)) break;
        const stats = fs.lstatSync(current);
        if (stats.isSymbolicLink()) throw new Error(`Symlink path is not allowed in generated files: ${current}`);
        if (current !== target && !stats.isDirectory()) {
            throw new Error(`Expected a directory while resolving generated path: ${current}`);
        }
    }
}

function transformPackageJson(
    sourcePath: string,
    bytes: Buffer,
    definition: DistroDefinition,
): { bytes: Buffer; transform?: string } {
    if (sourcePath !== "package.json") return { bytes };
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
        throw new Error("package.json must contain a scripts object to configure the distro installer.");
    }
    const scripts = parsed.scripts;
    if (typeof scripts.install !== "string" || scripts.install === "") {
        throw new Error("package.json scripts.install is required for the generated distro installer.");
    }
    if (Object.prototype.hasOwnProperty.call(scripts, definition.installation.npmScriptName)) {
        throw new Error(`package.json already defines ${definition.installation.npmScriptName}.`);
    }
    scripts[definition.installation.npmScriptName] = scripts.install;
    delete scripts.install;
    return {
        bytes: Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8"),
        transform: PACKAGE_SCRIPT_TRANSFORM,
    };
}

function makeReadme(definition: DistroDefinition): Buffer {
    const installScript = definition.installation.npmScriptName;
    const text = [
        `# ${definition.distro.name}`,
        "",
        definition.distro.description,
        "",
        `Version: ${definition.distro.version} (${definition.distro.status})`,
        "",
        "## Installation",
        "",
        "Requires Node.js and npm. From this directory, install dependencies and run the interactive installer:",
        "",
        "```sh",
        "npm install",
        `npm run ${installScript}`,
        "```",
        "",
        "The installer asks for a root password on a fresh distro image. It creates a locked root account and does not package node-local password files.",
        "",
        "For a non-interactive image, run `npm run " + installScript + " -- --defaults`; the root account remains locked until a password is set through an interactive install.",
        "",
        "## Features",
        "",
        ...definition.distro.features.map((feature) => `- ${feature}`),
        "",
        "## Release notes",
        "",
        ...definition.releaseNotes.map((note) => `- ${note}`),
        "",
    ].join("\n");
    return Buffer.from(text, "utf8");
}

function buildPlan(rootPath: string, manifestPath: string): GenerationPlan {
    const root = path.resolve(rootPath);
    const definitionPath = path.resolve(root, manifestPath);
    const relativeDefinition = path.relative(root, definitionPath);
    if (
        relativeDefinition === ".." ||
        relativeDefinition.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeDefinition)
    ) {
        throw new Error("Distro source manifest must be inside the project root.");
    }
    const definition = parseDefinition(readJson(definitionPath, "distro source manifest"));
    const definitionDirectory = path.dirname(definitionPath);
    const inventoryPath = resolveProjectPath(root, definitionDirectory, definition.sourceInventory, "sourceInventory");
    const outputDirectory = resolveProjectPath(root, definitionDirectory, definition.outputDirectory, "outputDirectory");
    const sourceInventoryRelativePath = path.relative(root, inventoryPath).split(path.sep).join("/");
    const sourceManifestRelativePath = relativeDefinition.split(path.sep).join("/");

    if (isWithin(path.relative(root, inventoryPath).split(path.sep).join("/"), path.relative(root, outputDirectory).split(path.sep).join("/"))) {
        throw new Error("The generated output directory cannot contain the source inventory.");
    }
    if (isWithin(sourceManifestRelativePath, path.relative(root, outputDirectory).split(path.sep).join("/"))) {
        throw new Error("The generated output directory cannot contain its source manifest.");
    }

    const inventory = parseInventory(readJson(inventoryPath, "source inventory"));
    const entriesByPath = new Map<string, InventoryFile>();
    for (const file of inventory.files) {
        const normalized = assertRelativePath(file.path, "inventory file path");
        if (entriesByPath.has(normalized)) throw new Error(`Duplicate inventory path: ${normalized}`);
        entriesByPath.set(normalized, file);
    }

    for (const exactPath of definition.selection.include.paths) {
        if (!entriesByPath.has(exactPath)) {
            throw new Error(`Explicitly included path is missing from inventory: ${exactPath}`);
        }
    }
    if (!definition.selection.include.paths.includes(definition.installation.entrypoint)) {
        throw new Error("The installer entrypoint must appear in selection.include.paths.");
    }

    const protectedCategories = new Set<FileCategory>([
        ...ALWAYS_PROTECTED_CATEGORIES,
        ...definition.selection.exclude.protectedCategories,
    ]);
    const excludedCategories = new Set(definition.selection.exclude.categories);
    const excludedStates = new Set(definition.selection.exclude.classificationStates);
    const excludedTags = new Set(definition.selection.exclude.tags);
    const selected = inventory.files.filter((file) => {
        const exactPath = definition.selection.include.paths.includes(file.path);
        const tags = file.tags ?? [];
        const included =
            definition.selection.include.categories.includes(file.category) ||
            tags.some((tag) => definition.selection.include.tags.includes(tag)) ||
            exactPath;
        const categoryExcluded =
            excludedCategories.has(file.category) &&
            (!exactPath || protectedCategories.has(file.category));
        const excluded =
            categoryExcluded ||
            protectedCategories.has(file.category) ||
            excludedStates.has(file.classification.state) ||
            tags.some((tag) => excludedTags.has(tag)) ||
            definition.selection.exclude.pathPrefixes.some((prefix) => isWithin(file.path, prefix));
        return included && !excluded;
    });

    const outputRelative = path.relative(root, outputDirectory).split(path.sep).join("/");
    const selectedPaths = new Set<string>();
    const files: GenerationPlan["files"] = [];
    for (const file of selected) {
        if (file.kind !== "file") {
            throw new Error(`Refusing to package non-regular source file: ${file.path}`);
        }
        const sourcePath = path.resolve(root, ...file.path.split("/"));
        assertNoSymlinkSegments(root, sourcePath);
        const sourceStats = fs.lstatSync(sourcePath);
        if (!sourceStats.isFile()) throw new Error(`Source is not a regular file: ${file.path}`);
        if (isWithin(file.path, outputRelative)) {
            throw new Error(`Source file is inside generated output: ${file.path}`);
        }
        if (file.path === "README.md" || file.path === "manifest.json") {
            throw new Error(`Source path conflicts with a generated metadata file: ${file.path}`);
        }
        if (selectedPaths.has(file.path)) throw new Error(`Duplicate selected destination: ${file.path}`);
        selectedPaths.add(file.path);

        const sourceBytes = fs.readFileSync(sourcePath);
        const transformed = transformPackageJson(file.path, sourceBytes, definition);
        const destinationPath = path.resolve(outputDirectory, ...file.path.split("/"));
        const outputRelativePath = path.relative(outputDirectory, destinationPath).split(path.sep).join("/");
        assertRelativePath(outputRelativePath, "destinationPath");
        files.push({
            inventoryFile: file,
            sourcePath,
            destinationPath,
            outputBytes: transformed.bytes,
            resolvedFile: {
                sourcePath: file.path,
                destinationPath: outputRelativePath,
                category: file.category,
                kind: file.kind,
                classification: file.classification,
                targets: file.targets,
                tags: file.tags ?? [],
                sourceSha256: sha256(sourceBytes),
                sha256: sha256(transformed.bytes),
                ...(transformed.transform ? { transform: transformed.transform } : {}),
            },
        });
    }

    const entrypoint = files.find((file) => file.inventoryFile.path === definition.installation.entrypoint);
    if (!entrypoint) throw new Error(`Installer entrypoint was excluded by selection: ${definition.installation.entrypoint}`);

    const byCategory: Record<string, number> = {};
    for (const file of files) {
        byCategory[file.inventoryFile.category] = (byCategory[file.inventoryFile.category] ?? 0) + 1;
    }
    const readmeBytes = makeReadme(definition);
    const baseManifest: GenerationPlan["baseManifest"] = {
        schemaVersion: 1,
        distro: definition.distro,
        sourceManifest: sourceManifestRelativePath,
        sourceInventory: sourceInventoryRelativePath,
        outputDirectory: outputRelative,
        layout: definition.layout,
        installation: definition.installation,
        selection: definition.selection,
        resolution: {
            inventorySchemaVersion: inventory.schemaVersion,
            summary: {
                fileCount: files.length,
                byCategory: Object.fromEntries(
                    Object.entries(byCategory).sort(([left], [right]) => left.localeCompare(right)),
                ),
            },
            generatedFiles: [{ path: "README.md", sha256: sha256(readmeBytes) }],
        },
        files: files.map((file) => file.resolvedFile),
        releaseNotes: definition.releaseNotes,
    };

    return {
        root,
        definition,
        outputDirectory,
        manifestPath: path.join(outputDirectory, "manifest.json"),
        sourceManifestRelativePath,
        sourceInventoryRelativePath,
        files,
        readmeBytes,
        baseManifest,
    };
}

function parsePreviousOutputs(manifestPath: string, expectedSourceManifest: string): PreviousOutput[] {
    if (!fs.existsSync(manifestPath)) return [];
    const previous = readJson(manifestPath, "existing resolved distro manifest");
    if (!isRecord(previous) || previous.sourceManifest !== expectedSourceManifest || !Array.isArray(previous.files)) {
        throw new Error(`Refusing to replace unrecognized output manifest: ${manifestPath}`);
    }
    const outputs: PreviousOutput[] = [];
    for (const file of previous.files) {
        if (!isRecord(file) || typeof file.destinationPath !== "string") {
            throw new Error(`Existing resolved manifest has an invalid file record: ${manifestPath}`);
        }
        const outputPath = assertRelativePath(file.destinationPath, "previous destinationPath");
        if (file.sha256 !== undefined && typeof file.sha256 !== "string") {
            throw new Error(`Existing resolved manifest has an invalid checksum for ${outputPath}`);
        }
        outputs.push({ path: outputPath, ...(typeof file.sha256 === "string" ? { sha256: file.sha256 } : {}) });
    }
    if (Array.isArray(previous.resolution) || !isRecord(previous.resolution ?? {})) {
        throw new Error(`Existing resolved manifest has an invalid resolution section: ${manifestPath}`);
    }
    const generatedFiles = isRecord(previous.resolution) ? previous.resolution.generatedFiles : undefined;
    if (generatedFiles !== undefined) {
        if (!Array.isArray(generatedFiles)) {
            throw new Error(`Existing resolved manifest has invalid generatedFiles: ${manifestPath}`);
        }
        for (const file of generatedFiles) {
            if (!isRecord(file) || typeof file.path !== "string") {
                throw new Error(`Existing resolved manifest has an invalid generated file record: ${manifestPath}`);
            }
            outputs.push({
                path: assertRelativePath(file.path, "previous generated path"),
                ...(typeof file.sha256 === "string" ? { sha256: file.sha256 } : {}),
            });
        }
    }
    return outputs;
}

function assertOwnedOrNewFile(
    outputRoot: string,
    destinationPath: string,
    expectedHash: string,
    previousOutputs: Map<string, PreviousOutput>,
): void {
    assertNoSymlinkSegments(outputRoot, destinationPath);
    if (!fs.existsSync(destinationPath)) return;
    const stats = fs.lstatSync(destinationPath);
    if (!stats.isFile()) throw new Error(`Refusing to overwrite non-file output: ${destinationPath}`);
    const actualHash = sha256(fs.readFileSync(destinationPath));
    const relative = path.relative(outputRoot, destinationPath).split(path.sep).join("/");
    const previous = previousOutputs.get(relative);
    if (actualHash === expectedHash) return;
    if (!previous?.sha256 || actualHash !== previous.sha256) {
        throw new Error(`Generated destination was modified or is not owned by this generator: ${destinationPath}`);
    }
}

function writeAtomicFile(filePath: string, bytes: Buffer, mode?: number): void {
    const temporaryPath = `${filePath}.tmp`;
    if (fs.existsSync(temporaryPath) && fs.lstatSync(temporaryPath).isSymbolicLink()) {
        throw new Error(`Refusing to write through symlink: ${temporaryPath}`);
    }
    fs.writeFileSync(temporaryPath, bytes);
    if (mode !== undefined) fs.chmodSync(temporaryPath, mode);
    fs.renameSync(temporaryPath, filePath);
}

function writeAtomicJson(filePath: string, value: unknown): void {
    writeAtomicFile(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function removeStaleOutputs(
    outputRoot: string,
    previousOutputs: PreviousOutput[],
    nextPaths: Set<string>,
): void {
    for (const previous of previousOutputs) {
        if (nextPaths.has(previous.path)) continue;
        const destinationPath = path.resolve(outputRoot, ...previous.path.split("/"));
        assertNoSymlinkSegments(outputRoot, destinationPath);
        if (!fs.existsSync(destinationPath)) continue;
        const stats = fs.lstatSync(destinationPath);
        if (!stats.isFile()) throw new Error(`Refusing to remove non-file stale output: ${destinationPath}`);
        if (!previous.sha256 || sha256(fs.readFileSync(destinationPath)) !== previous.sha256) {
            throw new Error(`Refusing to remove modified or unverified stale output: ${destinationPath}`);
        }
        fs.unlinkSync(destinationPath);
    }
}

export function previewDistro(
    rootPath: string,
    manifestRelativePath = "distro/manifests/iot-edition.json",
): { distroName: string; outputDirectory: string; fileCount: number } {
    const plan = buildPlan(rootPath, manifestRelativePath);
    return {
        distroName: plan.definition.distro.name,
        outputDirectory: plan.baseManifest.outputDirectory,
        fileCount: plan.files.length,
    };
}

export function generateDistro(
    rootPath: string,
    manifestRelativePath = "distro/manifests/iot-edition.json",
): { distroName: string; outputDirectory: string; fileCount: number; manifestPath: string } {
    const plan = buildPlan(rootPath, manifestRelativePath);
    const outputRoot = plan.outputDirectory;
    assertNoSymlinkSegments(plan.root, outputRoot);
    fs.mkdirSync(outputRoot, { recursive: true });

    const previousOutputs = parsePreviousOutputs(
        plan.manifestPath,
        plan.sourceManifestRelativePath,
    );
    const previousByPath = new Map(previousOutputs.map((output) => [output.path, output]));
    const nextPaths = new Set<string>(["README.md"]);
    for (const file of plan.files) nextPaths.add(file.resolvedFile.destinationPath);

    for (const file of plan.files) {
        assertOwnedOrNewFile(
            outputRoot,
            file.destinationPath,
            file.resolvedFile.sha256,
            previousByPath,
        );
    }
    assertOwnedOrNewFile(
        outputRoot,
        path.join(outputRoot, "README.md"),
        plan.baseManifest.resolution.generatedFiles[0].sha256,
        previousByPath,
    );

    for (const file of plan.files) {
        assertNoSymlinkSegments(outputRoot, file.destinationPath);
        fs.mkdirSync(path.dirname(file.destinationPath), { recursive: true });
        writeAtomicFile(
            file.destinationPath,
            file.outputBytes,
            fs.statSync(file.sourcePath).mode & 0o777,
        );
    }
    const readmePath = path.join(outputRoot, "README.md");
    writeAtomicFile(readmePath, plan.readmeBytes);
    removeStaleOutputs(outputRoot, previousOutputs, nextPaths);

    const completeManifest: ResolvedDistroManifest = {
        ...plan.baseManifest,
        generationStatus: "complete",
    };
    writeAtomicJson(plan.manifestPath, completeManifest);

    return {
        distroName: plan.definition.distro.name,
        outputDirectory: plan.baseManifest.outputDirectory,
        fileCount: plan.files.length,
        manifestPath: plan.manifestPath,
    };
}
