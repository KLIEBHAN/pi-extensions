# Auto-Mode V1 Implementation Sketch

## Goal

`extensions/auto-mode/` adds an autonomous controller loop for pi.

- The **worker** is the normal main assistant and keeps the full normal session context.
- The **controller** is a separate extension-internal model call with a compact rolling summary.
- After each completed worker run, the controller decides whether to continue, stop, pause, or request one limited read-only probe.

## File layout

```text
extensions/auto-mode/
├── core.ts   # pure helpers, types, parsers, controller decision parsing
└── index.ts  # runtime extension, commands, flags, event handlers, controller loop

test/
└── auto-mode-core.test.ts
```

## `core.ts`

Responsibilities:

- export the V1 state/config interfaces
- parse `/auto ...` command arguments
- parse CLI flag values into `AutoStartConfig`
- parse controller JSON decisions
- provide compact conversation summarization helpers
- provide small normalization/truncation helpers

Important interfaces:

- `AutoStartConfig`
- `AutoModeStateV1`
- `ControllerDecision`
- `ContinueDecision`
- `StopDecision`
- `PauseDecision`
- `ProbeDecision`

Important pure functions:

- `parseAutoCommandArgs(args)`
- `buildAutoStartConfigFromFlags(flags)`
- `parseControllerDecision(raw)`
- `buildRecentConversationContext(branch)`
- `buildLatestUserMessageContext(branch)`
- `buildLatestAssistantMessageContext(branch)`
- `appendDecisionHistory(history, entry)`
- `truncateControllerSummary(summary)`

## `index.ts`

Responsibilities:

- register flags and `/auto` command
- restore/persist auto-mode state
- inject worker system-prompt suffix in `before_agent_start`
- react to `agent_end` and run the controller loop
- execute limited read-only probes when the controller asks for them
- enforce stop/safety rules
- send transparent follow-up prompts via `pi.sendUserMessage(...)`

Runtime-only structures:

- `GitSnapshot`
- `VerifyCommandResult`
- `ProbeResult`
- `WorkerTurnSnapshot`
- `AutoRuntimeState`

## Event flow

### `session_start`

1. restore last persisted `auto-mode-state`
2. restore as paused by default
3. optionally auto-resume on startup when `--auto-resume` is set (and immediately kick off a resume prompt)
4. optionally start a fresh run from CLI flags (`--auto-goal`, ...)

### `before_agent_start`

When auto-mode is active and not paused:

- append a short worker system-prompt suffix with
  - goal
  - verification requirement / verify command
  - commit/push policy
  - autonomy rules

The optional `--until` completion gate stays controller-only.

### `agent_end`

When auto-mode is active and not paused:

1. capture latest assistant text and stop reason
2. capture git snapshot
3. when the worker looks close to done and a verify command is configured, run a pre-stop verification check
4. update no-change / stagnation counters
5. call the controller with compact context
6. if the controller requests a probe, run one limited read-only probe and call the controller once more
7. apply decision:
   - `continue` → send next user message
   - `pause` → pause run
   - `stop` → verify/finalize and stop, or request one final worker pass

## `/auto` command surface

- `/auto on [flags] <goal>`
- `/auto status`
- `/auto summary`
- `/auto pause`
- `/auto resume`
- `/auto off`
- `/auto nudge <instruction>`

## Controller JSON shape

```json
{
  "action": "continue|stop|pause|probe",
  "reason": "...",
  "updatedSummary": "...",
  "goalStatus": "in_progress|likely_met|met|blocked|stalled",
  "completionGateMet": false,
  "progressPercent": 62,
  "commitRecommendation": "none|milestone|finalize",
  "nextPrompt": "...",
  "finalMessage": "...",
  "probe": { "kind": "git_status|git_diff_names|git_head|verify_command" }
}
```

## Safety rules in V1

- default iteration budget: 8
- until-only safety budget: 12
- wall-clock limit: 60 minutes
- proactive verify-command preflight when the worker appears to claim completion or iteration budget is exhausted
- controller failures in a row: 2 → pause
- worker failures in a row: 2 → pause
- repeated identical next prompts: 3 → pause
- unchanged git snapshot across iterations: 3 → pause
- max probes per controller cycle: 1

## Transparent follow-up behavior

The controller does **not** inject hidden worker instructions as custom messages.

Instead, when it chooses `continue`, the extension sends a real follow-up user message with `pi.sendUserMessage(...)`, so the autonomous steps remain visible in the session transcript.
