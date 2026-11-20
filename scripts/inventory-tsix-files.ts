import * as path from "path";
import { writeInventory } from "./lib/tsix-file-inventory";

const ROOT = path.resolve(__dirname, "..");
const inventory = writeInventory(ROOT);

console.log(`[distro:inventory] file: distro/tsix-files.json`);
console.log(`[distro:inventory] total: ${inventory.files.length}`);
for (const [category, count] of Object.entries(inventory.summary)) {
    console.log(`[distro:inventory] ${category}: ${count}`);
}
console.log(`[distro:inventory] needs-review: ${inventory.classificationSummary["needs-review"]}`);
if (inventory.reviewQueue.length > 0) {
    console.log(`[distro:inventory] resolve classifications in distro/file-classification-overrides.json`);
}
const reviewPreview = inventory.reviewQueue.slice(0, 20);
for (const item of reviewPreview) {
    console.log(`[distro:inventory] review ${item.category}: ${item.path}`);
}
if (inventory.reviewQueue.length > reviewPreview.length) {
    console.log(
        `[distro:inventory] ${inventory.reviewQueue.length - reviewPreview.length} more; inspect reviewQueue in distro/tsix-files.json`,
    );
}
