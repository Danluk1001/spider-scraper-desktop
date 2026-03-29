import { useState } from "react";

type ScrapedPage = {
  id: number;
  title: string;
  category: string;
  url: string;
};

const mockPages: ScrapedPage[] = [
  { id: 1, title: "Home Page 25-26 - IRVINGTON PUBLIC SCHOOLS", category: "home", url: "https://irvington.k12.nj.us/" },
  { id: 2, title: "Site Search - IRVINGTON PUBLIC SCHOOLS", category: "search", url: "https://irvington.k12.nj.us/search/" },
  { id: 3, title: "Calendar - IRVINGTON PUBLIC SCHOOLS", category: "district", url: "https://irvington.k12.nj.us/district/calendar/" },
  { id: 4, title: "Staff Links - IRVINGTON PUBLIC SCHOOLS", category: "staff-links", url: "https://irvington.k12.nj.us/staff-links/" },
  { id: 5, title: "Augusta Preschool - IRVINGTON PUBLIC SCHOOLS", category: "schools", url: "https://irvington.k12.nj.us/schools/augusta-preschool-academy/" },
];

export default function Home() {
  const [rootUrl, setRootUrl] = useState("https://irvington.k12.nj.us/");
  const [selectedPage, setSelectedPage] = useState<ScrapedPage | null>(mockPages[0]);
  const [activeTab, setActiveTab] = useState("Text View");

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
    "Scraped Images",
  ];

  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        gridTemplateRows: "64px 1fr 120px 32px",
        background: "#e5e7eb",
        color: "#111827",
        fontFamily: "Segoe UI, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "12px 16px",
          borderBottom: "1px solid #cbd5e1",
          background: "#f8fafc",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: "18px", minWidth: "150px" }}>
          Spider Scraper
        </div>

        <label style={{ fontSize: "14px", color: "#374151" }}>Root:</label>

        <input
          value={rootUrl}
          onChange={(e) => setRootUrl(e.target.value)}
          style={{
            flex: 1,
            padding: "10px 12px",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            background: "#fff",
            fontSize: "14px",
          }}
        />

        {["Create Sitemap", "Save Sitemap", "Load Sitemap", "Settings"].map((btn) => (
          <button
            key={btn}
            style={{
              padding: "10px 14px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: 600,
            }}
          >
            {btn}
          </button>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "42% 58%",
          gap: "12px",
          padding: "12px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "10px",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "42% 18% 40%",
              padding: "10px 12px",
              background: "#f1f5f9",
              borderBottom: "1px solid #cbd5e1",
              fontWeight: 700,
              fontSize: "13px",
            }}
          >
            <div>Title</div>
            <div>Category</div>
            <div>URL</div>
          </div>

          <div style={{ overflowY: "auto", flex: 1 }}>
            {mockPages.map((page) => {
              const selected = selectedPage?.id === page.id;
              return (
                <div
                  key={page.id}
                  onClick={() => setSelectedPage(page)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "42% 18% 40%",
                    padding: "10px 12px",
                    borderBottom: "1px solid #e5e7eb",
                    cursor: "pointer",
                    background: selected ? "#dbeafe" : "#ffffff",
                    color: selected ? "#1d4ed8" : "#111827",
                    fontSize: "13px",
                  }}
                >
                  <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {page.title}
                  </div>
                  <div>{page.category}</div>
                  <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {page.url}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={{
            background: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "10px",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
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
                  border: activeTab === tab ? "1px solid #2563eb" : "1px solid #cbd5e1",
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
            <pre
              style={{
                margin: 0,
                fontFamily: "Consolas, monospace",
                whiteSpace: "pre-wrap",
              }}
            >
{`Title: ${selectedPage?.title || ""}
Category: ${selectedPage?.category || ""}
URL: ${selectedPage?.url || ""}
Active Tab: ${activeTab}

This panel will later show:
- extracted text
- HTML source
- metadata
- JSON
- images
- table data
- regex results`}
            </pre>
          </div>
        </div>
      </div>

      <div
        style={{
          background: "#ffffff",
          borderTop: "1px solid #cbd5e1",
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
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
          GET https://irvington.k12.nj.us/ <br />
          GET https://irvington.k12.nj.us/search/ <br />
          GET https://irvington.k12.nj.us/district/calendar/ <br />
          GET https://irvington.k12.nj.us/staff-links/
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px",
          background: "#dcfce7",
          borderTop: "1px solid #86efac",
          fontSize: "13px",
          fontWeight: 600,
        }}
      >
        <div>Pages scraped: 150</div>
        <div>Done</div>
      </div>
    </div>
  );
}