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

## Batch 1 trace rerun results

Batch 1 was rerun with trace logging enabled.

Artifacts:

- Job directory: `/tmp/pi-extensions-rerun-gpt55-priority1-trace/rerun-gpt55-priority1-trace-2026-04-26`
- Top-level result: `/tmp/pi-extensions-rerun-gpt55-priority1-trace/rerun-gpt55-priority1-trace-2026-04-26/result.json`

Run settings:

- `pi-extensions`: `c5310c2`
- `pi-mono`: `af11780f` on `feat/terminal-bench-optimizations`
- `PI_HARBOR_TRACE_JSONL=1`
- `PI_HARBOR_TASK_TIMEOUT_SEC=7200`
- `--agent-timeout-multiplier 4`
- Model: `openai-codex/gpt-5.5`
- Thinking: `xhigh`

Summary:

| Metric | Value |
|---|---:|
| Tasks | 5 |
| Reward = 1 | 1 |
| Reward = 0 | 4 |
| Errors | 0 |
| Mean | 0.200 |
| Runtime | 0:58:08 |

Per-task results:

| Task | Result | Trace lines | Trace size | Root-cause update from trace/logs |
|---|---:|---:|---:|---|
| `mcmc-sampling-stan` | 1 | 10,400 | 77.8 MB | Flipped to pass. The agent verified `Rscript /app/analysis.R` with visible sampling output (`Chain`, `Elapsed Time`) and saved posterior means in range. |
| `torch-tensor-parallelism` | 0 | 4,176 | 116.2 MB | Still failed `RowParallelLinear` for `world_size > 1`. Verifier traceback shows `RowParallelLinear.forward()` scatters an input that is already rank-local; rank 1 tries `start=32,length=32` on a 32-wide tensor. The agent only checked file/signatures, not the distributed verifier behavior. |
| `polyglot-rust-c` | 0 | 11,383 | 108.2 MB | Still failed final-state contract. Trace shows the agent explicitly left `/app/polyglot/main` and `/app/polyglot/cmain` after verification and even listed them as final required paths; verifier expects only `main.rs` before it compiles. |
| `sam-cell-seg` | 0 | 18,029 | 885.6 MB | Still failed only `test_coords_are_flat_lists`: `coords_x`/`coords_y` parse as tuples, not lists. Trace shows many code fixes but no full official-style run before finish; the agent only did syntax/artifact checks. |
| `dna-assembly` | 0 | 11,237 | 120.5 MB | Failed differently than the full run: overhang mismatch `egfp.left == atga`, expected `rc(vector.right) == tcat`. Trace shows the agent used a custom Node verifier that considered assembly rotation/Tm OK but did not match the official `make_fragment()` overhang parsing. |

Score update after substituting confirmed reruns:

```text
Previous adjusted score: 75/89 = 0.8427
After mcmc-sampling-stan pass: 76/89 = 0.8539
```

### Batch 1 interpretation

The trace rerun did not support more plain Batch-1 reruns as a high-value path.
Only `mcmc-sampling-stan` flipped. The other four failures are now explained by
specific implementation/final-state mistakes, not by timeout or missing trace:

- `torch-tensor-parallelism`: implementation bug in row-parallel input handling.
- `polyglot-rust-c`: exact final-state cleanup/contract misunderstanding.
- `sam-cell-seg`: CSV literal type bug; tuple vs list.
- `dna-assembly`: official overhang parser mismatch.

These are likely fixable with task-specific steering, but plain stochastic reruns
may repeat the same mistakes.

### Updated rerun priority after Batch 1

1. **Do not rerun `mcmc-sampling-stan`** unless validating reproducibility; it is
   now a confirmed pass for adjusted accounting.
2. **High-value diagnostic/steered reruns** if task-specific intervention is
   allowed:
   - `polyglot-rust-c`: explicitly require removing compile artifacts before
     final answer.
   - `sam-cell-seg`: explicitly require JSON/list literals (`[1, 2]`), not
     tuples (`(1, 2)`) in CSV coordinate columns.
   - `torch-tensor-parallelism`: explicitly state row-parallel `forward()` input
     is already scattered by the caller/test.
   - `dna-assembly`: explicitly require matching the official overhang relation
     `fragment_left == rc(previous_fragment_right)` under the test parser.
