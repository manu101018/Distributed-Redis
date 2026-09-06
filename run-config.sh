#!/bin/bash
# Usage: ./run-config.sh <label> <cluster_mode: true|false> <mode: local|docker>
set -e

LABEL=$1
CLUSTER=$2
MODE=$3

echo "=== Running config: $LABEL (cluster=$CLUSTER, mode=$MODE) ==="

# Always clear the port first - this is what killed you last time
lsof -ti:6380 | xargs kill -9 2>/dev/null || true
sleep 1

if [ "$MODE" = "local" ]; then
  CLUSTER_MODE=$CLUSTER WORKERS=4 node dist/src/server.js > "server-${LABEL}.log" 2>&1 &
  SERVER_PID=$!
  sleep 2

  # Confirm it's actually up before hammering it
  until redis-cli -p 6380 PING > /dev/null 2>&1; do
    echo "waiting for server..."
    sleep 1
  done

  ./run-sweep.sh "$LABEL" 127.0.0.1 6380 local

  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true

else
  # docker mode: edit compose env inline via -e overrides isn't native to
  # `up`, so we pass CLUSTER_MODE via environment for docker compose to
  # pick up - requires docker-compose.yml's