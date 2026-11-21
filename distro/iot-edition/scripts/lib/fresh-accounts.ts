import { BKFS } from "../../src/vfs/BKFS";

const BOOTSTRAP_ACCOUNT_FILES = [
    {
        path: "/etc/passwd",
        content: "root:x:0:0:root:/root:/bin/tsh.js\n",
        mode: 0o644,
    },
    {
        path: "/etc/group",
        content: "root:x:0:\nsudo:x:27:\nusers:x:100:\n",
        mode: 0o644,
    },
    {
        path: "/etc/shadow",
        content: "root:!:0:0:99999:7:::\n",
        mode: 0o640,
    },
] as const;

/**
 * Seed only missing account files. A packaged distro never needs to ship the
 * repository's operator-owned passwd/shadow contents or password hashes.
 *
 * @returns true when the root shadow entry was initialized in the locked state.
 */
export function ensureFreshAccountFiles(bkfs: BKFS): boolean {
    if (!bkfs.exists("/etc")) {
        bkfs.mkdir("/etc", 0, 0, 0o755);
    }

    let rootPasswordRequired = false;
    for (const file of BOOTSTRAP_ACCOUNT_FILES) {
        if (bkfs.exists(file.path)) continue;
        bkfs.touch(file.path, file.content, 0, 0, file.mode);
        if (file.path === "/etc/shadow") rootPasswordRequired = true;
    }

    if (!bkfs.exists("/root")) {
        bkfs.mkdir("/root", 0, 0, 0o700);
    } else {
        const root = bkfs.stat("/root");
        if (root && (root.uid !== 0 || root.gid !== 0)) bkfs.chown("/root", 0, 0);
        if (root && root.mode !== 0o700) bkfs.chmod("/root", 0o700);
    }

    return rootPasswordRequired;
}
