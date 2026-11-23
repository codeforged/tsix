/**
 * typecheck-pistachio.ts — Typecheck khusus Pistachio + konsumennya.
 *
 * Memakai `tsconfig.pistachio.json`. Gagal (exit 1) bila ada error di file
 * yang tercantum pada `include` config itu. Error di dependensi transitif di
 * luar cakupan (mis. inti OS) hanya dilaporkan sebagai catatan, karena bukan
 * tanggung jawab Pistachio dan sudah tercatat di baseline `npm run typecheck`.
 *
 * Jalankan: npm run typecheck:pistachio
 */

import * as path from "path";
import * as ts from "typescript";

const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "tsconfig.pistachio.json");

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
    console.error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
    process.exit(2);
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root, undefined, configPath);
const inScope = new Set(parsed.fileNames.map((f) => path.resolve(f)));

const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const diagnostics = ts.getPreEmitDiagnostics(program);

const host: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
};

const scoped: ts.Diagnostic[] = [];
const outside = new Map<string, number>();
for (const d of diagnostics) {
    const file = d.file ? path.resolve(d.file.fileName) : null;
    if (!file || inScope.has(file)) {
        scoped.push(d);
    } else {
        const rel = path.relative(root, file);
        outside.set(rel, (outside.get(rel) ?? 0) + 1);
    }
}

if (outside.size > 0) {
    console.log(`Catatan: ${[...outside.values()].reduce((a, b) => a + b, 0)} error di luar cakupan Pistachio (diabaikan):`);
    for (const [file, count] of outside) console.log(`  ${file} (${count})`);
}

if (scoped.length > 0) {
    console.error(ts.formatDiagnosticsWithColorAndContext(scoped, host));
    console.error(`typecheck:pistachio GAGAL — ${scoped.length} error di ${inScope.size} file.`);
    process.exit(1);
}

console.log(`typecheck:pistachio OK — 0 error di ${inScope.size} file.`);
