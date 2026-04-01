import os
import sys

print("backend sees SPIDER_SCRAPER_SERVE_FRONTEND =", os.environ.get("SPIDER_SCRAPER_SERVE_FRONTEND"))
print("backend sees SPIDER_SCRAPER_FRONTEND_DIST =", os.environ.get("SPIDER_SCRAPER_FRONTEND_DIST"))

import csv
import io
import json
import logging
import queue
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from flask import (
    Flask,
    Response,
    abort,
    after_this_request,
    jsonify,
    request,
    send_file,
    send_from_directory,
    stream_with_context,
)
from flask_cors import CORS
from app_config import load_app_config, save_app_config
from data_paths import (
    ensure_app_data_directories,
    get_exports_directory,
    get_logs_directory,
    get_screenshots_directory,
    get_sitemap_directory,
    iter_sitemap_json_files,
    resolve_sitemap_file,
    safe_join_data_path,
)
from page_screenshot import (
    PageScreenshotError,
    PlaywrightMissingError,
    capture_page_screenshot_png,
    inspect_playwright_environment,
)
from scraper import crawl_site_depth, scrape_page
from media_zip import create_media_zip, fetch_url_for_download

app = Flask(__name__)
logger = logging.getLogger(__name__)

# Ensure packaged app always has writable folders on startup.
_APP_DIRS = ensure_app_data_directories()
_APP_CONFIG = load_app_config()

# Desktop-friendly logging: file + stderr.
try:
    _LOG_PATH = get_logs_directory() / "backend.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[logging.FileHandler(_LOG_PATH, encoding="utf-8"), logging.StreamHandler()],
    )
except OSError:
    logging.basicConfig(level=logging.INFO)

log = logging.getLogger("spider_scraper.backend")


def _parse_max_pages(data: dict) -> Optional[int]:
    """
    Optional crawl size cap. None = no limit (crawl all reachable pages within depth).
    JSON: omit max_pages or use null for unlimited; positive int caps total pages.
    """
    raw = data.get("max_pages")
    if raw is None:
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    if n < 1:
        return None
    return n
CORS(app)

@app.route("/api/health")
def health():
    return jsonify({"status": "Spider Scraper backend is running"})


@app.route("/api/config", methods=["GET"])
def api_get_config():
    """Return effective backend config (file + env overrides)."""
    cfg = load_app_config()
    return jsonify({"config": cfg})


@app.route("/api/config", methods=["POST"])
def api_save_config():
    """
    Save backend config JSON for desktop use.
    Body: { "config": { ... } }
    """
    data = request.get_json() or {}
    cfg = data.get("config")
    if not isinstance(cfg, dict):
        return jsonify({"error": "config must be an object"}), 400
    try:
        save_app_config(cfg)
    except OSError as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True, "config": cfg})

@app.route("/api/scrape", methods=["POST"])
def scrape():
    data = request.get_json()
    url = data.get("url", "").strip()

    if not url:
        return jsonify({"error": "URL is required"}), 400

    try:
        result = scrape_page(url)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/crawl", methods=["POST"])
