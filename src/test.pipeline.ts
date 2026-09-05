import * as net from 'net';

function encodeCommand(parts: string[]): string {
    let out = `*${parts.length}\r\n`;
    for (const p of parts) out += `$${Buffer.byteLength(p)}\r\n${p}\r\n`;
    return out;
}

const socket = net.connect(6380, '127.0.0.1', () => {
    const commands = [
        encodeCommand(['SET', 'a', '1']),
        encodeCommand(['SET', 'b', '2']),
        encodeCommand(['GET', 'a']),
        encodeCommand(['GET', 'b']),
        encodeCommand(['DEL', 'a', 'b']),
    ];
    // Concatenate and send as ONE write - this is what pipelining looks like
    socket.write(commands.join(''));
});

let received = Buffer.alloc(0);
socket.on('data', (chunk) => {
    received = Buffer.concat([received, chunk]);
    console.log('raw reply so far:', JSON.stringify(received.toString()));
});

setTimeout(() => {
    socket.end();
    process.exit(0);
}, 500);