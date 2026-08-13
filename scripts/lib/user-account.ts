import * as bcrypt from "bcryptjs";
import { BKFS } from "../../src/vfs/BKFS";

/**
 * BUAT AKUN USER BARU + HOME DIRECTORY (ala installer Ubuntu).
 *
 * Menulis entri ke /etc/passwd, /etc/shadow (hash bcrypt), menambahkan user
 * ke grup 'users' (gid 100), lalu membuat /home/<username> (0700, milik user).
 * Konsisten dengan /bin/useradd.ts di dalam sistem.
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
  const groupPath = "/etc/group";
  const shadowPath = "/etc/shadow";
  const gid = 100; // grup 'users'
  const home = `/home/${username}`;
  const shell = "/bin/tsh.ts";

  // 1. /etc/passwd — hitung UID berikutnya (mulai dari 1000, seperti useradd)
  const passwd = bkfs.read(passwdPath) || "";
  const pLines = passwd.split("\n").filter((l) => l.trim().length > 0);
  if (pLines.some((l) => l.split(":")[0] === username)) {
    console.warn(`[INSTALL] User '${username}' sudah ada — dilewati.`);
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

  // 3. /etc/group — tambahkan sebagai member grup 'users'
  const group = bkfs.read(groupPath) || "";
  const gLines = group.split("\n").filter((l) => l.trim().length > 0);
  const gIdx = gLines.findIndex((l) => l.split(":")[0] === "users");
  if (gIdx >= 0) {
    const parts = gLines[gIdx].split(":");
    const members = parts[3] ? parts[3].split(",").filter(Boolean) : [];
    if (!members.includes(username)) {
      parts[3] = [...members, username].join(",");
      gLines[gIdx] = parts.join(":");
      bkfs.touch(groupPath, gLines.join("\n") + "\n", 0, 0, 0o644);
    }
  }

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
