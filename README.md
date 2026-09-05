# distributed-redis-clone — Phase 1: Single-Node RESP Server

A Redis-compatible key-value server built from scratch in TypeScript, speaking the **real RESP
(REdis Serialization Protocol)** over raw TCP — meaning `redis-cli` and `redis-benchmark` work
against it unmodified. This is Phase 1 of a larger distributed-systems learning project built to
prepare for SDE1/SDE2 interviews. Every design decision below was deliberately made to surface
real production tradeoffs, not just to get something working.

## Why RESP over raw TCP instead of a custom HTTP/JSON API?

- `redis-cli -p 6380 SET foo bar` just works — no custom client needed.
- `redis-benchmark` can be pointed at this server for an apples-to-apples comparison against real Redis.
- It forces you to deal with TCP being a byte **stream**, not a message stream — a single `data`
  event can contain zero, one, or many commands, and a command can be split across multiple
  packets. Handling this correctly (see `src/resp/parser.ts`) was the single most instructive part
  of this project.

## Architecture

```
src/
  resp/
    parser.ts      Stateful streaming RESP parser (handles partial + pipelined TCP chunks)
    encoder.ts      RESP response encoder (+OK, :123, $bulk, *array, -ERR)
    types.ts
  store/
    store.ts        In-memory KV store: lazy + active TTL expiration, glob-pattern KEYS
  commands/
    index.ts        Command dispatch table (SET/GET/DEL/EXPIRE/TTL/INCR/KEYS/...)
  server.ts         TCP server; optional multi-core scaling via the `cluster` module
benchmark/
  load-test.ts      Custom TCP load generator: concurrency, pipelining, percentile latency
```

Each layer was built and tested in isolation before being wired into the next:
`resp/` knows nothing about keys or commands; `store/` knows nothing about TCP or RESP;
`commands/` is the only layer that knows both. This separation is deliberate — in a later
sharding phase, only the dispatch layer needs to change.

### Supported commands (Phase 1)

`PING`, `ECHO`, `SET` (with `EX`/`PX`), `GET`, `DEL`, `EXISTS`, `EXPIRE`, `PEXPIRE`, `TTL`, `PTTL`,
`INCR`, `INCRBY`, `DECR`, `KEYS` (glob patterns), `FLUSHALL`, `DBSIZE`.

## Key design decisions (and why)

### Stateful, buffering RESP parser
TCP can deliver a command split across multiple packets, or multiple commands in a single packet.
The parser only consumes bytes from its internal buffer once it has confirmed a *complete* command
is present — every early-return path in `tryParseOne()` happens strictly before any mutation of
the buffer, so a partial command is never lost. This was verified directly by writing a test script
that deliberately split a single command across two separate `.write()` calls with a delay between
them, watching the naive first-draft parser fail on it, then fixing it.

### Lazy + active TTL expiration
A key's TTL is checked on every access (**lazy** expiration — guarantees no stale reads), *and* a
background `setInterval` sweep samples a handful of random keys periodically to reclaim memory even
from keys nobody ever reads again (**active** expiration). This dual strategy mirrors real Redis.
Verified by setting a key with a short TTL and confirming it disappeared from the store *without
ever being read*, proving the active sweep — not lazy expiration — was responsible.

### `INCR` must preserve an existing TTL
Early implementation risk: if `INCR` blindly re-`SET` the key without carrying over its existing
`expiresAt`, every increment would silently strip the key's expiration. Tested explicitly:
`SET views 5 EX 100` → `INCR views` → `TTL views` still returns a value close to 100, not `-1`.

### `KEYS` is intentionally O(n) — matching real Redis, not "fixed"
`KEYS` scans every key in the store and regex-tests each one. This is slow at scale, but it's
**faithful to real Redis's own documented behavior** — Redis's own docs warn `KEYS` can "ruin
performance" on large databases, because it has no secondary index over key names either. The
production answer (in both real Redis and here, as a planned follow-up) is `SCAN`, which pages
through the keyspace in small bounded chunks instead of blocking the single-threaded event loop
for one giant scan.

### Response batching (pipelining support)
When multiple commands arrive in a single `data` event (a pipelining client), all their responses
are concatenated into **one** `socket.write()` call instead of one write per command. Verified this
mattered by literally counting `socket.write()` calls per second before and after the fix — before,
write count scaled 1:1 with command count; after, it was capped at one per `data` event regardless
of how many commands were batched inside it.

