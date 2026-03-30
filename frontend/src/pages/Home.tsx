import { useState } from "react";
import axios from "axios";
import "./home.css";

type ScrapedPage = {
  id: number;
  title: string;
  category: string;
  url: string;
  paragraph_count: number;
  preview: string[];
  html?: string;
  links?: string[];
  images?: string[];
  videos?: string[];
};

export default function Home() {
  const [rootUrl, setRootUrl] = useState("https://irvington.k12.nj.us/");
  const [pages, setPages] = useState<ScrapedPage[]>([]);
  const [selectedPage, setSelectedPage] = useState<ScrapedPage | null>(null);
  const [activeTab, setActiveTab] = useState("Text View");
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const tabs = [
    "Text View",
    "XML View",
    "HTML Preview",
    "CSS Preview",
    "JavaScript Preview",
    "Metadata",
    "Tables",
    "JSON",
    "Regex Search",
    "Images",
    "Videos",
  ];

  const handleScrapeSite = async () => {
    if (!rootUrl.trim()) return;

    setLoading(true);
    setLogs((prev) => [...prev, `GET ${rootUrl}`]);

    try {
      const response = await axios.post("http://127.0.0.1:5000/api/scrape", {
        url: rootUrl,
      });

      const result = response.data;

      const newPages: ScrapedPage[] = [
        {
          id: Date.now(),
          title: result.title,
          category: "home",
          url: result.url,
          paragraph_count: result.paragraph_count,
          preview: result.preview,
          html: result.preview.join("\n\n"),
          links: result.links || [],
          images: result.images || [],
          videos: result.videos || [],
        },
        ...(result.links || []).map((link: string, index: number) => ({
          id: Date.now() + index + 1,
          title: link.replace(/^https?:\/\//, ""),
          category: "linked-page",
          url: link,
          paragraph_count: 0,
          preview: [],
          html: "",
          links: [],
          images: [],
          videos: [],
        })),
      ];

      setPages(newPages);
      setSelectedPage(newPages[0]);
      setLogs((prev) => [...prev, `SUCCESS ${result.url}`]);
    } catch (error) {
      console.error(error);
      setLogs((prev) => [...prev, `ERROR scraping ${rootUrl}`]);
    } finally {
      setLoading(false);
    }
  };

  const scrapeLinkedPage = async (page: ScrapedPage) => {
    if (page.category !== "linked-page") {
      setSelectedPage(page);
      return;
    }

    setLoading(true);
    setLogs((prev) => [...prev, `GET ${page.url}`]);

    try {
      const response = await axios.post("http://127.0.0.1:5000/api/scrape", {
        url: page.url,
      });

      const result = response.data;

      const updatedPage: ScrapedPage = {
        ...page,
        title: result.title,
        paragraph_count: result.paragraph_count,
        preview: result.preview,
        html: result.preview.join("\n\n"),
        links: result.links || [],
        images: result.images || [],
        videos: result.videos || [],
      };

      const updatedPages = pages.map((p) => (p.id === page.id ? updatedPage : p));

      setPages(updatedPages);
      setSelectedPage(updatedPage);
      setLogs((prev) => [...prev, `SUCCESS ${page.url}`]);
    } catch (error) {
      console.error(error);
      setLogs((prev) => [...prev, `ERROR scraping ${page.url}`]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="scraper-app">
      <div className="scraper-toolbar">
        <div style={{ fontWeight: 700, fontSize: "18px", minWidth: "150px" }}>
          Spider Scraper
        </div>

        <label style={{ fontSize: "14px", color: "#374151" }}>Root:</label>

        <input
          className="scraper-root-input"
          value={rootUrl}
          onChange={(e) => setRootUrl(e.target.value)}
        />

        <button
          onClick={handleScrapeSite}
          disabled={loading}
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #2563eb",
            background: loading ? "#93c5fd" : "#2563eb",
            color: "#fff",
            cursor: "pointer",
            fontSize: "13px",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          {loading ? "Scraping..." : "Scrape Site"}
        </button>

        {["Save Sitemap", "Load Sitemap", "Settings"].map((btn) => (
          <button
            key={btn}
            style={{
              padding: "10px 14px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              color: "#111827",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {btn}
          </button>
        ))}
      </div>

      <div className="scraper-main">
        <div className="scraper-left">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "48% 16% 36%",
              padding: "10px 12px",
              background: "#f1f5f9",
              borderBottom: "1px solid #cbd5e1",
              fontWeight: 700,
              fontSize: "13px",
              minWidth: "900px",
            }}
          >
            <div>Title</div>
            <div>Category</div>
            <div>URL</div>
          </div>

          <div
            style={{
              overflowY: "auto",
              overflowX: "auto",
              flex: 1,
            }}
          >
            {pages.length === 0 ? (
              <div style={{ padding: "16px", color: "#6b7280", fontSize: "14px" }}>
                No pages scraped yet.
              </div>
            ) : (
              pages.map((page) => {
                const selected = selectedPage?.id === page.id;
                return (
                  <div
                    key={page.id}
                    onClick={() => scrapeLinkedPage(page)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "48% 16% 36%",
                      padding: "10px 12px",
                      borderBottom: "1px solid #e5e7eb",
                      cursor: "pointer",
                      background: selected ? "#dbeafe" : "#ffffff",
                      color: selected ? "#1d4ed8" : "#111827",
                      fontSize: "13px",
                      minWidth: "900px",
                    }}
                  >
                    <div
                      title={page.title}
                      style={{
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {page.title}
                    </div>
                    <div
                      title={page.category}
                      style={{
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {page.category}
                    </div>
                    <div
                      title={page.url}
                      style={{
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {page.url}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="scraper-right">
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid #cbd5e1",
              fontWeight: 700,
              fontSize: "18px",
              background: "#f8fafc",
            }}
          >
            {selectedPage?.title || "No page selected"}
          </div>

          <div
            style={{
              display: "flex",
              gap: "8px",
              padding: "8px 12px",
              borderBottom: "1px solid #cbd5e1",
              background: "#f8fafc",
              flexWrap: "wrap",
            }}
          >
            {tabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border:
                    activeTab === tab ? "1px solid #2563eb" : "1px solid #cbd5e1",
                  background: activeTab === tab ? "#dbeafe" : "#ffffff",
                  color: activeTab === tab ? "#1d4ed8" : "#374151",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {tab}
              </button>
            ))}
          </div>

          <div
            style={{
              flex: 1,
              padding: "16px",
              overflowY: "auto",
              fontSize: "14px",
              lineHeight: 1.6,
              background: "#ffffff",
            }}
          >
            {!selectedPage ? (
              <div style={{ color: "#6b7280" }}>Scrape a site to view details here.</div>
            ) : activeTab === "Text View" ? (
              <pre
                style={{
                  margin: 0,
                  fontFamily: "Consolas, monospace",
                  whiteSpace: "pre-wrap",
                }}
              >
                {`Title: ${selectedPage.title}
Category: ${selectedPage.category}
URL: ${selectedPage.url}
Paragraph Count: ${selectedPage.paragraph_count}

Preview:
${selectedPage.preview.join("\n\n")}`}
              </pre>
            ) : activeTab === "Videos" ? (
              <div>
                <h3 style={{ marginTop: 0 }}>Scraped Videos</h3>
                {selectedPage.videos && selectedPage.videos.length > 0 ? (
                  <div style={{ display: "grid", gap: "12px" }}>
                    {selectedPage.videos.map((video, index) => (
                      <div
                        key={index}
                        style={{
                          padding: "12px",
                          border: "1px solid #cbd5e1",
                          borderRadius: "8px",
                          background: "#f8fafc",
                        }}
                      >
                        <a href={video} target="_blank" rel="noreferrer">
                          {video}
                        </a>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: "#6b7280" }}>No videos found on this page.</div>
                )}
              </div>
            ) : activeTab === "Images" ? (
              <div>
                <h3 style={{ marginTop: 0 }}>Scraped Images</h3>
                {selectedPage.images && selectedPage.images.length > 0 ? (
                  <div style={{ display: "grid", gap: "12px" }}>
                    {selectedPage.images.map((image, index) => (
                      <div
                        key={index}
                        style={{
                          padding: "12px",
                          border: "1px solid #cbd5e1",
                          borderRadius: "8px",
                          background: "#f8fafc",
                        }}
                      >
                        <a href={image} target="_blank" rel="noreferrer">
                          {image}
                        </a>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: "#6b7280" }}>No images found on this page.</div>
                )}
              </div>
            ) : activeTab === "JSON" ? (
              <pre
                style={{
                  margin: 0,
                  fontFamily: "Consolas, monospace",
                  whiteSpace: "pre-wrap",
                }}
              >
                {JSON.stringify(selectedPage, null, 2)}
              </pre>
            ) : (
              <div style={{ color: "#6b7280" }}>This tab is not wired up yet.</div>
            )}
          </div>
        </div>
      </div>

      <div className="scraper-log">
        <div style={{ fontWeight: 700, fontSize: "13px" }}>Activity Log</div>
        <div
          style={{
            flex: 1,
            background: "#f8fafc",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            padding: "8px 10px",
            fontFamily: "Consolas, monospace",
            fontSize: "12px",
            overflowY: "auto",
          }}
        >
          {logs.length === 0 ? (
            <div>No activity yet.</div>
          ) : (
            logs.map((log, index) => <div key={index}>{log}</div>)
          )}
        </div>
      </div>

      <div className="scraper-footer">
        <div>Pages scraped: {pages.length}</div>
        <div>{loading ? "Working..." : "Done"}</div>
      </div>
    </div>
  );
}