def crawl():
    """
    Same-host crawl with depth limit and graph edges.

    JSON body:
      url (required)
      crawl_depth: 1 = root only, 2 = root + direct links, 3 = + one more hop (default 2)
      max_pages: optional positive int cap; omit or null for no limit
    """
    data = request.get_json() or {}
    url = (data.get("url") or "").strip()

    if not url:
        return jsonify({"error": "URL is required"}), 400

    crawl_depth = data.get("crawl_depth", 2)
    try:
        crawl_depth = int(crawl_depth)
    except (TypeError, ValueError):
        crawl_depth = 2
    crawl_depth = max(1, min(3, crawl_depth))

    max_pages = _parse_max_pages(data)

    try:
        result = crawl_site_depth(url, crawl_depth=crawl_depth, max_pages=max_pages)
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/crawl/stream", methods=["POST"])
def crawl_stream():
    """
    Same crawl as POST /api/crawl, but streams NDJSON lines:
      {"type":"progress","phase":"page_start","current":N,"total":M,"url":"..."}
      {"type":"done","data":{...}}  — same shape as the JSON-only /api/crawl response
      {"type":"error","message":"..."}  — optional "code": 400 for bad input
    """
    data = request.get_json() or {}
    url = (data.get("url") or "").strip()

    if not url:
        return jsonify({"error": "URL is required"}), 400

    crawl_depth = data.get("crawl_depth", 2)
    try:
        crawl_depth = int(crawl_depth)
    except (TypeError, ValueError):
        crawl_depth = 2
    crawl_depth = max(1, min(3, crawl_depth))

    max_pages = _parse_max_pages(data)

    def generate():
        q: queue.Queue = queue.Queue()

        def worker() -> None:
            try:

                def on_progress(ev: dict) -> None:
                    q.put(("progress", ev))

                result = crawl_site_depth(
                    url,
                    crawl_depth=crawl_depth,
                    max_pages=max_pages,
                    on_progress=on_progress,
                )
                q.put(("done", result))
            except ValueError as e:
                q.put(("bad_request", str(e)))
            except Exception as e:
                q.put(("error", str(e)))

        threading.Thread(target=worker, daemon=True).start()

        while True:
            kind, payload = q.get()
            if kind == "progress":
                yield json.dumps(payload) + "\n"
            elif kind == "done":
                yield json.dumps({"type": "done", "data": payload}) + "\n"
                break
            elif kind == "bad_request":
                yield json.dumps({"type": "error", "message": payload, "code": 400}) + "\n"
                break
            elif kind == "error":
                yield json.dumps({"type": "error", "message": payload}) + "\n"
                break

    return Response(stream_with_context(generate()), mimetype="application/x-ndjson")


@app.route("/api/export", methods=["POST"])
def export_csv():
    data = request.get_json() or {}
    export_dir = get_exports_directory()
    export_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    filename = f"scrape-results-{stamp}.csv"
    out_path = safe_join_data_path("exports", filename)

    with open(out_path, mode="w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        writer.writerow(["Title", "URL", "Paragraph Count"])

        writer.writerow([
            data.get("title", ""),
            data.get("url", ""),
            data.get("paragraph_count", 0)
        ])

        writer.writerow([])
        writer.writerow(["Preview Content"])

        for item in data.get("preview", []):
            writer.writerow([item])

    return send_file(str(out_path), as_attachment=True, download_name=filename)


def _list_len(obj, key: str) -> int:
    v = obj.get(key) if isinstance(obj, dict) else None
    return len(v) if isinstance(v, list) else 0


@app.route("/api/export/pages-csv", methods=["POST"])
def export_pages_csv():
    """
    Download all crawled pages as CSV.
    Body: { "pages": [ { title, category, url, paragraph_count, links, images, videos, ... }, ... ] }
    Columns: title, category, url, paragraph_count, image_count, video_count, link_count
    """
    data = request.get_json() or {}
    pages = data.get("pages")
    if not isinstance(pages, list):
        return jsonify({"error": "pages must be an array"}), 400

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        [
            "title",
            "category",
            "url",
            "paragraph_count",
            "image_count",
            "video_count",
            "link_count",
        ]
    )

    for p in pages:
        if not isinstance(p, dict):
            continue
        try:
            pc = int(p.get("paragraph_count", 0) or 0)
        except (TypeError, ValueError):
            pc = 0
        writer.writerow(
            [
                p.get("title") or "",
                p.get("category") or "",
                p.get("url") or "",
                pc,
                _list_len(p, "images"),
                _list_len(p, "videos"),
                _list_len(p, "links"),
            ]
        )

    binary = io.BytesIO(buf.getvalue().encode("utf-8-sig"))
    binary.seek(0)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return send_file(
        binary,
        mimetype="text/csv; charset=utf-8",
        as_attachment=True,
        download_name=f"spider-scraper-pages-{stamp}.csv",
        max_age=0,
    )