### `CLUSTER_MODE` — a documented, deliberate correctness tradeoff
Setting `CLUSTER_MODE=true` forks one worker process per CPU core using Node's `cluster` module,
which load-balances incoming TCP *connections* across workers. **Each worker has its own
independent in-memory store.** This means a `SET` and a later `GET` for the same key can land on
different workers and appear inconsistent — verified directly by running 20 `SET`s and 20 `GET`s as
separate `redis-cli` invocations and observing some `GET`s return `(nil)` for keys that were
genuinely set moments earlier. This is a deliberate Phase 1 simplification for raw
connection-throughput testing, not a bug — a future sharding phase would replace this with
deterministic key→shard routing so a key always lands on the same node consistently.

## Running it

```bash
npm install
npm run build
npm start                 # single-process mode, port 6380 by default
CLUSTER_MODE=true npm start   # fork one worker per CPU core (see caveat above)
```

Sanity check with real `redis-cli`:
```bash
redis-cli -p 6380 SET foo bar
redis-cli -p 6380 GET foo
redis-cli -p 6380 INCR counter
```

## Load testing methodology

Two complementary tools were used, deliberately cross-checked against each other:

1. **A custom TCP load generator** (`benchmark/load-test.ts`), built from scratch specifically to
   understand connection concurrency, pipelining, and percentile latency measurement first-hand,
   rather than treating them as a black box.
2. **`redis-benchmark`** (real Redis's own compiled C client) — used throughout as a trusted
   reference point to sanity-check the custom tool's numbers, and to separate "the server is slow"
   from "the JS test tool is slow."

```bash
CONCURRENCY=5000 TOTAL_REQUESTS=1000000 PIPELINE=1 npx ts-node benchmark/load-test.ts
redis-benchmark -p 6380 -t set,get -n 1000000 -c 5000 -q
```

| Env var | Meaning | Default |
|---|---|---|
| `CONCURRENCY` | number of simultaneous TCP connections | 100 |
| `TOTAL_REQUESTS` | total commands sent across all connections | 100000 |
| `PIPELINE` | commands batched per write per connection | 1 |

### Two bugs found and fixed while pushing toward 10M requests

1. **Stack overflow in `max()`**: `Math.max(...samples)` spreads the entire samples array as
   individual function arguments, which throws `RangeError: Maximum call stack size exceeded` once
   the array grows into the hundreds of thousands (a real JS engine argument-count limit, not a
   logic bug). Fixed with a plain iterative loop instead of spread.
2. **Unbounded memory growth**: storing every single latency sample in a plain array doesn't scale
   to 10M requests — `sort()` at the end becomes slow and memory-heavy. Fixed with **reservoir
   sampling**, capping stored samples at 500,000 while still tracking the *true* running max
   independently (since max, unlike percentiles, is an extreme-value statistic that sampling would
   corrupt — losing the single slowest request to random eviction would silently under-report the
   real worst case).

## Benchmark results (single-process mode, custom load-test tool)

Run on a MacBook Air (see hardware caveats below).

| Concurrency | Total Requests | Throughput | p50 | p95 | p99 | Mean | Max |
|---|---|---|---|---|---|---|---|
| 100 | 100,000 | 112,052 req/s | 0.74ms | 1.46ms | 2.27ms | 0.86ms | 4.34ms |
| 1,000 | 500,000 | 106,498 req/s | 8.84ms | 10.25ms | 13.07ms | 9.02ms | 21.21ms |
| 5,000 | 1,000,000 | 109,691 req/s | 41.12ms | 44.91ms | 62.46ms | 41.69ms | 146.00ms |

**The clear takeaway**: throughput stays roughly flat (~106-112k req/s) as concurrency rises from
100 to 5,000, but **p50 latency rises 55x** (0.74ms → 41.12ms) over the same range. The server is
doing about the same total work per second regardless of concurrency — each individual request
just waits longer in queue behind everyone else on the single event loop before its turn comes up.
This is the single-threaded Node event-loop ceiling, and it's the direct motivation for
`CLUSTER_MODE` (vertical scaling across cores) and, in a future phase, sharding (horizontal scaling
across separate nodes).

## Cluster mode result — and an honest investigation of a surprising outcome

```bash
CLUSTER_MODE=true WORKERS=2 npm start
CONCURRENCY=5000 TOTAL_REQUESTS=1000000 PIPELINE=1 npx ts-node benchmark/load-test.ts
```

| Mode | Throughput | p50 | p99 | Max |
|---|---|---|---|---|
| Single-process | 109,691 req/s | 41.12ms | 62.46ms | 146.00ms |
| Cluster (2 workers) | 95,078-102,116 req/s | 43-47ms | 68-70ms | 98-262ms |

Cluster mode performed **slightly worse**, not better — the opposite of the naive expectation.
Investigated with `top` during a run:

```
PID    COMMAND      %CPU
31676  node         96.2   <- the load-test process itself, nearly maxed out
0      kernel_task  81.4   <- macOS thermal management, NOT application code
31275  node         71.4   <- a cluster worker
31276  node         71.2   <- another cluster worker
```

Two things this revealed:

1. **The load generator itself was the bottleneck, not the server.** At 96.2% CPU, the
   single-threaded JS load-test process couldn't generate requests fast enough to actually exercise
   the server's extra parallel capacity — and in cluster mode, it now had to *share* the same core
   pool with multiple busy server worker processes, making its own contention worse than in the
   single-process baseline.
2. **`kernel_task` at 80-98% CPU indicates thermal throttling.** A fanless MacBook Air under
   sustained multi-core load will have macOS deliberately throttle real workloads to manage heat —
   a genuine hardware constraint, not a code issue.

### Triangulating with `redis-benchmark` to isolate the real cause

Running the compiled-C `redis-benchmark` client against the same cluster-mode server at identical
concurrency:

```
redis-benchmark -p 6380 -t set,get -n 1000000 -c 5000 -q
SET: 110791.05 requests per second, p50=22.095 msec
GET: 102469.52 requests per second, p50=23.183 msec
```

| Client | Throughput | p50 |
|---|---|---|
| Custom JS load-test tool | ~102,116 req/s | ~43-47ms |
| `redis-benchmark` (compiled C) | ~110,791 req/s | ~22ms |

Similar throughput ceiling, but `redis-benchmark`'s p50 is **roughly half** the custom tool's,
against the identical server. This is conclusive: the custom tool's own JS-level overhead (string
encoding, buffer concatenation, reply-counting on every incoming chunk) roughly doubles measured
latency compared to a lightweight compiled client — a real, worth-documenting limitation of the
tool itself, separate from the server's actual capacity.

