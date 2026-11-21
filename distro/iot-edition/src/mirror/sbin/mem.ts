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
  out += `${`TOTAL`.padStart(6)}  ${`${rows.length} process${rows.length === 1 ? "" : "es"}`.padEnd(20)}${fm(sumHeap)}${fm(sumExt)}${fm(sumHeap + sumExt)}\n`;

  const workerTotal = sumHeap + sumExt;
  const rssBytes = memory.rss;
  out += `\n--- reconciliation with rss ---\n`;
  out += `  measured workers : ${fm(workerTotal)} MB   (heapUsed + external per isolate)\n`;
  out += `  process rss      : ${fm(rssBytes)} MB   (whole process: main + all workers)\n`;
  out += `  unattributed     : ${fm(rssBytes - workerTotal)} MB\n`;
  out += `\n  NOTE: 'measured workers' is NOT a lower bound of real worker RSS.\n`;
  out += `  heapTotal includes reserved-but-not-resident pages, so heapUsed+external\n`;
  out += `  can exceed the RSS those workers actually added (measured: 161.8 MB vs\n`;
  out += `  144.7 MB RSS growth for 12 workers). The 'unattributed' figure therefore\n`;
  out += `  mixes main thread data, V8 code space/JIT, thread stacks, mmap, and worker\n`;
  out += `  isolate overhead. Read it as a trend, not as a precise main-thread size.\n`;
  out += `  Use 'ps --sort-mem' to compare processes against each other instead.\n`;
  const unreadable = procs.filter((p: any) => !p.mem).length;
  out += `  unreadable procs : ${unreadable} (no worker, EXITED, or worker did not answer)\n`;
  if (procs.length > 0 && unreadable === procs.length) {
    // Tanpa penjelasan ini, kolom kosong terbaca sebagai "fitur rusak".
    out += `\n  WHY NO DATA: the kernel reads per-isolate stats directly with\n`;
    out += `  worker.getHeapStatistics(), which exists only on Node >= 22.16. On older\n`;
    out += `  Node it falls back to asking each worker over IPC with a short timeout,\n`;
    out += `  and a worker stuck in synchronous code cannot answer in time.\n`;
    const nodeVer = (globalThis as any).process?.version;
    if (nodeVer) out += `  Host Node: ${nodeVer}\n`;
  }

  return out;
});