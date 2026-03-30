import { useState, type CSSProperties } from "react";
import axios from "axios";
import "../home.css";

/**
 * Use relative `/api` so Vite (and preview) can proxy to Flask — avoids CORS and
 * localhost vs 127.0.0.1 mismatches that surface as axios "Network Error".
 * Override with VITE_API_BASE if the API is on another origin (no trailing slash).
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
/** Full-site crawl can run for a long time; 0 = no axios timeout. */
const CRAWL_TIMEOUT_MS = 0;

/** ZIP builds can take several minutes when many video URLs are probed. */
const ZIP_EXPORT_TIMEOUT_MS = 15 * 60 * 1000;
const FETCH_FILE_TIMEOUT_MS = 3 * 60 * 1000;

type MediaProvenanceEntry = {
  mediaUrl: string;
  sourcePageUrl: string;
};

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
  imageSources?: MediaProvenanceEntry[];
  videoSources?: MediaProvenanceEntry[];
};

function provenanceForMedia(
  mediaUrls: string[] | undefined,
  sourcePageUrl: string,
): MediaProvenanceEntry[] {
  return (mediaUrls ?? []).map((mediaUrl) => ({ mediaUrl, sourcePageUrl }));
}

function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return API_BASE ? `${API_BASE}${p}` : p;
}

