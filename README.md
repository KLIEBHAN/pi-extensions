# pi-extensions

Reusable [pi](https://github.com/badlogic/pi-mono) extensions collected in a standalone GitHub repository.

The repository is also a valid pi package, so you can either load individual extensions directly with `-e` or install the whole repository via `pi install`.

## Quick start

Load an individual extension from the repository:

```bash
pi -e ./extensions/hello.ts
pi -e ./extensions/notify.ts
pi -e ./extensions/permission-gate.ts
pi -e ./extensions/auto-mode --auto-goal "improve onboarding robustness"
pi -e ./extensions/prompt-autocomplete --prompt-autocomplete
pi -e ./extensions/ralphy-loop
pi -e ./extensions/session-name.ts
pi -e ./extensions/terminal-bench.ts --terminal-bench
```

Install the repository as a pi package:

```bash
pi install ../pi-extensions
pi install git:github.com/KLIEBHAN/pi-extensions
```

After package installation, enabled extensions are auto-discovered by pi. The `terminal-bench` and `prompt-autocomplete` extensions are safe to keep installed because they only activate when their flags are passed (or, for prompt autocomplete, when enabled via its slash command).

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
| `permission-gate.ts` | Asks for confirmation before dangerous bash commands | `pi -e ./extensions/permission-gate.ts` |
| `auto-mode/` | Controller-driven autonomous improvement loop that keeps iterating with transparent follow-up prompts | `/auto on --iterations 8 improve onboarding robustness` |
| `prompt-autocomplete/` | Copilot/Cursor-style inline AI autocomplete for the prompt editor with Tab accept and Escape dismiss | `pi -e ./extensions/prompt-autocomplete --prompt-autocomplete` |
| `ralphy-loop/` | Repeats the same task with autonomous prompts, AI completion verification, and per-iteration context pruning | `/ralphy-loop 5 harden edge cases` |
| `session-name.ts` | Adds `/session-name <name>` to label the current session | `/session-name auth-refactor` |
| `terminal-bench.ts` | Migrated from `feat/terminal-bench-optimizations`; adds Terminal-Bench prompt rules, tmux tools, environment bootstrapping, and completion verification | `pi -e ./extensions/terminal-bench.ts --terminal-bench` |

## Auto-mode extension

`extensions/auto-mode/` adds an autonomous controller loop on top of the normal pi worker.

### What it adds

- `/auto on <goal>` to start an autonomous improvement run
- optional stop modes:
  - iteration budget via `--iterations <n>`
  - controller-only completion gate via `--until "..."`
  - hybrid mode when both are set
- `/auto status`, `/auto summary`, `/auto pause`, `/auto resume`, `/auto off`, `/auto nudge <instruction>`
- completion policies:
  - `stop` = stop once verified completion is allowed
  - `continue-similar` = only after a normal verified stop would otherwise be allowed, optionally continue with bounded adjacent work still controlled by the controller
- configurable adjacent continuation cap via `--max-adjacent-continuations <n>` / `--auto-max-adjacent-continuations <n>` (defaults to `1`)
- separate controller model support via `--controller-model provider/model` or `--auto-controller-model provider/model` (defaults to the active worker model)
- transparent follow-up prompts via real user messages, so autonomous iterations stay visible in the transcript
- rolling controller summary with restore-on-start behavior (restored paused by default, or auto-resumed on startup when `--auto-resume` is set)
- targeted continue-prompt refinement when the controller would otherwise repeat the previous follow-up, preferring a materially more specific next step or pause over low-value repetition
- optional verification command for candidate-stop checks via `--verify "..."` / `--auto-verify "..."`, including proactive pre-stop verification when the worker looks close to done
- limited read-only controller probes for fresh git snapshots when needed
- pragmatic defaults for V1: 8 iterations by default, 12-iteration safety budget for completion-gate-only `--until` runs, `1` adjacent continuation by default for `continue-similar`, paused restore on restart unless you opt into `--auto-resume`
- `--until` is evaluated by the controller only; if the worker should explicitly optimize for that criterion, include it directly in the goal/prompt itself

### Usage

Directly from this repository:

```bash
pi -e ./extensions/auto-mode --auto-goal "improve onboarding robustness"
```

Inside pi:

```text
/auto on --iterations 8 improve onboarding robustness
/auto on --until "Stop when onboarding is robust and tests are green" improve onboarding robustness
/auto on --completion-policy continue-similar --max-adjacent-continuations 2 improve onboarding robustness
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
  --auto-completion-policy continue-similar \
  --auto-max-adjacent-continuations 2 \
  --auto-controller-model openai/gpt-5.4-mini \
  --auto-verify "npm test"
```

## Prompt autocomplete extension

`extensions/prompt-autocomplete/` adds inline AI autocomplete while you type your next prompt.

### What it adds

- ghost-text style prompt suggestions directly in the editor, including when the draft is still empty
- shows 2 alternatives by default, with configurable limit via flag
- `Tab` accepts the whole current suggestion
- `Ctrl+Space` accepts the next word/chunk from the current suggestion
- `Ctrl+,` and `Ctrl+.` cycle through alternative suggestions
- legacy fallbacks remain supported when your terminal forwards them: `Ctrl+Tab`, `Alt+[`, `Alt+]`
- `Escape` dismisses the current suggestion for the current draft
- repeated acceptance can keep extending the prompt step by step
- defaults to the current active model for autocomplete
- optional dedicated autocomplete model via `--prompt-autocomplete-model provider/model`
- configurable alternative count via `--prompt-autocomplete-max-alternatives <1-5>`
- clean default UI: debug/status lines stay hidden unless you opt into debug mode
- the internal autocomplete system prompt lives in `extensions/prompt-autocomplete/system-prompt.template.md` and is rendered through a tiny mini-template helper with `{{PLACEHOLDER}}` and `{{PLACEHOLDER|fallback}}`, so prompt tuning stays decoupled from TypeScript while still allowing reusable prompt fragments
- can be auto-loaded from `~/.pi/agent/extensions/` and is controllable per session via `/prompt-autocomplete on|off|toggle`

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
/prompt-autocomplete debug-on
/prompt-autocomplete debug-off
/prompt-autocomplete off
```

Optional dedicated fast model:

```bash
pi -e ./extensions/prompt-autocomplete \
  --prompt-autocomplete \
  --prompt-autocomplete-model openai/gpt-5.4-mini \
  --prompt-autocomplete-max-alternatives 2
```

### Notes

- The extension suggests as soon as the cursor is at the end of the current draft, even if the draft is still empty.
- Built-in slash-command and file/path autocomplete keep working.
- By default it pauses while the main agent is streaming so it can use the finished conversation context. Override with `--prompt-autocomplete-while-streaming` if you really want live suggestions while the agent is still working.
- Terminal-friendly defaults are `Ctrl+Space` for word/chunk accept and `Ctrl+,` / `Ctrl+.` for cycling.
- The default suggestion count is 2. Adjust it with `--prompt-autocomplete-max-alternatives <1-5>` if you want fewer or more.
- Legacy `Ctrl+Tab` and `Alt+[` / `Alt+]` remain supported as fallbacks when your terminal forwards them.
- For troubleshooting, start with `--prompt-autocomplete-debug` or run `/prompt-autocomplete debug-on` temporarily.
- If you want to tune the internal autocomplete prompt, edit `extensions/prompt-autocomplete/system-prompt.template.md`; simple `{{PLACEHOLDER}}` variables are filled in by `extensions/prompt-autocomplete/core.ts`, and `{{PLACEHOLDER|fallback}}` uses the fallback text when no variable is provided.

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
- It creates and uses a dedicated `tmux` session for interactive terminal control.
- `tmux` should be installed and available on `PATH` if you want to use `tmux_send` and `tmux_read`.

## Harbor wrapper example

For Harbor-based Terminal-Bench runs, see `examples/harbor-wrapper/README.md`.

The wrapper uploads the bundled `extensions/terminal-bench.ts` file into the
sandbox automatically. By default it installs the published npm `pi` package,
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
│   │   └── index.ts
│   ├── hello.ts
│   ├── notify.ts
│   ├── permission-gate.ts
│   ├── prompt-autocomplete/
│   │   ├── core.ts
│   │   ├── index.ts
│   │   └── system-prompt.template.md
│   ├── ralphy-loop/
│   │   ├── core.ts
│   │   └── index.ts
│   ├── session-name.ts
│   └── terminal-bench.ts
├── .gitignore
├── LICENSE
├── package.json
└── README.md
```

## Development

Place additional extensions in `extensions/`.

Each extension should export a default function:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
