from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from scraper import scrape_page
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

if __name__ == "__main__":
    app.run(debug=True)