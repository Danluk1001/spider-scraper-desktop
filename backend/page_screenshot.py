"""
Headless full-page screenshots of remote URLs using Playwright (Chromium).

Requires: pip install playwright && playwright install chromium
"""

from __future__ import annotations

import secrets
import sys
import time
from pathlib import Path
from typing import Any

from data_paths import get_screenshots_directory


class PageScreenshotError(Exception):
    """Navigation, timeout, or browser failure."""


class PlaywrightMissingError(PageScreenshotError):
    """Raised when the ``playwright`` package is not installed (ImportError)."""


def inspect_playwright_environment() -> dict[str, Any]:
    """
    Introspection for the *same* Python process that runs Flask (desktop or dev).

    Returns:
      - python_executable: sys.executable
      - playwright_import_ok: whether ``playwright.sync_api`` imports
      - chromium_available: True/False after a minimal launch attempt, or None if import failed
      - import_error / chromium_error: short strings when applicable
    """
    out: dict[str, Any] = {
        "python_executable": sys.executable,
        "playwright_import_ok": False,
        "chromium_available": None,
    }
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        out["import_error"] = str(e).strip() or e.__class__.__name__
        return out

    out["playwright_import_ok"] = True
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                browser.close()
            except Exception:
                pass
        out["chromium_available"] = True
    except Exception as e:
        out["chromium_available"] = False
        out["chromium_error"] = (str(e).strip() or e.__class__.__name__)[:800]
    return out


def capture_page_screenshot_png(url: str, *, timeout_ms: int = 90_000) -> Path:
    """
    Open ``url`` in headless Chromium and save a full-page PNG under the app
    screenshots directory. Returns the absolute path to the saved file.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        raise PlaywrightMissingError("Playwright is not installed") from e

    if not url.startswith(("http://", "https://")):
        raise PageScreenshotError("URL must start with http:// or https://")

    out_dir = get_screenshots_directory()
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{int(time.time())}_{secrets.token_hex(4)}"
    out_path = out_dir / f"{stem}.png"

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                context = browser.new_context(
                    viewport={"width": 1280, "height": 720},
                    user_agent=(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    ),
                )
                page = context.new_page()
                page.goto(url, wait_until="load", timeout=timeout_ms)
                page.screenshot(path=str(out_path), full_page=True)
            finally:
                browser.close()
    except Exception as e:
        try:
            if out_path.is_file():
                out_path.unlink()
        except OSError:
            pass
        msg = str(e).strip() or e.__class__.__name__
        raise PageScreenshotError(msg) from e

    return out_path.resolve()
