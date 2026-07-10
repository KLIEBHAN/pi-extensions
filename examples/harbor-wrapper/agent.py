"""
Harbor wrapper for pi coding agent.

Installs pi inside the Harbor sandbox container and runs it in print mode.
Pi uses its terminal-bench extension for environment bootstrapping, prompt
optimizations, completion verification, and tmux-based terminal interaction.

Usage:
    harbor run \
        --agent-import-path agent:PiAgent \
        -d terminal-bench@2.0 \
        -m anthropic/claude-opus-4-6 \
        -e runloop \
        -n 20 \
        --n-attempts 5

Requires:
    - harbor: pip install harbor
    - bundled terminal-bench extension at ../../extensions/terminal-bench.ts
      plus ../../extensions/terminal-bench.system-prompt.template.md
    - auth.json at ~/.pi/agent/auth.json (for subscription auth)
      OR ANTHROPIC_API_KEY set in environment
"""

import base64
import json
import logging
import os
import shlex
import tarfile
import tempfile
import time
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

_LOGGER = logging.getLogger(__name__)

# Per-task timeout in seconds (30 minutes).
TASK_TIMEOUT_SEC = 30 * 60

# Node.js version to install in the container.
NODE_VERSION = "22.16.0"

# Paths on host
_HOST_PACKAGE_ROOT = Path(__file__).resolve().parents[2]
_HOST_AUTH = Path.home() / ".pi" / "agent" / "auth.json"
_HOST_EXTENSION = _HOST_PACKAGE_ROOT / "extensions" / "terminal-bench.ts"
_HOST_EXTENSION_TEMPLATE = _HOST_PACKAGE_ROOT / "extensions" / "terminal-bench.system-prompt.template.md"
_DEFAULT_LOCAL_REPO_ROOT = _HOST_PACKAGE_ROOT.parent / "pi-mono"

# Paths inside the container
_REMOTE_PI_DIR = "/root/.pi/agent"
_REMOTE_AUTH = f"{_REMOTE_PI_DIR}/auth.json"
_REMOTE_EXT_DIR = f"{_REMOTE_PI_DIR}/extensions"
_REMOTE_EXT = f"{_REMOTE_EXT_DIR}/terminal-bench.ts"
_REMOTE_EXT_TEMPLATE = f"{_REMOTE_EXT_DIR}/terminal-bench.system-prompt.template.md"
_REMOTE_REPO_DIR = "/tmp/pi-mono"
_REMOTE_REPO_ARCHIVE = "/tmp/pi-mono.tar.gz"
_REMOTE_TASK = "/tmp/pi-task.txt"
_REMOTE_STDOUT = "/tmp/pi-stdout.log"
_REMOTE_ERRORS = "/tmp/pi-errors.log"
_REMOTE_TRACE = "/tmp/pi-trace.jsonl"
_REMOTE_WORKDIR = "/app"
_REMOTE_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR"
_TRACE_ENV = "PI_HARBOR_TRACE_JSONL"
_PI_SOURCE_ENV = "PI_HARBOR_PI_SOURCE"
_LOCAL_REPO_ENV = "PI_HARBOR_LOCAL_REPO"
_THINKING_ENV = "PI_HARBOR_THINKING"
_TASK_TIMEOUT_ENV = "PI_HARBOR_TASK_TIMEOUT_SEC"
_EXTRA_INSTRUCTION_ENV = "PI_HARBOR_EXTRA_INSTRUCTION"
_EXTRA_INSTRUCTION_FILE_ENV = "PI_HARBOR_EXTRA_INSTRUCTION_FILE"


def _find_extension() -> Path:
    """Locate the bundled terminal-bench extension in this repository."""
    if _HOST_EXTENSION.exists():
        return _HOST_EXTENSION

    raise FileNotFoundError(
        f"Bundled terminal-bench extension not found at {_HOST_EXTENSION}. "
        "Expected this wrapper to live inside the pi-extensions repository."
    )


