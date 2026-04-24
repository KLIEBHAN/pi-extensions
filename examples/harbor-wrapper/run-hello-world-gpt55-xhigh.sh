#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${PI_HARBOR_MODEL:-openai-codex/gpt-5.5}"
ENVIRONMENT="${PI_HARBOR_ENV:-docker}"
JOBS_DIR="${PI_HARBOR_JOBS_DIR:-/tmp/pi-extensions-hello-world-gpt55-xhigh}"
MODEL_SAFE="${MODEL//\//-}"
MODEL_SAFE="${MODEL_SAFE//:/-}"

export PI_HARBOR_THINKING="${PI_HARBOR_THINKING:-xhigh}"
export PI_HARBOR_TASK_TIMEOUT_SEC="${PI_HARBOR_TASK_TIMEOUT_SEC:-900}"
export PI_HARBOR_TRACE_JSONL="${PI_HARBOR_TRACE_JSONL:-1}"

cd "$SCRIPT_DIR"

exec harbor run \
  --agent-import-path agent:PiAgent \
  --path "$SCRIPT_DIR/hello-world-task" \
  --model "$MODEL" \
  --env "$ENVIRONMENT" \
  --n-concurrent 1 \
  --n-attempts 1 \
  --jobs-dir "$JOBS_DIR" \
  --job-name "hello-world-${MODEL_SAFE}-${PI_HARBOR_THINKING}" \
  "$@"
