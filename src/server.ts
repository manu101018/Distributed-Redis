import * as net from "net";
import cluster from 'cluster';
import * as os from 'os';

import { RespParser } from "./resp/parser";
import { Store } from "./store/store";
import { dispatch } from "./commands";

const PORT = Number(process.env.PORT ?? 6380);
const HOST = process.env.HOST ?? '0.0.0.0';
const CLUSTER_MODE = process.env.CLUSTER_MODE === 'true';
const WORKERS = Number(process.env.WORKERS ?? os.cpus().length);

function startWorker(): void {
    const store = new Store();

    const server = net.createServer((connection) => {
        // console.log('client conncted');
        const parser = new RespParser();

        connection.on('data', (chunks: Buffer) => {
            parser.feed(chunks);
            // console.log("parsed: ", parser.drainCommands());
            const commands = parser.drainCommands();

            if (commands.length === 0) return;

            const responses: Buffer[] = [];

            for (const cmd of commands) {
                responses.push(dispatch(store, cmd.name, cmd.args));
            }
            connection.write(Buffer.concat(responses));
        })

        connection.on('close', () => {
            // console.log("client disconnected");
        })

        connection.on('error', (error) => {
            console.log("client error", error);
        })
    })

    server.listen(PORT, HOST, 1024, () => {
        console.log(`Server is running on ${HOST}:${PORT}`);
    })
}

if (!CLUSTER_MODE) {
    console.log('single-process mode (set CLUSTER_MODE=true to scale across cores)');
    startWorker();
} else if (cluster.isPrimary) {
    console.log(`primary ${process.pid} forking ${WORKERS} workers`);
    for (let i = 0; i < WORKERS; i++) cluster.fork();
    cluster.on('exit', (worker, code, signal) => {
        console.log(`worker ${worker.process.pid} died (code=${code}, signal=${signal})`);
        if (code === 1 && !worker.exitedAfterDisconnect) {
            // Give it a moment, and cap retries in a real system - for now, at
            // minimum don't spin instantly and silently on an unrecoverable error.
            console.error('worker exited abnormally - not auto-restarting to avoid a crash loop on unrecoverable errors (e.g. port already in use)');
            return;
        }
        cluster.fork();
    });
} else {
    startWorker();
}