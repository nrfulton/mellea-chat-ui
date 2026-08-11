#!/usr/bin/env bash
# Start the chat interface. Override any setting via the environment, e.g.
#   LLAMA_BASE_URL=http://10.0.0.5:8080/v1 ./run.sh
set -euo pipefail

cd "$(dirname "$0")"

export LLAMA_BASE_URL="${LLAMA_BASE_URL:-http://9.105.22.23:8080/v1}"
export LLAMA_MODEL_ID="${LLAMA_MODEL_ID:-ibm-granite/granite-4.1-30b}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"

echo "Chat interface  ->  http://${HOST}:${PORT}"
echo "Inference       ->  ${LLAMA_BASE_URL}  (${LLAMA_MODEL_ID})"

exec python3 -m uvicorn app.main:app --host "$HOST" --port "$PORT" "$@"
