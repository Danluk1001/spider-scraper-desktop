"""
One-time setup: install the Playwright Python package and Chromium browser.

Run with the SAME interpreter you use to start the app, e.g. from repo root:

  python desktop/install_playwright.py

If you use a venv, activate it first. The UI Screenshot tab shows sys.executable
if something is still wrong.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    print("Using Python:", sys.executable)
    print("Installing package: playwright …")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "playwright"])
    if r.returncode != 0:
        print("pip install failed.", file=sys.stderr)
        return r.returncode

    env = os.environ.copy()
    # Match launcher.py: repo-local browser cache when developing from source
    root = Path(__file__).resolve().parent.parent
    local_pw = root / "ms-playwright"
    if local_pw.is_dir():
        env.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(local_pw.resolve()))
        print("PLAYWRIGHT_BROWSERS_PATH =", env["PLAYWRIGHT_BROWSERS_PATH"])
    elif sys.platform == "win32":
        la = os.environ.get("LOCALAPPDATA")
        if la:
            p = Path(la) / "SpiderScraper" / "ms-playwright"
            p.mkdir(parents=True, exist_ok=True)
            env.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(p.resolve()))
            print("PLAYWRIGHT_BROWSERS_PATH =", env["PLAYWRIGHT_BROWSERS_PATH"])

    print("Downloading Chromium (this may take a few minutes) …")
    r = subprocess.run(
        [sys.executable, "-m", "playwright", "install", "chromium"],
        env=env,
    )
    if r.returncode != 0:
        print("playwright install chromium failed.", file=sys.stderr)
        return r.returncode

    print("Done. Restart Spider Scraper and try Capture in the Screenshot tab.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
