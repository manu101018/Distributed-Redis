import * as net from 'net';
import { performance } from 'perf_hooks';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 6380);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 100);
const TOTAL_REQUESTS = Number(process.env.TOTAL_REQUESTS ?? 100_000);
const PIPELINE = Number(process.env.PIPELINE ?? 1);

class LatencyRecorder {
    private samples: number[] = [];

    record(ms: number): void {
        this.samples.push(ms);
    }

    percentile(p: number): number {
        if (this.samples.length === 0) return 0;
        //TODO: this is not efficient, but it's ok as of now for our purposes, will be replaced with a more efficient algorithm later
        const sorted = [...this.samples].sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
        return sorted[idx];
    }

    mean(): number {
        if (this.samples.length === 0) return 0;
        return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    }
}

function encodeCommand(parts: string[]): string {
    let out = `*${parts.length}\r\n`;
    for (const p of parts) out += `$${Buffer.byteLength(p)}\r\n${p}\r\n`;
    return out;
}

function countReplies(buf: Buffer): number {
    let count = 0;
    let i = 0;
    while (i < buf.length) {
        const type = buf[i];
        const lineEnd = buf.indexOf('\r\n', i, 'latin1');
        if (lineEnd === -1) break;
        if (type === 0x24 /* $ */) {
            const len = parseInt(buf.toString('utf8', i + 1, lineEnd), 10);
            i = len === -1 ? lineEnd + 2 : lineEnd + 2 + len + 2;
        } else {
            i = lineEnd + 2;
        }
        count++;
    }
    return count;
}

// Shared counter across all connections - each one decrements it as it sends
const remaining = { count: TOTAL_REQUESTS };

function runConnection(latency: LatencyRecorder): Promise<void> {
    return new Promise((resolve) => {
        const socket = net.connect(PORT, HOST);
        let recvBuffer = Buffer.alloc(0);
        let batchSentAt = 0;
        let expectedReplies = 0;

        const sendBatch = () => {
            if (remaining.count <= 0) {
                socket.end();
                return;
            }
            const batchSize = Math.min(PIPELINE, remaining.count);
            remaining.count -= batchSize;
            expectedReplies = batchSize;
            let payload = '';
            for (let i = 0; i < batchSize; i++) payload += encodeCommand(['SET', 'k', 'v']);
            batchSentAt = performance.now();
            socket.write(payload);
        };

        socket.on('connect', sendBatch);
        socket.on('data', (chunk: Buffer) => {
            recvBuffer = Buffer.concat([recvBuffer, chunk]);
            const replies = countReplies(recvBuffer);
            if (replies >= expectedReplies) {
                const elapsed = performance.now() - batchSentAt;
                for (let i = 0; i < expectedReplies; i++) latency.record(elapsed / expectedReplies);
                recvBuffer = Buffer.alloc(0);
                sendBatch();
            }
        });
        socket.on('close', () => resolve());
        socket.on('error', () => resolve());
    });
}

async function main() {
    console.log(`pipeline=${PIPELINE} concurrency=${CONCURRENCY} totalRequests=${TOTAL_REQUESTS}`);
    const latency = new LatencyRecorder();
    const start = performance.now();

    const connections = [];
    for (let i = 0; i < CONCURRENCY; i++) {
        connections.push(runConnection(latency));
    }

    await Promise.all(connections);

    const elapsed = (performance.now() - start) / 1000;
    console.log(`completed in ${elapsed.toFixed(2)}s`);
    console.log(`throughput: ${(TOTAL_REQUESTS / elapsed).toFixed(0)} req/s`);
    console.log(`p50: ${latency.percentile(50).toFixed(2)}ms`);
    console.log(`p95: ${latency.percentile(95).toFixed(2)}ms`);
    console.log(`p99: ${latency.percentile(99).toFixed(2)}ms`);
    console.log(`mean: ${latency.mean().toFixed(2)}ms`);
}

main();