3. **Next plain-rerun batch should move to Batch 2** rather than repeating Batch
   1 unchanged:
   - `install-windows-3.11`
   - `dna-insert`
   - `db-wal-recovery`
   - `make-doom-for-mips`
   - `make-mips-interpreter`
   - `video-processing`
4. Keep Batch 3 as diagnostic-only:
   - `model-extraction-relu-logits`
   - `train-fasttext`
   - `filter-js-from-html`

Updated near-term score expectations:

| Accounting | Score |
|---|---:|
| Conservative adjusted after `write-compressor` + `mcmc-sampling-stan` | `76/89 = 0.8539` |
| If two Batch-2 tasks flip | `78/89 = 0.8764` |
| If four Batch-2/tasks or steered near-misses flip | `80/89 = 0.8989` |
| 90% threshold | `81/89 = 0.9101` |

## Batch 2 trace rerun results

Batch 2 was rerun with trace logging enabled.

Artifacts:

- Job directory: `/tmp/pi-extensions-rerun-gpt55-priority2-trace/rerun-gpt55-priority2-trace-2026-04-26`
- Top-level result: `/tmp/pi-extensions-rerun-gpt55-priority2-trace/rerun-gpt55-priority2-trace-2026-04-26/result.json`

Run settings:

- `pi-extensions`: `10b6a9d` at run start
- `pi-mono`: `af11780f` on `feat/terminal-bench-optimizations`
- `PI_HARBOR_TRACE_JSONL=1`
- `PI_HARBOR_TASK_TIMEOUT_SEC=7200`
- `--agent-timeout-multiplier 4`
- Model: `openai-codex/gpt-5.5`
- Thinking: `xhigh`

Summary:

| Metric | Value |
|---|---:|
| Tasks | 6 |
| Reward = 1 | 0 |
| Reward = 0 | 6 |
| Errors | 0 |
| Mean | 0.000 |
| Runtime | 1:19:46 |

Per-task results:

| Task | Result | Trace lines | Trace size | Root-cause update from trace/logs |
|---|---:|---:|---:|---|
| `install-windows-3.11` | 0 | 35,068 | 356.9 MB | Improved relative to the full run: `network_status`, QEMU params, and image verification passed. Only keyboard visual feedback failed because the verifier expects HMP at `/tmp/qemu-monitor.sock`; agent created `/tmp/qemu-win311-hmp.sock` and TCP monitors instead. Very near final-state/socket-name miss. |
| `make-doom-for-mips` | 0 | 25,646 | 608.8 MB | Agent verified exact stdout and correct frame during its own run, but left `/tmp/frame.bmp` in place. The verifier's `test_vm_execution` starts `node vm.js` and waits only until `/tmp/frame.bmp` exists; because it already existed, verifier terminated too early and missed the expected stdout. High-confidence final-state side-effect miss. |
| `make-mips-interpreter` | 0 | 19,511 | 781.8 MB | Same pattern as `make-doom-for-mips`: valid frame and matching image, but `/tmp/frame.bmp` was left pre-existing, so verifier killed the new run before stdout reached `I_InitGraphics: DOOM screen size: w x h: 320 x 200`. High-confidence final-state side-effect miss. |
| `dna-insert` | 0 | 7,236 | 55.4 MB | Still failed Tm delta, now `5.7477 > 5`. Agent's own Tm calculation used intended shorter annealed regions (`61.24` and `61.96`), but the official parser found a different/longer forward annealed region and computed `66.27` vs `60.53`. Official-parser mismatch. |
| `db-wal-recovery` | 0 | 6,703 | 74.4 MB | Still recovered 11 rows, but values for ids 1/2 remained base values `100/200` instead of WAL-updated `150/250`. Trace shows extensive WAL exploration but final JSON still lacks update application. Partial recovery, not enough. |
| `video-processing` | 0 | 12,497 | 283.0 MB | Example video passed; hidden test video failed with takeoff frame `329`, expected `[219,223]`. Trace shows the agent only verified against `/app/example_video.mp4`; no hidden-video access during agent run. Stable hidden-generalization failure. |

