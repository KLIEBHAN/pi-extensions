# Terminal-Bench Full Benchmark Results (2026-04-11)

## Scope

This document records the final full benchmark run for the current Terminal-Bench work, plus the focused trace reruns used to interpret the remaining failures.

## Code state used for the run

- `pi-extensions` Terminal-Bench extension: commit `a6fa897` (`feat: tighten terminal-bench verification wording`)
- `pi-mono` local checkout used by Harbor wrapper at launch: branch `feat/terminal-bench-optimizations`, observed `HEAD` `aa081293`
- Model: `openai-codex/gpt-5.4`
- Thinking: `xhigh`
- Harbor environment: `docker`
- Agent timeout inside container: `PI_HARBOR_TASK_TIMEOUT_SEC=3600`
- Attempts: `1`
- Concurrency: `1`
- Source mode: local `pi-mono` checkout inside container
- Global trace capture: disabled for the full run

## Primary full benchmark run

Artifacts:

- Job directory: `/tmp/pi-extensions-full-gpt54-xhigh-tightened-wording/2026-04-11__11-46-25`
- Top-level result: `/tmp/pi-extensions-full-gpt54-xhigh-tightened-wording/2026-04-11__11-46-25/result.json`
- Harbor log: `/tmp/pi-extensions-full-gpt54-xhigh-tightened-wording.log`

### Summary

| Metric | Value |
|---|---:|
| Total tasks | 89 |
| Reward = 1 | 61 |
| Reward = 0 | 25 |
| Pure errors without reward result | 3 |
| Mean reward | 0.6854 |
| Reported `n_errors` | 15 |

Note: `n_errors = 15` includes several tasks that still received `reward = 1`. It is therefore larger than the count of true non-passes.

### Reward=0 tasks

- `gpt2-codegolf`
- `torch-tensor-parallelism`
- `caffe-cifar-10`
- `adaptive-rejection-sampler`
- `configure-git-webserver`
- `polyglot-rust-c`
- `db-wal-recovery`
- `headless-terminal`
- `git-multibranch`
- `train-fasttext`
- `video-processing`
- `qemu-alpine-ssh`
- `install-windows-3.11`
- `make-doom-for-mips`
- `torch-pipeline-parallelism`
- `extract-moves-from-video`
- `gcode-to-text`
- `make-mips-interpreter`
- `raman-fitting`
- `filter-js-from-html`
- `polyglot-c-py`
- `sam-cell-seg`
- `sparql-university`
- `dna-insert`
- `dna-assembly`

### Pure error tasks (no reward result)

- `mcmc-sampling-stan` — `AgentTimeoutError`
- `mteb-retrieve` — `RuntimeError`
- `mteb-leaderboard` — `RuntimeError`

### Tasks with `reward=1` but still counted in `exception_stats`

These tasks succeeded according to the verifier, but Harbor still recorded an agent exception:

- `crack-7z-hash` — `AgentTimeoutError`
- `cobol-modernization` — `AgentTimeoutError`
- `query-optimize` — `AgentTimeoutError`
- `financial-document-processor` — `AgentTimeoutError`

## Reference 30-task run on the same extension wording

This was the strongest clean subset run before the full benchmark and is useful as a sanity reference.

Artifacts:

- Job directory: `/tmp/pi-extensions-30-gpt54-xhigh-tightened-wording/2026-04-11__00-53-12`
- Top-level result: `/tmp/pi-extensions-30-gpt54-xhigh-tightened-wording/2026-04-11__00-53-12/result.json`

### Summary

| Metric | Value |
|---|---:|
| Total tasks | 30 |
| Reward = 1 | 25 |
| Reward = 0 | 4 |
| Pure errors without reward result | 1 |
| Mean reward | 0.8333 |

This run outperformed the full benchmark materially and represents the best clean 30-task result observed during this cycle.

## Focused trace reruns after the full benchmark

To avoid tracing all 89 tasks, only the highest-value remaining full-benchmark problem cases were rerun with trace capture enabled.

Artifacts:

- Job directory: `/tmp/pi-extensions-full-gpt54-xhigh-tightened-wording-focus-traces/2026-04-12__11-54-58`
- Top-level result: `/tmp/pi-extensions-full-gpt54-xhigh-tightened-wording-focus-traces/2026-04-12__11-54-58/result.json`
- Harbor log: `/tmp/pi-extensions-full-gpt54-xhigh-tightened-wording-focus-traces.log`

Trace rerun setup:

