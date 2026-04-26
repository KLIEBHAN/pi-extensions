# Terminal-Bench GPT-5.5 Remaining Failure Analysis (2026-04-26)

## Scope

This note analyzes the remaining unresolved failures after the GPT-5.5/xhigh
full run with `--agent-timeout-multiplier 4` and the focused reruns of
`write-compressor` and `train-fasttext`.

Baseline accounting after focused reruns:

- Official full run: `74/89 = 0.8315`
- `write-compressor` focused rerun passed, so adjusted conservative estimate:
  `75/89 = 0.8427`
- `train-fasttext` remained a pure timeout error even with
  `PI_HARBOR_TASK_TIMEOUT_SEC=7200`

The 14 remaining unresolved items are therefore the 13 full-run `reward=0` tasks
excluding `write-compressor`, plus the `train-fasttext` pure error.

## Root-cause categories

### A. Volatile / already shown to be flippable

| Task | Evidence | Root cause | Rerun priority |
|---|---|---|---|
| `torch-tensor-parallelism` | Passed in the prior 10-task timeout-x4 sample, failed in the full run | Volatile semantic implementation of `RowParallelLinear`; full run failed `world_size > 1` row-parallel cases | Very high |

### B. Near-miss / exact output or final-state contract failures

| Task | Evidence | Root cause | Rerun priority |
|---|---|---|---|
| `polyglot-rust-c` | Functional commands worked, but verifier found extra files: `main.rs`, `main`, `cmain` | Final-state cleanup miss; task requires only `/app/polyglot/main.rs` to remain | Very high |
| `sam-cell-seg` | 8/9 tests passed; only `coords_x`/`coords_y` parsed as tuple, not list | CSV serialization shape bug: tuple literal instead of list literal | Very high |
| `dna-assembly` | Only failure was Tm delta `5.002306 > 5` | Numerical near-miss at tolerance boundary | Very high |
| `mcmc-sampling-stan` | Alpha/beta estimates passed; Stan/R files passed; only stdout lacked `SAMPLING FOR MODEL`/`Chain`/`Elapsed Time` | Sampling probably ran, but output was suppressed or not emitted in verifier-visible run | High |
| `make-doom-for-mips` | Frame exists and image similarity passed; only expected stdout text missing | DOOM boots enough to draw correct frame, but stdout contract lacks exact `I_InitGraphics: DOOM screen size: w x h: 320 x 200` line | Medium |
| `make-mips-interpreter` | Same as above: frame exists and image similarity passed; stdout text missing | MIPS interpreter runs enough to produce frame, but not exact stdout initialization text | Medium |
| `install-windows-3.11` | VNC/nginx checks passed, but `pgrep qemu-system` failed and `/tmp/qemu-monitor.sock` was missing | Exact final-state mismatch: agent used TCP monitor/QMP instead of the Unix monitor socket expected by tests; QEMU process discovery also failed | Medium-high |

### C. Stable semantic / hidden-generalization failures

| Task | Evidence | Root cause | Rerun priority |
|---|---|---|---|
| `db-wal-recovery` | 5/7 tests passed; recovered 11 records, but WAL-updated values for ids 1/2 were wrong | Partial WAL recovery; inserts recovered but encrypted/decrypted update records not applied correctly | Medium |
| `video-processing` | Example video passed; hidden test video returned takeoff frame `0`, expected `[219,223]` | Overfit or non-general jump detector; hidden video generalization failure | Medium-low |
| `dna-insert` | Single primer pair produced, but Tm delta was `7.057 > 5` according to verifier | Primer design/Tm calculation mismatch; not as close as `dna-assembly` | Medium |
| `filter-js-from-html` | Both tests failed; clean HTML was reserialized/changed, and XSS vectors still triggered | Sanitizer strategy conflicts with exact byte/format preservation; likely used parser/serializer that changes clean HTML | Low |

### D. Provider/policy or timeout failures