`kernel_task` remained at ~98% even during the lightweight `redis-benchmark` run, reinforcing that
the ~100-110k req/s ceiling seen consistently across *every* test that day — different server
modes, different client tools — likely reflects a shared hardware/thermal constraint on this
specific machine, not a limit specific to any one piece of code.

### Conclusion from this investigation

- The server's actual capacity is *at least* ~110k req/s at 5,000 concurrency (established by the
  fastest client tested against it).
- The custom load-test tool has meaningfully more per-request overhead than a compiled client —
  documented as a known limitation rather than hidden.
- Absolute throughput numbers from this environment should be read cautiously; *relative*
  comparisons (e.g., pipeline=1 vs pipeline=10, or concurrency scaling shape) are more trustworthy
  than the raw req/s figures, given the thermal constraints of the test hardware.

## Known limitations of Phase 1 (by design)

- No persistence — a restart loses all data.
- No sharding — everything lives on one node.
- No replication or automatic failover.
- `CLUSTER_MODE` workers don't share state (documented and verified above) — use single-process
  mode when testing correctness; cluster mode only for raw connection-throughput testing.
- `KEYS` is O(n) full-scan, matching real Redis's own documented limitation; `SCAN` (incremental,
  non-blocking) is the identified follow-up.
- The custom load-test tool has meaningfully higher per-request overhead than a compiled client —
  useful for understanding concurrency/pipelining mechanics, but `redis-benchmark` numbers should
  be trusted over it for absolute throughput claims.
- Benchmarks in this document were gathered on a fanless MacBook Air showing signs of thermal
  throttling under sustained multi-core load; numbers should be treated as directionally
  informative rather than precise, and re-validated in Docker with isolated CPU allocations (or on
  different hardware) before drawing firm conclusions.

## Roadmap

1. ✅ Single-node RESP server, TTL expiration, full command set, pipelining, load-tested (this repo)
2. `SCAN` command (incremental, non-blocking keyspace iteration)
3. Persistence: append-only file + periodic snapshotting
4. Sharding: consistent hashing across multiple node instances
5. Replication: primary-replica with async catch-up
6. Cluster membership: gossip/heartbeat failure detection + basic leader election
7. Full Docker Compose cluster with the benchmark client isolated in its own container (removes the
   client/server CPU-contention problem documented above) and simulated network partitions