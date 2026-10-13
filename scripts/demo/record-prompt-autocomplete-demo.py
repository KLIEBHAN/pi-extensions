#!/usr/bin/env python3
"""Record the Prompt Autocomplete Gallery video from a real Pi TUI session.

Pi runs in a private tmux server with an isolated agent directory, offline,
with only this extension and a local demo provider loaded, so the recording
needs no credentials and makes no network request. Each frame is the captured
pane, rendered with Pillow, and ffmpeg encodes the result.

Requires: tmux, ffmpeg, Python 3 with Pillow, macOS fonts (Menlo, Apple
Symbols), and `npm ci` in the repository.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[2]
DEMO_PROVIDER = Path(__file__).resolve().parent / "demo-provider.ts"
SOCKET = "pa-gallery-demo"
SESSION = "demo"

WIDTH, HEIGHT = 1200, 676
MARGIN, TITLE_BAR, PAD_X, PAD_Y = 26, 44, 18, 12
FONT_SIZE = 19
ROWS = 23
# Fill the content width with whole Menlo cells.
COLS = int((WIDTH - 2 * MARGIN - 2 * PAD_X) // ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", FONT_SIZE).getlength("M"))
BACKGROUND = (11, 14, 20)
WINDOW = (17, 22, 31)
WINDOW_BORDER = (42, 50, 64)
DEFAULT_FG = (220, 224, 230)
TITLE = "Pi · Prompt Autocomplete"

ANSI16 = [
    (40, 44, 52), (224, 108, 117), (152, 195, 121), (229, 192, 123),
    (97, 175, 239), (198, 120, 221), (86, 182, 194), (171, 178, 191),
    (92, 99, 112), (240, 125, 134), (169, 214, 136), (240, 206, 140),
    (120, 190, 250), (212, 140, 234), (110, 200, 210), (230, 233, 238),
]


def xterm256(index: int) -> tuple[int, int, int]:
    if index < 16:
        return ANSI16[index]
    if index < 232:
        index -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return (steps[index // 36], steps[(index // 6) % 6], steps[index % 6])
    level = 8 + (index - 232) * 10
    return (level, level, level)


@dataclass
class Style:
    fg: tuple[int, int, int] | None = None
    bg: tuple[int, int, int] | None = None
    bold: bool = False
    dim: bool = False
    italic: bool = False
    underline: bool = False
    inverse: bool = False

    def copy(self) -> "Style":
        return Style(self.fg, self.bg, self.bold, self.dim, self.italic, self.underline, self.inverse)


SGR = re.compile(r"\x1b\[([0-9;:]*)m")


def apply_sgr(style: Style, params: str) -> Style:
    codes = [int(code) if code else 0 for code in re.split(r"[;:]", params)] if params else [0]
    index = 0
    while index < len(codes):
        code = codes[index]
        if code == 0:
            style = Style()
        elif code == 1:
            style.bold = True
        elif code == 2:
            style.dim = True
        elif code == 3:
            style.italic = True
        elif code == 4:
            style.underline = True
        elif code == 7:
            style.inverse = True
        elif code == 22:
            style.bold = style.dim = False
        elif code == 23:
            style.italic = False
        elif code == 24:
            style.underline = False
        elif code == 27:
            style.inverse = False
        elif 30 <= code <= 37:
            style.fg = ANSI16[code - 30]
        elif 90 <= code <= 97:
            style.fg = ANSI16[code - 90 + 8]
        elif 40 <= code <= 47:
            style.bg = ANSI16[code - 40]
        elif 100 <= code <= 107:
            style.bg = ANSI16[code - 100 + 8]
        elif code == 39:
            style.fg = None
        elif code == 49:
            style.bg = None
        elif code in (38, 48) and index + 1 < len(codes):
            mode = codes[index + 1]
            color = None
            if mode == 5 and index + 2 < len(codes):
                color = xterm256(codes[index + 2])
                index += 2
            elif mode == 2 and index + 4 < len(codes):
                color = (codes[index + 2], codes[index + 3], codes[index + 4])
                index += 4
            if code == 38:
                style.fg = color
            else:
                style.bg = color
        index += 1
    return style


def parse_capture(text: str) -> list[list[tuple[str, Style]]]:
    rows: list[list[tuple[str, Style]]] = []
    style = Style()
    for line in text.split("\n")[:ROWS]:
        cells: list[tuple[str, Style]] = []
        position = 0
        for match in SGR.finditer(line):
            for character in line[position:match.start()]:
                cells.append((character, style.copy()))
            style = apply_sgr(style.copy(), match.group(1))
            position = match.end()
        for character in line[position:]:
            cells.append((character, style.copy()))
        rows.append(cells)
    return rows


class Fonts:
    def __init__(self) -> None:
        menlo = "/System/Library/Fonts/Menlo.ttc"
        self.regular = ImageFont.truetype(menlo, FONT_SIZE, index=0)
        self.bold = ImageFont.truetype(menlo, FONT_SIZE, index=1)
        self.italic = ImageFont.truetype(menlo, FONT_SIZE, index=2)
        self.fallback = ImageFont.truetype("/System/Library/Fonts/Apple Symbols.ttf", FONT_SIZE)
        self.cell_width = self.regular.getlength("M")
        self.title = ImageFont.truetype(menlo, 17, index=0)

    def pick(self, style: Style, character: str) -> ImageFont.FreeTypeFont:
        if 0x2800 <= ord(character) <= 0x28FF:
            return self.fallback
        if style.bold:
            return self.bold
        if style.italic:
            return self.italic
        return self.regular


def blend(a: tuple[int, int, int], b: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    return tuple(round(x + (y - x) * amount) for x, y in zip(a, b))  # type: ignore[return-value]


def render(rows: list[list[tuple[str, Style]]], fonts: Fonts) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)
    window = (MARGIN, MARGIN, WIDTH - MARGIN, HEIGHT - MARGIN)
    draw.rounded_rectangle(window, radius=16, fill=WINDOW, outline=WINDOW_BORDER, width=2)
    for offset, color in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        cx, cy = MARGIN + 26 + offset * 22, MARGIN + TITLE_BAR // 2
        draw.ellipse((cx - 6, cy - 6, cx + 6, cy + 6), fill=color)
    draw.text((MARGIN + 100, MARGIN + TITLE_BAR // 2), TITLE, font=fonts.title, fill=(170, 178, 192), anchor="lm")
    draw.line((MARGIN + 2, MARGIN + TITLE_BAR, WIDTH - MARGIN - 2, MARGIN + TITLE_BAR), fill=WINDOW_BORDER, width=1)

    left = MARGIN + PAD_X
    top = MARGIN + TITLE_BAR + PAD_Y
    line_height = (HEIGHT - MARGIN - PAD_Y - top) / ROWS
    for row_index, cells in enumerate(rows):
        y = top + row_index * line_height
        for column, (character, style) in enumerate(cells[:COLS]):
            fg = style.fg or DEFAULT_FG
            bg = style.bg
            if style.inverse:
                fg, bg = (bg or WINDOW), (style.fg or DEFAULT_FG)
            if style.dim:
                fg = blend(fg, WINDOW, 0.45)
            x = left + column * fonts.cell_width
            if bg is not None:
                draw.rectangle((x, y, x + fonts.cell_width, y + line_height), fill=bg)
            if character != " ":
                draw.text((x, y + line_height / 2), character, font=fonts.pick(style, character), fill=fg, anchor="lm")
            if style.underline:
                draw.line((x, y + line_height - 4, x + fonts.cell_width, y + line_height - 4), fill=fg, width=1)
    return image


@dataclass
class Frame:
    capture: str
    duration: float


@dataclass
class Recorder:
    frames: list[Frame] = field(default_factory=list)

    def tmux(self, *args: str) -> str:
        return subprocess.run(["tmux", "-L", SOCKET, *args], check=True, capture_output=True, text=True).stdout

    def capture(self) -> str:
        return self.tmux("capture-pane", "-t", SESSION, "-p", "-e")

    def plain(self) -> str:
        return self.tmux("capture-pane", "-t", SESSION, "-p")

    def snap(self, duration: float) -> None:
        capture = self.capture()
        if self.frames and self.frames[-1].capture == capture:
            self.frames[-1].duration += duration
        else:
            self.frames.append(Frame(capture, duration))

    def hold(self, seconds: float) -> None:
        time.sleep(min(seconds, 0.2))
        self.snap(seconds)

    def type(self, text: str, delay: float = 0.065) -> None:
        for character in text:
            self.tmux("send-keys", "-t", SESSION, "-l", character)
            time.sleep(delay)
            self.snap(delay)

    def key(self, name: str, settle: float = 0.25) -> None:
        self.tmux("send-keys", "-t", SESSION, name)
        time.sleep(settle)
        self.snap(settle)

    def wait_for(self, needle: str, timeout: float = 8.0, interval: float = 0.08) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.snap(interval)
            if needle in self.plain():
                return
            time.sleep(interval)
        raise TimeoutError(f"timed out waiting for {needle!r}:\n{self.plain()}")


def run_scenes(recorder: Recorder) -> None:
    recorder.hold(0.8)
    # Inline ghost text, streamed, with alternatives.
    recorder.type("Review")
    recorder.wait_for("the patch for edge cases")
    recorder.wait_for("‹1/3›")
    recorder.hold(1.3)
    recorder.key("C-.")
    recorder.wait_for("the failing tests first")
    recorder.hold(1.0)
    recorder.key("Tab")
    recorder.hold(1.1)
    # Argument completion and runtime tuning.
    recorder.key("C-u", 0.15)
    recorder.type("/prompt-autocomplete se")
    recorder.wait_for("set debounce-ms")
    recorder.hold(1.3)
    recorder.key("Tab")
    recorder.type("200")
    recorder.hold(0.4)
    recorder.key("Enter")
    recorder.wait_for("debounce-ms set to 200")
    recorder.hold(1.3)
    # Local request inspection.
    recorder.type("/prompt-autocomplete inspect Add tests for", 0.045)
    recorder.key("Enter")
    recorder.wait_for("no provider request was made")
    recorder.hold(3.2)
    # Session request budget.
    recorder.type("/prompt-autocomplete budget 3", 0.05)
    recorder.key("Enter")
    recorder.wait_for("budget set to 3")
    recorder.hold(1.0)
    recorder.type("Add tests for")
    recorder.wait_for("the budget ceiling")
    recorder.hold(1.1)
    recorder.key("Tab")
    recorder.wait_for("session budget exhausted")
    recorder.hold(2.6)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=REPO / "extensions/prompt-autocomplete/media/prompt-autocomplete-demo.mp4")
    parser.add_argument("--frames", type=Path, help="keep rendered PNG frames in this directory")
    args = parser.parse_args()

    pi = REPO / "node_modules/.bin/pi"
    if not pi.exists():
        sys.exit("run `npm ci` in the repository first")
    for tool in ("tmux", "ffmpeg"):
        if not shutil.which(tool):
            sys.exit(f"{tool} is required")

    # Resolved, because Pi prints the real path (macOS: /var -> /private/var).
    workdir = Path(tempfile.mkdtemp(prefix="pa-demo-")).resolve()
    try:
        recorder = record(pi, workdir)
        encode(recorder, workdir, args.out, args.frames or workdir / "frames")
    finally:
        # Only the caller's --frames directory and the video outlive the run.
        shutil.rmtree(workdir, ignore_errors=True)
    return 0


def record(pi: Path, workdir: Path) -> Recorder:
    agent = workdir / "agent"
    project = workdir / "acme-api"
    agent.mkdir()
    project.mkdir()
    (agent / "settings.json").write_text(json.dumps({"quietStartup": True}))
    # `env -i` starts Pi from an explicit allowlist, so nothing from the
    # maintainer's environment (API keys, session or agent directories) leaks
    # in. A private HOME also keeps the footer short (~/acme-api).
    env = {
        "HOME": str(workdir),
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "LANG": "en_US.UTF-8",
        "PI_CODING_AGENT_DIR": str(agent),
        "PI_CODING_AGENT_SESSION_DIR": str(workdir / "sessions"),
        "PI_OFFLINE": "1",
        "PI_PROMPT_AUTOCOMPLETE_SETTINGS": str(workdir / "prompt-autocomplete.json"),
    }
    arguments = [
        str(pi), "--no-extensions", "--no-skills",
        "-e", str(REPO / "extensions/prompt-autocomplete"),
        "-e", str(DEMO_PROVIDER),
        "--model", "demo/autocomplete",
        "--prompt-autocomplete", "--prompt-autocomplete-debounce-ms", "120",
    ]
    # TERM stays the one tmux gives the pane; every other token is quoted.
    command = 'exec env -i TERM="$TERM" ' + shlex.join([*(f"{key}={value}" for key, value in env.items()), *arguments])

    recorder = Recorder()
    subprocess.run(["tmux", "-L", SOCKET, "kill-server"], capture_output=True)
    try:
        subprocess.run(["tmux", "-L", SOCKET, "-f", "/dev/null", "new-session", "-d", "-s", SESSION,
                        "-x", str(COLS), "-y", str(ROWS), "-c", str(project), command], check=True)
        for option in (
            ("set", "-g", "status", "off"),
            ("set", "-s", "extended-keys", "on"),
            ("set", "-s", "extended-keys-format", "csi-u"),
            ("set", "-s", "escape-time", "0"),
        ):
            recorder.tmux(*option)
        recorder.tmux("resize-window", "-t", SESSION, "-x", str(COLS), "-y", str(ROWS))
        deadline = time.monotonic() + 20
        while "─" not in recorder.plain():
            if time.monotonic() > deadline:
                raise TimeoutError(f"Pi did not start:\n{recorder.plain()}")
            time.sleep(0.2)
        time.sleep(0.6)
        recorder.frames.clear()
        run_scenes(recorder)
    finally:
        subprocess.run(["tmux", "-L", SOCKET, "kill-server"], capture_output=True)
    return recorder


def concat_path(path: Path) -> str:
    """Quote a path for ffmpeg's concat demuxer, which reads single-quoted strings."""
    return "'" + str(path).replace("'", "'\\''") + "'"


