import { Program, std, shell } from "@tsix/Application";

/**
 * MEM Utility
 *
 * System memory summary + OPTIONAL per-process breakdown.
 *
 * Important to understand:
 *   - `rss` from process.memoryUsage() is PROCESS-WIDE (main thread + every
 *     worker thread). Inside a worker, this number does NOT represent that
 *     worker's own usage.
 *   - The per-isolate figures are heapTotal / heapUsed / external / arrayBuffers.
 *   - For per-process attribution use `mem --per-proc` (or `ps --mem`), which
 *     reads each worker isolate's heap statistics directly from the kernel.
 */
export const main = Program(async (args: string[]) => {
  const perProc = args.includes("--per-proc") || args.includes("-p");

  const memory = process.memoryUsage();
  const mb = (n: number) => (n / 1024 / 1024).toFixed(2);
  const fm = (n: number) => (n / 1048576).toFixed(1).padStart(8);

  let out =
    `--- this process (its own PID isolate) ---\n` +
    `heapTotal:    ${mb(memory.heapTotal)} MB\n` +
    `heapUsed:     ${mb(memory.heapUsed)} MB   <- owned by this process\n` +
    `external:     ${mb(memory.external)} MB\n` +
    `arrayBuffers: ${mb(memory.arrayBuffers)} MB\n` +
    `rss:          ${mb(memory.rss)} MB   <- PROCESS-WIDE (all workers + main thread)\n`;

  if (!perProc) {
    out += `\nTip: run 'mem --per-proc' to see memory per process,\n`;
    out += `     or 'ps --mem' / 'ps --sort-mem'.\n`;
    return out;
  }

  // --- Per-process attribution (pull straight from each worker isolate) ---
  let procs: any[] = [];
  try {
    procs = await shell.ps({ includeMemory: true });
  } catch (e: any) {
    return out + `\nFailed to read the process list: ${e.message}\n`;
  }

  const rows = procs
    .filter((p: any) => p.mem)
    .map((p: any) => ({
      pid: p.pid,
      name: p.name,
      heapUsed: p.mem.heapUsed,
      external: p.mem.external,
      total: p.mem.heapUsed + p.mem.external,
    }))
    .sort((a, b) => b.total - a.total);

  let sumHeap = 0, sumExt = 0;
  for (const r of rows) { sumHeap += r.heapUsed; sumExt += r.external; }

  out += `\n--- per process (largest first) ---\n`;
  out += `${`PID`.padStart(6)}  ${`NAME`.padEnd(20)}${`HEAP(MB)`.padStart(10)}${`EXT(MB)`.padStart(9)}${`TOTAL`.padStart(9)}\n`;
  out += "-".repeat(58) + "\n";
  for (const r of rows) {
    out += `${String(r.pid).padStart(6)}  ${String(r.name).padEnd(20)}${fm(r.heapUsed)}${fm(r.external)}${fm(r.total)}\n`;
  }
  out += "-".repeat(58) + "\n";
  out += `${`TOTAL`.padStart(6)}  ${(rows.length + " processes").padEnd(20)}${fm(sumHeap)}${fm(sumExt)}${fm(sumHeap + sumExt)}\n`;

  const workerTotal = sumHeap + sumExt;
  const rssBytes = memory.rss;
  out += `\n--- reconciliation with rss ---\n`;
  out += `  measured workers : ${fm(workerTotal)} MB\n`;
  out += `  process rss      : ${fm(rssBytes)} MB\n`;
  out += `  difference       : ${fm(rssBytes - workerTotal)} MB  <- main thread + native libraries\n`;
  out += `                     (esbuild native service, mqtt, mysql2, better-sqlite3,\n`;
  out += `                      serialport/node-hid/usb, plus V8 allocator overhead)\n`;
  out += `  unreadable procs : ${procs.filter((p: any) => !p.mem).length} (zombie PCB / no worker)\n`;

  return out;
});