@app.route("/api/export/sitemap-json", methods=["POST"])
def export_sitemap_json():
    """
    Download full sitemap snapshot as JSON (same structured fields as Save Sitemap).
    Body: { "rootUrl", "pages", "selectedPage", "logs" } — optional "savedAt" passthrough.
    Adds "exportedAt" (ISO UTC) on the server.
    """
    data = request.get_json()
    if not isinstance(data, dict):
        return jsonify({"error": "JSON body required"}), 400

    pages = data.get("pages")
    if pages is not None and not isinstance(pages, list):
        return jsonify({"error": "pages must be an array"}), 400
    logs = data.get("logs")
    if logs is not None and not isinstance(logs, list):
        return jsonify({"error": "logs must be an array"}), 400

    selected = data.get("selectedPage")
    if selected is not None and not isinstance(selected, dict):
        return jsonify({"error": "selectedPage must be an object or null"}), 400

    edges = data.get("edges")
    if edges is not None and not isinstance(edges, list):
        return jsonify({"error": "edges must be an array"}), 400

    exported_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "rootUrl": data.get("rootUrl"),
        "pages": pages if isinstance(pages, list) else [],
        "selectedPage": selected,
        "logs": logs if isinstance(logs, list) else [],
        "edges": edges if isinstance(edges, list) else [],
        "exportedAt": exported_at,
    }
    if isinstance(data.get("savedAt"), str) and data.get("savedAt"):
        payload["savedAt"] = data.get("savedAt")

    raw = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
    binary = io.BytesIO(raw)
    binary.seek(0)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return send_file(
        binary,
        mimetype="application/json; charset=utf-8",
        as_attachment=True,
        download_name=f"spider-scraper-sitemap-{stamp}.json",
        max_age=0,
    )


@app.route("/api/fetch-file", methods=["POST"])
def fetch_file():
    data = request.get_json() or {}
    url = (data.get("url") or "").strip()
    body, filename, err = fetch_url_for_download(url)
    if err or body is None:
        return jsonify({"error": err or "download_failed"}), 400
    return send_file(
        io.BytesIO(body),
        as_attachment=True,
        download_name=filename,
        max_age=0,
    )


@app.route("/api/export-media-zip", methods=["POST"])
def export_media_zip():
    data = request.get_json() or {}
    mode = (data.get("mode") or "images").strip().lower()
    if mode not in ("images", "videos"):
        return jsonify({"error": "mode must be images or videos"}), 400

    entries = data.get("entries")
    if not isinstance(entries, list) or len(entries) == 0:
        return jsonify({"error": "entries must be a non-empty list"}), 400

    cleaned = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        mu = (e.get("mediaUrl") or "").strip()
        sp = (e.get("sourcePageUrl") or "").strip()
        if mu and sp:
            cleaned.append({"mediaUrl": mu, "sourcePageUrl": sp})

    if not cleaned:
        return jsonify({"error": "no valid entries with mediaUrl and sourcePageUrl"}), 400

    try:
        zip_path = create_media_zip(cleaned, mode)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    download_name = f"spider-scraper-{mode}.zip"

    @after_this_request
    def remove_zip(response):
        try:
            os.remove(zip_path)
        except OSError:
            pass
        return response

    return send_file(
        zip_path,
        mimetype="application/zip",
        as_attachment=True,
        download_name=download_name,
    )


def _safe_sitemap_filename(saved_at: str) -> str:
    """Filesystem-safe stem from ISO timestamp (e.g. 2026-03-29T12-30-00.000Z)."""
    s = re.sub(r"[^\w.\-]+", "-", saved_at.strip().replace(":", "-"))
    s = re.sub(r"-+", "-", s).strip("-") or "snapshot"
    return s[:160]


