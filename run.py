#!/usr/bin/env python3
"""
run.py
======
One-click launcher for the Rock · Paper · Scissors AI game.

This script handles *everything* needed to get the game running on a
fresh checkout:

1. Creates a virtual environment (``.venv``) if one doesn't already exist.
2. Installs/refreshes the Python dependencies from ``backend/requirements.txt``.
3. Starts the Flask server on port 5050 (overridable via ``PORT`` env var).
4. Optionally opens the default web browser at the game's URL.

It's intentionally dependency-free (uses only the Python standard library)
so it can run on a clean Python 3.9+ install with no prior setup.

Usage
-----
::

    python run.py            # create venv, install deps, run, open browser
    python run.py --no-venv  # use the current Python (no venv created)
    python run.py --no-open  # don't auto-open the browser
    python run.py --port 8080  # override the port (default 5050)
    python run.py --difficulty hard  # override the default AI difficulty

Exit codes
----------
* ``0`` -- the server shut down cleanly (Ctrl-C / SIGTERM).
* ``1`` -- a setup step failed (venv creation, pip install, etc.).
* ``2`` -- the Python version is too old (< 3.9).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
ROOT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = ROOT_DIR / "backend"
VENV_DIR = ROOT_DIR / ".venv"
REQUIREMENTS_FILE = BACKEND_DIR / "requirements.txt"
APP_FILE = BACKEND_DIR / "app.py"

DEFAULT_PORT = 5050
DEFAULT_DIFFICULTY = "medium"
VALID_DIFFICULTIES = ("easy", "medium", "hard", "insane")

MIN_PYTHON = (3, 9)


# ---------------------------------------------------------------------------
# Pretty printing
# ---------------------------------------------------------------------------
class Style:
    """Tiny ANSI colour helper (no external dependency)."""

    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    RED = "\033[31m"
    CYAN = "\033[36m"

    @classmethod
    def _supports_color(cls) -> bool:
        # Respect NO_COLOR (https://no-color.org/) and non-TTY streams.
        if os.environ.get("NO_COLOR"):
            return False
        return sys.stdout.isatty()

    @classmethod
    def wrap(cls, text: str, *codes: str) -> str:
        if not cls._supports_color():
            return text
        return "".join(codes) + text + cls.RESET


def info(msg: str) -> None:
    print(Style.wrap("•", Style.CYAN, Style.BOLD), msg)


def success(msg: str) -> None:
    print(Style.wrap("✓", Style.GREEN, Style.BOLD), msg)


def warn(msg: str) -> None:
    print(Style.wrap("!", Style.YELLOW, Style.BOLD), msg)


def error(msg: str) -> None:
    print(Style.wrap("✗", Style.RED, Style.BOLD), msg, file=sys.stderr)


def banner() -> None:
    title = "Rock · Paper · Scissors AI"
    subtitle = "One-click launcher"
    if Style._supports_color():
        title = Style.wrap(title, Style.BOLD, Style.CYAN)
        subtitle = Style.wrap(subtitle, Style.DIM)
    print()
    print(f"  {title}")
    print(f"  {subtitle}")
    print(Style.wrap("  " + "─" * 40, Style.DIM))
    print()


# ---------------------------------------------------------------------------
# Setup steps
# ---------------------------------------------------------------------------
def check_python_version() -> None:
    """Abort early if the running Python is older than :data:`MIN_PYTHON`."""
    if sys.version_info < MIN_PYTHON:
        error(
            f"Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ is required, "
            f"but you're running {sys.version.split()[0]}."
        )
        sys.exit(2)
    success(
        f"Python {sys.version.split()[0]} detected "
        f"(>= {MIN_PYTHON[0]}.{MIN_PYTHON[1]})."
    )


def venv_python() -> Path:
    """Return the path to the venv's Python interpreter (cross-platform)."""
    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def venv_pip() -> list[str]:
    """Return the command prefix for invoking pip inside the venv."""
    py = venv_python()
    return [str(py), "-m", "pip"]


