import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    buildInventory,
    classifyFile,
    readClassificationOverrides,
    recognizeFile,
} from "./tsix-file-inventory";

describe("TSIX file inventory", () => {
    let temporaryRoot: string | undefined;

    afterEach(() => {
        if (temporaryRoot) {
            fs.rmSync(temporaryRoot, { recursive: true, force: true });
            temporaryRoot = undefined;
        }
    });

    const createFile = (root: string, relativePath: string, content = "fixture"): void => {
        const absolutePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content);
    };

    it("uses explicit evidence and routes ambiguous deployment paths to review", () => {
        expect(classifyFile("src/kernel/Kernel.ts")).toBe("kernel");
        expect(classifyFile("src/mirror/lib/lantana/lantana-core.ts")).toBe("library");
        expect(classifyFile("src/mirror/opt/lantana/dashboard.ts")).toBe("application");
        expect(classifyFile("platformio/TSIX-All-in-One/include/secrets.h")).toBe("sensitive");
        expect(classifyFile("platformio/TSIX-All-in-One/include/secrets.sample.h")).toBe("firmware");
        expect(classifyFile("platformio/TSIX-All-in-One/flutter_helloworld.code-workspace"))
            .toBe("build-config");
        expect(classifyFile("src/mirror/etc/tpkg/keys/public.pem")).toBe("trust-anchor");
        expect(classifyFile("src/mirror/opt/lantana/parser.test.ts")).toBe("test");
        expect(classifyFile("wiki/diagram/overview.png")).toBe("asset");
        expect(classifyFile(".env.production")).toBe("sensitive");

        const otaArtifact = recognizeFile("src/mirror/opt/esp-ota/firmwares/test/firmware.bin");
        expect(otaArtifact.category).toBe("firmware");
        expect(otaArtifact.classification.state).toBe("needs-review");

        const ambiguousDemo = recognizeFile("src/mirror/opt/test/gui-demo.ts");
        expect(ambiguousDemo.category).toBe("application");
        expect(ambiguousDemo.classification.state).toBe("needs-review");
        expect(ambiguousDemo.classification.evidence.join(" ")).toContain("human review required");

        const firmwareExample = recognizeFile(
            "platformio/TSIX-All-in-One/lib/Crypto/examples/TestAES/TestAES.ino",
        );
        expect(firmwareExample.category).toBe("firmware");
        expect(firmwareExample.classification.state).toBe("needs-review");
        expect(firmwareExample.tags).toContain("example");

        const lantanaApp = recognizeFile("src/mirror/opt/demo/app.ts", [
            "@tsix/lantana/dashboard-switch-status",
        ]);
        expect(lantanaApp.tags).toEqual(["iot", "lantana"]);
        expect(lantanaApp.targets).toEqual(["vfs"]);

        expect(recognizeFile("src/mirror/lib/emerald.ts").tags)
            .toEqual(["desktop", "emerald", "tde"]);
        expect(recognizeFile("src/common/GUITypes.ts").tags)
            .toEqual(["desktop", "pixelspace", "tde"]);
        const desktopDependentApp = recognizeFile("src/mirror/opt/craving-tracker/app.ts", [
            "../lib/cashew",
        ]);
        expect(desktopDependentApp.tags).toEqual(["cashew", "desktop-dependent"]);
        expect(desktopDependentApp.tags).not.toContain("tde");

        expect(recognizeFile("misc/unknown.ts").classification.state).toBe("needs-review");
    });

    it("creates a sorted inventory, includes its output path, and skips local/build data", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsix-inventory-"));
        temporaryRoot = root;

        createFile(root, "src/kernel/core.ts");
        createFile(root, "src/kernel/entry.test.ts");
        createFile(root, "platformio/TSIX-All-in-One/main.cpp");
        createFile(root, "node_modules/example/index.js");
        createFile(root, ".git/config");
        createFile(root, "platformio/TSIX-All-in-One/lib/.piopm");
        createFile(root, "platformio/TSIX-All-in-One/lib/vendor/._metadata");
        createFile(root, "src/rootfs/runtime.db");
        createFile(root, "src/mirror/home/.gitkeep");
        createFile(root, "src/mirror/home/private.txt");
        createFile(root, "src/mirror/opt/test/hello-world.ts");
        createFile(root, "distro/tsix-iot/bin/command.ts");
        createFile(
            root,
            "src/mirror/opt/demo/lantana-consumer.ts",
            'import type { Status } from "@tsix/lantana/dashboard-switch-status";\n',
        );

        const inventory = buildInventory(root);
        const paths = inventory.files.map((file) => file.path);

        expect(inventory.schemaVersion).toBe(2);
        expect(paths).toEqual([
            "distro/tsix-files.json",
            "platformio/TSIX-All-in-One/main.cpp",
            "src/kernel/core.ts",
            "src/kernel/entry.test.ts",
            "src/mirror/home/.gitkeep",
            "src/mirror/opt/demo/lantana-consumer.ts",
            "src/mirror/opt/test/hello-world.ts",
        ]);
        expect(inventory.files.find((file) => file.path === "distro/tsix-files.json")?.category)
            .toBe("inventory");
        expect(inventory.files.find((file) => file.path === "src/kernel/entry.test.ts")?.category)
            .toBe("test");
        expect(inventory.files.find((file) => file.path === "platformio/TSIX-All-in-One/main.cpp")?.tags)
            .toEqual(["firmware", "iot"]);
        const lantanaConsumer = inventory.files.find(
            (file) => file.path === "src/mirror/opt/demo/lantana-consumer.ts",
        );
        expect(lantanaConsumer?.tags).toEqual(["iot", "lantana"]);
        expect(lantanaConsumer?.targets).toEqual(["vfs"]);
        expect(JSON.stringify(inventory)).not.toContain("@tsix/lantana/dashboard-switch-status");
        expect(inventory.files.find((file) => file.path === "src/mirror/opt/test/hello-world.ts")?.classification.state)
            .toBe("needs-review");
        expect(inventory.classificationSummary["needs-review"]).toBe(1);
        expect(inventory.reviewQueue.map((item) => item.path))
            .toEqual(["src/mirror/opt/test/hello-world.ts"]);
        expect(inventory.includesIgnoredFiles).toBe(true);
        expect(inventory.classificationStates["needs-review"]).toContain("do not package");
        expect(paths).not.toContain("distro/tsix-iot/bin/command.ts");
        expect(paths).not.toContain("platformio/TSIX-All-in-One/lib/.piopm");
        expect(paths).not.toContain("platformio/TSIX-All-in-One/lib/vendor/._metadata");
    });

    it("applies explicit human overrides and refuses to downgrade sensitive files", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsix-inventory-"));
        temporaryRoot = root;
        createFile(root, "src/mirror/opt/test/tutorial.ts");
        createFile(
            root,
            "distro/file-classification-overrides.json",
            JSON.stringify({
                schemaVersion: 1,
                overrides: {
                    "src/mirror/opt/test/tutorial.ts": {
                        category: "application",
                        reason: "Reviewed as a distributable tutorial app.",
                    },
                },
            }),
        );

        const inventory = buildInventory(root, readClassificationOverrides(root));
        const tutorial = inventory.files.find((file) => file.path === "src/mirror/opt/test/tutorial.ts");
        expect(tutorial?.classification.state).toBe("reviewed");
        expect(inventory.reviewQueue).toHaveLength(0);

        createFile(root, "platformio/TSIX-All-in-One/include/secrets.h");
        expect(() => buildInventory(root, {
            "platformio/TSIX-All-in-One/include/secrets.h": {
                category: "firmware",
                reason: "Must not override the sensitive guard.",
            },
        })).toThrow("Unsafe category override");
    });
});
