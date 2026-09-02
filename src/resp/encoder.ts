export function simpleString(s : string) : Buffer {
    return Buffer.from(`+${s}\r\n`);
}

export function error(message: string): Buffer {
    return Buffer.from(`-ERR ${message}\r\n`, 'utf8');
}

export function integer(n: number): Buffer {
    return Buffer.from(`:${Math.trunc(n)}\r\n`, 'utf8');
}

export function nullBulk(): Buffer {
    return Buffer.from('$-1\r\n', 'utf8');
}

export function bulkString(s: string | null): Buffer {
    if( s == null) return nullBulk();
    const data = Buffer.from(s, 'utf8');

    return Buffer.concat([
        Buffer.from(`$${data.length}\r\n`, 'utf8'),
        data,
        Buffer.from('\r\n'),
    ])
}

export function array(items: (string | number | null)[]): Buffer {
    const parts: Buffer[] = [Buffer.from(`*${items.length}\r\n`, 'utf-8')];
    for(const item of items){
        if(item == null){
            parts.push(nullBulk());
        } else if(typeof item === 'number'){
            parts.push(integer(item));
        } else {
            parts.push(bulkString(item));
        }
    }

    return Buffer.concat(parts);
}