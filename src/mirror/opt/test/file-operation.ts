import { Program, std, fs, shell } from "@tsix/Application";

/**
 * FILE-OPERATION — file operation lab for TSIX (FsLib / VFS syscalls)
 *
 * One binary to try EVERY way of touching a file in TSIX:
 *   - path-based  : readFile() / writeFile()
 *   - fd-based    : open() / read() / write() / close()
 *   - chunk-based : readChunk() / writeChunk()  (large files, progress)
 *   - metadata    : stat() / ls() / getSize() / getUsage() / getMounts()
 *   - permissions : chmod() / chown()
 *
 * Usage (see `--help` for the full list):
 *
 *   /opt/test/file-operation --write  /tmp/notes.txt hello world
 *   /opt/test/file-operation --read   /tmp/notes.txt
 *   /opt/test/file-operation --append /tmp/notes.txt "second line\n"
 *   /opt/test/file-operation --chunk  /tmp/notes.txt 0 5
 *   /opt/test/file-operation --info   /tmp/notes.txt
 *   /opt/test/file-operation --demo          # self-test, runs everything
 *
 * Why a `--demo` mode? Because examples that are never executed go stale fast.
 * `--demo` runs every operation against `/tmp/file-op-demo/` and reports how
 * many checks passed — so this demo doubles as a manual regression test for
 * the FsLib → syscall → VFS path on any node.
 *
 * (c) 2026 TSIX Project
 */

// ==================== COLORS & REPORTING ====================

const C = {
    ok: "\x1b[92m",
    err: "\x1b[91m",
    warn: "\x1b[93m",
    cyan: "\x1b[96m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
};

const say = (msg: string) => std.println(msg);
const ok = (msg: string) => say(`${C.ok}✓${C.reset} ${msg}`);
const info = (msg: string) => say(`${C.cyan}·${C.reset} ${msg}`);
const warn = (msg: string) => say(`${C.warn}!${C.reset} ${msg}`);
const fail = (msg: string) => say(`${C.err}✗${C.reset} ${msg}`);

/** Pass/fail counters used by `--demo`. */
const report = { pass: 0, fail: 0 };

/** check(): compare actual vs expected — the core of `--demo`. */
async function check(label: string, actual: any, expected: any): Promise<void> {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        report.pass++;
        ok(`${label} ${C.dim}= ${a}${C.reset}`);
    } else {
        report.fail++;
        say(`${C.err}✗${C.reset} ${label} — expected ${e}, got ${a}`);
    }
}

// ==================== HELPERS ====================

/**
 * Return values in TSIX are intentionally NOT uniform (they mirror POSIX-ish
 * syscalls), so know which one throws and which one returns a sentinel:
 *
 *   - stat()      → metadata object, or `null` when missing (never throws)
 *   - readFile()  → file content, or **throws** ENOENT when missing
 *   - getSize()   → size in chars, or **throws** ENOENT when missing
 *   - readChunk() → substring, or `null` when offset is out of range
 *   - open()      → fd (number), or **throws** on permission/missing errors
 *
 * The helpers below normalize everything to "throws → safe value" so app code
 * is not littered with try/catch. Copy this pattern into your own apps.
 */

/** Safe stat(): null when missing / on error. */
async function statOf(path: string): Promise<any | null> {
    try {
        return await fs.stat(path);
    } catch (_e) {
        return null;
    }
}

/** The "file exists" check in TSIX — never throws. */
async function existsOf(path: string): Promise<boolean> {
    return (await statOf(path)) !== null;
}

/** Size in chars, or -1 when missing (getSize() itself throws ENOENT). */
async function sizeOf(path: string): Promise<number> {
    try {
        return await fs.getSize(path);
    } catch (_e) {
        return -1;
    }
}

/** Whole file content, or null when missing (readFile() throws ENOENT). */
async function readWhole(path: string): Promise<string | null> {
    try {
        return await fs.readFile(path);
    } catch (_e) {
        return null;
    }
}

/** 0o755 → "755" for `ls -l` style display. */
function octal(mode: any): string {
    const n = typeof mode === "number" ? mode : 0;
    return (n & 0o777).toString(8).padStart(3, "0");
}

