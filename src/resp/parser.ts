import { ParsedCommand } from './types';

export class RespParser {
    private buffer: Buffer = Buffer.alloc(0);

    feed(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
    }

    drainCommands(): ParsedCommand[] {
        const commands: ParsedCommand[] = [];
        while (true) {
            const result = this.tryParseOne();
            if (result === null) break; // not enough data yet, stop and wait for more
            commands.push(result);
        }
        return commands;
    }

    private tryParseOne(): ParsedCommand | null {
        if (this.buffer.length === 0) return null;
        if (this.buffer[0] !== 0x2a /* '*' */) {
            throw new Error('expected array (*)');
        }

        const countLineEnd = this.buffer.indexOf('\r\n');
        if (countLineEnd === -1) return null; // haven't even got the count line yet

        const count = parseInt(this.buffer.toString('utf8', 1, countLineEnd), 10);
        let pos = countLineEnd + 2;

        const parts: string[] = [];
        for (let i = 0; i < count; i++) {
            if (pos >= this.buffer.length) return null; // ran out of buffer mid-array

            if (this.buffer[pos] !== 0x24 /* '$' */) {
                throw new Error('expected bulk string ($)');
            }

            const lenLineEnd = this.buffer.indexOf('\r\n', pos);
            if (lenLineEnd === -1) return null; // haven't got this item's length line yet

            const len = parseInt(this.buffer.toString('utf8', pos + 1, lenLineEnd), 10);
            const dataStart = lenLineEnd + 2;
            const dataEnd = dataStart + len;

            // +2 for the trailing \r\n after the data
            if (dataEnd + 2 > this.buffer.length) return null; // data itself hasn't fully arrived

            parts.push(this.buffer.toString('utf8', dataStart, dataEnd));
            pos = dataEnd + 2;
        }

        // Only NOW, having confirmed the whole command is present, do we consume it.
        this.buffer = this.buffer.subarray(pos);
        const [name, ...args] = parts;
        return { name: name.toUpperCase(), args };
    }
}