def encode(recorder: Recorder, workdir: Path, out: Path, frame_dir: Path) -> None:
    fonts = Fonts()
    frame_dir.mkdir(parents=True, exist_ok=True)
    concat = []
    for index, frame in enumerate(recorder.frames):
        path = frame_dir / f"frame-{index:04d}.png"
        render(parse_capture(frame.capture), fonts).save(path)
        concat.append(f"file {concat_path(path)}\nduration {frame.duration:.3f}")
    concat.append(f"file {concat_path(frame_dir / f'frame-{len(recorder.frames) - 1:04d}.png')}")
    (workdir / "frames.txt").write_text("\n".join(concat) + "\n")
    out.parent.mkdir(parents=True, exist_ok=True)
    total = sum(frame.duration for frame in recorder.frames)
    # The concat demuxer needs the last file listed twice and would otherwise
    # stretch the final frame, so the output is cut at the recorded length.
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(workdir / "frames.txt"),
        "-t", f"{total:.3f}",
        # A mostly static terminal stays crisp at 20 fps and CRF 24 with a
        # fraction of the bytes; the video ships inside the npm package.
        "-vf", "fps=20,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-tune", "animation",
        "-movflags", "+faststart", str(out),
    ], check=True)
    print(f"{len(recorder.frames)} frames, {total:.1f} s -> {out}")


if __name__ == "__main__":
    raise SystemExit(main())