# Windows reserved device names (case-insensitive); invalid as a file basename.
_WIN_RESERVED_BASENAMES = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }
)


def _sanitize_user_sitemap_filename(name: str) -> str | None:
    """
    Turn user input into a single safe *.json basename (under data/sitemaps/).
    Appends .json when missing. Rejects path tricks, odd characters, and
    Windows reserved names (CON, NUL, COM1, …).
    """
    name = (name or "").strip()
    if not name:
        return None
    if not name.lower().endswith(".json"):
        name = name + ".json"
    base = os.path.basename(name)
    if base != name:
        return None
    if ".." in base or "/" in base or "\\" in base:
        return None
    stem = base[:-5]
    if len(stem) == 0 or len(stem) > 180:
        return None
    if not re.match(r"^[a-zA-Z0-9._\- ()]+$", stem):
        return None
    safe_stem = re.sub(r"\s+", "_", stem.strip())
    # Strip trailing dots/spaces (Windows disallows names ending in . or space)
    safe_stem = safe_stem.rstrip(". ").strip()
    if not safe_stem:
        return None
    if safe_stem.upper() in _WIN_RESERVED_BASENAMES:
        return None
    return f"{safe_stem}.json"


def _unique_sitemap_path(sitemap_dir: Path, filename: str) -> Path:
    """Pick a path that does not exist yet (adds -1, -2, … before .json)."""
    out_path = sitemap_dir / filename
    if not out_path.exists():
        return out_path
    if not filename.lower().endswith(".json"):
        return out_path
    stem = filename[:-5]
    n = 1
    while True:
        cand = sitemap_dir / f"{stem}-{n}.json"
        if not cand.exists():
            return cand
        n += 1


@app.route("/api/sitemap/save", methods=["POST"])
def save_sitemap():
    """
    Save the current UI project state as JSON under data/sitemaps/ (see get_sitemap_directory).

    Body:
      Required: rootUrl, pages, logs
      Optional: savedAt (defaults to server UTC ISO), edges, selectedPage, crawlDepth,
      selectedPageId, selectedPageUrl, filename (custom basename; .json added if omitted)
    """
    data = request.get_json()
    if not isinstance(data, dict):
        return jsonify({"error": "JSON body required"}), 400

    for key in ("rootUrl", "pages", "logs"):
        if key not in data:
            return jsonify({"error": f"missing field: {key}"}), 400

    if not isinstance(data.get("pages"), list):
        return jsonify({"error": "pages must be an array"}), 400
    if not isinstance(data.get("logs"), list):
        return jsonify({"error": "logs must be an array"}), 400

    saved_at = str(data.get("savedAt", "")).strip()
    if not saved_at:
        saved_at = datetime.now(timezone.utc).isoformat()

    selected = data.get("selectedPage")
    if selected is not None and not isinstance(selected, dict):
        return jsonify({"error": "selectedPage must be an object or null"}), 400

    edges = data.get("edges")
    if edges is not None and not isinstance(edges, list):
        return jsonify({"error": "edges must be an array"}), 400

    crawl_depth = data.get("crawlDepth")
    if crawl_depth is not None:
        if not isinstance(crawl_depth, int) or crawl_depth not in (1, 2, 3):
            return jsonify({"error": "crawlDepth must be 1, 2, or 3"}), 400

    sel_id = data.get("selectedPageId")
    if sel_id is not None and not isinstance(sel_id, str):
        return jsonify({"error": "selectedPageId must be a string or null"}), 400
    sel_url = data.get("selectedPageUrl")
    if sel_url is not None and not isinstance(sel_url, str):
        return jsonify({"error": "selectedPageUrl must be a string or null"}), 400

    payload = {
        "rootUrl": data.get("rootUrl"),
        "crawlDepth": crawl_depth,
        "pages": data.get("pages"),
        "edges": edges if isinstance(edges, list) else [],
        "logs": data.get("logs"),
        "selectedPage": selected,
        "selectedPageId": sel_id,
        "selectedPageUrl": sel_url,
        "savedAt": saved_at,
    }

    sitemap_dir = get_sitemap_directory()
    sitemap_dir.mkdir(parents=True, exist_ok=True)

    user_fn = data.get("filename")
    if isinstance(user_fn, str) and user_fn.strip():
        filename = _sanitize_user_sitemap_filename(user_fn.strip())
        if not filename:
            return jsonify({"error": "invalid filename"}), 400
    else:
        stem = _safe_sitemap_filename(saved_at)
        filename = f"sitemap-{stem}.json"

    out_path = _unique_sitemap_path(sitemap_dir, filename)

    try:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
    except OSError as e:
        return jsonify({"error": f"could not write file: {e}"}), 500

    return jsonify(
        {
            "ok": True,
            "filename": out_path.name,
            "path": str(out_path.resolve()),
        }
    )