def _find_extension_template() -> Path:
    """Locate the terminal-bench prompt template used by the extension."""
    if _HOST_EXTENSION_TEMPLATE.exists():
        return _HOST_EXTENSION_TEMPLATE

    raise FileNotFoundError(
        f"Bundled terminal-bench prompt template not found at {_HOST_EXTENSION_TEMPLATE}. "
        "Expected this wrapper to live inside the pi-extensions repository."
    )


def _parse_model_arg(model_name: str | None) -> tuple[str | None, str | None]:
    """Parse 'provider/model-id' into (provider, model_id)."""
    if not model_name:
        return None, None
    if "/" in model_name:
        provider, model_id = model_name.split("/", 1)
        return provider, model_id
    return None, model_name


def _read_host_auth() -> dict[str, object] | None:
    """Load host auth.json if present and valid."""
    if not _HOST_AUTH.exists():
        return None

    try:
        data = json.loads(_HOST_AUTH.read_text())
    except Exception:
        _LOGGER.warning("Failed to parse %s", _HOST_AUTH, exc_info=True)
        return None

    if not isinstance(data, dict):
        _LOGGER.warning("Ignoring non-object auth.json at %s", _HOST_AUTH)
        return None

    return data


def _get_oauth_access_token(auth_data: dict[str, object] | None, provider: str) -> str | None:
    """Extract a non-expired OAuth access token from auth.json."""
    if not auth_data:
        return None

    entry = auth_data.get(provider)
    if not isinstance(entry, dict):
        return None

    if entry.get("type") != "oauth":
        return None

    access = entry.get("access")
    if not isinstance(access, str) or not access:
        return None

    expires = entry.get("expires")
    if isinstance(expires, (int, float)) and expires <= time.time() * 1000:
        _LOGGER.warning(
            "%s OAuth access token in auth.json is expired; relying on uploaded auth.json instead",
            provider,
        )
        return None

    return access


def _resolve_trace_path(value: str | None) -> str | None:
    """Resolve optional in-container trace path from host env configuration."""
    if value is None:
        return None

    normalized = value.strip()
    if not normalized:
        return None

    if normalized.lower() in {"0", "false", "no", "off"}:
        return None

    if normalized.lower() in {"1", "true", "yes", "on"}:
        return _REMOTE_TRACE

    return normalized


def _materialize_trace_path(path: str | None, remote_cwd: str | None) -> str | None:
    """Convert optional trace path config into a concrete in-container file path."""
    if path is None:
        return None

    if path.startswith("/"):
        return path

    base_dir = remote_cwd or "/tmp"
    return f"{base_dir.rstrip('/')}/{path}"


def _shell_join(parts: list[str]) -> str:
    """Quote command parts into a shell-safe command string."""
    return " ".join(shlex.quote(part) for part in parts)


def _resolve_pi_source(value: str | None) -> str:
    """Resolve whether Harbor should use the local checkout or published npm pi."""
    if value is None:
        return "npm"

    normalized = value.strip().lower()
    if not normalized or normalized in {"npm", "published", "release"}:
        return "npm"
    if normalized in {"local", "source", "checkout"}:
        return "local"

    raise ValueError(
        f"Invalid {_PI_SOURCE_ENV} value: {value!r}. Expected 'npm' or 'local'."
    )


def _resolve_local_repo_root(value: str | None) -> Path:
    """Resolve and validate the host pi checkout for local-source Harbor runs."""
    candidate = Path(value).expanduser() if value else _DEFAULT_LOCAL_REPO_ROOT
    resolved = candidate.resolve()

    if not resolved.exists():
        raise ValueError(
            f"Local pi checkout not found at {resolved}. Set {_LOCAL_REPO_ENV} to your pi-mono checkout path."
        )

    required_paths = [
        resolved / "package.json",
        resolved / "packages" / "coding-agent" / "src" / "cli.ts",
        resolved / "packages" / "agent" / "dist" / "index.js",
        resolved / "packages" / "ai" / "dist" / "index.js",
        resolved / "packages" / "tui" / "dist" / "index.js",
    ]
    missing = [str(path.relative_to(resolved)) for path in required_paths if not path.exists()]
    if missing:
        raise ValueError(
            f"Local pi checkout at {resolved} is missing required files for Harbor local-source mode: {', '.join(missing)}"
        )

    return resolved


