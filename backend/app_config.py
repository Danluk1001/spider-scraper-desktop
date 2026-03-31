"""
Desktop/dev configuration helpers for Spider Scraper backend.

Config file location is managed by data_paths.get_config_file_path().
"""

from __future__ import annotations

import json
import os
from typing import Any

from data_paths import get_config_file_path

DEFAULT_CONFIG: dict[str, Any] = {
    "backend_host": "127.0.0.1",
    "backend_port": 5000,
    "backend_debug": True,
}


def load_app_config() -> dict[str, Any]:
    """
    Load config JSON and merge with defaults.
    Environment variable overrides are applied last.
    """
    cfg = dict(DEFAULT_CONFIG)
    path = get_config_file_path()
    try:
        if path.is_file():
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                for k, v in raw.items():
                    cfg[k] = v
    except (OSError, json.JSONDecodeError):
        pass

    host = os.environ.get("SPIDER_SCRAPER_HOST")
    port = os.environ.get("SPIDER_SCRAPER_PORT")
    debug = os.environ.get("SPIDER_SCRAPER_DEBUG")
    if host:
        cfg["backend_host"] = host
    if port:
        try:
            cfg["backend_port"] = int(port)
        except ValueError:
            pass
    if debug is not None:
        cfg["backend_debug"] = debug.lower() in ("1", "true", "yes", "on")
    return cfg


def save_app_config(cfg: dict[str, Any]) -> None:
    """Write user config JSON (pretty, UTF-8)."""
    path = get_config_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