def _is_safe_sitemap_basename(name: str) -> bool:
    """Reject path traversal; only allow *.json basenames."""
    if not name or not isinstance(name, str):
        return False
    name = name.strip()
    if not name.endswith(".json"):
        return False
    if name != os.path.basename(name):
        return False
    if ".." in name or "/" in name or "\\" in name:
        return False
    return True


@app.route("/api/sitemap/list", methods=["GET"])
def list_sitemaps():
    """
    GET /api/sitemap/list — list saved sitemap JSON files (newest first).

    Response: { "files": [ { "filename", "path", "modified" }, ... ] }
    Primary folder: data/sitemaps/; legacy dev copies under output/sitemaps may appear too.
    """
    paths = iter_sitemap_json_files()
    if not paths:
        return jsonify({"files": []})

    files = []
    for p in paths:
        try:
            m = p.stat().st_mtime
            modified = datetime.fromtimestamp(m, tz=timezone.utc).isoformat()
        except OSError:
            modified = ""
        files.append(
            {
                "filename": p.name,
                "path": str(p.resolve()),
                "modified": modified,
            }
        )
    return jsonify({"files": files})


@app.route("/api/sitemap/load", methods=["GET"])
def load_sitemap():
    """
    GET /api/sitemap/load?filename=… — return one saved sitemap JSON object.

    Query: filename must be a safe *.json basename (no path segments).
    Response: same JSON written by Save Sitemap (rootUrl, crawlDepth, pages, edges, …).
    Errors: { "error": "…" } with 400 / 404 / 500.
    """
    filename = (request.args.get("filename") or "").strip()
    if not _is_safe_sitemap_basename(filename):
        return jsonify({"error": "invalid filename"}), 400

    path = resolve_sitemap_file(filename)
    if path is None:
        return jsonify({"error": "file not found"}), 404

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        return jsonify({"error": str(e)}), 500

    if not isinstance(data, dict):
        return jsonify({"error": "invalid sitemap format"}), 400

    return jsonify(data)


def _is_safe_screenshot_basename(name: str) -> bool:
    """Only allow simple .png names under the screenshots folder."""
    if not name or not isinstance(name, str):
        return False
    name = name.strip()
    if not name.endswith(".png"):
        return False
    if name != os.path.basename(name):
        return False
    if ".." in name or "/" in name or "\\" in name:
        return False
    return bool(re.match(r"^[a-zA-Z0-9_.-]+\.png$", name))


def _screenshot_index_path() -> str:
    root = get_screenshots_directory()
    root.mkdir(parents=True, exist_ok=True)
    return str(root / "index.json")


def _load_screenshot_index() -> list[dict[str, Any]]:
    path = _screenshot_index_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return []
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for row in data:
        if isinstance(row, dict):
            out.append(row)
    return out


def _save_screenshot_index(items: list[dict[str, Any]]) -> None:
    path = _screenshot_index_path()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=True, indent=2)


