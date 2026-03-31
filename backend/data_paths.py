"""
Writable and read-only path helpers for Spider Scraper.

Development: data lives under ``<backend>/data/`` (next to ``app.py``).
Packaged (PyInstaller): use ``%LOCALAPPDATA%\\SpiderScraper\\data`` on Windows so
writes never go into the read-only bundle. Override anytime with
``SPIDER_SCRAPER_DATA_DIR``.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_APP_NAME = "SpiderScraper"
_ENV_DATA_DIR = "SPIDER_SCRAPER_DATA_DIR"


def get_backend_root() -> Path:
    """Directory that contains ``app.py`` and ``scraper.py`` (code / resources)."""
    return Path(__file__).resolve().parent


def _is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def get_data_directory() -> Path:
    """
    Root folder for user-writable application data (sitemaps, future caches).

    Resolution order:
    1. ``SPIDER_SCRAPER_DATA_DIR`` if set (absolute or user-expanded path).
    2. If running under PyInstaller (``sys.frozen``): a per-user directory
       outside the bundle (Windows: ``LOCALAPPDATA/SpiderScraper/data``).
    3. Development: ``<backend>/data`` next to this package.
    """
    override = os.environ.get(_ENV_DATA_DIR)
    if override:
        return Path(override).expanduser().resolve()

    if _is_frozen():
        if sys.platform == "win32":
            local = os.environ.get("LOCALAPPDATA")
            if local:
                return Path(local) / _APP_NAME / "data"
        return Path.home() / f".{_APP_NAME.lower()}" / "data"

    return get_backend_root() / "data"


def get_sitemap_directory() -> Path:
    """Dedicated folder for saved sitemap JSON snapshots."""
    return get_data_directory() / "sitemaps"


def get_screenshots_directory() -> Path:
    """PNG captures of remote pages (Playwright full-page screenshots)."""
    return get_data_directory() / "screenshots"


def legacy_sitemap_directory() -> Path:
    """
    Pre-refactor location: ``<backend>/output/sitemaps``.

    Used only as a read fallback for list/load so existing dev saves keep working.
    New saves always go to :func:`get_sitemap_directory`.
    """
    return get_backend_root() / "output" / "sitemaps"


def resolve_sitemap_file(filename: str) -> Path | None:
    """
    Return a path to ``filename`` if it exists under the primary or legacy
    sitemap directory, else ``None``. Basename must already be validated.
    """
    primary = get_sitemap_directory() / filename
    if primary.is_file():
        return primary
    legacy = legacy_sitemap_directory() / filename
    if legacy.is_file():
        return legacy
    return None


def iter_sitemap_json_files() -> list[Path]:
    """
    All ``*.json`` sitemap files from primary (and legacy if different), newest
    first. If the same basename exists in both, the newer mtime wins.
    """
    primary = get_sitemap_directory()
    legacy = legacy_sitemap_directory()
    dirs: list[Path] = [primary]
    try:
        same = legacy.resolve() == primary.resolve()
    except OSError:
        same = False
    if not same:
        dirs.append(legacy)

    best: dict[str, tuple[Path, float]] = {}
    for d in dirs:
        if not d.is_dir():
            continue
        for p in d.glob("*.json"):
            try:
                mt = p.stat().st_mtime
            except OSError:
                continue
            prev = best.get(p.name)
            if prev is None or mt > prev[1]:
                best[p.name] = (p, mt)

    out = [t[0] for t in best.values()]
    out.sort(key=lambda x: x.stat().st_mtime, reverse=True)
    return out
