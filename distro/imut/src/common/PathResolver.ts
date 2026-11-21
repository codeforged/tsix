/**
 * PATH RESOLVER
 * 
 * Utilitas untuk mengolah path absoult dan relatif (handling . dan ..).
 */
export class PathResolver {
    public static resolve(cwd: string, targetPath: string): string {
        // 1. Jika path diawali '/', berarti absolute
        let absolutePath = targetPath.startsWith("/")
            ? targetPath
            : (cwd === "/" ? "/" + targetPath : cwd + "/" + targetPath);

        // 2. Normalisasi (Bersihkan //, ./ dan ..)
        const parts = absolutePath.split("/").filter(p => p.length > 0 && p !== ".");
        const stack: string[] = [];

        for (const part of parts) {
            if (part === "..") {
                stack.pop();
            } else {
                stack.push(part);
            }
        }

        return "/" + stack.join("/");
    }

    public static normalize(path: string): string {
        return this.resolve("/", path);
    }

    public static join(...parts: string[]): string {
        const joined = parts.filter(p => p.length > 0).join("/");
        const isAbs = parts.find(p => p.length > 0)?.startsWith("/") ?? false;
        const resolved = this.resolve("/", joined);
        return isAbs ? resolved : (resolved.startsWith("/") ? resolved.substring(1) : resolved);
    }

    public static isAbsolute(path: string): boolean {
        return path.startsWith("/");
    }

    public static basename(path: string): string {
        const parts = path.split("/").filter(p => p.length > 0);
        return parts.length > 0 ? parts[parts.length - 1] : "";
    }

    public static dirname(path: string): string {
        const isAbs = path.startsWith("/");
        const parts = path.split("/").filter(p => p.length > 0);
        if (parts.length <= 1) {
            return isAbs ? "/" : ".";
        }
        parts.pop();
        return (isAbs ? "/" : "") + parts.join("/");
    }
}