/** VFS node type → `ls -l` style letter (d/-/c). */
function kindLetter(type: any): string {
    return type === "DIRECTORY" ? "d" : type === "DEVICE" ? "c" : "-";
}

/** Print text safely (escape control chars, truncate when long). */
function preview(text: string | null, max = 120): string {
    if (text === null) return `${C.dim}(null)${C.reset}`;
    const shown = text.length > max ? text.slice(0, max) + "…" : text;
    return JSON.stringify(shown);
}

/** Join the remaining args into one text (supports spaces). */
function joinText(args: string[], from: number): string {
    return args.slice(from).join(" ");
}

/** Parse an integer arg with a clear failure message. */
function num(raw: string | undefined, label: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`${label} must be an integer >= 0 (got: ${raw ?? "empty"})`);
    }
    return n;
}

// ==================== COMMANDS ====================

/**
 * `--write <file> <text...>` — replace the whole content (path-based).
 * The most common way to write; the file is created when missing (mode 644).
 */
async function cmdWrite(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--write needs <file> <text...>");
    const text = joinText(args, 1);

    const wrote = await fs.writeFile(path, text);
    if (!wrote) throw new Error(`failed to write ${path}`);

    const node = await statOf(path);
    info(`writeFile() → ${path} (${text.length} chars, mode ${octal(node?.mode)})`);
    ok(`written: ${preview(text)}`);
}

/**
 * `--write-fd <file> <text...>` — low-level variant (open/write/close).
 * Use it when you need FD control: many writes without reopening, or precise
 * knowledge of when the file is opened and closed.
 */
async function cmdWriteFd(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--write-fd needs <file> <text...>");
    const text = joinText(args, 1);

    const fd = await fs.open(path, "w"); // "w" = create/truncate, mode 644
    info(`open("w") → fd ${fd}`);
    try {
        await fs.write(fd, text);
        info(`write(fd ${fd}) → ${text.length} chars`);
    } finally {
        // MANDATORY: a leaked FD holds resources until the process dies.
        await fs.close(fd);
        info(`close(fd ${fd})`);
    }
    ok(`written via fd: ${preview(text)}`);
}

/** `--read <file>` — read the whole content + size report. */
async function cmdRead(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--read needs <file>");

    const node = await statOf(path);
    if (!node) throw new Error(`not found: ${path}`);
    if (node.type === "DIRECTORY") throw new Error(`${path} is a directory, not a file`);

    const content = await readWhole(path);
    if (content === null) throw new Error(`failed to read ${path}`);

    say(content);
    info(`readFile() → ${content.length} chars (size=${node.size}, mode=${octal(node.mode)})`);
}

/**
 * `--append <file> <text...>` — append to the end of a file (chunk recipe).
 *
 * Resize-free and backend-agnostic: measure the current length, then write at
 * that offset. offset == length means no padding, so the result is a pure
 * append. `writeChunk()` also creates the file when it does not exist yet.
 */
async function cmdAppend(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--append needs <file> <text...>");
    const text = joinText(args, 1);

    const before = await sizeOf(path);
    const offset = before < 0 ? 0 : before; // getSize() throws when missing → treat as 0

    const wrote = await fs.writeChunk(path, text, offset);
    if (!wrote) throw new Error(`failed to append to ${path}`);

    const after = await sizeOf(path);
    ok(`appended ${text.length} chars at offset ${offset} → size ${before < 0 ? 0 : before} → ${after}`);
}

/**
 * `--append-fd <file> <text...>` — POSIX-style append: `open(path, "a")`.
 *
 * The kernel maps the "a" flag to `VFS.append()`, so this is the cheapest
 * append (the old content is never read). The file is created on first write.
 */
async function cmdAppendFd(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--append-fd needs <file> <text...>");
    const text = joinText(args, 1);

    const before = await sizeOf(path);
    const fd = await fs.open(path, "a"); // "a" = append (never truncates)
    try {
        await fs.write(fd, text);
    } finally {
        await fs.close(fd);
    }

    const after = await sizeOf(path);
    ok(`appended via fd ("a") ${text.length} chars → size ${before < 0 ? 0 : before} → ${after}`);
}

