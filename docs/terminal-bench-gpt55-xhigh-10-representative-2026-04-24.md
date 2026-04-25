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

Corrected subset comparison before increasing Harbor's task-level agent timeout:

| Model/run | Reward on these 10 selected tasks |
|---|---:|
| GPT-5.4 xhigh full-run baseline | 4/10 |
| GPT-5.5 xhigh representative run | 4/10 |

## Timeout-multiplier rerun

The same 10-task set was rerun with `--agent-timeout-multiplier 4` to remove the
900-second Harbor task-level agent timeout as a major confounder.

Additional command option:

```bash
--agent-timeout-multiplier 4
```

Artifacts:

- Job directory: `/tmp/pi-extensions-10-gpt55-xhigh-timeout4/10-representative-gpt55-xhigh-timeout4-2026-04-24`
- Top-level result: `/tmp/pi-extensions-10-gpt55-xhigh-timeout4/10-representative-gpt55-xhigh-timeout4-2026-04-24/result.json`
- Wall-clock runtime: `1:34:13`

Summary:

| Metric | Value |
|---|---:|
| Total tasks | 10 |
| Reward = 1 | 7 |
| Reward = 0 | 3 |
| Mean reward | 0.700 |
| Reported errors | 0 |

Per-task timeout-multiplier results:

| Task | GPT-5.4 xhigh full-run baseline | GPT-5.5 xhigh, normal timeout | GPT-5.5 xhigh, timeout x4 | Timeout x4 note |
|---|---:|---:|---:|---|
| `write-compressor` | 1 | 1 | 1 | Passed |
| `build-cython-ext` | 1 | 1 | 1 | Passed without timeout error |
| `fix-git` | 1 | 1 | 1 | Passed |
| `code-from-image` | 1 | 1 | 1 | Passed |
| `configure-git-webserver` | 0 | 0 | 0 | Still HTTP 404 final-state failure |
| `filter-js-from-html` | 0 | 0 | 0 | XSS and clean-HTML tests still failed |
| `gcode-to-text` | 0 | 0 | 0 | Produced `using gcode is cheating`, expected `flag{gc0d3_iz_ch4LLenGiNg}` |
| `adaptive-rejection-sampler` | 0 | 0 | 1 | Flipped to pass |
| `torch-tensor-parallelism` | 0 | 0 | 1 | Flipped to pass |
| `gpt2-codegolf` | 0 | 0 | 1 | Flipped to pass; note GPT-5.4 focus rerun had also passed this volatile task |

Agent execution durations in the timeout-multiplier run:

| Task | Agent duration |
|---|---:|
| `adaptive-rejection-sampler` | 0:11:18 |
| `build-cython-ext` | 0:07:00 |
| `code-from-image` | 0:00:39 |
| `configure-git-webserver` | 0:06:20 |
| `filter-js-from-html` | 0:07:19 |
| `fix-git` | 0:01:40 |
| `gcode-to-text` | 0:08:06 |
| `gpt2-codegolf` | 0:12:01 |
| `torch-tensor-parallelism` | 0:07:05 |
| `write-compressor` | 0:02:45 |

## Updated first impression

With Harbor's task-level timeout ambiguity reduced, `gpt-5.5`/`xhigh` looks
materially better on this small representative subset: `7/10` versus the
`4/10` GPT-5.4 full-run baseline on the same selected tasks.

The improvement comes from three flips relative to the GPT-5.4 full-run
baseline and the first GPT-5.5 normal-timeout run:

- `adaptive-rejection-sampler`
- `torch-tensor-parallelism`
- `gpt2-codegolf`

Caveats:

- This is still only 10 tasks and intentionally includes several previously
  known hard failures, so it is not a full-distribution estimate.
- The comparison is against the prior GPT-5.4 full-run baseline, not a fresh
  GPT-5.4 rerun with the same `--agent-timeout-multiplier 4` setting.
- `gpt2-codegolf` is known volatile from the 2026-04-11 notes: it failed in the
  full GPT-5.4 run but passed a focused trace rerun.
- Three selected failures remain stable for GPT-5.5 here:
  `configure-git-webserver`, `filter-js-from-html`, and `gcode-to-text`.

Recommendation: run a larger 30-task GPT-5.5/xhigh sample with
`--agent-timeout-multiplier 4` before deciding whether a full 89-task GPT-5.5
run is worth the cost.
