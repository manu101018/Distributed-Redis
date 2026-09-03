import { Store } from './store';

const store = new Store();

console.log(store.get('foo'));        // expect: null
store.set('foo', 'bar');
console.log(store.get('foo'));        // expect: "bar"
console.log(store.del(['foo']));      // expect: 1
console.log(store.get('foo'));        // expect: null
console.log(store.del(['nope']));     // expect: 0
console.log(store.size());           // expect: 0