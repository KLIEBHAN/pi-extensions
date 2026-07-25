# pi-extensions

Reusable [pi](https://github.com/badlogic/pi-mono) extensions and themes collected in a standalone GitHub repository.

The repository is also a valid pi package, so you can either load individual extensions directly with `-e` or install the whole repository via `pi install` to make bundled extensions and themes available.

## Quick start

Load an individual extension from the repository:

```bash
pi -e ./extensions/hello.ts
pi -e ./extensions/notify.ts
pi -e ./extensions/copy-prompt.ts
pi -e ./extensions/permission-gate.ts
pi -e ./extensions/auto-mode --auto-goal "improve onboarding robustness"
pi -e ./extensions/prompt-autocomplete --prompt-autocomplete
pi -e ./extensions/review-cycle
pi -e ./extensions/ralphy-loop
pi -e ./extensions/session-name.ts
pi -e ./extensions/terminal-bench.ts --terminal-bench
```

Install the repository as a pi package:

```bash
pi install ../pi-extensions
pi install git:github.com/KLIEBHAN/pi-extensions
```

After package installation, extensions are auto-discovered by pi. The `copy-prompt` extension stays passive until `Alt+C` or `Ctrl+Alt+C` is pressed. On macOS it also handles the common default-terminal `Option+C` composed-character fallback when Option is not configured as Meta. The `terminal-bench` extension only activates when its flag is passed. The `prompt-autocomplete` extension is disabled by default and can be enabled explicitly with `--prompt-autocomplete` or `/prompt-autocomplete on`.

The bundled themes are also available after installation. Select `hermes-dark` in `/settings` or set it in `~/.pi/agent/settings.json`:

```json
{
  "theme": "hermes-dark"
}
```

## Permanently enable an extension via the user folder

For a globally enabled extension, copy the directory into pi's user extension folder:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R ./extensions/ralphy-loop ~/.pi/agent/extensions/
```

Or symlink it during development:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/extensions/ralphy-loop" ~/.pi/agent/extensions/ralphy-loop
```

Then start pi normally:

```bash
pi
```

If pi is already running, reload extensions without restarting:

```text
/reload
```

To enable all extensions from this repository globally, prefer package installation:

```bash
pi install ../pi-extensions
```

Project-local alternative:

```bash
mkdir -p .pi/extensions
cp -R ./extensions/ralphy-loop .pi/extensions/
```

Use `~/.pi/agent/extensions/` for all projects and `.pi/extensions/` for the current project only.

## Included extensions

| Extension | Purpose | Example |
|---|---|---|
| `hello.ts` | Minimal custom tool example | `pi -e ./extensions/hello.ts` |
| `notify.ts` | Adds `/notify` for lightweight in-app notifications | `/notify build finished` |
| `copy-prompt.ts` | Adds `Alt+C` / `Ctrl+Alt+C` to copy the current prompt draft to the system clipboard, including a macOS `Option+C` fallback | `pi -e ./extensions/copy-prompt.ts` |
| `permission-gate.ts` | Asks for confirmation before dangerous bash commands | `pi -e ./extensions/permission-gate.ts` |
| `auto-mode/` | Controller-driven autonomous improvement loop that keeps iterating with transparent follow-up prompts | `/auto on --iterations 8 improve onboarding robustness` |
| `prompt-autocomplete/` | Copilot/Cursor-style inline AI autocomplete for the prompt editor with Tab accept and Escape dismiss | `pi -e ./extensions/prompt-autocomplete --prompt-autocomplete` |
| `review-cycle/` | Runs implement → fresh-context code review → apply-review feedback as a managed workflow | `/review-cycle add input validation` |
| `ralphy-loop/` | Repeats the same task with autonomous prompts, AI completion verification, and per-iteration context pruning | `/ralphy-loop 5 harden edge cases` |
| `session-name.ts` | Adds `/session-name <name>` to label the current session | `/session-name auth-refactor` |
| `terminal-bench.ts` | Migrated from `feat/terminal-bench-optimizations`; adds Terminal-Bench prompt rules, tmux tools, environment bootstrapping, and completion verification | `pi -e ./extensions/terminal-bench.ts --terminal-bench` |

## Included themes

| Theme | Purpose | Activation |
|---|---|---|
| `hermes-dark` | Dark Hermes-inspired theme with navy background, gold accents, warm bronze borders, and cream text. | Select `hermes-dark` in `/settings` or set `"theme": "hermes-dark"` in `~/.pi/agent/settings.json`. |

For the closest visual match to the Hermes Agent look, set your terminal background to approximately `#1e1e2d`.

If you want to use the theme without installing this repository as a package, copy it into pi's global theme folder:

```bash
mkdir -p ~/.pi/agent/themes
cp ./themes/hermes-dark.json ~/.pi/agent/themes/hermes-dark.json
```

## Auto-mode extension

`extensions/auto-mode/` adds an autonomous controller loop on top of the normal pi worker.

### V2 design

Auto-mode now defaults to a **pragmatic** controller flow:

- exactly **one** controller model call per worker turn in the default path
- hard runtime stop gates for:
  - unmet goal / unmet completion gate
  - failing configured verify command
  - required git finalization (commit / push / sync)
- no audit-style stop override prompts by default
- no controller probes, adjacent-continuation flow, or worker-reflection flow in the V2 default path
- transparent follow-up prompts via real user messages, so autonomous iterations stay visible in the transcript
- rolling controller summary with restore-on-start behavior (restored paused by default, or auto-resumed on startup when `--auto-resume` is set)
- the internal worker/controller system prompts live in `extensions/auto-mode/system-prompt.template.md` as named template sections, so prompt tuning stays decoupled from TypeScript
- `--until` is evaluated by the controller only; if the worker should explicitly optimize for that criterion, include it directly in the goal/prompt itself

### Commands

- `/auto on <goal>`
- `/auto status`
- `/auto summary`
- `/auto pause`
- `/auto resume`
- `/auto off`
- `/auto nudge <instruction>`

### Main options

- `--iterations <n>`: iteration budget
- `--until "..."`: controller-only completion gate
- `--controller-model provider/model`: optional dedicated controller model
- `--verify "..."`: optional verification command used near stop; required when `--assurance strict` is selected
- `--assurance pragmatic|strict`: choose between the default pragmatic behavior and an explicit stricter mode

### Usage

Directly from this repository:

```bash
pi -e ./extensions/auto-mode --auto-goal "improve onboarding robustness"
```

Inside pi:

```text
/auto on --iterations 8 improve onboarding robustness
/auto on --until "Stop when onboarding is robust and tests are green" improve onboarding robustness
/auto on --assurance strict --verify "npm test" improve onboarding robustness
/auto status
/auto pause
/auto resume
/auto off
```

Optional dedicated controller model, completion gate, and verify command:

```bash
pi -e ./extensions/auto-mode \
  --auto-goal "improve onboarding robustness" \
  --auto-until "Stop when onboarding is robust and tests are green" \
  --auto-assurance strict \
  --auto-controller-model openai/gpt-5.4-mini \
  --auto-verify "npm test"
```

### Repository fingerprint and untracked files

Auto-mode uses a repository fingerprint to detect no-change loops and pauses after repeated unchanged iterations. The fingerprint includes bounded `git status` data plus tiered tracked/untracked file fingerprints instead of materializing the full diff into memory each turn.

- more than 2000 changed/untracked files: use path-list digest only
- otherwise, up to 100 regular files, up to 5 MiB total, and up to 32k path characters: hash file contents with `git hash-object`
- remaining cases, such as 101-2000 files, more than 5 MiB total, too many path characters, deleted files, or symlinks: use path + size + mtime metadata

The fallback tiers intentionally trade precision for performance. In metadata mode, same-size/same-mtime content edits may be missed. In path-only mode, content and metadata edits may be missed until paths change. These fallbacks only affect the no-change pause heuristic; git finalization gates still use the actual git status.

### Deprecated V1 options

The following V1 options are still accepted for compatibility, but auto-mode V2 warns and ignores them:

- `--completion-policy` / `--auto-completion-policy`
- `--max-adjacent-continuations` / `--auto-max-adjacent-continuations`
- `--no-controller-probes` / `--auto-allow-controller-probes`
- `--worker-reflection` / `--auto-worker-reflection`

### Prompt tuning

If you want to tune the internal auto-mode prompts, edit `extensions/auto-mode/system-prompt.template.md`.

- `worker` is the worker-visible system-prompt section and is rendered with `{{VERIFY_RULE}}`, `{{COMMIT_POLICY}}`, `{{PUSH_POLICY}}`, and `{{GOAL}}`
- `controller` is the controller-visible system-prompt section used for `continue|stop|pause` decisions

## Prompt autocomplete extension

`extensions/prompt-autocomplete/` adds inline AI autocomplete while you type your next prompt. It is also packaged independently as [`@kliebhan/pi-prompt-autocomplete`](extensions/prompt-autocomplete/README.md), so users can install it without loading the rest of this collection.

[Watch the Prompt Autocomplete demo](https://github.com/KLIEBHAN/pi-extensions/releases/download/pi-prompt-autocomplete-v0.1.2/prompt-autocomplete-demo.mp4)

```bash
pi install npm:@kliebhan/pi-prompt-autocomplete
```

### What it adds

- ghost-text style prompt suggestions directly in the editor after explicit enablement and at least one non-whitespace draft character by default
- shows 3 alternatives by default, with configurable limit via flag
- `Tab` accepts the whole current suggestion
- `Ctrl+Space` accepts the next word/chunk from the current suggestion
- `Ctrl+,` and `Ctrl+.` cycle through alternative suggestions; when there is nothing to cycle, `Ctrl+.` forces a one-shot suggestion (even while the agent is working and while-streaming is off)
- legacy fallbacks remain supported when your terminal forwards them: `Ctrl+Tab`, `Alt+[`, `Alt+]`
- `Escape` dismisses the current suggestion for the current draft
- repeated acceptance can keep extending the prompt step by step
- defaults to the current active model for autocomplete
- optional dedicated autocomplete model via `--prompt-autocomplete-model provider/model`
- configurable alternative count via `--prompt-autocomplete-max-alternatives <1-5>`
- clean default UI: debug/status lines stay hidden unless you opt into debug mode
- the internal autocomplete system prompt lives in `extensions/prompt-autocomplete/system-prompt.template.md` and is rendered through a tiny mini-template helper with `{{PLACEHOLDER}}`, `{{PLACEHOLDER|fallback}}`, and escaped literals via `\{{PLACEHOLDER}}`, so prompt tuning stays decoupled from TypeScript while still allowing reusable prompt fragments
- can be auto-loaded from `~/.pi/agent/extensions/` and is controllable per session via `/prompt-autocomplete on|off|toggle` and `/prompt-autocomplete while-streaming on|off|toggle`

### Usage

Directly from this repository:

```bash
pi -e ./extensions/prompt-autocomplete --prompt-autocomplete
```

After package installation:

```bash
pi --prompt-autocomplete
```

Or enable it for the current session from inside pi:

```text
/prompt-autocomplete on
/prompt-autocomplete status
/prompt-autocomplete while-streaming on
/prompt-autocomplete while-streaming toggle
/prompt-autocomplete debug-on
/prompt-autocomplete debug-off
/prompt-autocomplete off
```

Optional dedicated fast model:

```bash
pi -e ./extensions/prompt-autocomplete \
  --prompt-autocomplete \
  --prompt-autocomplete-model openai/gpt-5.4-mini \
  --prompt-autocomplete-max-alternatives 3
```

### Privacy and provider usage

Prompt autocomplete makes additional model requests. Each request can include the current draft, the latest user and assistant messages, and a bounded recent-conversation summary. By default it uses the active model; `--prompt-autocomplete-model provider/model` may send that context to a different provider. Requests may incur token costs and consume provider rate limits. Successful results are cached in memory for up to 60 seconds and are cleared when the session resets or the extension is disabled.

The extension is disabled by default. Enabling it with the CLI flag or slash command is explicit consent to these autocomplete requests. Automatic empty-draft requests remain disabled by the default `--prompt-autocomplete-min-chars 1`; set the value to `0` to opt into them. A manual `Ctrl+.` one-shot is treated as explicit intent and can bypass the minimum-character gate.

### Notes

- The extension suggests when the cursor is at the end of a draft that meets `--prompt-autocomplete-min-chars` (default: `1`). Set it to `0` to opt into automatic empty-draft next-prompt suggestions.
- Built-in slash-command and file/path autocomplete keep working.
- By default it pauses while the main agent is streaming so it can use the finished conversation context. Override at startup with `--prompt-autocomplete-while-streaming`, or toggle it per session with `/prompt-autocomplete while-streaming on|off|toggle`.
- Even while-streaming is off, press `Ctrl+.` with no active suggestion to force a single one-shot completion during an agent turn; it ignores the streaming gate, the post-error cooldown, and the min-chars threshold for that one request (model/auth and slash/path checks still apply).
- Terminal-friendly defaults are `Ctrl+Space` for word/chunk accept and `Ctrl+,` / `Ctrl+.` for cycling (and `Ctrl+.` doubles as the one-shot trigger).
- The default suggestion count is 3. Adjust it with `--prompt-autocomplete-max-alternatives <1-5>` if you want fewer or more.
- Legacy `Ctrl+Tab` and `Alt+[` / `Alt+]` remain supported as fallbacks when your terminal forwards them.
- Prompt autocomplete requires exclusive ownership of Pi's custom editor slot. If another custom editor is already active, it refuses to replace it and reports a warning; disabling autocomplete never removes a later replacement editor.
- For troubleshooting, start with `--prompt-autocomplete-debug` or run `/prompt-autocomplete debug-on` temporarily.
- If you want to tune the internal autocomplete prompt, edit `extensions/prompt-autocomplete/system-prompt.template.md`; `{{PLACEHOLDER}}` variables are filled in by `extensions/prompt-autocomplete/core.ts`, `{{PLACEHOLDER|fallback}}` uses the fallback text when no variable is provided, and `\{{PLACEHOLDER}}` keeps the placeholder syntax literal.

## Review-cycle extension

`extensions/review-cycle/` adds a managed implement-review-apply workflow.

### What it adds

- `/review-cycle <task>` or short alias `/rc <task>` starts a normal implementation request in the current agent. If another review-cycle run is active, the extension stops that run automatically and starts the new one; replacement runs allow the current dirty workspace at start so no manual stop/continue step is needed.
- Optional start flags: `--manual-apply`, `--until-approved`, `--max-review-rounds <n>`, and `--allow-dirty`.
- After the implementation turn finishes, the extension spawns a separate `pi --mode json -p --no-session` reviewer process, so the reviewer has a fresh context window.
- The reviewer receives the original task, the implementation summary, the baseline git commit/status, and current diff/status data. It can also inspect the workspace with read-only tools.
- The reviewer subprocess is technically guarded: `read`, `grep`, `find`, `ls`, and `bash` are available, but `bash` only permits read-only git inspection commands such as `git status`, `git diff`, `git show`, `git log`, `git blame`, and `git ls-files`, plus common test commands such as `npm test`, `pnpm test`, `yarn test`, `bun test`, `pytest`, `cargo test`, and `go test`.
- Mutating tools, arbitrary shell execution, unsafe shell/git arguments, and unknown/custom tools are blocked in the reviewer subprocess. Auto-discovered extensions are disabled for that subprocess; only the guard extension is loaded.
- The main status-card widget is hidden by default to keep the workspace quiet; use `/review-cycle status-card on|off|toggle` or repo config `statusCardVisible` to show/hide it. The toggle is persisted in `.pi/review-cycle/preferences.json` (ignored by git), and when shown it contains phase, elapsed time, task, worker/reviewer model, test policy, git baseline, mode, verdict/findings, artifact path, and the next suggested action. The extension deliberately keeps the footer free of duplicate review-cycle status.
- `/review-cycle panel` opens an action-focused overlay for contextual actions such as continue, apply, skip, retry, status-card toggle, output toggle, artifact, and stop. Because the status card is hidden by default, the panel also includes concise run details while hidden and avoids duplicating them when the card is visible. Shortcuts include arrow keys, `j`/`k`, Home/End, Enter, and number keys `1`-`9`; recommended actions are marked with `★`.
- Reviewer text, tool calls, and tool results stream into a live widget while the review runs; use `/review-cycle output off|on|toggle` to hide or show it. Visibility is persisted in `.pi/review-cycle/preferences.json`; after a review completes, the log auto-collapses to a compact summary until `/review-cycle output on` expands it.
- The status card includes the verdict, finding counts, next action, and a findings checklist. `APPROVE` ends the cycle without an apply pass; `APPROVE_WITH_NOTES` and `CHANGES_REQUESTED` either queue the apply pass or wait for `/review-cycle apply` in manual mode.
- The reviewer also returns a structured `## Review Data` JSON block with `schemaVersion: 1`, which the extension uses for robust checklist rendering; invalid structured data is surfaced and falls back to Markdown parsing. Reviews without a recognized `APPROVE`, `APPROVE_WITH_NOTES`, or `CHANGES_REQUESTED` verdict fail closed and can be retried. If the reviewer's final message has no text, the extension falls back to the streamed reviewer text before failing. When the reviewer subprocess still exits cleanly without any usable text, the failure message says so explicitly and includes reviewer diagnostics (`stopReason` and a short `stderr` tail); the failure artifact additionally embeds a `## Reviewer log (captured)` section with the streamed reviewer output and tool calls, plus the reviewer `stopReason` in its metadata JSON, so reasoning-only/length/provider issues are easy to spot without re-running. When the reviewer stops because of `length`, the failure message adds a targeted hint to use a dedicated `--reviewer-model` or reduce scope.
- Before launching the reviewer, the extension warns when the review scope is large (many changed files or a large reviewer prompt), since oversized diffs make empty/length reviewer failures more likely; consider a dedicated `--reviewer-model` or a smaller scope in that case.
- The review output is sent back to the original agent as a follow-up prompt so it can apply the feedback and run verification when needed.
- Review artifacts are written atomically to `.pi/review-cycle/latest.md` and `.pi/review-cycle/runs/<timestamp>-<run-id>.md`; use `/review-cycle artifact`, `/review-cycle artifact list`, `/review-cycle artifact show <n>`, or `/review-cycle artifact path [n]` to inspect recent runs. The panel promotes the latest artifact when available, and the inactive panel shows the previous run's verdict and artifact path. Generated artifact files are ignored by git.
- `/review-cycle rerun` reruns the fresh-context reviewer against the previous task and current workspace state.
- `/review-cycle retry` retries a failed reviewer subprocess without discarding the implementation state.
- `/review-cycle tests add <cmd>` and `/review-cycle tests set <cmd>` restrict reviewer test execution to configured exact commands and reject unsafe/non-test commands early; `/review-cycle tests clear` restores the default safe test allowlist.
- `/review-cycle prefs status` shows effective, session, persisted, and repo UI preference values; `/review-cycle prefs reset` deletes `.pi/review-cycle/preferences.json` and reverts UI preferences to repo/default values.
- `/review-cycle config doctor` diagnoses `.pi/review-cycle.json`, persisted UI preferences, unsafe test commands, invalid value shapes, unknown keys, and effective defaults.
- `/review-cycle status` shows a compact status notification with phase, elapsed time, reviewer, tests, task, status-card visibility, and reviewer-output state. Without an active run, it shows the effective repo/default configuration; `/review-cycle panel` opens the interactive action overlay; `/review-cycle output off|on|toggle` controls the live reviewer log; `/review-cycle stop` cancels the managed workflow and aborts an active reviewer subprocess. Reviewer subprocess shutdown escalates from `SIGTERM` to `SIGKILL` when a timed-out/aborted child does not exit.
- If the workspace is already dirty, the cycle pauses for `/review-cycle continue` or `/review-cycle abort` unless `--allow-dirty` or config `allowDirty` is set.
- `/review-cycle help` or `/rc help` shows all commands and examples in a help widget.
- Repo defaults can be stored in `.pi/review-cycle.json` with `reviewerModel`, `tests`, `manualApply`, `autoRerunAfterApply`, `maxReviewRounds`, `allowDirty`, `reviewerOutputVisible`, and `statusCardVisible`; unsafe configured test commands are ignored with a warning.
- Optional reviewer model selection via `--reviewer-model provider/model` or CLI flag `--review-cycle-reviewer-model provider/model`.

### Usage

Directly from this repository:

```bash
pi -e ./extensions/review-cycle
```

Then inside pi:

```text
/review-cycle add input validation to the login form
/rc add input validation to the login form
/review-cycle on --reviewer-model anthropic/claude-sonnet-4-5 harden auth error handling
/review-cycle --manual-apply review sensitive payment changes
/review-cycle --until-approved --max-review-rounds 3 harden auth edge cases
/review-cycle --allow-dirty include current workspace changes
/review-cycle help
/review-cycle status
/review-cycle status-card on
/review-cycle panel
/review-cycle output off
/review-cycle output on
/review-cycle prefs status
/review-cycle prefs reset
/review-cycle config doctor
/review-cycle tests set npm test
/review-cycle continue
/review-cycle apply
/review-cycle retry
/review-cycle rerun
/review-cycle artifact
/review-cycle artifact list
/review-cycle artifact show 1
/review-cycle artifact path
/review-cycle stop
```

Auto-start from CLI:

```bash
pi -e ./extensions/review-cycle \
  --review-cycle-task "add input validation to the login form"
```

Repo config example:

```json
{
  "reviewerModel": "anthropic/claude-sonnet-4-5",
  "tests": ["npm test", "npm run lint"],
  "manualApply": false,
  "autoRerunAfterApply": false,
  "maxReviewRounds": 2,
  "allowDirty": false,
  "reviewerOutputVisible": true,
  "statusCardVisible": false
}
```

Notes:

- For best change scoping, start from a clean git working tree. If the run starts dirty, the extension pauses for an explicit continue/abort decision unless dirty runs are allowed.
- If the implementation creates commits, the review still uses the baseline commit captured at start and reviews changes since that baseline.
- The reviewer is instructed not to modify files and the runtime also enforces this by disabling auto-discovered extensions and loading a guard extension into the reviewer subprocess.

## Ralphy loop extension

`extensions/ralphy-loop/` is inspired by the repeat loop in Ralphy, but implemented with pi extension APIs.

The main goal is brownfield-style repetition: run the same task multiple times while clearing prior iterations out of the model context so each pass starts fresh, verifies completion conservatively, and keeps working without user interaction until the task is actually done.

### What it adds

- `/ralphy-loop <repeat> <task>` to run the same task multiple times
- optional `/ralphy-loop --repeat <n> --continue-on-failure <task>` syntax
- `/ralphy-status` to inspect the active loop
- `/ralphy-stop` to stop the loop and abort the current run
- optional CLI auto-start flags:
  - `--ralphy-task "..."`
  - `--ralphy-repeat <n>`
  - `--ralphy-continue-on-failure`
  - `--ralphy-verifier-model <provider/model>` to run completion verification on a different model when desired
- autonomous system prompt that explicitly forbids user interaction and requires commit/push in git repos
- per-iteration context pruning via the `context` hook
- loop termination is based on the assistant finishing with `stopReason: error|aborted|length`; recoverable tool errors do not automatically stop the loop if the assistant still completes successfully
- deterministic git verification before an iteration is considered done:
  - working tree must be clean
  - an upstream branch must be configured
  - the local branch must be in sync with upstream
- AI completion verification after technically successful turns, with up to 3 automatic "keep working" nudges when completion is unclear or not yet confirmed
- lightweight automated tests for the parser and verifier helper logic (`npm run test`)

### Usage

Interactive command:

```bash
pi -e ./extensions/ralphy-loop
```

Then inside pi:

```text
/ralphy-loop 3 find and fix bugs
/ralphy-loop --repeat 5 --continue-on-failure harden edge cases
/ralphy-status
/ralphy-stop
```

Auto-start from CLI:

```bash
pi -e ./extensions/ralphy-loop \
  --ralphy-task "find and fix bugs" \
  --ralphy-repeat 3
```

Optional separate verifier model:

```bash
pi -e ./extensions/ralphy-loop \
  --ralphy-task "find and fix bugs" \
  --ralphy-repeat 3 \
  --ralphy-verifier-model openai/gpt-5.4
```

If you enabled `ralphy-loop` globally via `~/.pi/agent/extensions/` or `pi install`, do not also pass `-e ./extensions/ralphy-loop` in the same session, or pi will load it twice and flag/tool registration will conflict.

### How context reset works

This extension does **not** create a brand new pi session for every repeat.

Instead, it keeps one pi session and uses the `context` hook to filter the messages sent to the model on each new iteration.

Concretely:

- when an iteration starts, the extension records a new `iterationStartAt` timestamp
- before each provider request, it removes messages older than that timestamp from the LLM context
- the model therefore sees only the current iteration's messages, tool calls, and tool results

Today this boundary is timestamp-based because the extension `context` hook gets `AgentMessage[]` without stable per-iteration message ids. So this is the safest implementation available purely at extension level.

What still remains:

- the full session history is still stored locally and remains visible in pi
- file changes from earlier iterations remain on disk
- git state, working directory, active tools, model selection, and loaded extensions all remain unchanged

So the behavior is:

- **fresh model context per iteration**
- **same pi session and same workspace state across iterations**

That makes the loop safer and simpler than forcing session switches from extension events, while still avoiding accumulation of earlier iterations in the model context.

## Terminal-Bench extension

`extensions/terminal-bench.ts` is the most specialized extension in this repository.
Its system prompt lives next to it in `extensions/terminal-bench.system-prompt.template.md`.

It is intended for benchmark-style tasks where the agent should work autonomously, verify completion carefully, and handle interactive terminal programs through `tmux`.

### What it adds

- environment snapshot injection before the first real agent turn
- Terminal-Bench-specific system prompt rules
- `tmux_send` tool for sending keys to a dedicated `tmux` session
- `tmux_read` tool for reading current terminal state without sending input
- extra completion verification when the assistant claims it is done
- stricter bash output truncation to preserve context window budget

### Usage

Directly from this repository:

```bash
pi -e ./extensions/terminal-bench.ts --terminal-bench
```

With higher reasoning:

```bash
pi -e ./extensions/terminal-bench.ts --terminal-bench --thinking high
```

After package installation:

```bash
pi --terminal-bench
```

### Notes

- The extension does nothing unless `--terminal-bench` is provided.
- If you copy `terminal-bench.ts` manually, copy `terminal-bench.system-prompt.template.md` next to it.
- It creates and uses a dedicated `tmux` session for interactive terminal control.
- `tmux` should be installed and available on `PATH` if you want to use `tmux_send` and `tmux_read`.

## Harbor wrapper example

For Harbor-based Terminal-Bench runs, see `examples/harbor-wrapper/README.md`.

The wrapper uploads the bundled `extensions/terminal-bench.ts` file and its
prompt template into the sandbox automatically. By default it installs the published npm `pi` package,
and it can optionally run a local `pi-mono` checkout for unreleased testing.

## Repository structure

```text
pi-extensions/
├── examples/
│   └── harbor-wrapper/
│       ├── agent.py
│       └── README.md
├── extensions/
│   ├── auto-mode/
│   │   ├── core.ts
│   │   ├── index.ts
│   │   └── system-prompt.template.md
│   ├── hello.ts
│   ├── notify.ts
│   ├── copy-prompt.ts
│   ├── permission-gate.ts
│   ├── prompt-autocomplete/
│   │   ├── core.ts
│   │   ├── index.ts
│   │   └── system-prompt.template.md
│   ├── review-cycle/
│   │   ├── core.ts
│   │   └── index.ts
│   ├── ralphy-loop/
│   │   ├── core.ts
│   │   └── index.ts
│   ├── session-name.ts
│   ├── terminal-bench.ts
│   └── terminal-bench.system-prompt.template.md
├── themes/
│   └── hermes-dark.json
├── .gitignore
├── LICENSE
├── package.json
└── README.md
```

## Development

Place additional extensions in `extensions/` and additional themes in `themes/`.

Run the full release gate, the focused autocomplete suite, or the package/install smoke test with:

```bash
npm run check
npm run test:prompt-autocomplete
npm run test:package
npm run release:check:prompt-autocomplete
npm run audit:dependencies
```

The package smoke tests build both the private collection tarball and the standalone `@kliebhan/pi-prompt-autocomplete` tarball, install them into temporary clean consumers, and verify exact Pi resource discovery against the pinned development Pi version. The standalone release process is documented in [`docs/releasing-prompt-autocomplete.md`](docs/releasing-prompt-autocomplete.md).

`npm run audit:dependencies` audits the complete tree, development dependencies included, and fails on any advisory that is not explicitly documented and time-boxed in `.github/audit-exceptions.json`. See [`docs/dependency-audit.md`](docs/dependency-audit.md).

Each extension should export a default function:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // register tools, commands, events, UI
}
```

## Publish to GitHub

```bash
cd ../pi-extensions
git add .
git commit -m "Describe your change"
git push
```

If you want to create a fresh GitHub repository with GitHub CLI:

```bash
gh repo create pi-extensions --public --source=. --remote=origin --push
```
