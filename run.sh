#!/usr/bin/env bash
# Start the chat interface. Override any setting via the environment, e.g.
#   LLAMA_BASE_URL=http://10.0.0.5:8080/v1 ./run.sh
set -euo pipefail

cd "$(dirname "$0")"

export LLAMA_BASE_URL="${LLAMA_BASE_URL:-http://127.0.0.1:8080/v1}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"

echo "Chat interface  ->  http://${HOST}:${PORT}"
# The model is not pinned here: the app asks the endpoint what it has loaded.
# Set LLAMA_MODEL_ID to override that.
echo "Inference       ->  ${LLAMA_BASE_URL}  (model ${LLAMA_MODEL_ID:-auto-detected})"

exec python3 -m uvicorn app.main:app --host "$HOST" --port "$PORT" "$@"
