"""
Headless full-page screenshots of remote URLs using Playwright (Chromium).

Requires: pip install playwright && playwright install chromium
"""

from __future__ import annotations

import secrets
import time
from pathlib import Path

from data_paths import get_screenshots_directory


class PageScreenshotError(Exception):
    """Navigation, timeout, or browser failure."""


class PlaywrightMissingError(PageScreenshotError):
    """Raised when the ``playwright`` package is not installed (ImportError)."""


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
