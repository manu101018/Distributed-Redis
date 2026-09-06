#!/bin/bash
# Usage: ./run-sweep.sh <label> <host> <port> <mode: local|docker>
# Runs both concurrency-sweep and load-sweep against whatever server
# is currently running at host:port, appends results to results.csv

LABEL=$1
HOST=$2
PORT=$3
MODE=$4  # "local" = run node/redis-benchmark directly, "docker" = run inside benchmark container

RESULTS_FILE="results.csv"
if [ ! -f "$RESULTS_FILE" ]; then
  echo "label,client,concurrency,requests,throughput,p50,p95,p99,max" > "$RESULTS_FILE"
fi

run_custom_tool() {
  local concurrency=$1
  local requests=$2
  echo "[$LABEL] custom-tool c=$concurrency n=$requests"
  if [ "$MODE" = "docker" ]; then
    OUTPUT=$(docker compose --profile benchmark run --rm \
      -e HOST=$HOST -e PORT=$PORT -e CONCURRENCY=$concurrency -e TOTAL_REQUESTS=$requests \
      benchmark)
  else
    OUTPUT=$(HOST=$HOST PORT=$PORT CONCURRENCY=$concurrency TOTAL_REQUESTS=$requests \
      node dist/benchmark/load-test.js)
  fi
  echo "$OUTPUT"
  THROUGHPUT=$(echo "$OUTPUT" | grep -o 'throughput: [0-9]*' | grep -o '[0-9]*')
  P50=$(echo "$OUTPUT" | grep -o 'p50: [0-9.]*' | grep -o '[0-9.]*')
  P95=$(echo "$OUTPUT" | grep -o 'p95: [0-9.]*' | grep -o '[0-9.]*')
  P99=$(echo "$OUTPUT" | grep -o 'p99: [0-9.]*' | grep -o '[0-9.]*')
  MAX=$(echo "$OUTPUT" | grep -o 'max: [0-9.]*' | grep -o '[0-9.]*')
  echo "$LABEL,custom-tool,$concurrency,$requests,$THROUGHPUT,$P50,$P95,$P99,$MAX" >> "$RESULTS_FILE"
}

run_redis_benchmark() {
  local concurrency=$1
  local requests=$2
  echo "[$LABEL] redis-benchmark c=$concurrency n=$requests"
  if [ "$MODE" = "docker" ]; then
    OUTPUT=$(docker compose run --rm --entrypoint sh benchmark -c \
      "apk add --no-cache redis -q && redis-benchmark -h $HOST -p $PORT -t set -n $requests -c $concurrency -q")
  else
    OUTPUT=$(redis-benchmark -h $HOST -p $PORT -t set -n $requests -c $concurrency -q)
  fi
  echo "$OUTPUT"
  THROUGHPUT=$(echo "$OUTPUT" | grep -o '[0-9.]* requests per second' | grep -o '^[0-9.]*')
  P50=$(echo "$OUTPUT" | grep -o 'p50=[0-9.]*' | grep -o '[0-9.]*$')
  echo "$LABEL,redis-benchmark,$concurrency,$requests,$THROUGHPUT,$P50,,," >> "$RESULTS_FILE"
}

# Sweep A: concurrency sweep at fixed 1M requests
for c in 500 1000 2000 5000; do
  run_custom_tool $c 1000000
  run_redis_benchmark $c 1000000
done

# Sweep B: load sweep at fixed 5000 concurrency
for n in 1000000 5000000 10000000; do
  run_custom_tool 5000 $n
  run_redis_benchmark 5000 $n
done

echo "Done. Results appended to $RESULTS_FILE"