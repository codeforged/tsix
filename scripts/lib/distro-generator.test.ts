import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInventory } from "./tsix-file-inventory";
import { generateDistro } from "./distro-generator";

describe("distro generator", () => {
    let temporaryRoot: string | undefined;

    afterEach(() => {
        if (temporaryRoot) {
            fs.rmSync(temporaryRoot, { recursive: true, force: true });
            temporaryRoot = undefined;
        }
    });

    const createFile = (root: string, relativePath: string, content: string): void => {
        const fullPath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
    };

    it("copies selected files, transforms the npm lifecycle hook, and preserves protected exclusions", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsix-distro-generator-"));
        temporaryRoot = root;
        createFile(root, "src/kernel/core.ts", "export const core = true;\n");
        createFile(root, "src/mirror/etc/shadow", "root:operator-hash\n");
        createFile(root, "src/mirror/opt/test/demo.ts", "export const demo = true;\n");
        createFile(root, "scripts/install.ts", "console.log('install');\n");
        createFile(root, "scripts/lib/fresh-accounts.ts", "export {};\n");
        createFile(root, "package.json", JSON.stringify({
            name: "fixture",
            version: "1.0.0",
            scripts: { install: "node scripts/install.ts", test: "vitest run" },
        }, null, 2));
        createFile(root, "package-lock.json", "{}\n");
        createFile(root, "tsconfig.json", "{}\n");
        createFile(
            root,
            "distro/manifests/fixture.json",
            JSON.stringify({
                schemaVersion: 1,
                distro: {
                    id: "fixture",
                    name: "Fixture Distro",
                    version: "1.0.0",
                    status: "draft",
                    description: "Test package",
                    purpose: [],
                    features: ["Core runtime"],
                },
                sourceInventory: "../tsix-files.json",
                outputDirectory: "../fixture",
                layout: "preserve-source-path",
                installation: {
                    entrypoint: "scripts/install.ts",
                    npmScriptName: "tsix:install",
                    rootAccountBootstrap: "locked-until-password-set",
                },
                selection: {
                    match: "any",
                    exactPathsOverrideCategoryExclusions: true,
                    include: {
                        categories: ["kernel"],
                        tags: [],
                        paths: [
                            "scripts/install.ts",
                            "scripts/lib/fresh-accounts.ts",
                            "package.json",
                            "package-lock.json",
                            "tsconfig.json",
                            "src/mirror/etc/shadow",
                        ],
                    },
                    exclude: {
                        categories: ["node-local", "sensitive", "test", "tooling"],
                        protectedCategories: ["node-local", "sensitive", "test"],
                        classificationStates: ["needs-review"],
                        tags: ["example"],
                        pathPrefixes: ["src/mirror/opt/test"],
                    },
                },
                releaseNotes: [],
            }, null, 2),
        );
        const inventory = buildInventory(root);
        createFile(root, "distro/tsix-files.json", `${JSON.stringify(inventory, null, 2)}\n`);

        const result = generateDistro(root, "distro/manifests/fixture.json");
        const outputRoot = path.join(root, "distro/fixture");
        const outputPackage = JSON.parse(fs.readFileSync(path.join(outputRoot, "package.json"), "utf8"));
        const resolved = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));

        expect(result.fileCount).toBe(6);
        expect(outputPackage.scripts["tsix:install"]).toBe("node scripts/install.ts");
        expect(outputPackage.scripts.install).toBeUndefined();
        expect(fs.readFileSync(path.join(outputRoot, "scripts/install.ts"), "utf8"))
            .toBe("console.log('install');\n");
        expect(fs.existsSync(path.join(outputRoot, "src/kernel/core.ts"))).toBe(true);
        expect(fs.existsSync(path.join(outputRoot, "src/mirror/etc/shadow"))).toBe(false);
        expect(fs.existsSync(path.join(outputRoot, "src/mirror/opt/test/demo.ts"))).toBe(false);
        expect(fs.existsSync(path.join(outputRoot, "README.md"))).toBe(true);
        expect(resolved.generationStatus).toBe("complete");
        expect(resolved.files.find((file: { sourcePath: string }) => file.sourcePath === "package.json").transform)
            .toBe("rename-install-lifecycle-script");
    });

    it("refuses to overwrite a generated file edited outside the generator", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsix-distro-generator-"));
        temporaryRoot = root;
        createFile(root, "src/kernel/core.ts", "export const core = true;\n");
        createFile(root, "scripts/install.ts", "console.log('install');\n");
        createFile(root, "package.json", JSON.stringify({
            scripts: { install: "node scripts/install.ts" },
        }));
        createFile(root, "distro/manifests/fixture.json", JSON.stringify({
            schemaVersion: 1,
            distro: {
                id: "fixture",
                name: "Fixture",
                version: "1",
                status: "draft",
                description: "Test",
                purpose: [],
                features: [],
            },
            sourceInventory: "../tsix-files.json",
            outputDirectory: "../fixture",
            layout: "preserve-source-path",
            installation: {
                entrypoint: "scripts/install.ts",
                npmScriptName: "tsix:install",
                rootAccountBootstrap: "locked-until-password-set",
            },
            selection: {
                match: "any",
                exactPathsOverrideCategoryExclusions: true,
                include: {
                    categories: ["kernel"],
                    tags: [],
                    paths: ["scripts/install.ts", "package.json"],
                },
                exclude: {
                    categories: ["node-local", "sensitive", "test", "tooling"],
                    protectedCategories: ["node-local", "sensitive", "test"],
                    classificationStates: ["needs-review"],
                    tags: ["example"],
                    pathPrefixes: ["src/mirror/opt/test"],
                },
            },
            releaseNotes: [],
        }));
        createFile(root, "package-lock.json", "{}\n");
        createFile(root, "tsconfig.json", "{}\n");
        const inventory = buildInventory(root);
        createFile(root, "distro/tsix-files.json", `${JSON.stringify(inventory, null, 2)}\n`);

        generateDistro(root, "distro/manifests/fixture.json");
        const generatedKernel = path.join(root, "distro/fixture/src/kernel/core.ts");
        fs.writeFileSync(generatedKernel, "user edit\n");

        expect(() => generateDistro(root, "distro/manifests/fixture.json"))
            .toThrow("Generated destination was modified or is not owned by this generator");
    });
});
