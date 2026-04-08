# pi-extensions

A small GitHub-ready repository for collecting reusable [pi](https://github.com/badlogic/pi-mono) extensions.

## Structure

```text
pi-extensions/
├── extensions/
│   ├── hello.ts
│   ├── notify.ts
│   ├── permission-gate.ts
│   └── session-name.ts
├── .gitignore
├── LICENSE
├── package.json
└── README.md
```

## Included extensions

- `hello.ts` - minimal example tool
- `notify.ts` - adds `/notify` for lightweight in-app notifications
- `permission-gate.ts` - asks for confirmation before dangerous bash commands
- `session-name.ts` - adds `/session-name <name>` to label the current session

## Use directly

From this repository:

```bash
pi -e ./extensions/hello.ts
pi -e ./extensions/notify.ts
pi -e ./extensions/permission-gate.ts
pi -e ./extensions/session-name.ts
```

## Install as a pi package

Because this repo exposes a `pi` manifest in `package.json`, pi can load it as a package.

Local path:

```bash
pi install ../pi-extensions
```

GitHub:

```bash
pi install git:github.com/<you>/pi-extensions
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
git init
git add .
git commit -m "Initial pi extensions repo"
```

Then create a remote and push it.

If you use GitHub CLI:

```bash
gh repo create pi-extensions --public --source=. --remote=origin --push
```
