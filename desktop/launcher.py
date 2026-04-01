"""
Spider Scraper desktop shell: Flask backend + PyWebView window.

Usage (development, from repo root):
  python desktop/launcher.py --dev          # Vite HMR on :5173, Flask on :5000
  python desktop/launcher.py                # Flask serves frontend/dist + API on one port
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

WINDOW_TITLE = "Spider-Scraper"
VITE_PORT = 5173


def _resolve_repo_root() -> Path:
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def _backend_dir(root: Path) -> Path:
    return root / "backend"


def _ensure_backend_on_path(root: Path) -> None:
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
    if dev:
        os.environ.pop("SPIDER_SCRAPER_SERVE_FRONTEND", None)
        os.environ.pop("SPIDER_SCRAPER_FRONTEND_DIST", None)
        return

    dist = (root / "frontend" / "dist").resolve()
    os.environ["SPIDER_SCRAPER_SERVE_FRONTEND"] = "1"
    os.environ["SPIDER_SCRAPER_FRONTEND_DIST"] = str(dist)
    os.environ.setdefault("SPIDER_SCRAPER_DEBUG", "0")

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


def _run_flask(dev_mode: bool) -> None:
    _ensure_backend_on_path(REPO_ROOT)

    if dev_mode:
        os.environ.pop("SPIDER_SCRAPER_SERVE_FRONTEND", None)
        os.environ.pop("SPIDER_SCRAPER_FRONTEND_DIST", None)
    else:
        dist = (REPO_ROOT / "frontend" / "dist").resolve()
        os.environ["SPIDER_SCRAPER_SERVE_FRONTEND"] = "1"
        os.environ["SPIDER_SCRAPER_FRONTEND_DIST"] = str(dist)

    from app import app as flask_app
    from app_config import load_app_config

    cfg = load_app_config()
    host = str(cfg.get("backend_host") or "127.0.0.1")
    port = int(cfg.get("backend_port") or 5000)

    try:
        from waitress import serve as waitress_serve
    except ImportError:
        flask_app.run(
            host=host,
            port=port,
            debug=False,
            threaded=True,
            use_reloader=False,
        )
    else:
        waitress_serve(flask_app, host=host, port=port, threads=8)


def _flask_base_url() -> str:
    _ensure_backend_on_path(REPO_ROOT)
    from app_config import load_app_config

    cfg = load_app_config()
    port = int(cfg.get("backend_port") or 5000)
    return f"http://127.0.0.1:{port}"


REPO_ROOT = _resolve_repo_root()


def main() -> None:
    global REPO_ROOT

    parser = argparse.ArgumentParser(description="Spider Scraper desktop launcher")
    parser.add_argument(
        "--dev",
        action="store_true",
        help=f"Run Vite dev server (HMR); webview loads :{VITE_PORT}; Flask still serves /api.",
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

    print("SPIDER_SCRAPER_SERVE_FRONTEND =", os.environ.get("SPIDER_SCRAPER_SERVE_FRONTEND"))
    print("SPIDER_SCRAPER_FRONTEND_DIST =", os.environ.get("SPIDER_SCRAPER_FRONTEND_DIST"))

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

    flask_thread = threading.Thread(target=_run_flask, args=(args.dev,), daemon=True)
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
                f"Vite did not start on port {VITE_PORT}. Run `npm run dev` in frontend/ to see errors.",
                file=sys.stderr,
            )
            vite_proc.terminate()
            sys.exit(1)
    else:
        url = f"{base}/"

    print(f"[Spider-Scraper launcher] PyWebView URL: {url}", flush=True)

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

    webview.create_window(
        WINDOW_TITLE,
        url,
        width=1600,
        height=950,
        min_size=(1200, 700),
    )

    try:
        webview.start(debug=False)
    finally:
        if vite_proc:
            vite_proc.terminate()


if __name__ == "__main__":
    main()