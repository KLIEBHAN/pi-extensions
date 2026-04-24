# Terminal-Bench GPT-5.5 xhigh Representative Run (2026-04-24)

## Scope

This document records a small first-look Terminal-Bench run with `gpt-5.5` at
`xhigh` reasoning. It is intended as a quick comparison point against the
previous `gpt-5.4`/`xhigh` full-run notes in
`docs/terminal-bench-full-benchmark-2026-04-11.md`, not as a statistically
stable replacement for a full 89-task run.

## Docker and wrapper smoke test

Docker was reachable before running Harbor:

```text
Docker OK: Server 28.0.1, CPUs 10, Memory 8218034176 bytes
```

The local Hello World Harbor smoke test passed with `gpt-5.5`/`xhigh`:

- Job directory: `/tmp/pi-extensions-hello-world-gpt55-xhigh/hello-world-openai-codex-gpt-5.5-xhigh`
- Result: mean reward `1.000`, errors `0`, trials `1`

After a local-source wrapper fix (see below), the same smoke test also passed in
`PI_HARBOR_PI_SOURCE=local` mode:

- Job directory: `/tmp/pi-extensions-hello-world-gpt55-xhigh-local/hello-world-openai-codex-gpt-5.5-xhigh`
- Result: mean reward `1.000`, errors `0`, trials `1`

## Code state and run settings

- `pi-extensions` branch at run time: `main`
- `pi-extensions` observed pre-commit HEAD: `e0ef240`
- Local `pi-mono` checkout: `../pi-mono`, branch `feat/terminal-bench-optimizations`
- Local `pi-mono` observed after the run: `e441cd82`
- Model: `openai-codex/gpt-5.5`
- Thinking: `xhigh`
- Harbor environment: `docker`
- Concurrency: `1`
- Attempts: `1`
- Source mode: local `pi-mono` checkout inside container
- Wrapper pi execution timeout: `PI_HARBOR_TASK_TIMEOUT_SEC=3600`
- Trace capture: disabled for the 10-task run (`PI_HARBOR_TRACE_JSONL=0`)

Main command shape:

```bash
cd examples/harbor-wrapper
PI_HARBOR_PI_SOURCE=local \
PI_HARBOR_LOCAL_REPO=/Users/fabi/Documents/workspace/pi-mono \
PI_HARBOR_THINKING=xhigh \
PI_HARBOR_TASK_TIMEOUT_SEC=3600 \
PI_HARBOR_TRACE_JSONL=0 \
harbor run \
  --agent-import-path agent:PiAgent \
  -d terminal-bench@2.0 \
  -m openai-codex/gpt-5.5 \
  -e docker \
  -n 1 \
  --n-attempts 1 \
  --jobs-dir /tmp/pi-extensions-10-gpt55-xhigh \
  --job-name 10-representative-gpt55-xhigh-2026-04-24 \
  -i write-compressor \
  -i build-cython-ext \
  -i fix-git \
  -i code-from-image \
  -i configure-git-webserver \
  -i filter-js-from-html \
  -i gcode-to-text \
  -i adaptive-rejection-sampler \
  -i torch-tensor-parallelism \
  -i gpt2-codegolf
```

## Main 10-task job artifact

- Job directory: `/tmp/pi-extensions-10-gpt55-xhigh/10-representative-gpt55-xhigh-2026-04-24`
- Top-level result: `/tmp/pi-extensions-10-gpt55-xhigh/10-representative-gpt55-xhigh-2026-04-24/result.json`

Top-level Harbor summary from the initial job:

| Metric | Value |
|---|---:|
| Total tasks | 10 |
| Reward = 1 | 4 |
| Reward = 0 | 6 |
| Mean reward | 0.400 |
| Reported errors | 5 |
| Exception type | `AgentTimeoutError` |

The initial `gcode-to-text` trial had an infrastructure issue in local-source
mode:

```text
/tmp/pi-mono/node_modules/.bin/tsx: No such file or directory
```

The wrapper was then tightened to install local-source dev dependencies with
`npm install --include=dev` and to assert that `node_modules/.bin/tsx` exists.
`gcode-to-text` was rerun after that fix. The corrected rerun still failed with
`reward = 0` and `AgentTimeoutError`, so the corrected representative reward
count remains `4/10`.

Corrected `gcode-to-text` rerun artifact:

- Job directory: `/tmp/pi-extensions-gcode-gpt55-xhigh-rerun/gcode-gpt55-xhigh-local-source-2026-04-24`
- Result: reward `0`, `AgentTimeoutError`, `/app/out.txt` missing

## Per-task results

The `gpt-5.4` baseline column below uses the 2026-04-11 full-run notes: tasks
not listed as reward-zero or pure-error in that document are treated as
`reward = 1` for that full run.

| Task | Category / reason included | GPT-5.4 xhigh full-run baseline | GPT-5.5 xhigh reward | GPT-5.5 exception | Note |
|---|---|---:|---:|---|---|
| `write-compressor` | artifact/compression calibration | 1 | 1 |  | Passed verifier |
| `build-cython-ext` | build/package calibration | 1 | 1 | `AgentTimeoutError` | Verifier passed despite Harbor agent timeout at 900s |
| `fix-git` | git recovery calibration | 1 | 1 |  | Passed verifier |
| `code-from-image` | multimedia/programmatic inspection calibration | 1 | 1 |  | Passed verifier |
| `configure-git-webserver` | known final-state/workflow failure | 0 | 0 | `AgentTimeoutError` | Verifier still saw HTTP 404 |
| `filter-js-from-html` | known sanitizer/security failure | 0 | 0 |  | XSS and clean-HTML tests failed |
| `gcode-to-text` | known file/domain extraction failure | 0 | 0 | `AgentTimeoutError` | Corrected rerun; `/app/out.txt` missing |
| `adaptive-rejection-sampler` | known stats/semantic implementation failure | 0 | 0 | `AgentTimeoutError` | 9/9 verifier tests failed |
| `torch-tensor-parallelism` | known ML/distributed semantic failure | 0 | 0 | `AgentTimeoutError` | Row-parallel failures for `world_size > 1` |
| `gpt2-codegolf` | volatile low-level/model task | 0 | 0 | `AgentTimeoutError` | Wrong sampled output; note GPT-5.4 focus rerun had passed this task |

Corrected subset comparison:

| Model/run | Reward on these 10 selected tasks |
|---|---:|
| GPT-5.4 xhigh full-run baseline | 4/10 |
| GPT-5.5 xhigh representative run | 4/10 |

## First impression

On this deliberately mixed subset, `gpt-5.5`/`xhigh` does **not** show an early
reward improvement over the prior `gpt-5.4`/`xhigh` full-run baseline. It kept
the four calibration passes, but did not flip any of the selected known
`gpt-5.4` reward-zero tasks.

Caveats:

- This is only 10 tasks and includes several previously known hard failures, so
  it is not a full-distribution estimate.
- Several failures are timeout-influenced at Harbor's task-level agent timeout
  (`900s` for many tasks), even though the wrapper's in-container pi timeout was
  set to `3600s`.
- `gpt2-codegolf` was volatile in the 2026-04-11 notes: it failed in the full
  GPT-5.4 run but passed a focused trace rerun. Its GPT-5.5 failure here should
  not be over-weighted.

Recommendation: if we continue, run either the same subset with
`--agent-timeout-multiplier 4` to reduce timeout ambiguity, or proceed to a
larger 30-task run before making claims about GPT-5.5 vs GPT-5.4.