def create_venv() -> bool:
    """Create a fresh virtualenv at :data:`VENV_DIR` if it doesn't exist.

    Returns ``True`` if a venv is ready to use (either pre-existing or
    freshly created), ``False`` if creation failed.
    """
    if VENV_DIR.exists():
        info(f"Virtual environment already exists at {VENV_DIR.relative_to(ROOT_DIR)}")
        return True

    info(f"Creating virtual environment at {VENV_DIR.relative_to(ROOT_DIR)} ...")
    try:
        subprocess.check_call(
            [sys.executable, "-m", "venv", str(VENV_DIR)],
            stdout=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError as exc:
        error(f"Failed to create virtual environment: {exc}")
        return False
    success("Virtual environment created.")
    return True


def install_requirements() -> bool:
    """Install/refresh dependencies from ``backend/requirements.txt``."""
    if not REQUIREMENTS_FILE.exists():
        error(f"Requirements file not found: {REQUIREMENTS_FILE}")
        return False

    info("Installing dependencies (this may take a minute on first run) ...")
    cmd = venv_pip() + [
        "install",
        "--upgrade",
        "pip",
    ]
    try:
        subprocess.check_call(cmd, stdout=subprocess.DEVNULL)
    except subprocess.CalledProcessError as exc:
        warn(f"Could not upgrade pip (continuing anyway): {exc}")

    cmd = venv_pip() + [
        "install",
        "-r",
        str(REQUIREMENTS_FILE),
    ]
    try:
        subprocess.check_call(cmd)
    except subprocess.CalledProcessError as exc:
        error(f"Failed to install dependencies: {exc}")
        return False
    success("Dependencies installed.")
    return True


def open_browser_later(url: str, delay: float = 1.5) -> None:
    """Open ``url`` in the default browser after a short delay (background thread)."""

    def _open() -> None:
        time.sleep(delay)
        try:
            webbrowser.open(url, new=1, autoraise=True)
        except Exception as exc:  # noqa: BLE001
            warn(f"Could not open browser automatically: {exc}")

    threading.Thread(target=_open, daemon=True).start()


def start_server(port: int, difficulty: str, use_venv: bool, open_browser: bool) -> int:
    """Start the Flask server, optionally auto-opening the browser."""
    python_cmd = str(venv_python()) if use_venv else sys.executable

    env = os.environ.copy()
    env["PORT"] = str(port)
    if difficulty:
        env["RPS_DIFFICULTY"] = difficulty

    url = f"http://127.0.0.1:{port}/"
    print()
    print(Style.wrap("  ─" * 22, Style.DIM))
    success(f"Starting server at {Style.wrap(url, Style.BOLD, Style.CYAN)}")
    info(f"Difficulty: {Style.wrap(difficulty, Style.BOLD)}")
    info("Press Ctrl+C to stop the server.")
    print(Style.wrap("  ─" * 22, Style.DIM))
    print()

    if open_browser:
        open_browser_later(url)

    try:
        return subprocess.call(
            [python_cmd, str(APP_FILE)],
            cwd=str(BACKEND_DIR),
            env=env,
        )
    except KeyboardInterrupt:
        print()
        info("Shutting down ...")
        return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="One-click launcher for Rock · Paper · Scissors AI.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"Port to run the Flask server on (default {DEFAULT_PORT}; "
        "5000 is avoided because it's often already in use).",
    )
    parser.add_argument(
        "--difficulty",
        choices=VALID_DIFFICULTIES,
        default=DEFAULT_DIFFICULTY,
        help="Starting AI difficulty (can be changed at runtime from the UI).",
    )
    parser.add_argument(
        "--no-venv",
        action="store_true",
        help="Use the current Python interpreter instead of creating/using .venv.",
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="Don't auto-open the browser when the server starts.",
    )
    parser.add_argument(
        "--skip-install",
        action="store_true",
        help="Skip the pip install step (assume deps are already installed).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    banner()
    check_python_version()

    use_venv = not args.no_venv

    if use_venv:
        if not create_venv():
            error("Could not create virtual environment. Aborting.")
            return 1
        if not args.skip_install and not install_requirements():
            error("Could not install dependencies. Aborting.")
            return 1
    else:
        warn("Running without a virtual environment (--no-venv).")
        if not args.skip_install:
            info("Installing dependencies into the current environment ...")
            try:
                subprocess.check_call(
                    [sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS_FILE)]
                )
            except subprocess.CalledProcessError as exc:
                error(f"Failed to install dependencies: {exc}")
                return 1

    return start_server(
        port=args.port,
        difficulty=args.difficulty,
        use_venv=use_venv,
        open_browser=not args.no_open,
    )


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print()
        info("Interrupted.")
        sys.exit(0)