- Same model/setup as full benchmark
- `PI_HARBOR_TRACE_JSONL=1`
- `--agent-timeout-multiplier 6`

### Rerun set and outcomes

| Task | Full benchmark outcome | Trace rerun outcome | Interpretation |
|---|---|---|---|
| `gpt2-codegolf` | reward=0 + timeout | reward=1 | Volatile / not a stable product issue |
| `mteb-retrieve` | pure runtime error | reward=1 | Volatile / not stable enough for new general rules |
| `mteb-leaderboard` | pure runtime error | reward=1 | Volatile / not stable enough for new general rules |
| `torch-tensor-parallelism` | reward=0 | reward=0 | Stable implementation bug |
| `adaptive-rejection-sampler` | reward=0 | reward=0 | Stable semantic bug |
| `configure-git-webserver` | reward=0 | reward=0 | Stable workflow / final-state failure |
| `caffe-cifar-10` | reward=0 + timeout | runtime error / timeout | Stable heavy-run / timeout failure |

## Focused diagnosis summary

### 1. `configure-git-webserver`

This remains the cleanest single remaining agent/policy failure.

Observed behavior:

- The agent sets up the repository and web serving flow.
- The agent attempts user-visible workflow verification.
- The agent still destroys or resets the real final state afterwards.

Representative trace behavior from the focused rerun shows destructive cleanup against the real target state, for example:

- removing served content from the live web root
- deleting the live Git branch ref
- clearing live repo metadata after a successful workflow check

Net effect:

- verifier still gets `HTTP 404`
- the task fails because the post-verification final state is wrong

Interpretation:

- This is the strongest remaining case of “final user-visible state was not left in place”.
- It is a better single-task analysis target than `caffe-cifar-10`.

### 2. `caffe-cifar-10`

This remains a heavy-run / timeout case rather than a clean small policy miss.

Observed behavior:

- repeated build/train/test work
- significant shell activity and some interactive probing
- repeated timeout at 3600s

Additional trace signal:

- the agent still spends effort around `./build/tools/caffe`
- the exact expected final binary and exact contract shape remain weak anchors
- the task is expensive enough that broader prompt tweaks are unlikely to solve it cleanly

Interpretation:

- This is not a good next target for general product rules.
- It is better understood as a difficult task-specific execution/strategy problem.

### 3. `torch-tensor-parallelism`

Stable semantic/implementation failure.

Focused rerun verifier output showed multiple failing distributed cases for `world_size > 1`.

Interpretation:

- real implementation bug
- not a benchmark harness issue
- not a good target for new global prompting

### 4. `adaptive-rejection-sampler`

Stable semantic/implementation failure.

Focused rerun verifier output showed:

- generation of standard normal samples still fails
- error around `lower` needing to be a numeric scalar

Interpretation:

- real implementation bug
- not a good target for further general prompt policy work

## What the benchmark supports keeping

### Keep in `pi-mono`

- `--trace-jsonl` / `PI_TRACE_JSONL`
- runtime-level JSONL tracing machinery
- Harbor wrapper hardening and artifact capture
- container-native execution of `pi`
- stdout/stderr persistence
- local-checkout Harbor mode
- thinking / timeout overrides

These are generally useful and not benchmark-specific.

### Keep in `pi-extensions`

- current `terminal-bench.ts` wording and checklist structure from `a6fa897`
- exact-contract extraction
- required-artifact rule
- final-state wording
- recent tool activity in completion checklist
- tmux tools
- output truncation
- environment snapshot

## What the benchmark does not support pursuing further

### Do not add more general core complexity

The evidence from the 30-task and full runs does not justify adding task heuristics or deliverable heuristics into the `pi` core.

Specifically, the benchmark work does **not** support continuing with:

- `best-so-far artifact` logic
- new task-semantic heuristics in core runtime/session code
- more broad prompt expansion

### Do not continue broad prompt iteration

The current wording is already short and effective enough. The remaining stable problems are now dominated by:

- one workflow/final-state case (`configure-git-webserver`)
- one heavy timeout case (`caffe-cifar-10`)
- several task-level semantic bugs

Further broad prompt tuning is unlikely to be the right lever.

## Final recommendation

1. Treat the current state as the end of the broad Terminal-Bench optimization cycle.
2. Keep the `pi-mono` observability / Harbor improvements.
3. Keep the current `pi-extensions` Terminal-Bench extension wording.
4. Do not add more general product or prompt complexity.
5. If any additional work is done, make it a **single-case investigation of `configure-git-webserver`**, not another wide optimization pass.
