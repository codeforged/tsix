/**
 * Extract Mermaid diagrams from wiki markdown files and convert to PNG.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { execSync } from "child_process";
import path from "path";

const wikiDir = path.resolve("wiki");
const diagramDir = path.resolve("wiki/diagram");
if (!existsSync(diagramDir)) mkdirSync(diagramDir, { recursive: true });

const files = readdirSync(wikiDir).filter(f => f.endsWith(".md")).map(f => path.join(wikiDir, f));
let counter = 0;
const results = [];

for (const file of files) {
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  let inMermaid = false;
  let mermaidLines = [];
  let diagramIndex = 0;
  let baseName = path.basename(file, ".md");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith("```mermaid")) {
      inMermaid = true;
      mermaidLines = [];
      continue;
    }

    if (inMermaid && line.trim().startsWith("```")) {
      inMermaid = false;
      const mermaidCode = mermaidLines.join("\n").trim();
      if (!mermaidCode) continue;

      diagramIndex++;
      counter++;
      const mmdFile = path.join(diagramDir, `${baseName}-${diagramIndex}.mmd`);
      const pngFile = path.join(diagramDir, `${baseName}-${diagramIndex}.png`);

      writeFileSync(mmdFile, mermaidCode, "utf-8");

      try {
        execSync(`npx -y mmdc -i "${mmdFile}" -o "${pngFile}" -b white -w 1200 -H 800`, {
          stdio: "pipe",
          timeout: 30000,
        });
        results.push(`✅ ${baseName} diagram ${diagramIndex} → ${pngFile}`);
      } catch (e) {
        results.push(`❌ ${baseName} diagram ${diagramIndex}: ${e.message}`);
      }
      continue;
    }

    if (inMermaid) {
      mermaidLines.push(line);
    }
  }
}

console.log(`\n=== Selesai: ${counter} diagram diproses ===\n`);
results.forEach(r => console.log(r));