Score update after Batch 2:

```text
Before Batch 2 adjusted score: 76/89 = 0.8539
Batch 2 additional passes: +0
After Batch 2 adjusted score: 76/89 = 0.8539
```

### Batch 2 interpretation

Plain Batch-2 reruns did not recover any additional tasks. The traces are still
useful because they identify several high-confidence, task-specific final-state
or verifier-contract misses:

- `install-windows-3.11` is now one socket-name away from passing the observed
  verifier: create/keep HMP at `/tmp/qemu-monitor.sock` specifically.
- `make-doom-for-mips` and `make-mips-interpreter` likely need `/tmp/frame.bmp`
  removed before final answer so the verifier waits for the fresh run and
  captures the expected stdout.
- `dna-insert` needs validation against the official parser's
  `primers_concat.find(insert)` and resulting annealed regions, not against the
  agent's intended shorter annealing regions.
- `db-wal-recovery` needs the WAL update semantics applied for ids 1 and 2;
  insertion recovery alone is insufficient.
- `video-processing` remains a genuine hidden-generalization failure and is a
  poor plain-rerun target.

### Updated next-action priority after Batch 2

Plain stochastic reruns have low expected value for these tasks. If steered or
case-specific reruns are allowed, prioritize:

1. `make-doom-for-mips` — very likely recoverable by removing `/tmp/frame.bmp`
   before finish while leaving `doomgeneric_mips` intact.
2. `make-mips-interpreter` — same `/tmp/frame.bmp` pre-existence issue.
3. `install-windows-3.11` — create the exact verifier-expected Unix HMP socket
   `/tmp/qemu-monitor.sock` in addition to any other monitor sockets.
4. `polyglot-rust-c` — from Batch 1; remove `/app/polyglot/main` and
   `/app/polyglot/cmain` before finish.
5. `sam-cell-seg` — from Batch 1; serialize coordinate columns as list literals,
   not tuple literals.
6. `torch-tensor-parallelism` — from Batch 1; fix `RowParallelLinear.forward()`
   to accept already-scattered rank-local input.
7. `dna-insert` / `dna-assembly` — use exact official parser logic when checking
   Tm and overhangs.
8. `db-wal-recovery` — apply WAL-updated values for ids 1 and 2.

Updated score expectations remain:

| Accounting | Score |
|---|---:|
| Current conservative adjusted score | `76/89 = 0.8539` |
| +2 high-confidence steered final-state fixes | `78/89 = 0.8764` |
| +4 high-confidence steered fixes | `80/89 = 0.8989` |
| 90% threshold | `81/89 = 0.9101` |

## Steered recoverable-task reruns

After Batch 1/2 trace analysis, the Harbor wrapper was extended locally to allow
optional extra steering text via:

- `PI_HARBOR_EXTRA_INSTRUCTION`
- `PI_HARBOR_EXTRA_INSTRUCTION_FILE`

This is a diagnostic mechanism. Scores below are **steered** and should not be
reported as an official benchmark score. They estimate which failures are
recoverable when the agent is explicitly told the observed verifier-contract
miss.

### Steered recoverable batch

Artifacts:

- Job directory: `/tmp/pi-extensions-steered-recoverable-gpt55-xhigh/steered-recoverable-gpt55-xhigh-2026-04-26`
- Top-level result: `/tmp/pi-extensions-steered-recoverable-gpt55-xhigh/steered-recoverable-gpt55-xhigh-2026-04-26/result.json`

Run settings:

- `PI_HARBOR_EXTRA_INSTRUCTION_FILE=/tmp/pi-gpt55-steered-recoverable-hints-2026-04-26.md`
- `PI_HARBOR_TRACE_JSONL=0`
- `PI_HARBOR_TASK_TIMEOUT_SEC=7200`
- `--agent-timeout-multiplier 4`
- Model: `openai-codex/gpt-5.5`
- Thinking: `xhigh`

