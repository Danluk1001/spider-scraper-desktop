from flask import Flask, jsonify, request
from flask_cors import CORS
from scraper import scrape_page

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

if __name__ == "__main__":
    app.run(debug=True)