def _append_screenshot_metadata(
    *,
    filename: str,
    image_url: str,
    page_url: str,
    page_title: str | None,
) -> dict[str, Any]:
    items = _load_screenshot_index()
    rec: dict[str, Any] = {
        "filename": filename,
        "image_url": image_url,
        "imageUrl": image_url,
        "pageUrl": page_url,
        "pageTitle": (page_title or "").strip() or None,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
    }
    items.insert(0, rec)
    # Keep recent history only (dev-first, keeps JSON small).
    if len(items) > 300:
        items = items[:300]
    _save_screenshot_index(items)
    return rec


@app.route("/api/screenshot", methods=["POST"])
def api_screenshot_capture():
    """
    Capture a full-page PNG of a remote URL using headless Chromium (Playwright).

    JSON body: { "url": "https://...", "pageTitle": "..." (optional) }

    Success: { "ok": true, "filename", "image_url", "saved_path", "page_url" }
    Failure: { "ok": false, "error": "short_code", "message": "..." }
    """
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    page_title = (data.get("pageTitle") or data.get("page_title") or "").strip()

    logger.info("screenshot API: capture requested url=%s", url[:500] if url else "")

    if not url:
        return (
            jsonify({"ok": False, "error": "url_required", "message": "url is required"}),
            400,
        )
    if not url.startswith(("http://", "https://")):
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "invalid_url",
                    "message": "url must start with http:// or https://",
                }
            ),
            400,
        )

    try:
        path = capture_page_screenshot_png(url)
    except PlaywrightMissingError as e:
        logger.warning("screenshot API: playwright missing: %s", e)
        diag = inspect_playwright_environment()
        payload: dict[str, Any] = {
            "ok": False,
            "error": "playwright_missing",
            "message": (
                "Playwright is not installed in the active backend Python environment. "
                "Install the `playwright` package and Chromium into the same interpreter "
                "shown in python_executable (the one used by desktop/launcher.py)."
            ),
            "python_executable": diag.get("python_executable", sys.executable),
            "playwright_import_ok": diag.get("playwright_import_ok", False),
            "chromium_available": diag.get("chromium_available"),
        }
        if "import_error" in diag:
            payload["import_error"] = diag["import_error"]
        if "chromium_error" in diag:
            payload["chromium_error"] = diag["chromium_error"]
        return jsonify(payload), 503
    except PageScreenshotError as e:
        logger.warning("screenshot API: capture failed: %s", e)
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "capture_failed",
                    "message": str(e),
                    "python_executable": sys.executable,
                }
            ),
            502,
        )
    except Exception as e:
        logger.exception("screenshot API: unexpected error")
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "internal_error",
                    "message": str(e),
                }
            ),
            500,
        )

    filename = path.name
    saved_abs = str(path.resolve())
    image_url = f"/screenshots/{filename}"
    logger.info("screenshot API: saved filename=%s path=%s", filename, saved_abs)

    _append_screenshot_metadata(
        filename=filename,
        image_url=image_url,
        page_url=url,
        page_title=page_title or None,
    )

    return jsonify(
        {
            "ok": True,
            "filename": filename,
            "image_url": image_url,
            "saved_path": saved_abs,
            "page_url": url,
        }
    )


@app.route("/api/screenshots/<filename>", methods=["GET"])
@app.route("/screenshots/<filename>", methods=["GET"])
def api_screenshot_file(filename: str):
    """Serve a PNG saved by POST /api/screenshot (same file under both URL prefixes)."""
    if not _is_safe_screenshot_basename(filename):
        return jsonify({"error": "invalid filename"}), 400
    root = get_screenshots_directory()
    path = root / filename
    try:
        if not path.is_file():
            return jsonify({"error": "not found"}), 404
        if path.resolve().parent != root.resolve():
            return jsonify({"error": "invalid path"}), 400
    except OSError:
        return jsonify({"error": "not found"}), 404

    return send_file(path, mimetype="image/png", max_age=0)


