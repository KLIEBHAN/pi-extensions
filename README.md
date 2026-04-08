# pi-extensions

Reusable [pi](https://github.com/badlogic/pi-mono) extensions collected in a standalone GitHub repository.

The repository is also a valid pi package, so you can either load individual extensions directly with `-e` or install the whole repository via `pi install`.

## Quick start

Load an individual extension from the repository:

```bash
pi -e ./extensions/hello.ts
pi -e ./extensions/notify.ts
pi -e ./extensions/permission-gate.ts
pi -e ./extensions/session-name.ts
pi -e ./extensions/terminal-bench.ts --terminal-bench
```

Install the repository as a pi package:

```bash
pi install ../pi-extensions
pi install git:github.com/KLIEBHAN/pi-extensions
```

After package installation, enabled extensions are auto-discovered by pi. The `terminal-bench` extension is safe to keep installed because it only activates when `--terminal-bench` is passed.

## Included extensions

| Extension | Purpose | Example |
|---|---|---|
| `hello.ts` | Minimal custom tool example | `pi -e ./extensions/hello.ts` |
| `notify.ts` | Adds `/notify` for lightweight in-app notifications | `/notify build finished` |
| `permission-gate.ts` | Asks for confirmation before dangerous bash commands | `pi -e ./extensions/permission-gate.ts` |
| `session-name.ts` | Adds `/session-name <name>` to label the current session | `/session-name auth-refactor` |
| `terminal-bench.ts` | Migrated from `feat/terminal-bench-optimizations`; adds Terminal-Bench prompt rules, tmux tools, environment bootstrapping, and completion verification | `pi -e ./extensions/terminal-bench.ts --terminal-bench` |

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

## Repository structure

```text
pi-extensions/
├── extensions/
│   ├── hello.ts
│   ├── notify.ts
│   ├── permission-gate.ts
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
