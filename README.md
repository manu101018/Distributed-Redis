# distributed-redis-clone — Phase 1: Single-Node RESP Server

A Redis-compatible key-value server built from scratch in TypeScript, speaking the
**real RESP (REdis Serialization Protocol)** over raw TCP — meaning `redis-cli` and
`redis-benchmark` work against it unmodified. This is Phase 1 of a larger distributed-systems
learning project; later phases add persistence, sharding, replication, and cluster membership.

## Why RESP over raw TCP instead of a custom HTTP/JSON API?

Implementing the actual wire protocol (rather than a JSON-over-HTTP wrapper) means:
- `redis-cli -p 6380 SET foo bar` just works — no custom client needed.
- `redis-benchmark` can be pointed at this server for an apples-to-apples comparison
  against real Redis.
- You have to deal with TCP being a byte *stream*, not a message stream — a single
  `data` event can contain zero, one, or many commands, and a command can be split
  across multiple packets. Handling this correctly (see `src/resp/parser.ts`) is one
  of the more instructive parts of this project.

## Architecture

```
src/
  resp/
    parser.ts      Stateful streaming RESP parser (handles partial TCP chunks)
    encoder.ts      RESP response encoder (+OK, :123, $bulk, *array, -ERR)
    types.ts
  store/
    store.ts        In-memory KV store: lazy + active TTL expiration, approx-LRU eviction
  commands/
    index.ts        Command dispatch table (SET/GET/DEL/EXPIRE/TTL/INCR/KEYS/...)
  utils/
    logger.ts
  server.ts         TCP server; optional multi-core scaling via `cluster` module
benchmark/
  load-test.ts      Custom TCP load generator with pipelining + percentile latency
```

### Supported commands (Phase 1)
`PING`, `ECHO`, `SET` (with `EX`/`PX`), `GET`, `DEL`, `EXISTS`, `EXPIRE`, `PEXPIRE`,
`TTL`, `PTTL`, `INCR`, `INCRBY`, `DECR`, `KEYS` (glob patterns), `FLUSHALL`, `DBSIZE`,
`INFO`, `COMMAND` (stub, so `redis-cli`/`redis-benchmark` handshake cleanly).

### Key design decisions worth discussing in an interview

- **Lazy + active expiration** (`store.ts`): a key's TTL is checked on every access
  (lazy), *and* a background sweep periodically samples random keys to reclaim memory
  from keys nobody reads again (active) — same dual strategy real Redis uses.
- **Approximate LRU eviction**: JS `Map` preserves insertion order, so "touching" a key
  on read/write (delete + re-insert) makes the front of the map the least-recently-used
  key — O(1) per touch, no separate linked list needed. Real Redis's LRU is also
  approximate (it samples a few keys rather than tracking exact recency), so this
  mirrors a real production tradeoff, not just a shortcut.
- **Response batching**: when a client pipelines multiple commands in one TCP packet,
  all responses are concatenated into a single `socket.write()` call rather than one
  write per command — this matters a lot once you're past a few thousand concurrent
  connections, since syscalls become the bottleneck before CPU does.
- **Cluster-mode caveat (important, and intentionally left in)**: setting
  `CLUSTER_MODE=true` forks one worker process per CPU core, and Node's `cluster`
  module load-balances incoming TCP connections across them. **Each worker has its own
  independent in-memory store** — so a `SET` and a later `GET` for the same key can
  land on different workers and appear inconsistent. This is a deliberate Phase 1
  simplification: it's fine (even useful) for raw connection/throughput stress-testing,
  but it is *not* correct for real use. Phase 3 (sharding) replaces this with
  deterministic key→shard routing so a key always lands on the same node. Being able to
  explain this tradeoff clearly is more valuable in an interview than never having hit it.

## Running it

```bash
npm install
npm run build
npm start                 # single-process mode, port 6380 by default
# or, to fork one worker per CPU core (see caveat above):
CLUSTER_MODE=true npm start
```

Or with Docker:
```bash
docker compose up --build redis-clone
```

