#!/bin/sh
# Start Redis as master. Clears a persisted replicaof from AOF/RDB after bad restarts.
set -e

redis-server --appendonly yes --maxmemory 1800mb --maxmemory-policy noeviction &
pid=$!

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if redis-cli ping >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

redis-cli REPLICAOF NO ONE >/dev/null 2>&1 || true

wait "$pid"
