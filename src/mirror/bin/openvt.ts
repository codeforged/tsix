import { IProgram, OSContext } from "../lib/IProgram";

/**
 * OPENVT UTILITY — "Occupied virtual terminal" (ala Linux `openvt`)
 *
 * Menjalankan program di sebuah virtual terminal (TTY) yang kosong, tanpa
 * harus menempatinya saat boot. Ini cara "menghidupkan" TTY yang tidak punya
 * login prompt (di luar jangkauan loginCount).
 *
 *   openvt <ttyNumber> [command...]
 *
 *   - ttyNumber : nomor konsol virtual (1..ttyCount)
 *   - command   : program + argumen yang dijalankan di TTY itu.
 *                 Default (tanpa command): /bin/login.js — munculkan login prompt
 *                 di TTY tersebut (mirip getty di Linux).
 *
 * Contoh:
 *   openvt 4                     → spawn login prompt di TTY4
 *   openvt 5 /bin/tsh            → spawn shell langsung di TTY5
 *   openvt 3 /bin/login.js root  → login otomatis user root di TTY3
 *
 * Proses yang di-spawn akan "menempati" TTY target: output & input-nya terikat
 * ke TTY itu, dan kamu bisa berpindah ke sana via `chvt` / Alt+F<N>.
 *
 * Catatan: proses berjalan di foreground TTY target; untuk melepaskannya dari
 * terminal pemanggil, gunakan `&`/backgrounding sesuai kebutuhan.
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, shell } = os;

        const ttyCount = parseInt(
            (await shell.getenv("TSIX_TTY_COUNT")) || "6",
        );

        if (args.includes("--help") || args.includes("-h")) {
            await std.print(
                "Usage: openvt <ttyNumber> [command...]\n" +
                "Run a program on an empty virtual terminal (default: login).\n" +
                `Valid TTY: 1-${ttyCount}.\n`,
            );
            return;
        }

        if (args.length < 1) {
            await std.print("Usage: openvt <ttyNumber> [command...]\n");
            await std.print("Example: openvt 4\n");
            return;
        }

        const ttyId = parseInt(args[0], 10);
        if (isNaN(ttyId) || ttyId < 1 || ttyId > ttyCount) {
            await std.print(
                `Invalid TTY number. Must be 1-${ttyCount}.\n`,
            );
            return;
        }

        // Resolve command (default: login prompt — ala getty)
        let cmdPath = "/bin/login.js";
        let cmdArgs: string[] = [];
        if (args.length > 1) {
            cmdPath = args[1];
            cmdArgs = args.slice(2);
        }

        // Cek TTY target ada + FLUSH stale input (enter/karakter basi yang
        // diketik user saat TTY ini idle — mencegah proses baru langsung
        // "memakan" input basi tersebut, mis. login dapat enter beruntun).
        try {
            const ttyFd = await os.fs.open(`/dev/tty${ttyId}`, "r");
            if (ttyFd < 0) {
                await std.print(`openvt: cannot access /dev/tty${ttyId}\n`);
                return;
            }
            // ioctl 5 = FLUSH_INPUT (buang semua input tertunda di TTY)
            await os.fs.ioctl(ttyFd, 5, null);
            await os.fs.close(ttyFd);
        } catch (e: any) {
            await std.print(
                `openvt: cannot access /dev/tty${ttyId}: ${e.message}\n`,
            );
            return;
        }

        // Spawn program di TTY target (arg ke-5 exec = ttyId)
        try {
            const proc = await shell.exec(
                cmdPath,
                cmdArgs,
                undefined,
                undefined,
                ttyId,
            );
            if (!proc || !proc.pid) {
                await std.print(`openvt: failed to start ${cmdPath}\n`);
                return;
            }
            await std.print(
                `openvt: ${cmdPath} started on TTY${ttyId} (PID ${proc.pid}).\n`,
            );
            await std.print(
                `openvt: switch with 'chvt ${ttyId}' or Alt+F${ttyId}.\n`,
            );
        } catch (e: any) {
            await std.print(`openvt: ${e.message}\n`);
        }
    }
}
