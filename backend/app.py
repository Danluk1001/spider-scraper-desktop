import io

from flask import Flask, after_this_request, jsonify, request, send_file
from flask_cors import CORS
from scraper import crawl_site, scrape_page
from media_zip import create_media_zip, fetch_url_for_download
import csv
import os

app = Flask(__name__)
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
    """Breadth-first crawl of every same-site page reachable from the start URL."""
    data = request.get_json() or {}
    url = (data.get("url") or "").strip()

    if not url:
        return jsonify({"error": "URL is required"}), 400

    max_pages = data.get("max_pages")
    if max_pages is not None:
        try:
            max_pages = int(max_pages)
            if max_pages < 1:
                max_pages = None
        except (TypeError, ValueError):
            max_pages = None

    try:
        result = crawl_site(url, max_pages=max_pages)
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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


if __name__ == "__main__":
    # threaded=True helps long ZIP / download requests not block other clients
    app.run(debug=True, threaded=True)