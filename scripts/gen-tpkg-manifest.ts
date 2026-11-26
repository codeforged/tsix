import * as fs from "fs";
import * as path from "path";

/**
 * GENERATOR MANIFEST TPKG — host infrastructure for `base-system`
 *
 * KENAPA GENERATOR, BUKAN DITULIS TANGAN:
 * Kernel dan shared runtime hidup di HOST FS, bukan di VFS. Daftar item host
 * `base-system` dibuat dari pohon kernel/common agar tidak tertinggal saat berubah.
 *
 * CARA PAKAI:
 *   npm run tpkg:manifest            -> tulis manifest
 *   npm run tpkg:manifest -- --dry   -> cuma tampilkan ringkasan (tanpa menulis)
 *
 * APA YANG DI-GENERATE:
 * Paket ini hanya menambahkan lapisan infrastruktur HOST dan shared runtime ke
 * paket base-system yang VFS intinya dikurasi di packages.json.
 *   1. Kernel           : src/kernel/**.ts
 *   2. Bootloader       : WorkerEntry.ts + VfsModuleResolver.ts
 *   3. Shared runtime   : semua TypeScript di src/common → /lib/common + hostDst
 *
 * File-file host-only:
 *      File-file ini HANYA ada di host (tidak pernah masuk VFS), jadi:
 *      src = /hostsrc/<rel>   (mount read-only dari fstab: hostPath "src")
 *      dst = /tmp/tpkg-stage/<rel>  (staging; SYNC_TO_HOST membaca isi dari VFS)
 *      hostDst = <rel>        (tujuan sebenarnya, relatif root proyek)
 */

const ROOT = path.resolve(__dirname, "..");
const MIRROR = path.join(ROOT, "src/mirror");
const MANIFEST = path.join(MIRROR, "etc/tpkg/packages.json");
/** Paket infrastruktur yang menerima daftar host/common hasil generator. */
const BASE_PKG = "base-system";
/** Mount host read-only di node (lihat src/mirror/etc/fstab.conf). */
const HOSTSRC_MOUNT = "/hostsrc";
/** Staging VFS untuk file host (ramfs /tmp). */
const HOST_STAGE = "/tmp/tpkg-stage";

/**
 * File yang SENGAJA dimiliki base-system DAN paket `tpkg` (updater slim):
 * `tpkg install tpkg` harus cukup untuk memperbarui klien beserta pustaka yang
 * dipakainya. `tpkg remove` membiarkan file yang masih dimiliki paket lain.
 */
const TPKG_SHARED_PATHS = ["/sbin/tpkg.ts", "/sbin/transpile.ts", "/lib/TpkgProtocol.ts", "/lib/common/ExecMode.ts"];

interface Item {
    src?: string;
    dst: string;
    hostDst?: string;
    permissions?: number;
    isExecutable?: boolean;
}

function walk(dir: string, base: string = ""): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".DS_Store" || entry.name.startsWith(".")) continue;
        const rel = base ? `${base}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walk(full, rel));
            continue;
        }
        if (/\.(test|spec)\.ts$/.test(entry.name)) continue;
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".json")) continue;
        out.push(rel);
    }
    return out;
}

function walkAll(dir: string, base: string = ""): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".DS_Store" || entry.name.startsWith(".")) continue;
        const rel = base ? `${base}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkAll(full, rel));
        else if (entry.isFile()) out.push(rel);
    }
    return out;
}

/** Versi engine diambil dari `src/kernel/Kernel.ts` — satu sumber kebenaran. */
function kernelVersion(): string {
    const src = fs.readFileSync(path.join(ROOT, "src/kernel/Kernel.ts"), "utf8");
    const m = src.match(/private\s+version\s*:\s*string\s*=\s*"([^"]+)"/);
    if (!m) throw new Error("versi kernel tidak ketemu di src/kernel/Kernel.ts");
    return m[1];
}

const OPTIONAL_KERNEL_FILES = new Set([
    "devices/aux-devices/ILI9341Device.ts",
    "devices/aux-devices/LM6029Device.ts",
    "devices/aux-devices/PLCDDevice.ts",
    "devices/aux-devices/joystick.ts",
    "devices/aux-devices/lcdFontClassic.ts",
    "devices/aux-devices/lcdFonts.ts",
    "devices/aux-devices/plcdFont5x7.ts",
]);

