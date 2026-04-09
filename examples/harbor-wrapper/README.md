# Harbor Wrapper for Pi

Runs pi as a [Terminal-Bench 2.0](https://tbench.ai) agent via [Harbor](https://github.com/laude-institute/harbor).

## How It Works

The wrapper installs Node.js and pi inside the Harbor sandbox container,
uploads the bundled terminal-bench extension from this repository plus auth
credentials, injects an `ANTHROPIC_OAUTH_TOKEN` from `auth.json` when
available, then runs pi in print mode (`-p`) for each task from `/app` when
that directory exists.
Pi uses its `terminal-bench` extension for:

- Environment bootstrapping (sandbox snapshot)
- Terminal-Bench-specific prompt optimizations
- Completion verification checklist
- tmux-based terminal interaction (for interactive programs)
- Aggressive output truncation (30KB limit)

## Prerequisites

```bash
# Install harbor
pip install harbor

# Run Harbor from this directory so `agent:PiAgent` resolves correctly
cd examples/harbor-wrapper

# Auth: either API key or subscription login
export ANTHROPIC_API_KEY=sk-ant-...    # Option 1: API key
# OR run `pi` then `/login` to authenticate via subscription (saves to ~/.pi/agent/auth.json)
# The wrapper uploads auth.json and extracts the Anthropic OAuth access token automatically.
```

Note: Pi is installed automatically *inside* the sandbox container during
setup. This wrapper also uploads the bundled `../../extensions/terminal-bench.ts`
file automatically, so no separate global extension install is required.

## Pi Source Mode

By default the wrapper installs the published npm `pi` package inside the
sandbox container.

If you want to run an unreleased local `pi-mono` checkout instead, enable local
source mode:

```bash
PI_HARBOR_PI_SOURCE=local harbor run ...
```

When `PI_HARBOR_PI_SOURCE=local` is set, the wrapper looks for a sibling
`pi-mono` checkout next to this `pi-extensions` repository by default. If your
checkout lives elsewhere, override it:

```bash
PI_HARBOR_LOCAL_REPO=/path/to/pi-mono harbor run ...
```

In local-source mode the wrapper archives the selected checkout, uploads it into
the sandbox at `/tmp/pi-mono`, runs `HUSKY=0 npm install`, and then starts pi
via `tsx packages/coding-agent/src/cli.ts` from that uploaded checkout.

This mode expects the checkout to already contain the workspace dist files that
pi's extension loader uses in Node.js source mode:

- `packages/agent/dist/index.js`
- `packages/ai/dist/index.js`
- `packages/tui/dist/index.js`

## Usage

```bash
cd examples/harbor-wrapper

# Run on Terminal-Bench 2.0
harbor run \
  --agent-import-path agent:PiAgent \
  -d terminal-bench@2.0 \
  -m anthropic/claude-sonnet-4-20250514 \
  -e runloop \
  -n 20 \
  --n-attempts 5

# Run one named task from the dataset
harbor run \
  --agent-import-path agent:PiAgent \
  -d terminal-bench@2.0 \
  -i break-filter-js-from-html \
  -l 1 \
  -m anthropic/claude-sonnet-4-20250514 \
  -n 1 \
  --n-attempts 1

# Use OpenAI models
harbor run \
  --agent-import-path agent:PiAgent \
  -d terminal-bench@2.0 \
  -m openai/gpt-4o \
  -e runloop \
  -n 20
```

## Debugging

Each Harbor trial stores pi process logs under the trial's `agent/` directory:

- `agent/pi-stdout.log` - captured pi stdout
- `agent/pi-errors.log` - captured pi stderr
- `agent/pi-trace.jsonl` - optional structured pi session trace

Stdout/stderr are always downloaded, even when the agent times out.
The structured trace is opt-in to avoid unnecessary overhead and artifact size.

Enable trace capture for a Harbor run with:

```bash
PI_HARBOR_TRACE_JSONL=1 harbor run \
  --agent-import-path agent:PiAgent \
  -d terminal-bench@2.0 \
  -m anthropic/claude-opus-4-6 \
  -e docker \
  -n 1 \
  -t write-compressor \
  --n-attempts 1
```

When running in local-source mode, the current local `--trace-jsonl`
implementation is available automatically when enabled:

```bash
PI_HARBOR_PI_SOURCE=local \
PI_HARBOR_TRACE_JSONL=1 \
harbor run \
  --agent-import-path agent:PiAgent \
  -d terminal-bench@2.0 \
  -m anthropic/claude-opus-4-6 \
  -e docker \
  -n 1 \
  -t write-compressor \
  --n-attempts 1
```

You can also override the in-container trace path:

```bash
PI_HARBOR_TRACE_JSONL=/tmp/custom-pi-trace.jsonl harbor run ...
```

When enabled, the wrapper checks whether the selected in-container `pi` build
already supports `--trace-jsonl`. If so, it passes the flag to pi and then
downloads the resulting JSONL file as `agent/pi-trace.jsonl` for analysis.
If `PI_HARBOR_PI_SOURCE=npm` is used with an older published `pi` release
without that flag, the wrapper logs a warning and continues without trace
capture instead of failing the trial.

## Configuration

The wrapper passes `--terminal-bench` to pi and uses `--thinking high` by default.
You can override the thinking level per run without editing code:

```bash
PI_HARBOR_THINKING=low harbor run ...
```

Valid values:
- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

You can also override the wrapper's in-container pi timeout per run:

```bash
PI_HARBOR_TASK_TIMEOUT_SEC=3600 harbor run ...
```

Edit `agent.py` only if you want to change other defaults such as:

- available tools
- the default fallback for `PI_HARBOR_TASK_TIMEOUT_SEC` (30 minutes)

## Architecture

```
Harbor Orchestrator
  │
  ├── Creates sandbox environment (Docker/runloop)
  ├── Calls PiAgent.setup():
  │     ├── Installs Node.js + pi in container
  │     │   ├── from npm (default)
  │     │   └── or from uploaded local checkout (opt-in)
  │     ├── Uploads bundled terminal-bench.ts from pi-extensions
  │     ├── Uploads auth.json (if available)
  │     ├── Sets PI_CODING_AGENT_DIR in-container
  │     └── Installs tmux
  ├── Calls PiAgent.run(instruction):
  │     ├── Writes task to /tmp/pi-task.txt in container
  │     ├── Runs `pi -p --terminal-bench ...` in container
  │     │   ├── Runs from /app when present
  │     │   ├── terminal-bench extension activates:
  │     │   │   ├── Environment snapshot gathered
  │     │   │   ├── Guidelines injected into system prompt
  │     │   │   └── tmux session created
  │     │   ├── pi's agent loop runs:
  │     │   │   ├── bash tool for non-interactive commands
  │     │   │   ├── tmux_send/tmux_read for interactive programs
  │     │   │   ├── read/write/edit for file operations
  │     │   │   └── Completion verification on "done" signals
  │     │   └── pi exits when done
  │     └── Downloads logs for debugging
  │         ├── agent/pi-stdout.log
  │         ├── agent/pi-errors.log
  │         └── agent/pi-trace.jsonl (optional)
  │
  └── Harbor runs verifier to score the result
```
