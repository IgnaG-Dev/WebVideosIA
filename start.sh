#!/bin/bash
set -e

npx tsx --conditions=react-server worker.ts &
WORKER_PID=$!

npx next start &
SERVER_PID=$!

trap 'kill -TERM $WORKER_PID $SERVER_PID 2>/dev/null' TERM INT

wait -n $WORKER_PID $SERVER_PID
EXIT_CODE=$?

kill -TERM $WORKER_PID $SERVER_PID 2>/dev/null
exit $EXIT_CODE