/** `--chunk <file> <offset> <length>` — read part of a file (chunked read). */
async function cmdChunk(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--chunk needs <file> <offset> <length>");
    const offset = num(args[1], "offset");
    const length = num(args[2], "length");

    const chunk = await fs.readChunk(path, offset, length);
    if (chunk === null) {
        // null = offset out of range (NOT an error) — that is EOF in TSIX.
        warn(`readChunk(${offset}, ${length}) → null (offset out of range; file size: ${await sizeOf(path)})`);
        return;
    }
    ok(`readChunk(${offset}, ${length}) → ${preview(chunk)}`);
}

/**
 * `--patch <file> <offset> <text>` — in-place chunk write (writeChunk).
 * `writeChunk()` **replaces** `text.length` chars starting at `offset`; it does
 * not insert. Total length changes only when the new text is longer/shorter.
 */
async function cmdPatch(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--patch needs <file> <offset> <text>");
    const offset = num(args[1], "offset");
    const text = joinText(args, 2);
    if (!text) throw new Error("--patch needs replacement text");

    const before = await readWhole(path);
    const wrote = await fs.writeChunk(path, text, offset);
    if (!wrote) throw new Error(`failed to patch ${path}`);
    const after = await readWhole(path);

    ok(`patched ${text.length} chars at offset ${offset}`);
    say(`  ${C.dim}before: ${preview(before)}${C.reset}`);
    say(`  ${C.dim}after : ${preview(after)}${C.reset}`);
}

/**
 * `--copy <src> [dst] [--chunk-size <chars>]` — copy with a progress bar.
 * This is how you copy a huge file (hundreds of MB) without loading it all
 * into memory: the source is streamed chunk by chunk.
 */
async function cmdCopy(args: string[]): Promise<void> {
    const src = args[0];
    if (!src) throw new Error("--copy needs <src> [dst]");

    const csIdx = args.indexOf("--chunk-size");
    // 31 KB = batas chunk protokol NetFS (FsLib men-clamp ke angka ini juga).
    const chunkSize = csIdx >= 0 ? num(args[csIdx + 1], "--chunk-size") : 31 * 1024;
    const positional = args.filter((_a, i) => i !== 0 && i !== csIdx && i !== csIdx + 1);
    const dst = positional[0] || `${src}.copy`;

    const total = await sizeOf(src);
    if (total < 0) throw new Error(`source not found: ${src}`);

    let lastPct = -1;
    const copied = await fs.copyWithProgress(
        src,
        dst,
        (pct: number) => {
            // Throttle the display; FsLib already limits callbacks to ~200ms.
            if (pct === lastPct) return;
            lastPct = pct;
            const filled = Math.round(pct / 5);
            const bar = "█".repeat(filled) + "░".repeat(20 - filled);
            void std.print(`\r  ${bar} ${String(pct).padStart(3)}%`);
        },
        chunkSize,
    );
    say("");
    if (!copied) throw new Error(`failed to copy to ${dst}`);

    await check("copy: destination size == source size", await sizeOf(dst), total);
}

/** `--info <path>` — `stat`-like metadata. */
async function cmdInfo(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--info needs <path>");

    const node = await statOf(path);
    if (!node) throw new Error(`not found: ${path}`);

    say(`${C.bold}${path}${C.reset}`);
    say(`  type    : ${node.type}`);
    say(`  size    : ${node.size} chars`);
    say(`  mode    : ${octal(node.mode)} (decimal ${node.mode})`);
    say(`  owner   : uid=${node.uid} gid=${node.gid}`);
    if (node.createdAt) say(`  created : ${new Date(node.createdAt).toISOString()}`);
    if (node.modifiedAt) say(`  modified: ${new Date(node.modifiedAt).toISOString()}`);
}

/** `--exists <path>` — existence check; exits 1 when missing (script friendly). */
async function cmdExists(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--exists needs <path>");

    const node = await statOf(path);
    if (!node) {
        fail(`not found: ${path}`);
        // Exit 1 so scripts can branch: `if file-operation --exists x; then ...`
        await shell.exit(1);
        return;
    }
    ok(`exists: ${path} (${node.type}${node.type === "FILE" ? `, ${node.size} chars` : ""})`);
}

