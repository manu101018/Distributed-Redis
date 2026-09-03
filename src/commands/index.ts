import { Store } from "../store/store";
import * as enc from "../resp/encoder";

export type CommandHandler = (store: Store, args: string[]) => Buffer;

function wrongArgs(cmd: string): Buffer {
    return enc.error(`wrong number of arguments for '${cmd.toLowerCase()}' command`);
}

const handlers: Record<string, CommandHandler> = {
    PING: (_store, args) => (args.length != 0) ? enc.bulkString(args[0]) : enc.simpleString("PONG"),

    SET: (store, args) => {
        if (args.length < 2) return wrongArgs("SET");
        const [key, value] = args;
        store.set(key, value);
        return enc.simpleString("OK");
    },

    GET: (store, args) => {
        if (args.length < 1) return wrongArgs("GET");
        const key = args[0];
        const value = store.get(key);
        return enc.bulkString(value);
    },

    DEL: (store, args) => {
        if (args.length < 1) return wrongArgs("DEL");
        const count = store.del(args);
        return enc.integer(count);
    },

    SIZE: (store, _args) => {
        return enc.integer(store.size());
    }
}

export function dispatch(store: Store, name: string, args: string[]): Buffer {
    const handler = handlers[name];
    if (!handler) {
        return enc.error(`unknown command '${name.toLowerCase()}'`);
    }

    return handler(store, args);
}