async function downloadMediaZip(
  mode: "images" | "videos",
  entries: MediaProvenanceEntry[],
): Promise<void> {
  try {
    const res = await axios.post(
      apiUrl("/api/export-media-zip"),
      { mode, entries },
      {
        responseType: "blob",
        timeout: ZIP_EXPORT_TIMEOUT_MS,
        headers: { "Content-Type": "application/json" },
      },
    );
    const blob = new Blob([res.data], { type: "application/zip" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `spider-scraper-${mode}-${Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(href);
  } catch (e: unknown) {
    if (axios.isAxiosError(e) && e.response?.data instanceof Blob) {
      const text = await e.response.data.text();
      let message = text || "Export failed";
      try {
        const j = JSON.parse(text) as { error?: string };
        if (j.error) message = j.error;
      } catch {
        /* response body is not JSON */
      }
      throw new Error(message);
    }
    if (
      axios.isAxiosError(e) &&
      !e.response &&
      (e.code === "ERR_NETWORK" || (e.message || "").toLowerCase().includes("network"))
    ) {
      throw new Error(
        "Cannot reach the backend (network error). Start Flask on port 5000 and use " +
          "npm run dev so /api is proxied, or set VITE_API_BASE to your API URL (e.g. http://127.0.0.1:5000).",
      );
    }
    if (axios.isAxiosError(e) && e.code === "ECONNABORTED") {
      throw new Error(
        "ZIP export timed out. Try fewer pages or a smaller crawl; video exports can take a long time.",
      );
    }
    throw e;
  }
}

async function downloadSingleFileViaApi(url: string): Promise<void> {
  try {
    const res = await axios.post(
      apiUrl("/api/fetch-file"),
      { url },
      { responseType: "blob", timeout: FETCH_FILE_TIMEOUT_MS },
    );
    const blob = res.data as Blob;
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    let filename = "download";
    const cd = res.headers["content-disposition"];
    if (typeof cd === "string") {
      const utf8 = /filename\*=UTF-8''([^;\s]+)/i.exec(cd);
      const quoted = /filename="([^"]+)"/i.exec(cd);
      const plain = /filename=([^;\s]+)/i.exec(cd);
      if (utf8?.[1]) {
        try {
          filename = decodeURIComponent(utf8[1].trim());
        } catch {
          filename = utf8[1].trim();
        }
      } else if (quoted?.[1]) {
        filename = quoted[1].trim();
      } else if (plain?.[1]) {
        filename = plain[1].replace(/['"]/g, "").trim();
      }
    }
    a.download = filename;
    a.click();
    URL.revokeObjectURL(href);
  } catch (e: unknown) {
    let apiErr = "";
    if (axios.isAxiosError(e) && e.response?.data instanceof Blob) {
      const text = await e.response.data.text();
      try {
        const j = JSON.parse(text) as { error?: string };
        if (j.error) apiErr = j.error;
      } catch {
        apiErr = text;
      }
    }
    if (
      apiErr.includes("not_direct_media") ||
      apiErr.includes("skipped_html") ||
      apiErr.includes("HTTP")
    ) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

type ScrapeResult = {
  title?: string;
  url?: string;
  paragraph_count?: number;
  preview?: string[];
  paragraphs?: string[];
  links?: string[];
  images?: string[];
  videos?: string[];
  error?: string;
};

type CrawlApiResponse = {
  start_url?: string;
  total_pages?: number;
  pages?: ScrapeResult[];
  errors?: { url: string; error: string }[];
  error?: string;
};

function crawlResponseToPages(data: CrawlApiResponse): ScrapedPage[] {
  const list = data.pages ?? [];
  const baseId = Date.now();
  return list.map((p, index) => {
    const text = [...(p.preview ?? p.paragraphs ?? [])];
    const pageUrl = (p.url as string) || "";
    return {
      id: baseId + index,
      title: (p.title as string) ?? pageUrl,
      category: index === 0 ? "home" : "crawled-page",
      url: pageUrl,
      paragraph_count: p.paragraph_count ?? text.length,
      preview: text,
      html: text.join("\n\n"),
      links: p.links ?? [],
      images: p.images ?? [],
      videos: p.videos ?? [],
      imageSources: provenanceForMedia(p.images, pageUrl),
      videoSources: provenanceForMedia(p.videos, pageUrl),
    };
  });
}

function ImagePreviewCell({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);

  return (
    <div
      style={{
        padding: "10px",
        border: "1px solid #cbd5e1",
        borderRadius: "8px",
        background: "#f8fafc",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        minWidth: 0,
      }}
    >
      <div
        style={{
          aspectRatio: "4 / 3",
          background: "#e5e7eb",
          borderRadius: "6px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {failed ? (
          <span
            style={{
              color: "#6b7280",
              fontSize: "12px",
              padding: "8px",
              textAlign: "center",
            }}
          >
            Preview unavailable
          </span>
        ) : (
          <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              width: "auto",
              height: "auto",
              objectFit: "contain",
            }}
          />
        )}
      </div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        style={{
          fontSize: "11px",
          wordBreak: "break-all",
          color: "#2563eb",
        }}
      >
        {url}
      </a>
      <button
        type="button"
        disabled={downloading}
        onClick={async () => {
          setDownloading(true);
          try {
            await downloadSingleFileViaApi(url);
          } finally {
            setDownloading(false);
          }
        }}
        style={{
          padding: "6px 10px",
          borderRadius: "6px",
          border: "1px solid #2563eb",
          background: downloading ? "#e0e7ff" : "#eff6ff",
          color: "#1d4ed8",
          fontSize: "12px",
          fontWeight: 600,
          cursor: downloading ? "wait" : "pointer",
          alignSelf: "flex-start",
        }}
      >
        {downloading ? "Downloading…" : "Download"}
      </button>
    </div>
  );
}

type VideoPreviewKind =
  | { kind: "iframe"; embedSrc: string }
  | { kind: "native"; src: string }
  | { kind: "link" };

function videoPreviewKind(url: string): VideoPreviewKind {
  const u = url.trim();
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path = parsed.pathname;

    if (
      host.includes("youtube.com") ||
      host === "youtu.be" ||
      host.includes("youtube-nocookie.com")
    ) {
      let id: string | null = null;
      if (host === "youtu.be") {
        id = path.replace(/^\//, "").split("/")[0] || null;
      } else if (path.includes("/embed/")) {
        id = path.split("/embed/")[1]?.split("/")[0]?.split("?")[0] || null;
      } else if (path.includes("/watch") || parsed.searchParams.has("v")) {
        id = parsed.searchParams.get("v");
      }
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
        const nocookie = host.includes("youtube-nocookie");
        const embedSrc = nocookie
          ? `https://www.youtube-nocookie.com/embed/${id}`
          : `https://www.youtube.com/embed/${id}`;
        return { kind: "iframe", embedSrc };
      }
    }

    if (host.includes("vimeo.com")) {
      const m = path.match(/\/(?:video\/)?(\d+)/);
      if (m?.[1]) {
        return {
          kind: "iframe",
          embedSrc: `https://player.vimeo.com/video/${m[1]}`,
        };
      }
    }

    const base = u.toLowerCase().split("?")[0].split("#")[0];
    if (
      base.endsWith(".mp4") ||
      base.endsWith(".webm") ||
      base.endsWith(".mov") ||
      base.endsWith(".m4v") ||
      base.endsWith(".ogv")
    ) {
      return { kind: "native", src: u };
    }

    return { kind: "link" };
  } catch {
    return { kind: "link" };
  }
}