@app.route("/api/screenshots", methods=["GET"])
def api_screenshot_list():
    """
    List saved screenshot metadata for the gallery UI.
    Returns newest-first items from screenshots/index.json.
    """
    items = _load_screenshot_index()
    root = get_screenshots_directory()
    out: list[dict[str, Any]] = []
    for row in items:
        filename = str(row.get("filename") or "").strip()
        image_url = str(
            row.get("image_url") or row.get("imageUrl") or "",
        ).strip()
        if not _is_safe_screenshot_basename(filename):
            continue
        path = root / filename
        if not path.is_file():
            continue
        if not image_url:
            image_url = f"/screenshots/{filename}"
        out.append(
            {
                "filename": filename,
                "imageUrl": image_url,
                "image_url": image_url,
                "pageUrl": str(row.get("pageUrl") or ""),
                "pageTitle": row.get("pageTitle"),
                "capturedAt": str(row.get("capturedAt") or ""),
            }
        )
    return jsonify({"items": out})


# Desktop / PyInstaller: serve the built Vite app from the same origin as the API.
# API routes registered above take precedence. Static SPA routes are registered last.
# Production desktop env (set only by desktop/launcher.py before import):
#   SPIDER_SCRAPER_SERVE_FRONTEND=1
#   SPIDER_SCRAPER_FRONTEND_DIST=<absolute path to frontend/dist>


def _spa_dist_for_request() -> Path | None:
    if os.environ.get("SPIDER_SCRAPER_SERVE_FRONTEND") != "1":
        return None
    raw = os.environ.get("SPIDER_SCRAPER_FRONTEND_DIST")
    if not raw:
        return None
    p = Path(raw).expanduser().resolve()
    return p if p.is_dir() else None


def _serve_spa_impl(path: str):
    """Serve files under dist or fall back to index.html for client-side routes."""
    spa_root = _spa_dist_for_request()
    if spa_root is None or not spa_root.is_dir():
        abort(404)
    if path == "api" or path.startswith("api/"):
        abort(404)
    root = spa_root.resolve()
    if path:
        target = (spa_root / path).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            return send_from_directory(str(spa_root), "index.html")
        try:
            if target.is_file():
                return send_file(target)
        except OSError:
            pass
    return send_from_directory(str(spa_root), "index.html")


@app.route("/__desktop_debug")
def desktop_debug():
    """JSON snapshot of desktop SPA env (read directly from os.environ)."""
    resolved = _spa_dist_for_request()
    idx = (resolved / "index.html") if resolved else None
    return jsonify(
        {
            "SPIDER_SCRAPER_SERVE_FRONTEND": os.environ.get("SPIDER_SCRAPER_SERVE_FRONTEND"),
            "SPIDER_SCRAPER_FRONTEND_DIST": os.environ.get("SPIDER_SCRAPER_FRONTEND_DIST"),
            "resolved_spa_root": str(resolved) if resolved else None,
            "resolved_spa_root_exists": resolved.is_dir() if resolved else False,
            "index_html_exists": idx.is_file() if idx else False,
            "index_html_path": str(idx) if idx else None,
            "request_path": request.path,
        }
    )


@app.route("/")
def serve_spa_root():
    """Root URL: always serve index.html when desktop SPA mode is active."""
    return _serve_spa_impl("")


@app.route("/<path:path>")
def serve_spa_catchall(path: str):
    """Assets and deep links; unknown paths fall back to index.html inside _serve_spa_impl."""
    return _serve_spa_impl(path)


if __name__ == "__main__":
    # threaded=True helps long ZIP / download requests not block other clients
    app.run(
        host=str(_APP_CONFIG.get("backend_host") or "127.0.0.1"),
        port=int(_APP_CONFIG.get("backend_port") or 5000),
        debug=bool(_APP_CONFIG.get("backend_debug", True)),
        threaded=True,
    )