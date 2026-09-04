import { Store } from './store';

async function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const store = new Store();

    store.set('foo', 'bar', 1000); // expires in 1 second
    console.log(store.get('foo'));       // expect: "bar"
    console.log(store.ttlMs('foo'));     // expect: ~1000 (some number close to it)

    await sleep(1200);

    console.log(store.get('foo'));       // expect: null (lazy expiration kicked in on read)
    console.log(store.ttlMs('foo'));     // expect: null (key gone)

    store.set('baz', 'qux'); // no TTL
    console.log(store.ttlMs('baz'));     // expect: -1 (exists, never expires)

    store.set('active-test', 'v', 300);
    await sleep(600); // don't read it — let active expiration alone clean it up
    console.log((store as any).data.has('active-test')); // expect: false
}

main();