function VideoPreviewCell({ url }: { url: string }) {
  const preview = videoPreviewKind(url);
  const [downloading, setDownloading] = useState(false);

  const frameStyle: CSSProperties = {
    width: "100%",
    height: "100%",
    border: "none",
    borderRadius: "6px",
  };

  return (
    <div
      style={{
        padding: "10px",
        border: "1px solid #cbd5e1",
        borderRadius: "8px",
        background: "#f8fafc",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        minWidth: 0,
      }}
    >
      <div
        style={{
          aspectRatio: "16 / 9",
          background: "#e5e7eb",
          borderRadius: "6px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {preview.kind === "iframe" ? (
          <iframe
            src={preview.embedSrc}
            title="Video embed"
            style={frameStyle}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        ) : preview.kind === "native" ? (
          <video
            src={preview.src}
            controls
            preload="metadata"
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              width: "100%",
              height: "100%",
              objectFit: "contain",
            }}
          />
        ) : (
          <span
            style={{
              color: "#6b7280",
              fontSize: "12px",
              padding: "8px",
              textAlign: "center",
            }}
          >
            Open link for preview
          </span>
        )}
      </div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        style={{
          fontSize: "11px",
          wordBreak: "break-all",
          color: "#2563eb",
        }}
      >
        {url}
      </a>
      <button
        type="button"
        disabled={downloading}
        onClick={async () => {
          setDownloading(true);
          try {
            await downloadSingleFileViaApi(url);
          } finally {
            setDownloading(false);
          }
        }}
        style={{
          padding: "6px 10px",
          borderRadius: "6px",
          border: "1px solid #7c3aed",
          background: downloading ? "#ede9fe" : "#f5f3ff",
          color: "#5b21b6",
          fontSize: "12px",
          fontWeight: 600,
          cursor: downloading ? "wait" : "pointer",
          alignSelf: "flex-start",
        }}
      >
        {downloading ? "Downloading…" : "Download"}
      </button>
    </div>
  );
}

