import io
import json
import queue
import re
import threading
from datetime import datetime, timezone

from flask import Flask, Response, after_this_request, jsonify, request, send_file, stream_with_context
from flask_cors import CORS
from data_paths import get_sitemap_directory, iter_sitemap_json_files, resolve_sitemap_file
from scraper import crawl_site_depth, scrape_page
from media_zip import create_media_zip, fetch_url_for_download
import csv
import os
from typing import Optional

app = Flask(__name__)


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
    data = request.get_json()

    filename = "scrape_results.csv"

    with open(filename, mode="w", newline="", encoding="utf-8") as file:
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

    return send_file(
        os.path.abspath(filename),
        as_attachment=True
    )


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


@app.route("/api/sitemap/save", methods=["POST"])
def save_sitemap():
    """
    Save the current UI project state as JSON under backend/output/sitemaps/.
    Body: { rootUrl, pages, selectedPage, logs, savedAt }
    """
    data = request.get_json()
    if not isinstance(data, dict):
        return jsonify({"error": "JSON body required"}), 400

    for key in ("rootUrl", "pages", "logs", "savedAt"):
        if key not in data:
            return jsonify({"error": f"missing field: {key}"}), 400

    if not isinstance(data.get("pages"), list):
        return jsonify({"error": "pages must be an array"}), 400
    if not isinstance(data.get("logs"), list):
        return jsonify({"error": "logs must be an array"}), 400

    saved_at = str(data.get("savedAt", "")).strip()
    if not saved_at:
        return jsonify({"error": "savedAt must be non-empty"}), 400

    selected = data.get("selectedPage")
    if selected is not None and not isinstance(selected, dict):
        return jsonify({"error": "selectedPage must be an object or null"}), 400

    edges = data.get("edges")
    if edges is not None and not isinstance(edges, list):
        return jsonify({"error": "edges must be an array"}), 400

    payload = {
        "rootUrl": data.get("rootUrl"),
        "pages": data.get("pages"),
        "selectedPage": selected,
        "logs": data.get("logs"),
        "savedAt": saved_at,
        "edges": edges if isinstance(edges, list) else [],
    }

    sitemap_dir = get_sitemap_directory()
    sitemap_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe_sitemap_filename(saved_at)
    filename = f"sitemap-{stem}.json"
    out_path = sitemap_dir / filename

    n = 0
    while out_path.exists():
        n += 1
        filename = f"sitemap-{stem}-{n}.json"
        out_path = sitemap_dir / filename

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
    """List saved sitemap JSON files (newest first). Includes legacy output/sitemaps in dev."""
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
    """Return the contents of one saved sitemap JSON file."""
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


if __name__ == "__main__":
    # threaded=True helps long ZIP / download requests not block other clients
    app.run(debug=True, threaded=True)