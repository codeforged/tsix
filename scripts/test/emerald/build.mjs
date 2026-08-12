/**
 * Build script untuk emerald browser bundle.
 * 
 * Menggunakan esbuild untuk compile emerald.ts + adapter → satu file JS
 * yang bisa dipake langsung di browser HTML.
 */
import * as esbuild from "esbuild";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function build() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "stubs", "uuid.ts")],
    outfile: "/dev/null",
    write: false,
    bundle: false,
  });

  await esbuild.build({
    entryPoints: [path.join(__dirname, "emerald-bundle.ts")],
    outfile: path.join(__dirname, "emerald-bundle.js"),
    bundle: true,
    format: "iife",
    // No globalName - the entry file sets window.Emerald itself
    platform: "browser",
    target: "es2020",
    sourcemap: "inline",
    tsconfig: path.resolve("tsconfig.json"),
    alias: {
      uuid: path.join(__dirname, "stubs", "uuid.ts"),
    },
    define: {
      "process.env.NODE_ENV": '"development"',
    },
    plugins: [
      // Resolve @tsix/* and @common/* aliases
      {
        name: "tsix-aliases",
        setup(build) {
          // Resolve @tsix/* aliases
          build.onResolve({ filter: /^@tsix\// }, (args) => {
            const modName = args.path.replace("@tsix/", "");
            const mirrorPath = path.resolve("src/mirror/lib", modName + ".ts");
            const sdkPath = path.resolve("src/.tsix_sdk/lib", modName + ".ts");
            const rootPath = path.resolve("src/root/lib", modName + ".ts");
            if (fs.existsSync(mirrorPath)) return { path: mirrorPath };
            if (fs.existsSync(sdkPath)) return { path: sdkPath };
            if (fs.existsSync(rootPath)) return { path: rootPath };
            return { path: mirrorPath };
          });

          // Resolve @common/* aliases
          build.onResolve({ filter: /^@common\// }, (args) => {
            const resolved = path.resolve("src/common", args.path.replace("@common/", "") + ".ts");
            return { path: resolved };
          });

          // Stub ./UserLib when imported from mirror/lib
          build.onResolve({ filter: /\.\/UserLib$/ }, (args) => {
            if (args.importer && args.importer.includes("mirror/lib")) {
              return { path: path.join(__dirname, "stubs", "UserLib.ts") };
            }
          });
          build.onResolve({ filter: /^@common\// }, (args) => {
            const resolved = path.resolve(
              "src/common",
              args.path.replace("@common/", "")
            );
            return { path: resolved + ".ts" };
          });
          // Resolve SyscallCode — cari file fisik
          build.onResolve({ filter: /\.\.\/\.\.\/common\/SyscallCode/ }, (args) => {
            const resolved = path.resolve("src/common/SyscallCode.ts");
            return { path: resolved };
          });
        },
      },
    ],
    logLevel: "info",
  });

  console.log(`✅ Built: ${result.outputFiles?.[0]?.path || "emerald-bundle.js"}`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
