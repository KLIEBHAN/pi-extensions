# Terminal-Bench Full Benchmark GPT-5.5 xhigh timeout x4 (2026-04-26)

## Scope

This document records the full Terminal-Bench 2.0 run for `gpt-5.5` with
`xhigh` reasoning and `--agent-timeout-multiplier 4`, plus focused reruns of
`write-compressor` and `train-fasttext`.

## Code state and run settings

- `pi-extensions`: commit `34402e4` on `main`
- `pi-mono`: commit `e441cd82` on `feat/terminal-bench-optimizations`
- Model: `openai-codex/gpt-5.5`
- Thinking: `xhigh`
- Harbor environment: `docker`
- Attempts: `1`
- Concurrency: `1`
- Source mode: local `pi-mono` checkout inside container
- Harbor option: `--agent-timeout-multiplier 4`
- Wrapper pi execution timeout for the full run: `PI_HARBOR_TASK_TIMEOUT_SEC=3600`
- Trace capture: disabled (`PI_HARBOR_TRACE_JSONL=0`)

Full run artifacts:

- Job directory: `/tmp/pi-extensions-full-gpt55-xhigh-timeout4/full-gpt55-xhigh-timeout4-2026-04-24`
- Top-level result: `/tmp/pi-extensions-full-gpt55-xhigh-timeout4/full-gpt55-xhigh-timeout4-2026-04-24/result.json`
- Log: `/tmp/pi-extensions-full-gpt55-xhigh-timeout4.log`

Runtime:

- Wall-clock: `14:53:35`

## Full run summary

| Metric | Value |
|---|---:|
| Total tasks | 89 |
| Reward = 1 | 74 |
| Reward = 0 | 14 |
| Pure errors without reward result | 1 |
| Mean reward | 0.8315 |
| Reported `n_errors` | 1 |

Pure error:

- `train-fasttext` — `RuntimeError: Command timed out after 3600 seconds`

Reward-zero tasks:

- `write-compressor`
- `torch-tensor-parallelism`
- `polyglot-rust-c`
- `db-wal-recovery`
- `video-processing`
- `install-windows-3.11`
- `make-doom-for-mips`
- `make-mips-interpreter`
- `mcmc-sampling-stan`
- `filter-js-from-html`
- `sam-cell-seg`
- `model-extraction-relu-logits`
- `dna-insert`
- `dna-assembly`

Notable full-run observations:

- `configure-git-webserver` passed in this run.
- `adaptive-rejection-sampler` passed in this run.
- `caffe-cifar-10` passed in this run.
- `gpt2-codegolf` passed in this run.
- `mteb-retrieve` passed in this run.
- `write-compressor` looked like verifier/network infrastructure rather than a
  clean agent failure: the verifier failed while downloading `uv` due to an HTTP
  `502`, then `uvx` was unavailable.

## Focused reruns

Focused rerun artifacts:

- Job directory: `/tmp/pi-extensions-rerun-write-train-gpt55-xhigh-timeout7200/rerun-write-train-gpt55-xhigh-timeout7200-2026-04-26`
- Top-level result: `/tmp/pi-extensions-rerun-write-train-gpt55-xhigh-timeout7200/rerun-write-train-gpt55-xhigh-timeout7200-2026-04-26/result.json`

Focused rerun settings:

- Same model/setup as full run
- `PI_HARBOR_TASK_TIMEOUT_SEC=7200`
- `--agent-timeout-multiplier 4`
- Included tasks: `write-compressor`, `train-fasttext`

Focused rerun summary:

| Task | Full run outcome | Focused rerun outcome | Interpretation |
|---|---|---|---|
| `write-compressor` | reward=0 due to verifier `uv` download HTTP 502 | reward=1 | Full-run failure was likely verifier/network infrastructure noise |
| `train-fasttext` | pure `RuntimeError`, command timed out after 3600s | pure `RuntimeError`, command timed out after 7200s | Still unresolved heavy timeout/stall |

`write-compressor` focused rerun verifier passed all checks:

- `/app/data.comp` existed
- compressed size was `2274` bytes
- `cat data.comp | /app/decomp | cmp - data.txt` succeeded

`train-fasttext` focused rerun still produced no reward result and timed out at
7200 seconds.

## Updated score estimate

The official full-run result remains:

| Accounting | Reward |
|---|---:|
| Official full run | `74/89 = 0.8315` |

If we substitute the focused `write-compressor` rerun for the full-run verifier
network failure while leaving `train-fasttext` as an error/failure, the adjusted
estimate is:

| Accounting | Reward |
|---|---:|
| Adjusted for `write-compressor` verifier/network rerun | `75/89 = 0.8427` |

If considering only reward-producing trials after the `write-compressor` fix and
excluding the unresolved `train-fasttext` pure error, the reward-producing-trial
rate is:

| Accounting | Reward |
|---|---:|
| Reward-producing trials only | `75/88 = 0.8523` |

For headline comparisons against the previous GPT-5.4 full-run note, prefer the
conservative adjusted estimate including `train-fasttext` as a miss:

```text
GPT-5.4 xhigh full run:              61/89 = 0.6854
GPT-5.5 xhigh timeout x4 official:   74/89 = 0.8315
GPT-5.5 xhigh timeout x4 adjusted:   75/89 = 0.8427
```

## Interpretation

`gpt-5.5`/`xhigh` with the current pi Terminal-Bench harness and timeout x4 is a
substantial improvement over the earlier `gpt-5.4`/`xhigh` run. The conservative
adjusted score is about 84.3%, or +14 solved tasks over the prior GPT-5.4 full
run.

The remaining failures are mostly long-tail, task-specific semantic or systems
problems rather than broad harness/prompt misses. `train-fasttext` remains a
heavy timeout case even with a 7200-second in-container pi timeout.
