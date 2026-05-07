# Auto-Mode V2 Plan

## Goal

`extensions/auto-mode/` now favors a **pragmatic default**:

- one controller decision per worker turn in the default path
- short worker/controller prompts
- only hard runtime stop gates
- no audit-style stop override prompts by default

This document describes the V2 target architecture that replaced the more layered V1 flow documented in `docs/auto-mode-v1-plan.md`.

## Product modes

### `pragmatic` (default)

Use a single controller decision plus deterministic runtime checks.

Stop is blocked only when one of these hard blockers is present:

- primary goal not yet `met`
- completion gate not yet met
- configured verify command is still failing
- commit is still required
- push is still required
- branch is not synchronized with upstream

Notably, V2 no longer blocks stop just because the assistant phrased verification evidence too vaguely.

### `strict`

Strict mode is explicit opt-in and requires `--verify` / `--auto-verify`.

The runtime still uses the same single-controller architecture, but stop depends on the verify command passing.

## Architecture

## Worker

The worker is still the normal pi assistant.

Before each worker turn, auto-mode appends a short worker prompt suffix with:

- the active goal
- the verification rule
- commit policy
- push policy

The completion gate remains controller-only.

## Controller

The controller is a single extension-internal model call that returns one of:

- `continue`
- `stop`
- `pause`

The controller prompt is intentionally short and does not include separate sub-prompts for:

- stop override refinement
- repeated-continue refinement
- adjacent continuation
- controller probes

## Runtime flow

### `session_start`

1. restore any persisted auto-mode state
2. migrate legacy V1 state to V2 if needed
3. restore in paused mode by default
4. optionally auto-resume on startup when `--auto-resume` is set
5. optionally start a fresh run from CLI flags (`--auto-goal`, ...)

Legacy V1 states are restored under V2 semantics and emit migration warnings.

### `before_agent_start`

When auto-mode is active and not paused:

- append the worker prompt suffix

### `agent_end`

When auto-mode is active and not paused:

1. capture the latest assistant text and stop reason
2. capture a git snapshot
3. run the configured verify command near stop when applicable
4. call the controller exactly once
5. apply the result:
   - `continue` → send one transparent follow-up prompt
   - `pause` → pause the run
   - `stop` → apply hard stop gates
     - if allowed → stop the run
     - if blocked → send one short deterministic follow-up or pause at the budget boundary

## Hard runtime stop gates

The runtime evaluates:

- `goalStatus`
- `completionGateMet`
- verify command success, when configured
- git cleanliness when commit policy requires finalization
- upstream sync when push policy requires it

Blocked stops produce deterministic short prompts such as:

- `Run npm test until it passes, then report the exact passing result.`
- `Create the final atomic commit and confirm the working tree is clean.`
- `Bring the current branch back in sync with upstream before stopping.`

## Safety rules

- default iteration budget: 8
- until-only safety budget: 12
- controller failures in a row: 2 → pause
- worker failures in a row: 2 → pause
- repeated equivalent continue prompts: 3 → pause
- unchanged repository fingerprint across iterations: 3 → pause

## Repository fingerprint

The no-change detector fingerprints repository state from:

- `git status --short --branch`
- `git diff --no-ext-diff --no-color HEAD --`
- untracked files from `git ls-files --others --exclude-standard -z`

Untracked files use bounded fallback tiers so large generated directories do not make every auto-mode iteration expensive:

| Untracked set | Fingerprint detail | Tradeoff |
|---|---|---|
| >2000 files | path-list only | content/metadata-only edits can be missed |
| ≤100 regular files, ≤5 MiB total, ≤32k path chars | content hashes via `git hash-object --no-filters` | most precise |
| remaining cases, such as 101-2000 files, >5 MiB total, too many path chars, or any symlink | path + size + mtime metadata | same-size/same-mtime content edits can be missed |

These tiers only affect the no-change pause heuristic. Stop/finalization guards still inspect the actual git status and do not rely on this fingerprint alone.

## Deprecated V1 behavior

The following V1 features are deprecated in V2 and ignored in the default runtime path:

- completion-policy / adjacent continuation
- controller probes
- worker reflection

The corresponding CLI flags and slash-command flags are still accepted for compatibility, but V2 warns and ignores them.

## Migration behavior

When V2 restores a persisted V1 state:

- the state is migrated to a V2 snapshot
- `assuranceMode` defaults to `pragmatic`
- migration warnings are attached to the snapshot
- restore is forced into paused mode so the user can resume explicitly

## Prompt files

`extensions/auto-mode/system-prompt.template.md` now contains only two sections:

- `worker`
- `controller`

This keeps prompt tuning simple and avoids multiple special-case controller prompt variants.
