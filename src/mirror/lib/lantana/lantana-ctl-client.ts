import { fs, shell } from "@tsix/Application";

const CLI_PATH = "/opt/lantana/lantana-ctl.js";
const MAX_OUTPUT_LENGTH = 2 * 1024 * 1024;

export async function runLantanaCtl<T>(...args: string[]): Promise<T> {
    const [readFd, writeFd] = await shell.pipe();
    let readOpen = true;
    let writeOpen = true;
    let childPid: number | null = null;
    let output = "";

    try {
        const child = await shell.exec(CLI_PATH, ["--json", ...args], writeFd);
        childPid = child.pid;
        await fs.close(writeFd);
        writeOpen = false;

        while (true) {
            const chunk = await fs.read(readFd);
            if (chunk === "") break;
            if (chunk === null) {
                await new Promise((resolve) => setTimeout(resolve, 25));
                continue;
            }
            if (typeof chunk !== "string") {
                throw new Error("lantana-ctl mengembalikan output non-teks");
            }

            output += chunk;
            if (output.length > MAX_OUTPUT_LENGTH) {
                throw new Error("Output lantana-ctl melebihi batas 2 MiB");
            }
        }

        await fs.close(readFd);
        readOpen = false;
        await shell.waitpid(childPid);
        childPid = null;

        let parsed: unknown;
        try {
            parsed = JSON.parse(output.trim());
        } catch {
            throw new Error("Output JSON lantana-ctl tidak valid");
        }

        if (!isRecord(parsed)) throw new Error("Envelope JSON lantana-ctl tidak valid");
        if (parsed.version !== 1) {
            throw new Error(`Versi protokol lantana-ctl tidak didukung: ${String(parsed.version)}`);
        }
        if (parsed.ok === false) {
            const error = parsed.error;
            const message = isRecord(error) ? error.message : null;
            if (typeof message !== "string" || !message) {
                throw new Error("Envelope error lantana-ctl tidak valid");
            }
            throw new Error(message);
        }
        if (parsed.ok !== true || !Object.prototype.hasOwnProperty.call(parsed, "data")) {
            throw new Error("Envelope sukses lantana-ctl tidak valid");
        }
        return parsed.data as T;
    } finally {
        if (writeOpen) await fs.close(writeFd);
        if (readOpen) await fs.close(readFd);
        if (childPid !== null) await shell.waitpid(childPid);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
