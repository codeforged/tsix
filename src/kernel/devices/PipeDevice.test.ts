import { describe, it, expect, beforeEach } from "vitest";
import { PipeDevice } from "./PipeDevice";

describe("PipeDevice (C4)", () => {
    let pipe: PipeDevice;

    beforeEach(() => {
        pipe = new PipeDevice();
    });

    // C4.01
    it("C4.01 name is Pipe", () => {
        expect(pipe.name).toBe("Pipe");
    });

    // C4.02 – write + read basic
    it("C4.02 write to pipe then read returns data", () => {
        // Initialize refs
        pipe.ioctl(10, null); // INC_READ_REF
        pipe.ioctl(20, null); // INC_WRITE_REF

        expect(pipe.write("hello")).toBe(true);
        expect(pipe.read()).toBe("hello");
    });

    // C4.03 – read from empty pipe (buffer kosong, writers exist) → null
    it("C4.03 read from empty pipe with writers → returns null (would block)", () => {
        pipe.ioctl(10, null); // INC_READ_REF
        pipe.ioctl(20, null); // INC_WRITE_REF

        const result = pipe.read();
        expect(result).toBeNull();
    });

    // C4.04 – read from empty pipe, NO writers → EOF ("")
    it("C4.04 read from empty pipe with no writers → returns EOF (empty string)", () => {
        pipe.ioctl(10, null); // INC_READ_REF
        // No write refs → pipe is "closed for writing"

        const result = pipe.read();
        expect(result).toBe("");
    });

    // C4.06 – pipe buffer size
    it("C4.06 multiple writes buffered and read in order (FIFO)", () => {
        pipe.ioctl(10, null);
        pipe.ioctl(20, null);

        pipe.write("first");
        pipe.write("second");
        pipe.write("third");

        expect(pipe.read()).toBe("first");
        expect(pipe.read()).toBe("second");
        expect(pipe.read()).toBe("third");
    });

    // C4.08 – close write end → reader gets EOF
    it("C4.08 closing write end → reader gets EOF after buffer drained", () => {
        pipe.ioctl(10, null); // INC_READ_REF
        pipe.ioctl(20, null); // INC_WRITE_REF

        pipe.write("data");
        pipe.ioctl(21, null); // DEC_WRITE_REF → 0 writers

        expect(pipe.read()).toBe("data");
        expect(pipe.read()).toBe(""); // EOF
    });

    // C4.09 – close read end → write fails (broken pipe)
    it("C4.09 writing when no readers → returns false (broken pipe)", () => {
        pipe.ioctl(20, null); // INC_WRITE_REF (no readers)
        const result = pipe.write("data");
        expect(result).toBe(false);
    });

    // C4.14 – large data
    it("C4.14 large data is buffered correctly", () => {
        pipe.ioctl(10, null);
        pipe.ioctl(20, null);

        const big = "A".repeat(10000);
        expect(pipe.write(big)).toBe(true);
        expect(pipe.read()).toBe(big);
    });

    // ref counting edge cases
    it("ref counting — multiple open/close cycles", () => {
        pipe.ioctl(10, null); // 1 reader
        pipe.ioctl(10, null); // 2 readers
        pipe.ioctl(20, null); // 1 writer

        pipe.write("msg");
        expect(pipe.read()).toBe("msg");

        pipe.ioctl(11, null); // 1 reader left
        pipe.write("msg2");
        pipe.ioctl(11, null); // 0 readers
        expect(pipe.write("msg3")).toBe(false); // broken pipe
    });
});
