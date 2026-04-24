#!/usr/bin/env python3
"""Verifier for the pi Harbor wrapper Hello World smoke test."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

EXPECTED = "Hello, world!\n"
APP_DIR = Path(os.environ.get("APP_DIR", "/app"))


def main() -> int:
    errors: list[str] = []

    hello_txt = APP_DIR / "hello.txt"
    if not hello_txt.exists():
        errors.append("/app/hello.txt does not exist")
    elif not hello_txt.is_file():
        errors.append("/app/hello.txt exists but is not a regular file")
    else:
        content = hello_txt.read_text(encoding="utf-8")
        if content != EXPECTED:
            errors.append(
                f"/app/hello.txt content mismatch: expected {EXPECTED!r}, got {content!r}"
            )

    hello_sh = APP_DIR / "hello.sh"
    if not hello_sh.exists():
        errors.append("/app/hello.sh does not exist")
    elif not hello_sh.is_file():
        errors.append("/app/hello.sh exists but is not a regular file")
    else:
        if not os.access(hello_sh, os.X_OK):
            errors.append("/app/hello.sh is not executable")
        try:
            result = subprocess.run(
                [str(hello_sh)],
                cwd=str(APP_DIR),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=5,
                check=False,
            )
        except Exception as exc:  # noqa: BLE001 - verifier should report any execution failure clearly.
            errors.append(f"failed to execute /app/hello.sh: {exc}")
        else:
            if result.returncode != 0:
                errors.append(
                    f"/app/hello.sh exited with {result.returncode}; stderr={result.stderr!r}"
                )
            if result.stdout != EXPECTED:
                errors.append(
                    f"/app/hello.sh stdout mismatch: expected {EXPECTED!r}, got {result.stdout!r}"
                )
            if result.stderr:
                errors.append(f"/app/hello.sh wrote to stderr: {result.stderr!r}")

    if errors:
        print("Verifier failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print("Verifier passed: hello.txt and hello.sh satisfy the contract.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