| Task | Evidence | Root cause | Rerun priority |
|---|---|---|---|
| `model-extraction-relu-logits` | No `/app/steal.py`; agent stderr contains Codex `cyber_policy` invalid_request | Provider safety policy blocked the task during the agent turn | Low as plain rerun; high as harness/prompt-policy investigation |
| `train-fasttext` | Timed out at 3600s in full run and again at 7200s in focused rerun; no reward result | Heavy task timeout or agent stall; no trace available to distinguish training time from planning/tool loop | Low as plain rerun; high only with trace/diagnostics |

## Prioritized rerun plan

### Batch 1: highest expected value, mostly cheap or known-flippable

Run these first:

1. `torch-tensor-parallelism`
2. `polyglot-rust-c`
3. `sam-cell-seg`
4. `dna-assembly`
5. `mcmc-sampling-stan`

Rationale:

- `torch-tensor-parallelism` already passed once under the same model/timeout
  regime.
- `polyglot-rust-c`, `sam-cell-seg`, and `dna-assembly` are near-misses with
  highly localized failures.
- `mcmc-sampling-stan` had all substantive numerical checks passing and failed
  only on verifier-visible sampling output.

Suggested command shape:

```bash
cd examples/harbor-wrapper
PI_HARBOR_PI_SOURCE=local \
PI_HARBOR_LOCAL_REPO=/Users/fabi/Documents/workspace/pi-mono \
PI_HARBOR_THINKING=xhigh \
PI_HARBOR_TASK_TIMEOUT_SEC=7200 \
PI_HARBOR_TRACE_JSONL=0 \
harbor run \
  --agent-import-path agent:PiAgent \
  -d terminal-bench@2.0 \
  -m openai-codex/gpt-5.5 \
  -e docker \
  -n 1 \
  --n-attempts 1 \
  --agent-timeout-multiplier 4 \
  --jobs-dir /tmp/pi-extensions-rerun-gpt55-priority1 \
  --job-name rerun-gpt55-priority1-2026-04-26 \
  -i torch-tensor-parallelism \
  -i polyglot-rust-c \
  -i sam-cell-seg \
  -i dna-assembly \
  -i mcmc-sampling-stan
```

Potential score impact from Batch 1:

| Additional passes | Adjusted score |
|---:|---:|
| +1 | `76/89 = 0.8539` |
| +3 | `78/89 = 0.8764` |
| +5 | `80/89 = 0.8989` |

### Batch 2: medium probability, task-specific semantic/final-state misses

Run after Batch 1:

1. `install-windows-3.11`
2. `dna-insert`
3. `db-wal-recovery`
4. `make-doom-for-mips`
5. `make-mips-interpreter`
6. `video-processing`

Rationale:

- `install-windows-3.11` passed several external checks but missed exact monitor
  socket/process requirements.
- `dna-insert` is cheap and structurally close, but the Tm mismatch is less
  borderline than `dna-assembly`.
- `db-wal-recovery` recovered much of the data but missed WAL updates.
- The two MIPS/DOOM tasks are image-correct but stdout-contract incorrect.
- `video-processing` passed the example and failed hidden generalization.

### Batch 3: diagnostic rather than plain rerun

Do not prioritize plain reruns for these without trace or a harness/prompt change:

1. `model-extraction-relu-logits`
2. `train-fasttext`
3. `filter-js-from-html`

Recommended handling:

- `model-extraction-relu-logits`: rerun with trace enabled to confirm whether the
  provider policy block is deterministic and where it occurs. A prompt-level
  authorized-benchmark clarification may be needed; a normal rerun is unlikely
  to be reliable.
- `train-fasttext`: rerun only with trace capture or additional stdout/stderr
  instrumentation. It already timed out at 7200 seconds.
- `filter-js-from-html`: likely needs a better sanitizer strategy that preserves
  clean HTML byte-for-byte while removing only harmful substrings. Plain rerun
  probability appears low because the failure is stable and verifier-heavy.

## Score expectations

Current conservative adjusted score:

```text
75/89 = 0.8427
```

Realistic short-term rerun target if Batch 1 recovers 3–5 tasks:

```text
78/89 to 80/89 = 0.8764 to 0.8989
```

Crossing 90% requires at least six additional passes:

```text
81/89 = 0.9101
```

That is possible only if most near-misses flip and at least one medium-priority
semantic/final-state task also flips.
