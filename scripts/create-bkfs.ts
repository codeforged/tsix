import { BKFS } from "../src/vfs/BKFS";
import * as fs from "fs";
import * as path from "path";
import { getDefaultDbPath } from "./lib/db-path";

/**
 * CREATE BKFS
 *
 * Membuat file database VFS baru yang KOSONG — hanya berisi root "/".
 * Berguna untuk: fresh install, testing bootstrap dari nol, atau reset VFS.
 *
 * Path default diambil dari src/sysconfig.json (kernel.database).
 *
 * Cara pakai (dari root project):
 *   npm run bkfs:create                        -> buat DB kosong (path dari sysconfig)
 *   npm run bkfs:create -- --path data/test.db -> simpan di path lain
 *   npm run bkfs:create -- --seed-dirs         -> + skeleton direktori standar
 *   npm run bkfs:create -- --force             -> timpa yang lama (auto-backup dulu)
 *
 * Setelah membuat, isi konten dengan:
 *   npm run vfs:bootstrap   (sinkronkan seluruh src/mirror ke VFS)
 */

interface Options {
  dbPath: string;
  seedDirs: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dbPath: getDefaultDbPath(),
    seedDirs: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--path") opts.dbPath = argv[++i] || getDefaultDbPath();
    else if (a === "--seed-dirs") opts.seedDirs = true;
    else if (a === "--force") opts.force = true;
  }
  return opts;
}

/** Skeleton direktori tingkat atas standar TSIX (opsional via --seed-dirs). */
const SEED_DIRS: Array<[string, number]> = [
  ["/bin", 0o755],
  ["/dev", 0o755],
  ["/etc", 0o755],
  ["/home", 0o755],
  ["/lib", 0o755],
  ["/mnt", 0o755],
  ["/opt", 0o755],
  ["/root", 0o700],
  ["/tmp", 0o1777],
  ["/usr", 0o755],
  ["/var", 0o755],
];

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const absPath = path.resolve(opts.dbPath);

  // Keamanan: jangan timpa file yang sudah ada tanpa --force
  if (fs.existsSync(absPath) && !opts.force) {
    console.error(`[BKFS] File sudah ada: ${absPath}`);
    console.error(`       Pakai --force untuk menimpa (file lama otomatis di-backup).`);
    process.exit(1);
  }

  // Backup file lama kalau ada
  if (fs.existsSync(absPath)) {
    const bak = `${absPath}.bak-${Date.now()}`;
    fs.renameSync(absPath, bak);
    console.log(`[BKFS] File lama di-backup ke: ${bak}`);
  }

  // Pastikan folder parent ada (better-sqlite3 tidak membuat direktori)
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  // Buat DB kosong — constructor better-sqlite3 membuat file + initSchema()
  const bkfs = new BKFS(absPath);
  console.log(`[BKFS] Database kosong dibuat: ${absPath}`);

  if (opts.seedDirs) {
    for (const [dir, mode] of SEED_DIRS) {
      if (!bkfs.exists(dir)) {
        bkfs.mkdir(dir, 0, 0, mode);
        console.log(`[BKFS]   mkdir ${dir}  (mode ${mode.toString(8)})`);
      }
    }
    console.log(`[BKFS] Skeleton direktori standar selesai.`);
  } else {
    console.log(
      `[BKFS] DB kosong (hanya root "/"). Isi konten via: npm run vfs:bootstrap`,
    );
  }

  // Verifikasi isi DB
  try {
    const db = (bkfs as any).db;
    const root = db
      ?.prepare("SELECT name FROM vnodes WHERE name = '/' AND parent_id IS NULL")
      .get();
    const count = db
      ?.prepare("SELECT COUNT(*) AS c FROM vnodes")
      .get();
    console.log(
      `[BKFS] Verifikasi: root=${root?.name ?? "?"}, total node=${count?.c ?? "?"}`,
    );
  } catch (_) {
    /* abaikan error verifikasi */
  }

  // Tutup koneksi biar file ter-flush rapi
  try {
    (bkfs as any).db?.close?.();
  } catch (_) {
    /* proses akan exit, better-sqlite3 tetap flush */
  }

  console.log(`[BKFS] Selesai.`);
}

main();
