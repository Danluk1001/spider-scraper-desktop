import { useState } from "react";
import axios from "axios";

type ScrapeResult = {
  title: string;
  url: string;
  paragraph_count: number;
  preview: string[];
};

export default function Home() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ScrapeResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleScrape = async () => {
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const response = await axios.post("http://127.0.0.1:5000/api/scrape", {
        url,
      });

      setResult(response.data);
    } catch (err: any) {
      setError(err?.response?.data?.error || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: "800px", margin: "40px auto", fontFamily: "Arial" }}>
      <h1>Spider Scraper Desktop</h1>
      <p>Enter a URL and preview basic page content.</p>

      <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
        <input
          type="text"
          placeholder="https://example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{
            flex: 1,
            padding: "12px",
            fontSize: "16px",
            border: "1px solid #ccc",
            borderRadius: "8px",
          }}
        />
        <button
          onClick={handleScrape}
          disabled={loading}
          style={{
            padding: "12px 18px",
            fontSize: "16px",
            border: "none",
            borderRadius: "8px",
            cursor: "pointer",
          }}
        >
          {loading ? "Scraping..." : "Scrape"}
        </button>
      </div>

      {error && (
        <div style={{ color: "red", marginBottom: "20px" }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {result && (
        <div style={{ border: "1px solid #ddd", padding: "20px", borderRadius: "10px" }}>
          <h2>{result.title}</h2>
          <p><strong>URL:</strong> {result.url}</p>
          <p><strong>Paragraphs Found:</strong> {result.paragraph_count}</p>

          <h3>Preview</h3>
          <ul>
            {result.preview.map((text, index) => (
              <li key={index} style={{ marginBottom: "10px" }}>
                {text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}