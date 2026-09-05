import * as net from "net";
import * as enc from './resp/encoder';
import { RespParser } from "./resp/parser";
import { Store } from "./store/store";
import { dispatch } from "./commands";

const PORT = 6380;
const HOST = "0.0.0.0";

const store = new Store();

const server = net.createServer((connection) => {
    console.log('client conncted');
    const parser = new RespParser();

    connection.on('data', (chunks: Buffer) => {
        parser.feed(chunks);
        const commands = parser.drainCommands();
        if (commands.length === 0) return;

        const responses: Buffer[] = [];

        for (const cmd of commands) {
            responses.push(dispatch(store, cmd.name, cmd.args));
        }
        connection.write(Buffer.concat(responses));
    })

    connection.on('close', () => {
        console.log("client disconnected");
    })

    connection.on('error', (error) => {
        console.log("client error", error);
    })
})

server.listen(PORT, HOST, () => {
    console.log(`Server is running on ${HOST}:${PORT}`);
})