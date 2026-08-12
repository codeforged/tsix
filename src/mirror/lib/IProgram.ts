import { StdLib, FsLib, ShellLib, AuxLib } from "./UserLib";

export interface OSContext {
    std: StdLib;
    fs: FsLib;
    shell: ShellLib;
    aux: AuxLib;
}

export interface IProgram {
    execute(os: OSContext, args: string[]): Promise<string | void>;
}