/** `--size <file>` — size in chars (note: NOT UTF-8 bytes). */
async function cmdSize(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--size needs <file>");
    const size = await sizeOf(path);
    if (size < 0) throw new Error(`not found: ${path}`);
    ok(`${path}: ${size} chars`);
    info(`${C.dim}note: chunk offsets count CHARACTERS (JS code units), not UTF-8 bytes${C.reset}`);
}

/** `--ls [dir]` — directory listing with type + mode + size. */
async function cmdLs(args: string[]): Promise<void> {
    const path = args[0] || ".";
    const items = await fs.ls(path);

    if (!items || items.length === 0) {
        warn(`empty: ${path}`);
        return;
    }
    say(`${C.bold}${path}${C.reset} (${items.length} entries)`);
    for (const it of items) {
        say(`  ${kindLetter(it.type)}${octal(it.mode)}  ${String(it.size).padStart(8)}  ${it.name}`);
    }
}

/**
 * `--mkdir <dir/nested/deep>` — create a directory.
 *
 * DIFFERENT from POSIX: TSIX `mkdir()` is **recursive** (every path segment is
 * created) and **idempotent** (already exists → still `true`). There is no
 * separate `mkdir -p`: `/tmp/a/b/c` works in one call. This holds for every
 * backend (VFS/RamFS/BKFS/HostVFS) since each one creates segments one by one.
 */
async function cmdMkdir(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--mkdir needs <dir>");

    const existed = await existsOf(path);
    const made = await fs.mkdir(path);
    if (!made) throw new Error(`failed to create ${path} (check parent permissions)`);

    if (existed) {
        warn(`already exists: ${path} (mkdir() still reports success — idempotent)`);
        return;
    }
    ok(`directory created: ${path} (recursive — parents are created too)`);
}

/** `--rm <file>` — delete a file. */
async function cmdRm(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--rm needs <file>");
    const node = await statOf(path);
    if (!node) throw new Error(`not found: ${path}`);
    if (node.type === "DIRECTORY") throw new Error(`${path} is a directory — use --rmdir`);

    const gone = await fs.unlink(path);
    if (!gone) throw new Error(`failed to delete ${path}`);
    ok(`deleted: ${path}`);
}

/** `--rmdir <dir>` — remove an EMPTY directory (deepest first). */
async function cmdRmdir(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--rmdir needs <dir>");
    const gone = await fs.rmdir(path);
    if (!gone) {
        // rmdir() = false when it is not a directory, or when it is not empty.
        warn(`${path}: failed (not a directory, or still not empty — delete contents first)`);
        return;
    }
    ok(`directory removed: ${path}`);
}

/** `--chmod <file> <octal-mode>` — e.g. `--chmod app.sh 755`. */
async function cmdChmod(args: string[]): Promise<void> {
    const path = args[0];
    const raw = args[1];
    if (!path || !raw) throw new Error("--chmod needs <file> <octal-mode> (e.g. 755)");
    if (!/^[0-7]{3,4}$/.test(raw)) throw new Error(`mode must be 3-4 octal digits: ${raw}`);

    const changed = await fs.chmod(path, parseInt(raw, 8));
    if (!changed) {
        // false = missing, not the owner, or not root.
        throw new Error(`chmod failed for ${path} (owner or root only)`);
    }
    ok(`${path} → ${octal((await statOf(path))?.mode)}`);
}

/** `--chown <file> <uid> <gid>` — requires root. */
async function cmdChown(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--chown needs <file> <uid> <gid>");
    const uid = num(args[1], "uid");
    const gid = num(args[2], "gid");

    const changed = await fs.chown(path, uid, gid);
    if (!changed) throw new Error(`chown failed for ${path} (root required)`);
    ok(`${path} → uid=${uid} gid=${gid}`);
}

/** `--touch <file>` — create an empty file when missing (mode 644). */
async function cmdTouch(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--touch needs <file>");
    if (await existsOf(path)) {
        warn(`already exists: ${path} (touch does not change the content)`);
        return;
    }
    const fd = await fs.open(path, "w"); // "w" on a new file = create empty
    await fs.close(fd);
    ok(`empty file created: ${path}`);
}

