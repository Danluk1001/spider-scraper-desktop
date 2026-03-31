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
_ENV_FRONTEND_DIST = "SPIDER_SCRAPER_FRONTEND_DIST"


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


def get_frontend_dist_directory() -> Path | None:
    """
    Root of the built Vite app (``frontend/dist``) when Flask serves the SPA.

    Resolution:
    1. ``SPIDER_SCRAPER_FRONTEND_DIST`` if set (absolute path to ``dist``).
    2. PyInstaller: ``sys._MEIPASS/frontend/dist`` if that folder exists.
    3. PyInstaller fallback: ``<exe_dir>/frontend/dist``.
    4. Development: ``<repo>/frontend/dist`` if present.

    Returns ``None`` if no usable directory exists (caller should skip SPA routes).
    """
    override = os.environ.get(_ENV_FRONTEND_DIST)
    if override:
        p = Path(override).expanduser().resolve()
        return p if p.is_dir() else None

    if _is_frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            candidate = Path(meipass) / "frontend" / "dist"
            if candidate.is_dir():
                return candidate
        exe_dir = Path(sys.executable).resolve().parent
        candidate = exe_dir / "frontend" / "dist"
        if candidate.is_dir():
            return candidate
        return None

    candidate = get_backend_root().parent / "frontend" / "dist"
    return candidate if candidate.is_dir() else None


def get_sitemap_directory() -> Path:
    """Dedicated folder for saved sitemap JSON snapshots."""
    return get_data_directory() / "sitemaps"


def get_screenshots_directory() -> Path:
    """PNG captures of remote pages (Playwright full-page screenshots)."""
    return get_data_directory() / "screenshots"


def get_exports_directory() -> Path:
    """User-exported files (CSV/JSON downloads) for desktop packaging."""
    return get_data_directory() / "exports"


def get_logs_directory() -> Path:
    """Backend runtime logs for troubleshooting desktop builds."""
    return get_data_directory() / "logs"


def get_config_file_path() -> Path:
    """Primary app config JSON (editable by users / installer scripts)."""
    return get_data_directory() / "config.json"


def ensure_app_data_directories() -> dict[str, Path]:
    """
    Create all writable app data folders and return them.
    Safe to call on startup in dev and packaged modes.
    """
    root = get_data_directory()
    dirs = {
        "data": root,
        "sitemaps": get_sitemap_directory(),
        "screenshots": get_screenshots_directory(),
        "exports": get_exports_directory(),
        "logs": get_logs_directory(),
    }
    for p in dirs.values():
        p.mkdir(parents=True, exist_ok=True)
    return dirs


def safe_join_data_path(*parts: str) -> Path:
    """
    Join under data root and block path traversal.
    Raises ValueError if the resolved path escapes data root.
    """
    root = get_data_directory().resolve()
    out = root.joinpath(*parts).resolve()
    if out == root or root in out.parents:
        return out
    raise ValueError("unsafe data path")


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
