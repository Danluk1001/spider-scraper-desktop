"""
Spider Scraper desktop shell: Flask backend + PyWebView window.

Usage (development, from repo root):
  python desktop/launcher.py --dev          # Vite HMR on :5173, Flask on :5000
  python desktop/launcher.py                # Flask serves frontend/dist + API on one port

Packaged (PyInstaller): run the built .exe; set SPIDER_SCRAPER_FRONTEND_DIST in the spec
or bundle ``frontend/dist`` under ``_MEIPASS/frontend/dist`` (see desktop/spider_scraper.spec).
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

WINDOW_TITLE = "Spider Scraper"
VITE_PORT = 5173


def _resolve_repo_root() -> Path:
    """Project root: repo in dev, or PyInstaller extract / exe folder when frozen."""
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def _backend_dir(root: Path) -> Path:
    return root / "backend"


def _ensure_backend_on_path(root: Path) -> None:
    """Dev: add ``repo/backend`` so ``import app`` works. Frozen: prepend ``sys._MEIPASS``."""
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            s = str(meipass)
            if s not in sys.path:
                sys.path.insert(0, s)
        return
    b = _backend_dir(root)
    if b.is_dir():
        s = str(b)
        if s not in sys.path:
            sys.path.insert(0, s)


def _apply_packaged_env(root: Path, dev: bool) -> None:
    """Point Flask at bundled ``frontend/dist`` and serve the SPA (non-dev only)."""
    if dev:
        return
    dist = root / "frontend" / "dist"
    os.environ["SPIDER_SCRAPER_SERVE_FRONTEND"] = "1"
    os.environ.setdefault("SPIDER_SCRAPER_FRONTEND_DIST", str(dist))
    # Stable desktop runs: no Flask reloader / extra threads from debug toolbar.
    os.environ.setdefault("SPIDER_SCRAPER_DEBUG", "0")
    # Optional bundled Playwright browsers: _MEIPASS/ms-playwright.
    bundled_pw = root / "ms-playwright"
    if bundled_pw.is_dir():
        os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(bundled_pw))


def _wait_for_http(url: str, timeout: float = 90.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urlopen(url, timeout=2) as r:
                if getattr(r, "status", 200) in (200, 204):
                    return True
        except (URLError, OSError, TimeoutError):
            time.sleep(0.15)
    return False


def _run_flask() -> None:
    _ensure_backend_on_path(REPO_ROOT)
    # Import after main() sets SPIDER_SCRAPER_* env vars.
    from app import app as flask_app  # noqa: WPS433
    from app_config import load_app_config

    cfg = load_app_config()
    host = str(cfg.get("backend_host") or "127.0.0.1")
    port = int(cfg.get("backend_port") or 5000)
    flask_app.run(
        host=host,
        port=port,
        debug=False,
        threaded=True,
        use_reloader=False,
    )


def _flask_base_url() -> str:
    _ensure_backend_on_path(REPO_ROOT)
    from app_config import load_app_config

    cfg = load_app_config()
    port = int(cfg.get("backend_port") or 5000)
    return f"http://127.0.0.1:{port}"


def _icon_path(root: Path) -> str | None:
    candidates = [
        root / "desktop" / "resources" / "icon.ico",
        root / "resources" / "icon.ico",
    ]
    for p in candidates:
        if p.is_file():
            return str(p)
    return None


REPO_ROOT = _resolve_repo_root()


def main() -> None:
    global REPO_ROOT
    parser = argparse.ArgumentParser(description="Spider Scraper desktop launcher")
    parser.add_argument(
        "--dev",
        action="store_true",
        help="Run Vite dev server (HMR); webview loads :%s; Flask still serves /api." % VITE_PORT,
    )
    parser.add_argument(
        "--no-webview",
        action="store_true",
        help="Start servers only (no PyWebView window).",
    )
    args = parser.parse_args()

    if os.environ.get("SPIDER_SCRAPER_REPO_ROOT"):
        REPO_ROOT = Path(os.environ["SPIDER_SCRAPER_REPO_ROOT"]).expanduser().resolve()

    _apply_packaged_env(REPO_ROOT, dev=args.dev)

    if not args.dev:
        dist = REPO_ROOT / "frontend" / "dist"
        if not (dist / "index.html").is_file():
            print(
                "Production mode requires a built frontend. From repo root:\n"
                "  cd frontend\n"
                "  set VITE_DESKTOP_MODE=1\n"
                "  npm run build",
                file=sys.stderr,
            )
            sys.exit(1)

    flask_thread = threading.Thread(target=_run_flask, daemon=True)
    flask_thread.start()

    base = _flask_base_url()
    health = f"{base}/api/health"
    if not _wait_for_http(health):
        print("Flask did not become ready at " + health, file=sys.stderr)
        sys.exit(1)

    vite_proc: subprocess.Popen | None = None
    url: str
    if args.dev:
        npm = shutil.which("npm")
        if not npm:
            print("npm not found in PATH (install Node.js).", file=sys.stderr)
            sys.exit(1)
        fe = REPO_ROOT / "frontend"
        if not (fe / "package.json").is_file():
            print("frontend/package.json missing.", file=sys.stderr)
            sys.exit(1)
        popen_kw: dict = {
            "cwd": str(fe),
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
        }
        if sys.platform == "win32":
            popen_kw["creationflags"] = subprocess.CREATE_NO_WINDOW
        vite_proc = subprocess.Popen(
            [
                npm,
                "run",
                "dev",
                "--",
                "--host",
                "127.0.0.1",
                "--port",
                str(VITE_PORT),
                "--strictPort",
            ],
            **popen_kw,
        )
        url = f"http://127.0.0.1:{VITE_PORT}/"
        if not _wait_for_http(url):
            print(
                "Vite did not start on port %s. Run `npm run dev` in frontend/ to see errors."
                % VITE_PORT,
                file=sys.stderr,
            )
            vite_proc.terminate()
            sys.exit(1)
    else:
        url = f"{base}/"

    if args.no_webview:
        print("Flask:", base)
        print("Open:", url)
        print("Press Ctrl+C to stop.")
        try:
            if vite_proc:
                vite_proc.wait()
            else:
                while True:
                    time.sleep(3600)
        except KeyboardInterrupt:
            if vite_proc:
                vite_proc.terminate()
        return

    import webview

    icon = _icon_path(REPO_ROOT)
    if icon:
        webview.create_window(WINDOW_TITLE, url, icon=icon)
    else:
        webview.create_window(WINDOW_TITLE, url)
    try:
        webview.start(debug=False)
    finally:
        if vite_proc:
            vite_proc.terminate()


if __name__ == "__main__":
    main()