/** `--wc <file>` — lines / words / chars, like `wc`. */
async function cmdWc(args: string[]): Promise<void> {
    const path = args[0];
    if (!path) throw new Error("--wc needs <file>");
    const content = await readWhole(path);
    if (content === null) throw new Error(`not found: ${path}`);

    const lines = content.length === 0 ? 0 : content.split("\n").length;
    const words = content.split(/\s+/).filter(Boolean).length;
    ok(`${lines} lines, ${words} words, ${content.length} chars (${path})`);
}

/** `--usage [path]` — VFS statistics (size, file/dir count) from the driver. */
async function cmdUsage(args: string[]): Promise<void> {
    const path = args[0] || "/";
    const usage = await fs.getUsage(path);
    ok(
        `${path}: ${usage.files} files, ${usage.dirs} dirs, ${usage.size} chars` +
            (usage.diskSize ? ` (disk ${usage.diskSize} bytes)` : ""),
    );
    info(`${C.dim}note: getUsage(path) reports the WHOLE filesystem backing that path${C.reset}`);
}

/** `--mounts` — list mounts (which path lives on which driver). */
async function cmdMounts(): Promise<void> {
    const mounts = await fs.getMounts();
    for (const m of mounts) {
        say(`  ${m.vfsPath.padEnd(16)} ${m.type.padEnd(6)} ${m.readOnly ? "ro" : "rw"}  ${m.source}`);
    }
}

// ==================== DEMO MODE ====================

/**
 * `--demo` — run EVERY operation against `/tmp/file-op-demo/` and report the
 * result. Safe to re-run (always cleaned up first) and it never touches other
 * files.
 */
