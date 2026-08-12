import { Program, fs, std } from "@tsix/Application";

export default Program(async () => {
    await std.print("--- Host Path Bridge (Mount) Verification ---\n");

    const mountPoint = "/mnt/host_share";
    const hostDir = "./shared_data";

    await std.print(`1. Attempting to mount ${hostDir} to ${mountPoint}...\n`);
    const mountOk = await fs.mount(mountPoint, hostDir);
    if (!mountOk) {
        await std.print("Mount failed!\n");
        return;
    }
    await std.print("Mount successful.\n");

    await std.print("\n2. Writing a file to mounted path from TSIX...\n");
    const testFile = `${mountPoint}/hello_from_tsix.txt`;
    const content = "Hello! This file was created from within TSIX into a mounted host directory.\n";
    await fs.writeFile(testFile, content);
    await std.print(`Filw written: ${testFile}\n`);

    await std.print("\n3. Reading the file back from TSIX...\n");
    const readBack = await fs.readFile(testFile);
    await std.print(`Content read back:\n${readBack}`);

    await std.print("\n4. Listing files in mount point...\n");
    const files = await fs.ls(mountPoint);
    for (const f of files) {
        await std.print(`- ${f.name} (${f.type}, ${f.size} bytes)\n`);
    }

    await std.print("\n5. Verification of seamless operation: Copy between VFS and Host...\n");
    const vfsFile = "/etc/passwd";
    const hostDest = `${mountPoint}/passwd_copy_on_host`;

    await std.print(`Copying ${vfsFile} (BKFS) to ${hostDest} (HostVFS)...\n`);
    const passwdContent = await fs.readFile(vfsFile);
    if (passwdContent) {
        await fs.writeFile(hostDest, passwdContent);
        await std.print("Copy successful.\n");
    }

    await std.print("\n--- Verification Completed ---\n");
});