export default function Home() {
  const [rootUrl, setRootUrl] = useState("https://irvington.k12.nj.us/");
  const [pages, setPages] = useState<ScrapedPage[]>([]);
  const [selectedPage, setSelectedPage] = useState<ScrapedPage | null>(null);
  const [activeTab, setActiveTab] = useState("Text View");
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);

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
    const start = rootUrl.trim();
    if (!start) return;

    setLoading(true);
    setLogs((prev) => [
      ...prev,
      `Full-site crawl from ${start} (all same-domain pages linked from HTML; no caps)…`,
    ]);

    try {
      const response = await axios.post(
        apiUrl("/api/crawl"),
        { url: start },
        { timeout: CRAWL_TIMEOUT_MS },
      );

      const data = response.data as CrawlApiResponse;
      if (data.error) {
        setLogs((prev) => [...prev, `ERROR: ${data.error}`]);
        return;
      }

      const newPages = crawlResponseToPages(data);
      if (newPages.length === 0) {
        setLogs((prev) => [...prev, "Crawl returned no pages."]);
        setPages([]);
        setSelectedPage(null);
        return;
      }

      setPages(newPages);
      setSelectedPage(newPages[0]);

      for (const err of data.errors ?? []) {
        setLogs((prev) => [...prev, `FAIL ${err.url}: ${err.error}`]);
      }
      setLogs((prev) => [
        ...prev,
        `Crawl finished: ${data.total_pages ?? newPages.length} pages scraped.`,
      ]);
    } catch (error) {
      console.error(error);
      setLogs((prev) => [...prev, `ERROR crawl ${start}`]);
    } finally {
      setLoading(false);
    }
  };

  const handleScrapeAllMedia = async (kind: "images" | "videos") => {
    const root = rootUrl.trim();
    if (!root) return;

    setLoading(true);
    setLogs((prev) => [
      ...prev,
      `${kind === "images" ? "Scrape all images" : "Scrape all videos"} (every crawled page) — ${root}`,
    ]);

    try {
      let contentPages = pages.filter(
        (p) => p.category !== "aggregate-images" && p.category !== "aggregate-videos",
      );

      if (contentPages.length === 0) {
        setLogs((prev) => [
          ...prev,
          "No pages in the table — running full-site crawl first (may take a long time)…",
        ]);
        const response = await axios.post(
          apiUrl("/api/crawl"),
          { url: root },
          { timeout: CRAWL_TIMEOUT_MS },
        );
        const data = response.data as CrawlApiResponse;
        if (data.error) {
          setLogs((prev) => [...prev, `ERROR: ${data.error}`]);
          return;
        }
        contentPages = crawlResponseToPages(data);
        for (const err of data.errors ?? []) {
          setLogs((prev) => [...prev, `FAIL ${err.url}: ${err.error}`]);
        }
        setLogs((prev) => [...prev, `Crawl done: ${contentPages.length} pages.`]);
      }

      const imageProv: MediaProvenanceEntry[] = [];
      const videoProv: MediaProvenanceEntry[] = [];
      const mergedImages = new Set<string>();
      const mergedVideos = new Set<string>();

      for (const p of contentPages) {
        const pageUrl = p.url;
        for (const u of p.images ?? []) {
          mergedImages.add(u);
          imageProv.push({ mediaUrl: u, sourcePageUrl: pageUrl });
        }
        for (const u of p.videos ?? []) {
          mergedVideos.add(u);
          videoProv.push({ mediaUrl: u, sourcePageUrl: pageUrl });
        }
      }

      const baseId = Date.now();
      const mergedImgArr = Array.from(mergedImages);
      const mergedVidArr = Array.from(mergedVideos);

      const aggregatePage: ScrapedPage =
        kind === "images"
          ? {
              id: baseId,
              title: `All images (${mergedImgArr.length})`,
              category: "aggregate-images",
              url: root,
              paragraph_count: 0,
              preview: [],
              html: "",
              links: [],
              images: mergedImgArr,
              videos: [],
              imageSources: imageProv,
              videoSources: [],
            }
          : {
              id: baseId,
              title: `All videos (${mergedVidArr.length})`,
              category: "aggregate-videos",
              url: root,
              paragraph_count: 0,
              preview: [],
              html: "",
              links: [],
              images: [],
              videos: mergedVidArr,
              imageSources: [],
              videoSources: videoProv,
            };

      setPages([aggregatePage, ...contentPages]);
      setSelectedPage(aggregatePage);
      setActiveTab(kind === "images" ? "Images" : "Videos");
      const count = kind === "images" ? mergedImgArr.length : mergedVidArr.length;
      setLogs((prev) => [...prev, `Done: ${count} unique ${kind}`]);

      const provEntries = kind === "images" ? imageProv : videoProv;
      if (provEntries.length > 0) {
        setLogs((prev) => [...prev, "Building ZIP (media files + manifest)..."]);
        setZipBusy(true);
        try {
          await downloadMediaZip(kind, provEntries);
          setLogs((prev) => [...prev, "ZIP download finished"]);
        } catch (zipErr) {
          console.error(zipErr);
          const msg = zipErr instanceof Error ? zipErr.message : String(zipErr);
          setLogs((prev) => [...prev, `ZIP export failed: ${msg}`]);
        } finally {
          setZipBusy(false);
        }
      } else {
        setLogs((prev) => [...prev, "No media URLs to include in ZIP"]);
      }
    } catch (error) {
      console.error(error);
      setLogs((prev) => [...prev, `ERROR ${kind} crawl`]);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadZip = async (mode: "images" | "videos") => {
    const entries =
      mode === "images" ? selectedPage?.imageSources : selectedPage?.videoSources;
    if (!entries?.length) return;
    setZipBusy(true);
    setLogs((prev) => [...prev, `ZIP export (${mode})...`]);
    try {
      await downloadMediaZip(mode, entries);
      setLogs((prev) => [...prev, `ZIP export (${mode}) done`]);
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message : String(e);
      setLogs((prev) => [...prev, `ZIP export failed: ${msg}`]);
    } finally {
      setZipBusy(false);
    }
  };

  const scrapeLinkedPage = async (page: ScrapedPage) => {
    if (
      page.category === "home" ||
      page.category === "crawled-page" ||
      page.category === "aggregate-images" ||
      page.category === "aggregate-videos"
    ) {
      setSelectedPage(page);
      return;
    }

    if (page.category !== "linked-page") {
      setSelectedPage(page);
      return;
    }

    setLoading(true);
    setLogs((prev) => [...prev, `GET ${page.url}`]);

    try {
      const response = await axios.post(apiUrl("/api/scrape"), {
        url: page.url,
      });

      const result = response.data as ScrapeResult;
      const text = [...(result.preview ?? result.paragraphs ?? [])];

      const updatedPage: ScrapedPage = {
        ...page,
        title: result.title ?? page.title,
        paragraph_count: result.paragraph_count ?? text.length,
        preview: text,
        html: text.join("\n\n"),
        links: result.links || [],
        images: result.images || [],
        videos: result.videos || [],
        imageSources: provenanceForMedia(result.images, page.url),
        videoSources: provenanceForMedia(result.videos, page.url),
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
          {loading ? "Crawling…" : "Crawl entire site"}
        </button>

        <button
          type="button"
          onClick={() => handleScrapeAllMedia("images")}
          disabled={loading}
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #059669",
            background: loading ? "#a7f3d0" : "#ecfdf5",
            color: "#047857",
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: "13px",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          Scrape all images
        </button>

        <button
          type="button"
          onClick={() => handleScrapeAllMedia("videos")}
          disabled={loading}
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #7c3aed",
            background: loading ? "#ddd6fe" : "#f5f3ff",
            color: "#5b21b6",
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: "13px",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          Scrape all videos
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
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    flexWrap: "wrap",
                    marginBottom: "12px",
                  }}
                >
                  <h3 style={{ margin: 0 }}>Scraped Videos</h3>
                  {selectedPage.videoSources && selectedPage.videoSources.length > 0 ? (
                    <button
                      type="button"
                      disabled={loading || zipBusy}
                      onClick={() => handleDownloadZip("videos")}
                      style={{
                        padding: "8px 12px",
                        borderRadius: "8px",
                        border: "1px solid #7c3aed",
                        background: loading || zipBusy ? "#ede9fe" : "#f5f3ff",
                        color: "#5b21b6",
                        fontSize: "12px",
                        fontWeight: 600,
                        cursor: loading || zipBusy ? "not-allowed" : "pointer",
                      }}
                    >
                      {zipBusy ? "Preparing ZIP…" : "Download videos ZIP + manifest"}
                    </button>
                  ) : null}
                </div>
                {selectedPage.videos && selectedPage.videos.length > 0 ? (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                      gap: "12px",
                    }}
                  >
                    {selectedPage.videos.map((video, index) => (
                      <VideoPreviewCell key={`${video}-${index}`} url={video} />
                    ))}
                  </div>
                ) : (
                  <div style={{ color: "#6b7280" }}>No videos found on this page.</div>
                )}
              </div>
            ) : activeTab === "Images" ? (
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    flexWrap: "wrap",
                    marginBottom: "12px",
                  }}
                >
                  <h3 style={{ margin: 0 }}>Scraped Images</h3>
                  {selectedPage.imageSources && selectedPage.imageSources.length > 0 ? (
                    <button
                      type="button"
                      disabled={loading || zipBusy}
                      onClick={() => handleDownloadZip("images")}
                      style={{
                        padding: "8px 12px",
                        borderRadius: "8px",
                        border: "1px solid #059669",
                        background: loading || zipBusy ? "#a7f3d0" : "#ecfdf5",
                        color: "#047857",
                        fontSize: "12px",
                        fontWeight: 600,
                        cursor: loading || zipBusy ? "not-allowed" : "pointer",
                      }}
                    >
                      {zipBusy ? "Preparing ZIP…" : "Download images ZIP + manifest"}
                    </button>
                  ) : null}
                </div>
                {selectedPage.images && selectedPage.images.length > 0 ? (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                      gap: "12px",
                    }}
                  >
                    {selectedPage.images.map((image, index) => (
                      <ImagePreviewCell key={`${image}-${index}`} url={image} />
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