async function cmdDemo(): Promise<void> {
    const dir = "/tmp/file-op-demo";
    const file = `${dir}/notes.txt`;
    const big = `${dir}/big.txt`;
    const copy = `${dir}/copy.txt`;

    say(`${C.bold}FILE OPERATION DEMO — ${dir}${C.reset}`);

    // --- 0. Clean up leftovers so the run is idempotent ---
    for (const leaf of [`${dir}/a/b/c`, `${dir}/a/b`, `${dir}/a`, `${dir}/sub`]) {
        if (await existsOf(leaf)) await fs.rmdir(leaf); // rmdir() refuses non-empty dirs
    }
    for (const p of [copy, big, file]) {
        if (await existsOf(p)) await fs.unlink(p);
    }
    if (!(await existsOf(dir))) await fs.mkdir(dir);

    // --- 1. Write & read (path-based) ---
    // Expectations are derived from variables — no magic numbers — so the demo
    // stays correct even when the sample text is edited.
    const content = "line one\nline two\n"; // 18 chars
    await check("writeFile()", await fs.writeFile(file, content), true);
    await check("readFile()", await readWhole(file), content);
    await check("getSize()", await sizeOf(file), content.length);

    // --- 2. FD-based ---
    const fd = await fs.open(file, "r");
    await check('open("r") returns fd', typeof fd, "number");
    await check("read(fd)", await fs.read(fd), content);
    await check("close(fd)", await fs.close(fd), true);

    // --- 3. Chunk read ---
    await check("readChunk(0, 10)", await fs.readChunk(file, 0, 10), content.slice(0, 10));
    await check("readChunk(9, 9)", await fs.readChunk(file, 9, 9), content.slice(9, 18));
    await check("readChunk(far offset) → null (EOF)", await fs.readChunk(file, 9999, 5), null);

    // --- 4. Chunk write / in-place patch ---
    // writeChunk() REPLACES from the offset (it does not insert): the first 4
    // chars are overwritten by "LINE", so the total length stays the same.
    const patched = "LINE" + content.slice(4);
    await check('writeChunk(0, "LINE")', await fs.writeChunk(file, "LINE", 0), true);
    await check("content after patch", await readWhole(file), patched);

    // --- 5. Append via chunk recipe (getSize + writeChunk) ---
    const extra = "line three\n";
    const before = await sizeOf(file);
    await check("append (writeChunk at end)", await fs.writeChunk(file, extra, before), true);
    await check("size after append", await sizeOf(file), before + extra.length);

    // --- 5b. Append the POSIX way: open("a") + write ---
    const beforeFd = await readWhole(file);
    const extraFd = "line four\n";
    const appendFd = await fs.open(file, "a");
    await check('open("a") then write()', await fs.write(appendFd, extraFd), true);
    await check("close(append fd)", await fs.close(appendFd), true);
    await check("content = old + appended", await readWhole(file), `${beforeFd}${extraFd}`);

    // --- 5c. Corner case: writeChunk beyond the end pads with SPACES ---
    const padded = `${dir}/padding.txt`;
    await fs.writeFile(padded, "abc");
    await fs.writeChunk(padded, "z", 6);
    await check("writeChunk(offset 6) → space padding", await fs.readFile(padded), "abc   z");

    // --- 6. Large file + copy with progress (chunked I/O) ---
    // ~200 KB built from small pieces so the demo stays fast while still
    // exercising the chunk path (copyWithProgress uses 31 KiB chunks).
    const piece = "0123456789".repeat(64) + "\n";
    let buffer = "";
    while (buffer.length < 200000) buffer += piece;
    await check("writeFile() large file (>=200KB)", await fs.writeFile(big, buffer), true);
    await check("getSize() large file", await sizeOf(big), buffer.length);

    let lastPct = -1;
    const copied = await fs.copyWithProgress(big, copy, (pct: number) => {
        lastPct = pct;
    });
    await check("copyWithProgress() finished", copied, true);
    await check("copy reached 100%", lastPct, 100);
    await check("copy size matches", await sizeOf(copy), buffer.length);
    await check("copy content identical", (await readWhole(copy)) === buffer, true);

    // --- 7. Metadata & existence ---
    const node = await statOf(file);
    await check("stat().type", node?.type, "FILE");
    await check("stat() missing path → null", await statOf(`${dir}/ghost.txt`), null);
    await check("existsOf(file)", await existsOf(file), true);
    await check("existsOf(dir)", await existsOf(dir), true);
    await check("existsOf(ghost)", await existsOf(`${dir}/ghost.txt`), false);

    // --- 8. Directories (mkdir in TSIX = recursive + idempotent) ---
    await check("mkdir()", await fs.mkdir(`${dir}/sub`), true);
    await check("ls() lists files & subdir", (await fs.ls(dir)).map((e: any) => e.name).sort(), [
        "big.txt",
        "copy.txt",
        "notes.txt",
        "padding.txt",
        "sub",
    ]);
    await check('mkdir("a/b/c") recursive', await fs.mkdir(`${dir}/a/b/c`), true);
    await check("parents created as well", await existsOf(`${dir}/a/b/c`), true);
    await check("mkdir() again → still true (idempotent)", await fs.mkdir(`${dir}/a/b/c`), true);
    await check("rmdir() on non-empty dir → false", await fs.rmdir(dir), false);

    // --- 9. Permissions ---
    await check("chmod(0o755)", await fs.chmod(`${dir}/sub`, 0o755), true);
    await check("mode after chmod", octal((await statOf(`${dir}/sub`))?.mode), "755");

    // --- 10. Delete ---
    await check("unlink()", await fs.unlink(copy), true);
    await check("file is really gone", await existsOf(copy), false);
    await check("rmdir() empty sub", await fs.rmdir(`${dir}/sub`), true);
    // Nested directories must be removed from the deepest one up (POSIX rmdir).
    await check("rmdir() a/b/c → true", await fs.rmdir(`${dir}/a/b/c`), true);
    await check("rmdir() a/b → true", await fs.rmdir(`${dir}/a/b`), true);
    await check("rmdir() a → true", await fs.rmdir(`${dir}/a`), true);
    await check("a is gone", await existsOf(`${dir}/a`), false);

    // --- 11. Usage ---
    // NOTE: `getUsage(path)` returns statistics for the WHOLE filesystem backing
    // that path (here RamFS /tmp), not just that subdirectory.
    const usage = await fs.getUsage(dir);
    await check("getUsage() reports >= 2 files", usage.files >= 2, true);

    // --- Report ---
    say("");
    if (report.fail === 0) {
        say(`${C.ok}${C.bold}ALL CHECKS PASSED${C.reset} — ${report.pass} checks.`);
    } else {
        say(`${C.err}${C.bold}FAILED ${report.fail} of ${report.pass + report.fail}${C.reset} checks.`);
    }
}