def _resolve_thinking_level(value: str | None) -> str:
    """Resolve the pi thinking level for Harbor runs."""
    if value is None:
        return "high"

    normalized = value.strip().lower()
    if not normalized:
        return "high"

    valid = {"off", "minimal", "low", "medium", "high", "xhigh"}
    if normalized not in valid:
        raise ValueError(
            f"Invalid {_THINKING_ENV} value: {value!r}. Expected one of {', '.join(sorted(valid))}."
        )

    return normalized


def _resolve_task_timeout_sec(value: str | None) -> int:
    """Resolve the wrapper's in-container pi execution timeout."""
    if value is None:
        return TASK_TIMEOUT_SEC

    normalized = value.strip()
    if not normalized:
        return TASK_TIMEOUT_SEC

    try:
        timeout_sec = int(normalized)
    except ValueError as error:
        raise ValueError(
            f"Invalid {_TASK_TIMEOUT_ENV} value: {value!r}. Expected a positive integer number of seconds."
        ) from error

    if timeout_sec <= 0:
        raise ValueError(
            f"Invalid {_TASK_TIMEOUT_ENV} value: {value!r}. Expected a positive integer number of seconds."
        )

    return timeout_sec


def _read_extra_instruction() -> str | None:
    """Read optional benchmark steering text from env or a host-side file."""
    parts: list[str] = []

    file_value = os.environ.get(_EXTRA_INSTRUCTION_FILE_ENV)
    if file_value and file_value.strip():
        hint_path = Path(file_value).expanduser().resolve()
        try:
            parts.append(hint_path.read_text())
        except Exception as error:
            raise ValueError(
                f"Failed to read {_EXTRA_INSTRUCTION_FILE_ENV}={file_value!r}: {error}"
            ) from error

    inline_value = os.environ.get(_EXTRA_INSTRUCTION_ENV)
    if inline_value and inline_value.strip():
        parts.append(inline_value)

    normalized = "\n\n".join(part.strip() for part in parts if part.strip())
    return normalized or None


def _compose_instruction(instruction: str, extra_instruction: str | None) -> str:
    """Append optional wrapper-provided steering text to the task instruction."""
    if not extra_instruction:
        return instruction

    return (
        instruction.rstrip()
        + "\n\n---\n\n"
        + "Additional benchmark steering from the Harbor wrapper. "
        + "Apply only the guidance that is relevant to this task, and keep all original requirements authoritative.\n\n"
        + extra_instruction.strip()
        + "\n"
    )


def _filter_repo_archive_member(member: tarfile.TarInfo) -> tarfile.TarInfo | None:
    """Exclude large or irrelevant files from the uploaded local checkout archive."""
    parts = Path(member.name).parts
    if any(part in {".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache"} for part in parts):
        return None

    name = parts[-1]
    if name == ".DS_Store" or name.endswith((".pyc", ".pyo")):
        return None

    return member


def _create_local_repo_archive(repo_root: Path) -> Path:
    """Create a compressed archive of the current local pi checkout."""
    handle = tempfile.NamedTemporaryFile(prefix="pi-harbor-source-", suffix=".tar.gz", delete=False)
    handle.close()
    archive_path = Path(handle.name)

    try:
        with tarfile.open(archive_path, "w:gz") as tar:
            tar.add(repo_root, arcname=Path(_REMOTE_REPO_DIR).name, filter=_filter_repo_archive_member)
        return archive_path
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise


class PiAgent(BaseAgent):
    """Harbor agent that installs and runs pi inside the sandbox container."""

    SUPPORTS_ATIF: bool = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._provider, self._model_id = _parse_model_arg(self.model_name)
        self._host_auth = _read_host_auth()
        self._anthropic_oauth_token = _get_oauth_access_token(self._host_auth, "anthropic")
        self._trace_path_config = _resolve_trace_path(os.environ.get(_TRACE_ENV))
        self._pi_source = _resolve_pi_source(os.environ.get(_PI_SOURCE_ENV))
        self._thinking_level = _resolve_thinking_level(os.environ.get(_THINKING_ENV))
        self._task_timeout_sec = _resolve_task_timeout_sec(os.environ.get(_TASK_TIMEOUT_ENV))
        self._extra_instruction = _read_extra_instruction()
        self._local_repo_root = (
            _resolve_local_repo_root(os.environ.get(_LOCAL_REPO_ENV))
            if self._pi_source == "local"
            else None
        )
        self._supports_trace_jsonl = False

    @staticmethod
    def name() -> str:
        return "pi-coding-agent"

    def version(self) -> str | None:
        return "1.0.0"

    def _pi_cli_parts(self) -> list[str]:
        """Return the CLI invocation prefix for the selected pi source."""
        if self._pi_source == "local":
            return [
                f"{_REMOTE_REPO_DIR}/node_modules/.bin/tsx",
                f"{_REMOTE_REPO_DIR}/packages/coding-agent/src/cli.ts",
            ]
        return ["pi"]

    def _pi_cli_command(self, *args: str) -> str:
        """Return a shell-safe pi CLI command string."""
        return _shell_join([*self._pi_cli_parts(), *args])

    async def _install_local_pi_source(self, environment: BaseEnvironment) -> None:
        """Upload the current local pi checkout and install its dependencies in-container."""
        assert self._local_repo_root is not None

        archive_path = _create_local_repo_archive(self._local_repo_root)
        archive_size_mb = archive_path.stat().st_size / (1024 * 1024)
        _LOGGER.info(
            "Uploading local pi checkout from %s (%.1f MiB archive)",
            self._local_repo_root,
            archive_size_mb,
        )
        try:
            await environment.upload_file(str(archive_path), _REMOTE_REPO_ARCHIVE)
        finally:
            archive_path.unlink(missing_ok=True)

        await environment.exec(
            f"rm -rf {shlex.quote(_REMOTE_REPO_DIR)} && "
            f"tar -xzf {shlex.quote(_REMOTE_REPO_ARCHIVE)} -C /tmp && "
            f"rm -f {shlex.quote(_REMOTE_REPO_ARCHIVE)}",
            timeout_sec=300,
        )
        await environment.exec(
            "HUSKY=0 npm install --include=dev --no-fund --no-audit",
            cwd=_REMOTE_REPO_DIR,
            timeout_sec=900,
        )
        await environment.exec(
            f"test -x {shlex.quote(_REMOTE_REPO_DIR)}/node_modules/.bin/tsx",
            timeout_sec=10,
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        """Install Node.js, pi, tmux, and upload config into the container."""
        _LOGGER.info("Setting up pi in container...")
        _LOGGER.info("pi source mode: %s", self._pi_source)
        _LOGGER.info("pi thinking level: %s", self._thinking_level)
        _LOGGER.info("pi task timeout: %s seconds", self._task_timeout_sec)
        if self._extra_instruction:
            _LOGGER.info("extra instruction steering enabled (%d chars)", len(self._extra_instruction))

        # 1. System dependencies (curl for Node.js download, tmux for tmux tools)
        _LOGGER.info("Installing system dependencies...")
        await environment.exec(
            "apt-get update -qq && apt-get install -y -qq curl tmux xz-utils > /dev/null 2>&1",
            timeout_sec=180,
        )

        # 2. Node.js from binary tarball (faster than nodesource apt repo)
        _LOGGER.info("Installing Node.js %s...", NODE_VERSION)
        await environment.exec(
            "ARCH=$(uname -m); "
            "case $ARCH in x86_64) NA=x64;; aarch64|arm64) NA=arm64;; *) NA=x64;; esac; "
            f'curl -fsSL "https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-${{NA}}.tar.xz" '
            "| tar -xJ -C /usr/local --strip-components=1",
            timeout_sec=120,
        )

        # Verify node works
        result = await environment.exec("node --version", timeout_sec=10)
        _LOGGER.info("Node.js installed: %s", (result.stdout or "").strip())

        # 3. Install pi
        if self._pi_source == "local":
            _LOGGER.info("Installing pi from local checkout...")
            await self._install_local_pi_source(environment)
        else:
            _LOGGER.info("Installing pi coding agent from npm...")
            await environment.exec(
                "npm install -g @earendil-works/pi-coding-agent 2>&1 | tail -5",
                timeout_sec=300,
            )

        result = await environment.exec(self._pi_cli_command("--version"), timeout_sec=20)
        _LOGGER.info("pi available: %s", (result.stdout or "").strip())

        help_result = await environment.exec(self._pi_cli_command("--help"), timeout_sec=20)
        help_text = f"{help_result.stdout or ''}\n{help_result.stderr or ''}"
        self._supports_trace_jsonl = "--trace-jsonl" in help_text
        if self._trace_path_config:
            if self._supports_trace_jsonl:
                _LOGGER.info("Installed pi supports --trace-jsonl")
            else:
                _LOGGER.warning(
                    "PI_HARBOR_TRACE_JSONL was requested, but the installed pi does not support "
                    "--trace-jsonl yet; continuing without structured trace capture"
                )

        # 4. Upload bundled terminal-bench extension and prompt template
        ext_path = _find_extension()
        ext_template_path = _find_extension_template()
        _LOGGER.info("Uploading bundled terminal-bench extension from %s", ext_path)
        _LOGGER.info("Uploading bundled terminal-bench prompt template from %s", ext_template_path)
        await environment.exec(f"mkdir -p {_REMOTE_EXT_DIR}", timeout_sec=5)
        await environment.upload_file(str(ext_path), _REMOTE_EXT)
        await environment.upload_file(str(ext_template_path), _REMOTE_EXT_TEMPLATE)

        # 5. Upload auth.json for subscription auth (if available)
        if _HOST_AUTH.exists():
            _LOGGER.info("Uploading auth.json for subscription auth")
            await environment.exec(f"mkdir -p {_REMOTE_PI_DIR}", timeout_sec=5)
            await environment.upload_file(str(_HOST_AUTH), _REMOTE_AUTH)

            if self._anthropic_oauth_token:
                _LOGGER.info("Will inject Anthropic OAuth access token via environment")
        elif os.environ.get("ANTHROPIC_OAUTH_TOKEN"):
            _LOGGER.info("Using ANTHROPIC_OAUTH_TOKEN from environment")
        elif os.environ.get("ANTHROPIC_API_KEY"):
            _LOGGER.info("Using ANTHROPIC_API_KEY from environment")
        else:
            _LOGGER.warning(
                "No auth.json, ANTHROPIC_OAUTH_TOKEN, or ANTHROPIC_API_KEY. "
                "Pi may not be able to authenticate."
            )

        _LOGGER.info("Setup complete.")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run pi in print mode inside the container."""
        instruction = _compose_instruction(instruction, self._extra_instruction)
        _LOGGER.info("Running pi on task (%d chars)", len(instruction))

        # Write instruction to file via base64 to avoid any shell escaping issues
        encoded = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
        await environment.exec(
            f"echo '{encoded}' | base64 -d > {_REMOTE_TASK}",
            timeout_sec=10,
        )

        remote_cwd = _REMOTE_WORKDIR if await environment.is_dir(_REMOTE_WORKDIR) else None
        trace_path = _materialize_trace_path(self._trace_path_config, remote_cwd)
        trace_enabled = trace_path is not None and self._supports_trace_jsonl

        # Build pi command
        cmd_parts = [
            *self._pi_cli_parts(),
            "-p",
            "--terminal-bench",
            "--thinking", self._thinking_level,
            "--no-session",
        ]

        if self._provider:
            cmd_parts.extend(["--provider", self._provider])
        if self._model_id:
            cmd_parts.extend(["--model", self._model_id])
        if trace_enabled:
            cmd_parts.extend(["--trace-jsonl", trace_path])

        # Pass auth + config via env vars.
        env_vars: dict[str, str] = {
            _REMOTE_AGENT_DIR_ENV: _REMOTE_PI_DIR,
        }
        for key in [
            "ANTHROPIC_OAUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GEMINI_API_KEY",
            "XAI_API_KEY",
        ]:
            val = os.environ.get(key)
            if val:
                env_vars[key] = val

        if (
            "ANTHROPIC_OAUTH_TOKEN" not in env_vars
            and "ANTHROPIC_API_KEY" not in env_vars
            and self._anthropic_oauth_token
        ):
            env_vars["ANTHROPIC_OAUTH_TOKEN"] = self._anthropic_oauth_token

        # @file passes file content as the prompt
        cmd_parts.append(f"@{_REMOTE_TASK}")

        pi_command = _shell_join(cmd_parts)
        capture_command = (
            "set -o pipefail; "
            f"{pi_command} "
            f"> >(tee {shlex.quote(_REMOTE_STDOUT)} >/dev/null) "
            f"2> >(tee {shlex.quote(_REMOTE_ERRORS)} >/dev/null)"
        )
        cmd = f"bash -lc {shlex.quote(capture_command)}"

        if remote_cwd:
            _LOGGER.info("Executing in working directory: %s", remote_cwd)
        else:
            _LOGGER.warning("Working directory %s not found; using container default", _REMOTE_WORKDIR)

        if trace_enabled:
            _LOGGER.info("Enabling pi trace capture at %s", trace_path)

        _LOGGER.info("Executing: %s", pi_command)

        result = None
        exec_error: Exception | None = None
        try:
            result = await environment.exec(
                cmd,
                cwd=remote_cwd,
                env=env_vars,
                timeout_sec=self._task_timeout_sec,
            )
        except Exception as error:
            exec_error = error

        # Always download stdout/stderr logs, and trace logs when enabled, even on timeout.
        local_stdout = self.logs_dir / "pi-stdout.log"
        local_errors = self.logs_dir / "pi-errors.log"
        local_trace = self.logs_dir / "pi-trace.jsonl"
        try:
            await environment.download_file(_REMOTE_STDOUT, str(local_stdout))
        except Exception:
            _LOGGER.debug("Could not download pi stdout log", exc_info=True)
        try:
            await environment.download_file(_REMOTE_ERRORS, str(local_errors))
        except Exception:
            _LOGGER.debug("Could not download pi error log", exc_info=True)
        if trace_enabled:
            try:
                await environment.download_file(trace_path, str(local_trace))
            except Exception:
                _LOGGER.debug("Could not download pi trace log", exc_info=True)

        if local_stdout.exists():
            stdout_content = local_stdout.read_text(errors="replace").strip()
            if stdout_content:
                _LOGGER.info("pi stdout (first 500 chars): %s", stdout_content[:500])
                _LOGGER.info("pi stdout (last 500 chars): %s", stdout_content[-500:])

        if local_errors.exists():
            error_content = local_errors.read_text(errors="replace").strip()
            if error_content:
                _LOGGER.info("pi stderr (last 500 chars): %s", error_content[-500:])

        if local_trace.exists():
            try:
                trace_lines = sum(1 for _ in local_trace.open())
            except Exception:
                _LOGGER.debug("Could not count pi trace log lines", exc_info=True)
            else:
                _LOGGER.info("pi trace saved to %s (%d JSONL records)", local_trace, trace_lines)
            metadata = dict(context.metadata or {})
            metadata["pi_trace_jsonl"] = local_trace.name
            context.metadata = metadata

        if exec_error is not None:
            raise exec_error

        assert result is not None

        # Log result
        exit_code = result.return_code
        _LOGGER.info("pi exited with code %s", exit_code)

        if exit_code != 0:
            _LOGGER.error("pi failed with exit code %s", exit_code)
