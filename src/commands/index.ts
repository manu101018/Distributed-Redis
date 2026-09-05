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
        const [key, value, ...opts] = args;
        let ttlMs : number | undefined;

        for (let i = 0; i < opts.length; i++) {
            const opt = opts[i].toUpperCase();
            if (opt === 'EX') ttlMs = Number(opts[++i]) * 1000;
            else if (opt === 'PX') ttlMs = Number(opts[++i]);
            else return enc.error('syntax error');
        }

        if (ttlMs !== undefined && (Number.isNaN(ttlMs) || ttlMs <= 0)) {
            return enc.error("invalid expire time in 'set' command");
        }

        store.set(key, value, ttlMs);
        return enc.simpleString('OK');
    },

    EXPIRE: (store, args) =>{
        if (args.length !== 2) return wrongArgs('EXPIRE');
        const seconds = Number(args[1]);
        if (Number.isNaN(seconds)) return enc.error('value is not an integer or out of range');
        return enc.integer(store.expire(args[0], seconds * 1000) ? 1 : 0);
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
    },

    TTL: (store, args) => {
        if (args.length !== 1) return wrongArgs('TTL');
        const ttl = store.ttlMs(args[0]);
        if (ttl === null) return enc.integer(-2); // key doesn't exist (Redis convention)
        if (ttl === -1) return enc.integer(-1);   // no expiry set
        return enc.integer(Math.ceil(ttl / 1000)); // convert ms remaining -> whole seconds
    },

    EXISTS: (store, args) => {
        if(args.length < 1) return wrongArgs("EXISTS");
        return enc.integer(store.exists(args));
    },

    INCR: (store, args) =>{
        if(args.length !== 1) return wrongArgs("INCR");
        try {
            return enc.integer(store.incrBy(args[0], 1));
        } catch (error) {
            return enc.error((error as Error).message);
        }
    },

    INCRBY: (store, args) => {
        if(args.length !== 2) return wrongArgs("INCRBY");
        const delta = Number(args[1]);
        if (Number.isNaN(delta)) return enc.error('value is not an integer or out of range');

        try {
            return enc.integer(store.incrBy(args[0], delta));
        } catch (error) {
            return enc.error((error as Error).message);
        }
    },

    DECR: (store, args) => {
        if (args.length !== 1) return wrongArgs("DECR");
        try {
            return enc.integer(store.incrBy(args[0], -1));
        } catch (error) {
            return enc.error((error as Error).message);
        }
    },

    KEYS: (store, args) => {
        if(args.length !== 1) return wrongArgs("KEYS");
        return enc.array(store.keys(args[0]));
    },

    DBSIZE: (store, _args) =>{
        return enc.integer(store.size());
    },

    FLUSHALL: (store, _args) => {
        store.flushAll();
        return enc.simpleString("OK");
    },

    PEXPIRE: (store, args) =>{
        if(args.length !== 2) return wrongArgs("PEXPIRE");

        const ms = Number(args[1]);
        if(Number.isNaN(ms)) return enc.error('value is not an integer or out of range');
        return enc.integer(store.expire(args[0], ms) ? 1 : 0);
    },

    PTTL: (store, args) => {
        if (args.length !== 1) return wrongArgs('PTTL');
        const ttl = store.ttlMs(args[0]);
        if (ttl === null) return enc.integer(-2);
        if (ttl === -1) return enc.integer(-1);
        return enc.integer(Math.ceil(ttl));
    },
}

export function dispatch(store: Store, name: string, args: string[]): Buffer {
    const handler = handlers[name];
    if (!handler) {
        return enc.error(`unknown command '${name.toLowerCase()}'`);
    }

    return handler(store, args);
}