function commonItems(): Item[] {
    const commonRoot = path.join(ROOT, "src/common");
    return walk(commonRoot)
        .filter((relative) => relative.endsWith(".ts"))
        .map((relative) => ({
            src: `/lib/common/${relative}`,
            dst: `/lib/common/${relative}`,
            hostDst: `src/common/${relative}`,
        }));
}

/** File host-only (kernel + bootloader worker). */
function hostItems(): Item[] {
    const items: Item[] = [];
    const targets = [
        { abs: path.join(ROOT, "src/kernel"), rel: "src/kernel" },
        // Bootloader worker + resolver modul relatif. Keduanya dimuat LANGSUNG oleh
        // Node (WorkerEntry.js via `new Worker()`, VfsModuleResolver.js via require),
        // jadi sidecar .js-nya dibangun ulang oleh /sbin/apply-update.ts.
        {
            abs: path.join(ROOT, "src/userland"),
            rel: "src/userland",
            only: ["WorkerEntry.ts", "VfsModuleResolver.ts"],
        },
    ];

    for (const t of targets) {
        if (!fs.existsSync(t.abs)) continue;
        for (const rel of walk(t.abs)) {
            if (t.only && !t.only.includes(rel)) continue;
            if (t.rel === "src/kernel" && OPTIONAL_KERNEL_FILES.has(rel)) continue;
            const hostRel = `${t.rel}/${rel}`;
            items.push({
                src: `${HOSTSRC_MOUNT}/${hostRel.substring("src/".length)}`,
                dst: `${HOST_STAGE}/${hostRel.substring("src/".length)}`,
                hostDst: hostRel,
            });
        }
    }
    return items;
}

function vfsItems(relativePaths: string[]): Item[] {
    return relativePaths.map((relative) => {
        const vfsPath = `/${relative}`;
        return { src: vfsPath, dst: vfsPath };
    });
}

function directoryItems(relativeDirectory: string, include: (relative: string) => boolean = () => true): Item[] {
    const absolute = path.join(MIRROR, relativeDirectory);
    if (!fs.existsSync(absolute)) return [];
    return walkAll(absolute)
        .filter(include)
        .map((relative) => `/${relativeDirectory}/${relative}`)
        .map((vfsPath) => ({ src: vfsPath, dst: vfsPath }));
}

function ensurePackage(manifest: any, name: string, description: string, items: Item[] = []): any {
    let pkg = manifest.packages.find((candidate: any) => candidate.name === name);
    if (!pkg) {
        pkg = { name, version: "1.0.0", description, author: "TSIX", needReboot: false, items: [] };
        manifest.packages.push(pkg);
    }
    const destinations = new Set((pkg.items as Item[]).map((item) => item.dst));
    for (const item of items) {
        if (destinations.has(item.dst)) continue;
        pkg.items.push(item);
        destinations.add(item.dst);
    }
    return pkg;
}

function packageItems(manifest: any, name: string, items: Item[]): void {
    const pkg = manifest.packages.find((candidate: any) => candidate.name === name);
    if (!pkg) throw new Error(`Required package is missing: ${name}`);
    const destinations = new Set((pkg.items as Item[]).map((item) => item.dst));
    for (const item of items) {
        if (destinations.has(item.dst)) continue;
        pkg.items.push(item);
        destinations.add(item.dst);
    }
}

