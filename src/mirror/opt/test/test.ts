import { IProgram, OSContext } from "../../lib/IProgram";

export class main implements IProgram {
    async execute({ std }: OSContext, _args: string[]): Promise<string> {
        await std.print("Hello World!\n");
        return "";
    }
}

