import * as bcrypt from "bcryptjs";
import { BKFS } from "../../src/vfs/BKFS";

/** GID grup `sudo` — sama dengan seed `/etc/group` (`scripts/lib/fresh-accounts.ts`). */
const SUDO_GID = 27;

/**
 * addToGroup(): jadikan `username` anggota `groupName` di /etc/group.
 * Baris grup dibuat (dengan `gid`) kalau belum ada; idempoten.
 *
 * `/bin/sudo` mengizinkan anggota grup `sudo` (atau `root`) — lihat
 * `src/mirror/bin/sudo.ts` — jadi keanggotaan di sini = "sudoers".
 */
export function addToGroup(bkfs: BKFS, groupName: string, gid: number, username: string): void {
  const groupPath = "/etc/group";
  const lines = (bkfs.read(groupPath) || "").split("\n").filter((l) => l.trim().length > 0);
  const idx = lines.findIndex((l) => l.split(":")[0] === groupName);
  if (idx < 0) {
    lines.push(`${groupName}:x:${gid}:${username}`);
  } else {
    const parts = lines[idx].split(":");
    while (parts.length < 4) parts.push("");
    const members = parts[3] ? parts[3].split(",").map((m) => m.trim()).filter(Boolean) : [];
    if (members.includes(username)) return;
    parts[3] = [...members, username].join(",");
    lines[idx] = parts.join(":");
  }
  bkfs.touch(groupPath, lines.join("\n") + "\n", 0, 0, 0o644);
}

/**
 * BUAT AKUN USER BARU + HOME DIRECTORY (ala installer Ubuntu).
 *
 * Menulis entri ke /etc/passwd, /etc/shadow (hash bcrypt), menambahkan user
 * ke grup 'users' (gid 100) DAN grup 'sudo' (gid 27 — user installer adalah
 * admin node, seperti user pertama di installer Ubuntu), lalu membuat
 * /home/<username> (0700, milik user).
 *
 * Root TIDAK dibuat di sini — akun root sudah otomatis dari src/mirror.
 * Dipakai oleh scripts/install.ts (fresh install) agar bisa diuji terpisah.
 */
export function createUserAccount(
  bkfs: BKFS,
  username: string,
  password: string,
): void {
  const passwdPath = "/etc/passwd";
  const shadowPath = "/etc/shadow";
  const gid = 100; // grup 'users'
  const home = `/home/${username}`;
  // Sidecar .js agar shell tidak memakai preload transpiler (+14.4 MB/worker).
  const shell = "/bin/tsh.js";

  // 1. /etc/passwd — hitung UID berikutnya (mulai dari 1000, seperti useradd)
  const passwd = bkfs.read(passwdPath) || "";
  const pLines = passwd.split("\n").filter((l) => l.trim().length > 0);
  if (pLines.some((l) => l.split(":")[0] === username)) {
    // Akun sudah ada (mis. install diulang) — tidak dibuat ulang, tapi tetap
    // dipastikan sudoer: user yang diisi di installer adalah admin node.
    addToGroup(bkfs, "sudo", SUDO_GID, username);
    console.warn(`[INSTALL] User '${username}' already exists — skipped (ensured 'sudo' group membership).`);
    return;
  }
  let maxUid = 0;
  for (const l of pLines) {
    const u = parseInt(l.split(":")[2], 10);
    if (!isNaN(u) && u > maxUid) maxUid = u;
  }
  const uid = maxUid < 1000 ? 1000 : maxUid + 1;
  const passwdLine = `${username}:x:${uid}:${gid}:${username}:${home}:${shell}`;
  bkfs.touch(passwdPath, passwd.trim() + "\n" + passwdLine + "\n", 0, 0, 0o644);

  // 2. /etc/shadow — hash bcrypt, mode 0640 root:root seperti file asli
  const hash = bcrypt.hashSync(password, bcrypt.genSaltSync(10));
  const shadow = bkfs.read(shadowPath) || "";
  const days = Math.floor(Date.now() / 86400000);
  const shadowLine = `${username}:${hash}:${days}:0:99999:7:::`;
  bkfs.touch(shadowPath, shadow.trim() + "\n" + shadowLine + "\n", 0, 0, 0o640);

  // 3. /etc/group — member grup 'users' + 'sudo' (lihat addToGroup)
  addToGroup(bkfs, "users", gid, username);
  addToGroup(bkfs, "sudo", SUDO_GID, username);
  console.log(`[INSTALL] User '${username}' added to the 'sudo' group (sudoers).`);

  // 4. Home directory — milik user (uid/gid), privat 0700
  if (!bkfs.exists(home)) {
    bkfs.mkdir(home, uid, gid, 0o700);
  } else {
    bkfs.chown(home, uid, gid);
    bkfs.chmod(home, 0o700);
  }

  console.log(
    `[INSTALL] User '${username}' dibuat (UID ${uid}, home ${home}, mode 0700).`,
  );
}