function reconcilePackages(manifest: any): void {
    const obsolete = new Set(["system-update", "packages-list"]);
    const otaServer = manifest.packages.find((pkg: any) => pkg.name === "ota-server");
    if (otaServer) packageItems(manifest, "esp-ota", otaServer.items);
    manifest.packages = manifest.packages.filter((pkg: any) => !obsolete.has(pkg.name) && pkg.name !== "ota-server");

    // Paket `tpkg` di repo adalah UPDATER SLIM: klien `tpkg` tetap tinggal di
    // base-system sebagai "modal awal", tetapi file klien + tool `transpile`
    // juga didaftarkan di sini supaya `tpkg install tpkg` cukup untuk memperbarui
    // klien (irisan disengaja — lihat `allowedOverlap`). `onAfterDownload` =
    // `transpile` hanya membangun sidecar `.js` untuk file paket ini.
    const tpkgPkg = manifest.packages.find((pkg: any) => pkg.name === "tpkg");
    if (tpkgPkg) {
        tpkgPkg.onAfterDownload = "/sbin/transpile.ts";
        // TpkgProtocol + ExecMode ikut: tpkg/transpile baru memakai fungsi baru di
        // keduanya, jadi klien dengan base-system lama tidak boleh tertinggal.
        for (const sharedPath of TPKG_SHARED_PATHS) {
            if (!(tpkgPkg.items as Item[]).some((item) => item.dst === sharedPath)) {
                (tpkgPkg.items as Item[]).push({ src: sharedPath, dst: sharedPath });
            }
        }
    }

    const vfs = (paths: string[]) => vfsItems(paths);
    ensurePackage(
        manifest,
        "coreutils",
        "Core userland commands and small general-purpose tools.",
        vfs([
            "bin/awk.ts",
            "bin/chgrp.ts",
            "bin/df.ts",
            "bin/echo.ts",
            "bin/history.ts",
            "bin/less.ts",
            "bin/more.ts",
            "bin/users.ts",
            "bin/uuid-gen.ts",
            "bin/which.ts",
            "bin/xargs.ts",
            "usr/bin/img2b64.ts",
        ]),
    );
    ensurePackage(manifest, "procutils", "Process inspection and control tools.", vfs(["bin/kill.ts"]));
    ensurePackage(
        manifest,
        "nettools",
        "Networking utilities and daemons for TSIX.",
        vfs(["bin/netfs.ts", "sbin/netfsd.ts", "sbin/vpns.ts"]),
    );
    ensurePackage(manifest, "filesystem-tools", "BKFS inspection and management utilities.", vfs(["usr/bin/bkfs.ts"]));
    ensurePackage(
        manifest,
        "scheduler",
        "Cron daemon and crontab management tools.",
        vfs(["sbin/crond.ts", "usr/bin/crontab.ts"]),
    );
    ensurePackage(
        manifest,
        "esp-ota",
        "ESP OTA tools and firmware repository.",
        vfs(["usr/bin/esp-send.ts", "sbin/otad.ts", "usr/bin/ota-gen-ak.ts"]),
    );
    ensurePackage(
        manifest,
        "ipc-tools",
        "Local process IPC diagnostic utilities.",
        vfs(["usr/bin/ipc-listen.ts", "usr/bin/ipc-send.ts"]),
    );
    ensurePackage(
        manifest,
        "key-tools",
        "Identity and key generation utilities.",
        vfs(["usr/bin/keygen.ts", "usr/bin/ssh-keygen.ts"]),
    );
    ensurePackage(
        manifest,
        "dev-tools",
        "Developer tools for maintaining the TSIX host SDK.",
        vfs(["sbin/userlib-update.ts"]),
    );
    ensurePackage(manifest, "bitshark", "Graphical MQTNL packet inspector.", [
        ...vfs(["usr/bin/bitshark.ts"]),
        ...vfs(["etc/asteracea/menu/bitshark.menu"]),
    ]);

    const apps: Array<{ name: string; description: string; directory: string; menu?: string }> = [
        {
            name: "craving-tracker",
            description: "Craving tracker desktop app.",
            directory: "opt/craving-tracker",
            menu: "craving-tracker",
        },
        {
            name: "iot-dashboard",
            description: "Lantana IoT dashboard.",
            directory: "opt/iot-dashboard",
            menu: "iot-dashboard",
        },
        { name: "krisan", description: "Krisan desktop environment sample and assets.", directory: "opt/krisan" },
        {
            name: "pixelspace-traffic",
            description: "PixelSpace traffic monitor.",
            directory: "opt/pixelspace-traffic",
            menu: "pixelspace-traffic",
        },
        {
            name: "plcd-emulator",
            description: "PLCD display emulator and launcher.",
            directory: "opt/plcd",
            menu: "lcd-emulator",
        },
    ];
    for (const app of apps) {
        const items = directoryItems(app.directory);
        if (app.menu) items.push(...vfs([`etc/asteracea/menu/${app.menu}.menu`]));
        ensurePackage(manifest, app.name, app.description, items);
    }

    const owned = new Set<string>();
    for (const pkg of manifest.packages) for (const item of pkg.items as Item[]) owned.add(item.dst);
    const testItems = directoryItems("opt/test", (relative) => relative !== "tmp_hex.txt").filter(
        (item) => !owned.has(item.dst),
    );
    const unownedMenus = directoryItems("etc/asteracea/menu", (relative) => relative.endsWith(".menu")).filter(
        (item) => !owned.has(item.dst),
    );
    ensurePackage(manifest, "test-lab", "Optional TSIX test programs, examples, and their launcher menus.", [
        ...testItems,
        ...unownedMenus,
    ]);

    const destinationOwner = new Map<string, string>();
    const hostOwner = new Map<string, string>();
    // Irisan yang DISENGAJA: paket `tpkg` (updater slim di repo) boleh memuat ulang
    // file klien yang juga ada di base-system, supaya `tpkg install tpkg` cukup
    // memperbarui klien tanpa perlu base-system/reboot penuh.
    const allowedOverlap = new Map<string, Set<string>>([["tpkg", new Set(TPKG_SHARED_PATHS)]]);
    for (const pkg of manifest.packages) {
        const unique: Item[] = [];
        for (const item of pkg.items as Item[]) {
            const previous = destinationOwner.get(item.dst);
            const shared = allowedOverlap.get(pkg.name)?.has(item.dst) === true;
            if (previous && !shared) {
                console.log(`[tpkg:manifest] overlap removed: ${item.dst} (${pkg.name}; owned by ${previous})`);
                continue;
            }
            if (item.hostDst) {
                const previousHost = hostOwner.get(item.hostDst);
                if (previousHost)
                    throw new Error(`Duplicate hostDst '${item.hostDst}' in '${previousHost}' and '${pkg.name}'.`);
                hostOwner.set(item.hostDst, pkg.name);
            }
            destinationOwner.set(item.dst, pkg.name);
            unique.push(item);
        }
        pkg.items = unique;
    }
}