// ==================== HELP ====================

const HELP = `${C.bold}file-operation${C.reset} — TSIX file operations (FsLib → syscall → VFS)

${C.bold}Usage:${C.reset}
  file-operation <command> [arguments...]
  file-operation --demo            run every operation against /tmp/file-op-demo

${C.bold}Write:${C.reset}
  --write     <file> <text...>     replace content via writeFile()     (path-based)
  --write-fd  <file> <text...>     replace content via open/write/close (fd-based)
  --append    <file> <text...>     append at end (getSize + writeChunk)
  --append-fd <file> <text...>     append the POSIX way (open "a" + write)
  --patch     <file> <off> <text>  overwrite a slice in place (writeChunk)
  --touch     <file>               create an empty file when missing

${C.bold}Read:${C.reset}
  --read      <file>               whole content (readFile)
  --chunk     <file> <off> <len>   slice (readChunk; null = out of range)
  --size      <file>               size in chars (getSize; throws when missing)
  --wc        <file>               lines / words / chars

${C.bold}Copy & metadata:${C.reset}
  --copy      <src> [dst] [--chunk-size <chars>]   copyWithProgress (progress bar)
  --info      <path>               stat: type, size, mode, uid/gid, timestamps
  --exists    <path>               existence check (exit 1 when missing)
  --ls        [dir]                listing (type + mode + size)
  --usage     [path]               VFS stats: file/dir count + size
  --mounts                         list mounts (path → driver)

${C.bold}Directories & permissions:${C.reset}
  --mkdir     <dir>                create dir (RECURSIVE + idempotent)
  --rmdir     <dir>                remove an EMPTY dir (deepest first)
  --rm        <file>               delete file (unlink)
  --chmod     <file> <octal>       e.g. 755 / 644
  --chown     <file> <uid> <gid>   root only

${C.bold}Examples:${C.reset}
  file-operation --write /tmp/a.txt hello world
  file-operation --append /tmp/a.txt "\\\\nsecond line"
  file-operation --chunk /tmp/a.txt 0 4
  file-operation --info /tmp/a.txt
  file-operation --mkdir /tmp/nested/dir            # recursive, no -p needed
  file-operation --copy /tmp/big.bin --chunk-size 131072
`;

// ==================== ENTRY POINT ====================

export const main = Program(async (args: string[]) => {
    const has = (...flags: string[]) => flags.some((f) => args.includes(f));

    if (args.length === 0 || has("--help", "-h", "help")) {
        await std.print(HELP);
        return;
    }

    if (has("--demo")) {
        await cmdDemo();
        if (report.fail > 0) await shell.exit(1);
        return;
    }

    // Command map: accepts both `--write` and `write`.
    const table: Record<string, (a: string[]) => Promise<void>> = {
        write: cmdWrite,
        "write-fd": cmdWriteFd,
        read: cmdRead,
        append: cmdAppend,
        "append-fd": cmdAppendFd,
        chunk: cmdChunk,
        patch: cmdPatch,
        copy: cmdCopy,
        info: cmdInfo,
        stat: cmdInfo,
        exists: cmdExists,
        size: cmdSize,
        ls: cmdLs,
        mkdir: cmdMkdir,
        rm: cmdRm,
        rmdir: cmdRmdir,
        chmod: cmdChmod,
        chown: cmdChown,
        touch: cmdTouch,
        wc: cmdWc,
        usage: cmdUsage,
        mounts: cmdMounts,
    };

    const flag = args[0];
    const key = flag.replace(/^--?/, "");
    const handler = table[key];

    if (!handler) {
        await std.print(`${C.err}unknown command: ${flag}${C.reset}\n\n` + HELP);
        await shell.exit(64); // EX_USAGE — same code as plcd/launcher
        return;
    }

    try {
        await handler(args.slice(1));
    } catch (err: any) {
        // Operation failure = short message + exit 1, so scripts can rely on it
        // (`if file-operation --exists x; then ...`).
        say(`${C.err}✗ ${err?.message ?? err}${C.reset}`);
        await shell.exit(1);
    }
});