Sanity check with real `redis-cli`:
```bash
redis-cli -p 6380 SET foo bar
redis-cli -p 6380 GET foo
redis-cli -p 6380 INCR counter
```

## Load testing

Two complementary approaches:

**1. `redis-benchmark`** (real Redis's own C benchmark client — best for an
apples-to-apples number against real Redis):
```bash
redis-benchmark -p 6380 -t set,get -n 1000000 -c 5000 -q
```

**2. Custom load generator** (`benchmark/load-test.ts`) — gives you p50/p95/p99
latency, configurable pipelining, and a mixed read/write workload:
```bash
HOST=127.0.0.1 PORT=6380 CONCURRENCY=5000 TOTAL_REQUESTS=1000000 \
  PIPELINE=1 COMMAND=MIXED npm run bench:build
```

| Env var | Meaning | Default |
|---|---|---|
| `CONCURRENCY` | number of simultaneous TCP connections | 100 |
| `TOTAL_REQUESTS` | total commands to send across all connections | 100000 |
| `PIPELINE` | commands batched per write per connection | 1 |
| `COMMAND` | `SET`, `GET`, or `MIXED` (80% GET / 20% SET) | MIXED |
| `KEYSPACE_SIZE` | number of distinct keys used | 10000 |

### ⚠️ Important: run the load generator on a separate machine/core from the server

The load generator is itself a Node.js process doing real CPU work (encoding
commands, parsing replies). If you run it on the same single-core box as the server,
**they compete for the same CPU**, and you'll see inflated tail latency and dropped
connections that have nothing to do with the server's actual performance. In this
project's dev sandbox (1 vCPU), running 5000 concurrent connections from a
same-machine load generator produced misleading multi-second p99s and connection
errors — `redis-benchmark` (a lightweight compiled C client) didn't show this at the
same concurrency, confirming it was generator-side contention, not the server.

For real numbers: run the server and the benchmark client in **separate Docker
containers** (see `docker-compose.yml` — the `benchmark` service is isolated from
`redis-clone`), or on separate machines, and give the server multiple CPU cores via
`CLUSTER_MODE=true`.

```bash
docker compose --profile benchmark run --rm benchmark
```

### Results captured during development (single vCPU sandbox, single-process server)

| Concurrency | Requests | Tool | Throughput | p50 | Notes |
|---|---|---|---|---|---|
| 100 | 100,000 | redis-benchmark | ~50k req/s | ~1.6ms | |
| 100 | 50,000 | custom load-test | ~39.5k req/s | 1.8ms | matches redis-benchmark closely |
| 1,000 | 200,000 | custom load-test | ~43.5k req/s | 15.8ms | clean, zero errors |
| 5,000 | 500,000 | redis-benchmark | ~44k req/s | 109ms | single core saturated — expected |
| 5,000 | 500,000 | custom load-test | ~15.5k req/s* | 59ms* | *client/server CPU contention, see warning above |

The clear takeaway (and a good interview story): **a single-threaded Node event loop
hits a wall well before 5,000-10,000 concurrent connections** once request handling
involves any real parsing/serialization work — p50 latency goes from ~2ms to over
100ms as concurrency rises from 100 to 5,000, even though throughput barely changes.
This is exactly the motivation for `CLUSTER_MODE` (vertical scaling across cores) and,
eventually, Phase 3's sharding (horizontal scaling across nodes).

## Known limitations of Phase 1 (by design — later phases address these)

- No persistence — a restart loses all data (Phase 2: AOF + snapshotting).
- No sharding — everything lives on one node (Phase 3: consistent hashing).
- No replication — no read replicas or failover (Phase 4).
- No cluster membership / automatic failover (Phase 5).
- `CLUSTER_MODE` workers don't share state (documented above) — use single-process
  mode when testing correctness, cluster mode only for raw connection-handling
  throughput.

## Roadmap

1. ✅ Single-node RESP server (this repo)
2. Persistence: append-only file + periodic snapshotting
3. Sharding: consistent hashing across multiple node instances
4. Replication: primary-replica with async catch-up
5. Cluster membership: gossip/heartbeat failure detection + basic leader election
6. Full Docker Compose cluster with simulated network partitions