function main(): void {
    const dry = process.argv.includes("--dry");
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    const base = manifest.packages.find((pkg: any) => pkg.name === BASE_PKG);
    if (!base) throw new Error(`Package '${BASE_PKG}' is missing from ${MANIFEST}.`);

    const vfs = (base.items as Item[])
        .filter((item) => typeof item.src === "string")
        .filter((item) => !item.src!.startsWith("/hostsrc/") && !item.src!.startsWith("/lib/common/"))
        .filter((item) => !["/etc/profile", "/etc/rc.local", "/etc/tpkg/packages.json"].includes(item.src!));
    for (const requiredPath of ["/usr/bin/tbuild.ts", "/sbin/apply-update.ts", "/sbin/transpile.ts"]) {
        if (!vfs.some((item) => item.dst === requiredPath)) vfs.push({ src: requiredPath, dst: requiredPath });
    }
    const vfsWithHost = vfs.map((item) => ({
        ...item,
        hostDst: item.hostDst ?? `src/mirror/${item.src!.slice(1)}`,
    }));
    const common = commonItems();
    const host = hostItems();
    const items = [...vfsWithHost, ...common, ...host];
    const destinations = new Set<string>();
    for (const item of items) {
        if (destinations.has(item.dst)) throw new Error(`Duplicate base-system destination: ${item.dst}`);
        destinations.add(item.dst);
    }

    base.version = kernelVersion();
    base.description = "TSIX base system: essential VFS, shared runtime, kernel and bootloader host infrastructure.";
    base.author = "TSIX";
    base.needReboot = true;
    base.onAfterDownload = "/sbin/apply-update.ts";
    base.items = items.sort((a, b) => a.dst.localeCompare(b.dst));
    reconcilePackages(manifest);

    const packageCount = manifest.packages.length;
    const totalItems = manifest.packages.reduce((sum: number, pkg: any) => sum + pkg.items.length, 0);
    const baseBytes = base.items.reduce((sum: number, item: Item) => {
        const source = item.hostDst ? path.join(ROOT, item.hostDst) : path.join(MIRROR, item.src ?? "");
        return sum + fs.statSync(source).size;
    }, 0);
    console.log(`[tpkg:manifest] package: ${BASE_PKG} v${base.version}`);
    console.log(`[tpkg:manifest] host kernel/common items: ${host.length + common.length}`);
    console.log(`[tpkg:manifest] base items: ${base.items.length} (${(baseBytes / 1024).toFixed(0)} KB)`);
    console.log(`[tpkg:manifest] catalog: ${packageCount} packages, ${totalItems} total items`);
    if (dry) {
        console.log("[tpkg:manifest] --dry: manifest not written.");
        return;
    }
    fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 4)}\n`);
    console.log(`[tpkg:manifest] written: ${path.relative(ROOT, MANIFEST)}`);
}
main();
