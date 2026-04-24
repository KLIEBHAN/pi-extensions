# pi-extensions/hello-world

Minimal Harbor task used as a smoke test for the pi Harbor wrapper.

The agent must leave two files in `/app`:

- `/app/hello.txt` containing exactly `Hello, world!\n`
- executable `/app/hello.sh` printing exactly `Hello, world!\n`

The verifier is intentionally small and uses only Python's standard library.