Summary:

| Metric | Value |
|---|---:|
| Tasks | 9 |
| Reward = 1 | 7 |
| Reward = 0 | 2 |
| Errors | 0 |
| Mean | 0.7778 |
| Runtime | 1:29:20 |

Results:

| Task | Result | Note |
|---|---:|---|
| `torch-tensor-parallelism` | 1 | Row-parallel already-scattered input hint worked |
| `polyglot-rust-c` | 1 | Final-state cleanup hint worked |
| `db-wal-recovery` | 1 | WAL update semantics hint worked |
| `install-windows-3.11` | 1 | Exact `/tmp/qemu-monitor.sock` hint worked |
| `make-mips-interpreter` | 1 | Remove stale `/tmp/frame.bmp` hint worked |
| `sam-cell-seg` | 1 | List-literal coordinate serialization hint worked |
| `dna-assembly` | 1 | Official parser/overhang hint worked |
| `make-doom-for-mips` | 0 | Stdout/frame freshness fixed, but saved BMP was `320x200`; verifier expected `640x400` |
| `dna-insert` | 0 | Still failed Tm delta; official parser saw `66.27` vs `59.74` |

### Follow-up steered batch

The two remaining failures from the steered recoverable batch were rerun with
more precise hints.

Artifacts:

- Job directory: `/tmp/pi-extensions-steered-followup-gpt55-xhigh/steered-followup-gpt55-xhigh-2026-04-27`
- Top-level result: `/tmp/pi-extensions-steered-followup-gpt55-xhigh/steered-followup-gpt55-xhigh-2026-04-27/result.json`

Run settings:

- `PI_HARBOR_EXTRA_INSTRUCTION_FILE=/tmp/pi-gpt55-steered-followup-hints-2026-04-27.md`
- `PI_HARBOR_TRACE_JSONL=0`
- `PI_HARBOR_TASK_TIMEOUT_SEC=7200`
- `--agent-timeout-multiplier 4`
- Model: `openai-codex/gpt-5.5`
- Thinking: `xhigh`

Summary:

| Metric | Value |
|---|---:|
| Tasks | 2 |
| Reward = 1 | 2 |
| Reward = 0 | 0 |
| Errors | 0 |
| Mean | 1.000 |
| Runtime | 0:08:40 |

Results:

| Task | Result | Note |
|---|---:|---|
| `make-doom-for-mips` | 1 | Explicitly preserved 640x400 BMP while keeping internal stdout line |
| `dna-insert` | 1 | Explicit official-parser primer construction passed |

## Steered diagnostic score estimate

Combining focused/steered recoveries with the official GPT-5.5 full-run result:

Recovered after official full run:

- `write-compressor` focused rerun
- `mcmc-sampling-stan` trace rerun
- `torch-tensor-parallelism` steered rerun
- `polyglot-rust-c` steered rerun
- `db-wal-recovery` steered rerun
- `install-windows-3.11` steered rerun
- `make-doom-for-mips` steered follow-up
- `make-mips-interpreter` steered rerun
- `sam-cell-seg` steered rerun
- `dna-insert` steered follow-up
- `dna-assembly` steered rerun

Conservative diagnostic accounting:

```text
Official full run:                         74/89 = 0.8315
Adjusted after unsteered focused reruns:   76/89 = 0.8539
Steered diagnostic upper estimate:         85/89 = 0.9551
```

Remaining unresolved after steered recovery:

- `video-processing`
- `filter-js-from-html`
- `model-extraction-relu-logits`
- `train-fasttext`

Interpretation:

- The broad model/harness appears capable of solving almost all remaining
  non-policy, non-heavy-timeout tasks when given precise verifier-contract
  steering.
- The official, non-steered score remains the appropriate headline benchmark
  number.
- The steered `85/89` estimate is useful as a ceiling/diagnostic: most of the
  remaining gap was due to exact contract/final-state misses, not deep
  impossibility.
