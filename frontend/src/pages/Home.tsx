import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import axios from "axios";
import "../home.css";
import { SitemapGraphView } from "../components/SitemapGraphView";

/**
 * Use relative `/api` so Vite (and preview) can proxy to Flask — avoids CORS and
 * localhost vs 127.0.0.1 mismatches that surface as axios "Network Error".
 * Override with VITE_API_BASE if the API is on another origin (no trailing slash).
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

/** Per-page scrape timeout (matches backend REQUEST_TIMEOUT ~30s with headroom). */
const PER_PAGE_SCRAPE_TIMEOUT_MS = 45_000;

/**
 * ZIP export downloads each media URL on the server; large video sets can take
 * many minutes. One hour avoids axios aborting before the backend finishes.
 */
const ZIP_EXPORT_TIMEOUT_MS = 60 * 60 * 1000;
const FETCH_FILE_TIMEOUT_MS = 3 * 60 * 1000;

type MediaProvenanceEntry = {
  mediaUrl: string;
  sourcePageUrl: string;
};

/** Stable graph node id (UUID). Used in edges and flowchart views. */
type NodeId = string;

/** Directed link parent → child (same-site crawl discovery or root fan-out). */
type SitemapEdge = {
  source: NodeId;
  target: NodeId;
};

/** HTTP health from crawl / probe (matches backend `status_label`). */
type PageStatusLabel = "ok" | "redirect" | "broken" | "timeout_error";

/** Crawl item classification (matches backend `link_classification` / `item_type`). */
export type ItemType = "page" | "pdf" | "docx" | "doc" | "epub" | "file";

export type FileMetadata = {
  size_bytes?: number;
  extraction_error?: string;
  fetch_error?: string;
};

type ScrapedPage = {
  nodeId: NodeId;
  title: string;
  category: string;
  url: string;
  /** page | pdf | docx | doc | epub | file — default page when omitted (legacy). */
  item_type?: ItemType;
  mime_type?: string | null;
  extension?: string | null;
  extracted_text?: string | null;
  /** PDF: number of pages from pypdf (when extraction succeeded). */
  pdf_page_count?: number | null;
  /** PDF: document info title from file metadata (may differ from ``title``). */
  pdf_title?: string | null;
  /** PDF: short preview of extracted text (server-truncated). */
  pdf_preview_snippet?: string | null;
  /** DOCX: title from document core properties. */
  docx_title?: string | null;
  docx_preview_snippet?: string | null;
  docx_paragraph_count?: number | null;
  /** EPUB: DC title and spine-style document count. */
  epub_title?: string | null;
  epub_preview_snippet?: string | null;
  epub_chapter_count?: number | null;
  /** Bytes downloaded for this document (PDF and other files). */
  file_size?: number | null;
  file_metadata?: FileMetadata | null;
  paragraph_count: number;
  preview: string[];
  /** Response status when known (0 = unknown after probe failure). */
  http_status?: number;
  status_label?: PageStatusLabel;
  /** SEO / social / structure (from backend `extract_metadata`). */
  meta_description?: string | null;
  canonical_url?: string | null;
  og_title?: string | null;
  og_description?: string | null;
  og_image?: string | null;
  twitter_title?: string | null;
  twitter_description?: string | null;
  h1?: string[];
  h2?: string[];
  /** Flattened paragraph text (for Text View / legacy). */
  html?: string;
  /** Full response body HTML from the server (HTML tab). */
  raw_html?: string;
  /** Inline `<style>` + linked stylesheet markers from the page (CSS tab). */
  raw_css?: string;
  /** Inline scripts + external `script src` markers (JavaScript tab). */
  raw_js?: string;
  links?: string[];
  images?: string[];
  videos?: string[];
  imageSources?: MediaProvenanceEntry[];
  videoSources?: MediaProvenanceEntry[];
};

const VALID_STATUS_LABELS: PageStatusLabel[] = [
  "ok",
  "redirect",
  "broken",
  "timeout_error",
];

function parseStatusLabel(v: unknown): PageStatusLabel | undefined {
  if (typeof v !== "string") return undefined;
  return VALID_STATUS_LABELS.includes(v as PageStatusLabel)
    ? (v as PageStatusLabel)
    : undefined;
}

function statusLabelDisplay(v: PageStatusLabel | undefined): string {
  if (!v) return "—";
  if (v === "timeout_error") return "timeout / error";
  return v;
}

/** Left table filters — derived from ``pages``; original array is never mutated. */
export type TableTypeFilter = "all" | "page" | "pdf" | "docx" | "epub" | "broken";
export type TableMediaFilter = "any" | "images" | "videos";
export type TableHttpFilter = "any" | "ok" | "redirect" | "broken";

export type TableFilterState = {
  search: string;
  typeFilter: TableTypeFilter;
  mediaFilter: TableMediaFilter;
  httpFilter: TableHttpFilter;
};

function isBrokenTableRow(p: ScrapedPage): boolean {
  const code = p.http_status ?? 0;
  const sl = p.status_label;
  if (sl === "broken" || sl === "timeout_error") return true;
  if (code > 0 && code >= 400) return true;
  return false;
}

function matchesHttpTableFilter(p: ScrapedPage, h: TableHttpFilter): boolean {
  if (h === "any") return true;
  const sl = p.status_label;
  const code = p.http_status ?? 0;
  if (h === "ok") {
    if (sl === "ok") return true;
    if (code >= 200 && code < 300) return true;
    return false;
  }
  if (h === "redirect") return sl === "redirect";
  if (h === "broken") return isBrokenTableRow(p);
  return true;
}

/**
 * Returns a subset of ``pages`` for the left results table. Does not mutate ``pages``.
 */
export function filterScrapedPagesForTable(
  pages: ScrapedPage[],
  f: TableFilterState,
): ScrapedPage[] {
  const q = f.search.trim().toLowerCase();
  return pages.filter((p) => {
    if (q) {
      const haystack = `${p.title}\n${p.url}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    const it = (p.item_type ?? "page").toLowerCase();
    switch (f.typeFilter) {
      case "page":
        if (it !== "page") return false;
        break;
      case "pdf":
        if (it !== "pdf") return false;
        break;
      case "docx":
        if (it !== "docx") return false;
        break;
      case "epub":
        if (it !== "epub") return false;
        break;
      case "broken":
        if (!isBrokenTableRow(p)) return false;
        break;
      default:
        break;
    }

    if (f.mediaFilter === "images" && (p.images?.length ?? 0) === 0) return false;
    if (f.mediaFilter === "videos" && (p.videos?.length ?? 0) === 0) return false;

    if (!matchesHttpTableFilter(p, f.httpFilter)) return false;

    return true;
  });
}

function parseItemType(v: unknown): ItemType {
  if (v === "page" || v === "pdf" || v === "docx" || v === "doc" || v === "epub" || v === "file") {
    return v;
  }
  return "page";
}

function parseOptionalPositiveInt(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  return v >= 0 ? Math.floor(v) : null;
}

function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function ItemTypeIcon({ type }: { type: ItemType }) {
  const common = { width: 14, height: 14, flexShrink: 0 } as const;
  switch (type) {
    case "pdf":
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden style={common}>
          <path
            d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="#fee2e2"
          />
          <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <text x="7" y="17" fontSize="7" fontWeight="700" fill="#b91c1c">
            PDF
          </text>
        </svg>
      );
    case "docx":
    case "doc":
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden style={common}>
          <rect x="4" y="2" width="16" height="20" rx="2" fill="#dbeafe" stroke="#2563eb" strokeWidth="1.25" />
          <text x="6" y="15" fontSize="8" fontWeight="800" fill="#1d4ed8">
            W
          </text>
        </svg>
      );
    case "epub":
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden style={common}>
          <path
            d="M4 19V5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"
            fill="#ede9fe"
            stroke="#7c3aed"
            strokeWidth="1.25"
          />
          <path d="M14 3v5h5" stroke="#7c3aed" strokeWidth="1.25" />
        </svg>
      );
    case "file":
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden style={common}>
          <path
            d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
            fill="#f1f5f9"
            stroke="#64748b"
            strokeWidth="1.25"
          />
          <path d="M14 2v6h6" stroke="#64748b" strokeWidth="1.25" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden style={common}>
          <circle cx="12" cy="12" r="9" fill="#e0f2fe" stroke="#0369a1" strokeWidth="1.25" />
        </svg>
      );
  }
}

/** Preview box shared by PDF / DOCX / EPUB detail strips. */
function ExtractPreviewBox({
  text,
  borderColor,
  labelColor,
}: {
  text: string;
  borderColor: string;
  labelColor: string;
}) {
  return (
    <div style={{ marginBottom: "10px" }}>
      <div style={{ fontWeight: 600, marginBottom: "4px", color: labelColor }}>Preview</div>
      <div
        style={{
          maxHeight: "120px",
          overflow: "auto",
          padding: "8px 10px",
          borderRadius: "6px",
          background: "#ffffffcc",
          border: `1px solid ${borderColor}`,
          lineHeight: 1.45,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text}
      </div>
    </div>
  );
}

/** Detail strip for PDF, DOCX, EPUB, and generic file rows. */
function DocumentAssetDetailPanel({ page }: { page: ScrapedPage }) {
  const t = page.item_type ?? "page";
  if (t === "page") return null;

  const openAsset = () => {
    window.open(page.url, "_blank", "noopener,noreferrer");
  };

  const err = page.file_metadata?.extraction_error;
  const downloadLink = (
    <a
      href={page.url}
      download
      style={{
        padding: "8px 14px",
        borderRadius: "8px",
        border: "1px solid #cbd5e1",
        background: "#ffffff",
        color: "#334155",
        fontSize: "13px",
        fontWeight: 600,
        textDecoration: "none",
        display: "inline-block",
      }}
    >
      Download (save as)
    </a>
  );

  if (t === "pdf") {
    return (
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #fecaca",
          background: "linear-gradient(180deg, #fff7ed 0%, #fffbeb 100%)",
          fontSize: "13px",
          color: "#431407",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: "8px", fontSize: "14px", color: "#9a3412" }}>
          PDF document
        </div>
        <div style={{ display: "grid", gap: "6px", marginBottom: "10px" }}>
          <div>
            <strong>Pages:</strong>{" "}
            {page.pdf_page_count != null && page.pdf_page_count > 0 ? page.pdf_page_count : "—"}
          </div>
          <div>
            <strong>File size:</strong> {formatFileSize(page.file_size ?? undefined)}
          </div>
          {page.pdf_title ? (
            <div>
              <strong>PDF title:</strong> {page.pdf_title}
            </div>
          ) : null}
          <div>
            <strong>MIME:</strong> {page.mime_type ?? "—"}
          </div>
          {page.extension ? (
            <div>
              <strong>Extension:</strong> {page.extension}
            </div>
          ) : null}
        </div>
        {page.pdf_preview_snippet ? (
          <ExtractPreviewBox text={page.pdf_preview_snippet} borderColor="#fed7aa" labelColor="#9a3412" />
        ) : null}
        {err ? (
          <div style={{ color: "#b91c1c", marginBottom: "8px", fontSize: "12px" }}>Extraction note: {err}</div>
        ) : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            onClick={openAsset}
            style={{
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid #ea580c",
              background: "#fff7ed",
              color: "#9a3412",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Open in new tab
          </button>
          {downloadLink}
        </div>
      </div>
    );
  }

  if (t === "docx") {
    return (
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #93c5fd",
          background: "linear-gradient(180deg, #eff6ff 0%, #f8fafc 100%)",
          fontSize: "13px",
          color: "#1e3a5f",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: "8px", fontSize: "14px", color: "#1d4ed8" }}>
          Word document (DOCX)
        </div>
        <div style={{ display: "grid", gap: "6px", marginBottom: "10px" }}>
          <div>
            <strong>Paragraphs (non-empty):</strong>{" "}
            {page.docx_paragraph_count != null && page.docx_paragraph_count > 0
              ? page.docx_paragraph_count
              : "—"}
          </div>
          <div>
            <strong>File size:</strong> {formatFileSize(page.file_size ?? undefined)}
          </div>
          {page.docx_title ? (
            <div>
              <strong>Document title:</strong> {page.docx_title}
            </div>
          ) : null}
          <div>
            <strong>MIME:</strong> {page.mime_type ?? "—"}
          </div>
          {page.extension ? (
            <div>
              <strong>Extension:</strong> {page.extension}
            </div>
          ) : null}
        </div>
        {page.docx_preview_snippet ? (
          <ExtractPreviewBox text={page.docx_preview_snippet} borderColor="#93c5fd" labelColor="#1d4ed8" />
        ) : null}
        {err ? (
          <div style={{ color: "#b91c1c", marginBottom: "8px", fontSize: "12px" }}>Extraction note: {err}</div>
        ) : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            onClick={openAsset}
            style={{
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid #2563eb",
              background: "#ffffff",
              color: "#1d4ed8",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Open in new tab
          </button>
          {downloadLink}
        </div>
      </div>
    );
  }

  if (t === "epub") {
    return (
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #c4b5fd",
          background: "linear-gradient(180deg, #f5f3ff 0%, #faf5ff 100%)",
          fontSize: "13px",
          color: "#3b0764",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: "8px", fontSize: "14px", color: "#6d28d9" }}>
          EPUB e-book
        </div>
        <div style={{ display: "grid", gap: "6px", marginBottom: "10px" }}>
          <div>
            <strong>HTML documents (spine):</strong>{" "}
            {page.epub_chapter_count != null && page.epub_chapter_count > 0 ? page.epub_chapter_count : "—"}
          </div>
          <div>
            <strong>File size:</strong> {formatFileSize(page.file_size ?? undefined)}
          </div>
          {page.epub_title ? (
            <div>
              <strong>Title (DC):</strong> {page.epub_title}
            </div>
          ) : null}
          <div>
            <strong>MIME:</strong> {page.mime_type ?? "—"}
          </div>
          {page.extension ? (
            <div>
              <strong>Extension:</strong> {page.extension}
            </div>
          ) : null}
        </div>
        {page.epub_preview_snippet ? (
          <ExtractPreviewBox text={page.epub_preview_snippet} borderColor="#c4b5fd" labelColor="#6d28d9" />
        ) : null}
        {err ? (
          <div style={{ color: "#b91c1c", marginBottom: "8px", fontSize: "12px" }}>Extraction note: {err}</div>
        ) : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            onClick={openAsset}
            style={{
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid #7c3aed",
              background: "#ffffff",
              color: "#5b21b6",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Open in new tab
          </button>
          {downloadLink}
        </div>
      </div>
    );
  }

  if (t === "file" || t === "doc") {
    return (
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #e2e8f0",
          background: "#f8fafc",
          fontSize: "13px",
          color: "#334155",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: "8px", fontSize: "14px", color: "#475569" }}>
          {t === "doc" ? "Word (.doc) — binary format; extract in a desktop app." : "Downloadable file"}
        </div>
        <div style={{ display: "grid", gap: "6px", marginBottom: "10px" }}>
          <div>
            <strong>File size:</strong> {formatFileSize(page.file_size ?? undefined)}
          </div>
          <div>
            <strong>MIME:</strong> {page.mime_type ?? "—"}
          </div>
          {page.extension ? (
            <div>
              <strong>Extension:</strong> {page.extension}
            </div>
          ) : null}
        </div>
        {err ? (
          <div style={{ color: "#b91c1c", marginBottom: "8px", fontSize: "12px" }}>Note: {err}</div>
        ) : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            onClick={openAsset}
            style={{
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid #64748b",
              background: "#ffffff",
              color: "#334155",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Open in new tab
          </button>
          {downloadLink}
        </div>
      </div>
    );
  }

  return null;
}

function ItemTypeBadge({ type }: { type: ItemType }) {
  const palette: Record<ItemType, { bg: string; fg: string; border: string }> = {
    page: { bg: "#e0f2fe", fg: "#0369a1", border: "#7dd3fc" },
    pdf: { bg: "#fee2e2", fg: "#b91c1c", border: "#fecaca" },
    docx: { bg: "#dbeafe", fg: "#1d4ed8", border: "#93c5fd" },
    doc: { bg: "#dbeafe", fg: "#1e40af", border: "#93c5fd" },
    epub: { bg: "#ede9fe", fg: "#5b21b6", border: "#c4b5fd" },
    file: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
  };
  const c = palette[type];
  const label =
    type === "page"
      ? "PAGE"
      : type === "pdf"
        ? "PDF"
        : type === "docx"
          ? "DOCX"
          : type === "doc"
            ? "DOC"
            : type === "epub"
              ? "EPUB"
              : "FILE";
  return (
    <span
      title={`Item type: ${type}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "2px 8px",
        borderRadius: "6px",
        fontSize: "10px",
        fontWeight: 700,
        letterSpacing: "0.02em",
        border: `1px solid ${c.border}`,
        background: c.bg,
        color: c.fg,
        whiteSpace: "nowrap",
      }}
    >
      <ItemTypeIcon type={type} />
      {label}
    </span>
  );
}

function StatusBadge({
  label,
  code,
}: {
  label?: PageStatusLabel;
  code?: number;
}) {
  const palette: Record<
    PageStatusLabel,
    { bg: string; fg: string; border: string }
  > = {
    ok: { bg: "#dcfce7", fg: "#166534", border: "#86efac" },
    redirect: { bg: "#fef9c3", fg: "#854d0e", border: "#fde047" },
    broken: { bg: "#fee2e2", fg: "#991b1b", border: "#fecaca" },
    timeout_error: { bg: "#f3e8ff", fg: "#6b21a8", border: "#d8b4fe" },
  };
  const colors =
    label && label in palette ? palette[label] : { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" };
  const showCode = typeof code === "number" && code > 0;
  return (
    <span
      title={showCode ? `HTTP ${code} · ${statusLabelDisplay(label)}` : statusLabelDisplay(label)}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "8px",
        fontSize: "11px",
        fontWeight: 600,
        border: `1px solid ${colors.border}`,
        background: colors.bg,
        color: colors.fg,
        whiteSpace: "nowrap",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {showCode ? `${code} ` : ""}
      {statusLabelDisplay(label)}
    </span>
  );
}

function parseOptionalMetaString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

function parseHeadingList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function MetaFieldRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  const has = value != null && String(value).trim() !== "";
  return (
    <div style={{ marginBottom: "14px" }}>
      <div
        style={{
          fontSize: "11px",
          fontWeight: 600,
          color: "#64748b",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "14px",
          color: has ? "#0f172a" : "#94a3b8",
          marginTop: "4px",
          wordBreak: "break-word",
          lineHeight: 1.5,
        }}
      >
        {has ? value : "—"}
      </div>
    </div>
  );
}

function HeadingBlock({
  label,
  items,
}: {
  label: string;
  items: string[] | undefined;
}) {
  const list = items?.filter((s) => s.trim().length > 0) ?? [];
  return (
    <div style={{ marginBottom: "14px" }}>
      <div
        style={{
          fontSize: "11px",
          fontWeight: 600,
          color: "#64748b",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>
      {list.length === 0 ? (
        <div style={{ fontSize: "13px", color: "#94a3b8", marginTop: "6px" }}>None found</div>
      ) : (
        <ol
          style={{
            margin: "8px 0 0 0",
            paddingLeft: "20px",
            color: "#0f172a",
            fontSize: "14px",
            lineHeight: 1.5,
          }}
        >
          {list.map((t, i) => (
            <li key={i} style={{ marginBottom: "4px" }}>
              {t}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function OgImagePreview({ url }: { url: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return null;
  return (
    <div style={{ marginTop: "8px" }}>
      <img
        src={url}
        alt=""
        style={{
          maxWidth: "100%",
          maxHeight: "200px",
          borderRadius: "8px",
          border: "1px solid #e2e8f0",
          objectFit: "contain",
          background: "#f8fafc",
        }}
        onError={() => setFailed(true)}
        loading="lazy"
      />
    </div>
  );
}

function PageMetadataPanel({ page }: { page: ScrapedPage }) {
  return (
    <div style={{ maxWidth: "640px" }}>
      <h3 style={{ margin: "0 0 8px 0", fontSize: "16px", color: "#0f172a" }}>Page metadata</h3>
      <p style={{ fontSize: "13px", color: "#64748b", margin: "0 0 20px 0", lineHeight: 1.5 }}>
        Values come from <code style={{ fontSize: "12px" }}>&lt;meta&gt;</code>,{" "}
        <code style={{ fontSize: "12px" }}>&lt;link rel=&quot;canonical&quot;&gt;</code>, Open Graph,
        Twitter Cards, and <code style={{ fontSize: "12px" }}>&lt;h1&gt;</code> /{" "}
        <code style={{ fontSize: "12px" }}>&lt;h2&gt;</code> tags. Empty fields show an em dash.
      </p>

      <MetaFieldRow label="Meta description" value={page.meta_description} />
      <MetaFieldRow label="Canonical URL" value={page.canonical_url} />

      <div
        style={{
          margin: "20px 0 12px 0",
          fontSize: "12px",
          fontWeight: 700,
          color: "#334155",
          letterSpacing: "0.02em",
        }}
      >
        Open Graph
      </div>
      <MetaFieldRow label="og:title" value={page.og_title} />
      <MetaFieldRow label="og:description" value={page.og_description} />
      <div style={{ marginBottom: "14px" }}>
        <div
          style={{
            fontSize: "11px",
            fontWeight: 600,
            color: "#64748b",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          og:image
        </div>
        {page.og_image != null && String(page.og_image).trim() !== "" ? (
          <>
            <div
              style={{
                fontSize: "13px",
                color: "#2563eb",
                marginTop: "4px",
                wordBreak: "break-all",
              }}
            >
              <a href={page.og_image} target="_blank" rel="noreferrer">
                {page.og_image}
              </a>
            </div>
            <OgImagePreview url={page.og_image} />
          </>
        ) : (
          <div style={{ fontSize: "14px", color: "#94a3b8", marginTop: "4px" }}>—</div>
        )}
      </div>

      <div
        style={{
          margin: "20px 0 12px 0",
          fontSize: "12px",
          fontWeight: 700,
          color: "#334155",
          letterSpacing: "0.02em",
        }}
      >
        Twitter
      </div>
      <MetaFieldRow label="twitter:title" value={page.twitter_title} />
      <MetaFieldRow label="twitter:description" value={page.twitter_description} />

      <div
        style={{
          margin: "20px 0 12px 0",
          fontSize: "12px",
          fontWeight: 700,
          color: "#334155",
          letterSpacing: "0.02em",
        }}
      >
        Headings
      </div>
      <HeadingBlock label="H1" items={page.h1} />
      <HeadingBlock label="H2" items={page.h2} />
    </div>
  );
}

/** Scrollable monospace preview + copy (HTML / CSS / JS tabs). */
function CodePreviewPanel({
  title,
  content,
  emptyMessage,
}: {
  title: string;
  content: string | undefined;
  emptyMessage: string;
}) {
  const [copied, setCopied] = useState(false);
  const text = content?.trim() ?? "";
  const has = text.length > 0;

  const handleCopy = async () => {
    if (!has || content == null) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be denied in non-secure contexts */
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        padding: "16px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          marginBottom: "10px",
          flexWrap: "wrap",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: "14px", fontWeight: 600, color: "#0f172a" }}>{title}</span>
        <button
          type="button"
          disabled={!has}
          onClick={() => void handleCopy()}
          style={{
            padding: "6px 12px",
            borderRadius: "8px",
            border: "1px solid #cbd5e1",
            background: has ? "#ffffff" : "#f1f5f9",
            color: "#374151",
            fontSize: "12px",
            fontWeight: 600,
            cursor: has ? "pointer" : "not-allowed",
          }}
        >
          {copied ? "Copied" : "Copy to clipboard"}
        </button>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          overflow: "auto",
          background: "#0f172a",
        }}
      >
        <pre
          style={{
            margin: 0,
            padding: "12px 14px",
            fontFamily: "Consolas, ui-monospace, monospace",
            fontSize: "12px",
            lineHeight: 1.45,
            color: "#e2e8f0",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {has ? content : emptyMessage}
        </pre>
      </div>
    </div>
  );
}

/** Screenshot tab errors: missing Playwright vs other (navigation, timeout, etc.). */
type ScreenshotErrorState =
  | null
  | { kind: "playwright_missing" }
  | { kind: "generic"; message: string };

function parseScreenshotApiError(data: unknown): Exclude<ScreenshotErrorState, null> {
  if (data && typeof data === "object" && "error" in data) {
    const d = data as { error?: unknown; message?: unknown };
    if (d.error === "playwright_missing") {
      return { kind: "playwright_missing" };
    }
    if (typeof d.error === "string" && d.error.length > 0) {
      const msg =
        typeof d.message === "string" && d.message.length > 0
          ? d.message
          : d.error;
      return { kind: "generic", message: msg };
    }
  }
  return { kind: "generic", message: "Unexpected response from server." };
}

/** Live page screenshot from POST /api/screenshot (Playwright on the server). */
function PageScreenshotPanel({
  pageUrl,
  busy,
  previewUrl,
  error,
  onCapture,
  onRetry,
}: {
  pageUrl: string | undefined;
  busy: boolean;
  previewUrl: string | null;
  error: ScreenshotErrorState;
  onCapture: () => void;
  onRetry: () => void;
}) {
  if (!pageUrl?.trim()) {
    return (
      <div style={{ padding: "16px", color: "#64748b", fontSize: "14px" }}>
        Select a row in the results list to choose a page for screenshot.
      </div>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        padding: "16px",
        boxSizing: "border-box",
        gap: "12px",
      }}
    >
      <div style={{ fontSize: "13px", color: "#334155" }}>
        <strong>URL:</strong>{" "}
        <span style={{ wordBreak: "break-all" }}>{pageUrl}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onCapture()}
          style={{
            padding: "8px 14px",
            borderRadius: "8px",
            border: "1px solid #2563eb",
            background: busy ? "#93c5fd" : "#2563eb",
            color: "#fff",
            fontSize: "13px",
            fontWeight: 600,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {busy ? "Capturing…" : "Capture full-page screenshot"}
        </button>
        {error ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void onRetry()}
            style={{
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid #64748b",
              background: busy ? "#e2e8f0" : "#f1f5f9",
              color: "#334155",
              fontSize: "13px",
              fontWeight: 600,
              cursor: busy ? "wait" : "pointer",
            }}
          >
            Retry
          </button>
        ) : null}
        <span style={{ fontSize: "12px", color: "#64748b" }}>
          Opens this URL in headless Chromium on the server (Playwright).
        </span>
      </div>
      {error?.kind === "playwright_missing" ? (
        <div
          style={{
            padding: "14px 16px",
            borderRadius: "8px",
            border: "1px solid #fcd34d",
            background: "#fffbeb",
            color: "#374151",
            fontSize: "13px",
            lineHeight: 1.55,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: "8px", color: "#92400e" }}>
            Playwright is not installed on the server
          </div>
          <p style={{ margin: "0 0 10px 0" }}>
            Install the Python package and Chromium for the backend, then click Retry (or Capture
            again).
          </p>
          <ol style={{ margin: "0 0 10px 1.2em", padding: 0 }}>
            <li style={{ marginBottom: "6px" }}>
              <code
                style={{
                  display: "inline-block",
                  background: "#fef3c7",
                  padding: "2px 8px",
                  borderRadius: "4px",
                  fontSize: "12px",
                }}
              >
                pip install playwright
              </code>
            </li>
            <li>
              <code
                style={{
                  display: "inline-block",
                  background: "#fef3c7",
                  padding: "2px 8px",
                  borderRadius: "4px",
                  fontSize: "12px",
                }}
              >
                python -m playwright install chromium
              </code>
            </li>
          </ol>
          <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
            Run these in your backend environment, restart the Flask server, then try again.
          </p>
        </div>
      ) : error?.kind === "generic" ? (
        <div style={{ color: "#b91c1c", fontSize: "13px", fontWeight: 600 }}>{error.message}</div>
      ) : null}
      {previewUrl ? (
        <div
          style={{
            flex: 1,
            minHeight: 200,
            overflow: "auto",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            background: "#f8fafc",
          }}
        >
          <img
            src={previewUrl}
            alt={`Screenshot of ${pageUrl}`}
            style={{ width: "100%", height: "auto", display: "block" }}
          />
        </div>
      ) : !busy ? (
        <div style={{ color: "#94a3b8", fontSize: "13px" }}>No screenshot yet. Click Capture.</div>
      ) : null}
    </div>
  );
}

type RegexSearchSource = "html" | "preview";
type RegexPresetId = "emails" | "phones" | "pdf" | "social" | "custom";

const REGEX_PRESET_DEF: Record<
  Exclude<RegexPresetId, "custom">,
  { label: string; source: string; flags: string }
> = {
  emails: {
    label: "Emails",
    source: String.raw`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`,
    flags: "g",
  },
  phones: {
    label: "Phone numbers",
    source: String.raw`(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}|\+?\d{10,15}\b`,
    flags: "g",
  },
  pdf: {
    label: "PDF links",
    source: String.raw`https?://[^\s"'<>]+\.pdf(?:\?[^\s"'<>]*)?`,
    flags: "gi",
  },
  social: {
    label: "Social links",
    source: String.raw`https?://(?:www\.)?(?:twitter\.com|x\.com|t\.co|facebook\.com|fb\.com|linkedin\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|reddit\.com|pinterest\.com|github\.com|threads\.net|snapchat\.com|medium\.com)/[^\s"'<>]*`,
    flags: "gi",
  },
};

function compileSearchRegex(
  preset: RegexPresetId,
  customPattern: string,
): { ok: true; regex: RegExp } | { ok: false; message: string } {
  if (preset === "custom") {
    const trimmed = customPattern.trim();
    if (!trimmed) {
      return { ok: false, message: "Enter a regex pattern." };
    }
    try {
      let flags = "";
      let body = trimmed;
      const m = /^\/(.+)\/([a-z]*)$/i.exec(trimmed);
      if (m) {
        body = m[1];
        flags = m[2] ?? "";
      }
      if (!flags.includes("g")) flags += "g";
      return { ok: true, regex: new RegExp(body, flags) };
    } catch {
      return { ok: false, message: "Invalid regular expression." };
    }
  }
  const def = REGEX_PRESET_DEF[preset];
  try {
    return { ok: true, regex: new RegExp(def.source, def.flags) };
  } catch {
    return { ok: false, message: "Invalid preset (internal error)." };
  }
}

function collectRegexMatches(text: string, regex: RegExp): string[] {
  const out: string[] = [];
  const r = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
  for (const m of text.matchAll(r)) {
    const full = m[0];
    if (full) out.push(full);
  }
  return out;
}

function RegexSearchPanel({ page }: { page: ScrapedPage }) {
  const [source, setSource] = useState<RegexSearchSource>("html");
  const [preset, setPreset] = useState<RegexPresetId>("emails");
  const [customPattern, setCustomPattern] = useState("");

  const haystack = useMemo(() => {
    if (source === "html") {
      const h = page.raw_html;
      return typeof h === "string" && h.length > 0 ? h : "";
    }
    return page.preview.join("\n\n");
  }, [page.preview, page.raw_html, source]);

  const compiled = useMemo(
    () => compileSearchRegex(preset, customPattern),
    [preset, customPattern],
  );

  const { matches, totalMatchCount } = useMemo(() => {
    if (!compiled.ok || !haystack) {
      return { matches: [] as string[], totalMatchCount: 0 };
    }
    const all = collectRegexMatches(haystack, compiled.regex);
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const s of all) {
      if (seen.has(s)) continue;
      seen.add(s);
      deduped.push(s);
    }
    return { matches: deduped, totalMatchCount: all.length };
  }, [compiled, haystack]);

  const hasContent = haystack.length > 0;
  const errorMsg = !compiled.ok ? compiled.message : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        padding: "16px",
        boxSizing: "border-box",
      }}
    >
      <div style={{ flexShrink: 0, marginBottom: "12px" }}>
        <div
          style={{
            fontSize: "14px",
            fontWeight: 600,
            color: "#0f172a",
            marginBottom: "10px",
          }}
        >
          Regex search
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", marginBottom: "10px" }}>
          <label style={{ fontSize: "12px", color: "#475569", fontWeight: 600 }}>Source</label>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as RegexSearchSource)}
            style={{
              padding: "6px 10px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              fontSize: "12px",
              background: "#fff",
            }}
          >
            <option value="html">Raw HTML (if available)</option>
            <option value="preview">Preview text</option>
          </select>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginBottom: "10px" }}>
          <label style={{ fontSize: "12px", color: "#475569", fontWeight: 600 }}>Preset</label>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value as RegexPresetId)}
            style={{
              padding: "6px 10px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              fontSize: "12px",
              background: "#fff",
              minWidth: "160px",
            }}
          >
            {(Object.keys(REGEX_PRESET_DEF) as Array<Exclude<RegexPresetId, "custom">>).map((id) => (
              <option key={id} value={id}>
                {REGEX_PRESET_DEF[id].label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </div>
        {preset === "custom" ? (
          <div style={{ marginBottom: "10px" }}>
            <label style={{ display: "block", fontSize: "12px", color: "#475569", fontWeight: 600, marginBottom: "6px" }}>
              Pattern (optionally wrap as /pattern/flags)
            </label>
            <input
              type="text"
              value={customPattern}
              onChange={(e) => setCustomPattern(e.target.value)}
              placeholder='e.g. \b\d{5}\b or /foo/gi'
              spellCheck={false}
              autoComplete="off"
              style={{
                width: "100%",
                maxWidth: "560px",
                padding: "8px 10px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                fontFamily: "Consolas, ui-monospace, monospace",
                fontSize: "12px",
                boxSizing: "border-box",
              }}
            />
          </div>
        ) : null}
        <div style={{ fontSize: "12px", color: "#64748b" }}>
          {!hasContent
            ? source === "html"
              ? "No raw HTML for this page — switch to Preview text or re-crawl."
              : "No preview text."
            : null}
          {hasContent && errorMsg ? (
            <span style={{ color: "#b91c1c", fontWeight: 600 }}>{errorMsg}</span>
          ) : null}
          {hasContent && !errorMsg ? (
            <span>
              {matches.length} unique match{matches.length === 1 ? "" : "es"}
              {totalMatchCount !== matches.length ? ` (${totalMatchCount} total)` : ""}
              {" · "}
              {source === "html" ? "raw HTML" : "preview text"} ·{" "}
              {preset === "custom" ? "custom" : REGEX_PRESET_DEF[preset as Exclude<RegexPresetId, "custom">].label}
            </span>
          ) : null}
        </div>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          overflow: "auto",
          background: "#f8fafc",
        }}
      >
        {!hasContent || errorMsg ? (
          <div style={{ padding: "14px", color: "#64748b", fontSize: "13px" }}>
            {errorMsg ? "Fix the pattern above to see matches." : "Nothing to search."}
          </div>
        ) : matches.length === 0 ? (
          <div style={{ padding: "14px", color: "#64748b", fontSize: "13px" }}>No matches.</div>
        ) : (
          <ul style={{ margin: 0, padding: "10px 14px", listStyle: "none" }}>
            {matches.map((m, i) => (
              <li
                key={`${i}-${m.slice(0, 64)}`}
                style={{
                  padding: "8px 10px",
                  marginBottom: "6px",
                  background: "#ffffff",
                  border: "1px solid #e2e8f0",
                  borderRadius: "6px",
                  fontFamily: "Consolas, ui-monospace, monospace",
                  fontSize: "12px",
                  lineHeight: 1.45,
                  wordBreak: "break-all",
                  color: "#0f172a",
                }}
              >
                <span style={{ color: "#94a3b8", marginRight: "8px", userSelect: "none" }}>{i + 1}.</span>
                {m}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function newNodeId(): NodeId {
  return crypto.randomUUID();
}

function edgeKey(source: NodeId, target: NodeId): string {
  return `${source}\t${target}`;
}

function pushEdge(
  edges: SitemapEdge[],
  seen: Set<string>,
  source: NodeId,
  target: NodeId,
): void {
  const k = edgeKey(source, target);
  if (seen.has(k)) return;
  seen.add(k);
  edges.push({ source, target });
}

/** Old snapshots may use numeric `id` only — assign a stable nodeId for graph + selection. */
function normalizeLoadedPage(p: ScrapedPage & { id?: number }): ScrapedPage {
  const nodeId =
    p.nodeId && String(p.nodeId).length > 0
      ? p.nodeId
      : typeof p.id === "number"
        ? `legacy-${p.id}`
        : newNodeId();
  const { id: _omit, ...rest } = p;
  return { ...rest, nodeId };
}

/** POST /api/sitemap/save request body */
type SitemapSavePayload = {
  rootUrl: string;
  pages: ScrapedPage[];
  edges: SitemapEdge[];
  selectedPage: ScrapedPage | null;
  logs: string[];
  /** ISO 8601 timestamp */
  savedAt: string;
};

/** POST /api/sitemap/save success JSON */
type SitemapSaveResponse = {
  ok: boolean;
  filename: string;
  path: string;
};

/** GET /api/sitemap/list */
type SitemapListFile = {
  filename: string;
  path: string;
  modified: string;
};

type SitemapListResponse = {
  files: SitemapListFile[];
};

/** GET /api/sitemap/load — same shape as saved JSON */
type SitemapSnapshot = {
  rootUrl?: string;
  pages?: ScrapedPage[];
  edges?: SitemapEdge[];
  selectedPage?: ScrapedPage | null;
  logs?: string[];
  savedAt?: string;
};

/** Pick the row to highlight after load: nodeId, legacy id, then url, else first page. */
function restoreSelectedPage(
  loadedPages: ScrapedPage[],
  saved: ScrapedPage | null | undefined,
): ScrapedPage | null {
  if (loadedPages.length === 0) return null;
  if (saved == null) return loadedPages[0];
  if (saved.nodeId) {
    const byNode = loadedPages.find((p) => p.nodeId === saved.nodeId);
    if (byNode) return byNode;
  }
  const legacy = saved as ScrapedPage & { id?: number };
  if (typeof legacy.id === "number") {
    const byLegacy = loadedPages.find((p) => p.nodeId === `legacy-${legacy.id}`);
    if (byLegacy) return byLegacy;
  }
  const byUrl = loadedPages.find((p) => p.url === saved.url);
  if (byUrl) return byUrl;
  return loadedPages[0];
}

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

/** POST JSON → file download (CSV/JSON). Parses errors from JSON error responses. */
async function postBlobDownload(
  path: string,
  body: unknown,
  fallbackFilename: string,
): Promise<void> {
  try {
    const res = await axios.post<Blob>(apiUrl(path), body, {
      responseType: "blob",
      timeout: 120_000,
      headers: { "Content-Type": "application/json" },
    });
    const blob = res.data;
    const cd = res.headers["content-disposition"];
    let filename = fallbackFilename;
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
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
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
        /* not JSON */
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
          "npm run dev so /api is proxied, or set VITE_API_BASE to your API URL.",
      );
    }
    throw e;
  }
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
  http_status?: number;
  status_label?: string;
  meta_description?: string | null;
  canonical_url?: string | null;
  og_title?: string | null;
  og_description?: string | null;
  og_image?: string | null;
  twitter_title?: string | null;
  twitter_description?: string | null;
  h1?: string[];
  h2?: string[];
  /** Full response body HTML (same as crawled `raw_html`). */
  raw_html?: string;
  raw_css?: string;
  raw_js?: string;
  error?: string;
};

/** One server request runs the full depth-limited crawl (same host, deduped URLs). */
const CRAWL_API_TIMEOUT_MS = 15 * 60 * 1000;

type CrawlDepth = 1 | 2 | 3;

type CrawlGraphResult = {
  pages: ScrapedPage[];
  edges: SitemapEdge[];
};

/** Live crawl progress (NDJSON stream from POST /api/crawl/stream). */
type CrawlProgressState = {
  current: number;
  total: number;
  url: string;
};

/** Mirrors backend `crawl_stats` from depth-limited crawl (sitemap / diagnostics). */
type CrawlStatsPayload = {
  counts?: {
    pages_recorded?: number;
    visited_unique?: number;
    enqueued_unique?: number;
    pending_in_queue?: number;
    skipped_duplicate?: number;
    depth_skipped_links?: number;
    external_urls_unique?: number;
  };
  visited_urls?: string[];
  queued_urls?: string[];
  pending?: Array<{ url: string; normalized: string; depth: number }>;
  skipped_duplicates_sample?: Array<{
    normalized: string;
    reason: string;
    from_page: string;
  }>;
  external_urls?: string[];
  external_urls_truncated?: boolean;
  broken_links?: unknown[];
};

type ServerCrawlResponse = {
  pages?: Array<Record<string, unknown>>;
  edges?: SitemapEdge[];
  errors?: Array<{ url: string; error: string }>;
  error?: string;
  crawl_depth?: number;
  crawl_stats?: CrawlStatsPayload;
};

function backendPageToScrapedPage(raw: Record<string, unknown>, index: number): ScrapedPage {
  const prev = (raw.preview as string[] | undefined) ?? (raw.paragraphs as string[] | undefined);
  const text = Array.isArray(prev) ? [...prev] : [];
  const pageUrl = String(raw.url ?? "");
  const nodeId = String(raw.nodeId ?? newNodeId());
  const category = String(
    raw.category ?? (index === 0 ? "home" : "crawled-page"),
  );
  const images = (raw.images as string[] | undefined) ?? [];
  const videos = (raw.videos as string[] | undefined) ?? [];
  const hs = raw.http_status;
  const http_status =
    typeof hs === "number" && !Number.isNaN(hs) ? hs : undefined;
  const status_label = parseStatusLabel(raw.status_label);
  const rawHtml = raw.raw_html;
  const rawCss = raw.raw_css;
  const rawJs = raw.raw_js;
  const item_type = parseItemType(raw.item_type);
  const extRaw = raw.extension;
  const extension =
    typeof extRaw === "string" && extRaw.length > 0 ? extRaw : undefined;
  const extracted =
    typeof raw.extracted_text === "string" ? raw.extracted_text : undefined;
  const fm = raw.file_metadata;
  const file_metadata =
    fm && typeof fm === "object" && !Array.isArray(fm)
      ? (fm as FileMetadata)
      : undefined;
  const pdf_page_count = parseOptionalPositiveInt(raw.pdf_page_count);
  const pdf_title =
    typeof raw.pdf_title === "string" && raw.pdf_title.trim().length > 0
      ? raw.pdf_title.trim()
      : null;
  const pdf_preview_snippet =
    typeof raw.pdf_preview_snippet === "string" && raw.pdf_preview_snippet.trim().length > 0
      ? raw.pdf_preview_snippet
      : null;
  const docx_title =
    typeof raw.docx_title === "string" && raw.docx_title.trim().length > 0
      ? raw.docx_title.trim()
      : null;
  const docx_preview_snippet =
    typeof raw.docx_preview_snippet === "string" && raw.docx_preview_snippet.trim().length > 0
      ? raw.docx_preview_snippet
      : null;
  const docx_paragraph_count = parseOptionalPositiveInt(raw.docx_paragraph_count);
  const epub_title =
    typeof raw.epub_title === "string" && raw.epub_title.trim().length > 0
      ? raw.epub_title.trim()
      : null;
  const epub_preview_snippet =
    typeof raw.epub_preview_snippet === "string" && raw.epub_preview_snippet.trim().length > 0
      ? raw.epub_preview_snippet
      : null;
  const epub_chapter_count = parseOptionalPositiveInt(raw.epub_chapter_count);
  const fsRaw = raw.file_size;
  const file_size =
    typeof fsRaw === "number" && !Number.isNaN(fsRaw) && fsRaw >= 0 ? fsRaw : null;
  return {
    nodeId,
    title: String(raw.title ?? pageUrl),
    category,
    url: pageUrl,
    item_type,
    mime_type: parseOptionalMetaString(raw.mime_type) ?? null,
    extension,
    extracted_text: extracted,
    pdf_page_count: pdf_page_count ?? null,
    pdf_title,
    pdf_preview_snippet,
    docx_title,
    docx_preview_snippet,
    docx_paragraph_count: docx_paragraph_count ?? null,
    epub_title,
    epub_preview_snippet,
    epub_chapter_count: epub_chapter_count ?? null,
    file_size,
    file_metadata,
    paragraph_count: Number(raw.paragraph_count ?? text.length),
    preview: text,
    http_status,
    status_label,
    meta_description: parseOptionalMetaString(raw.meta_description),
    canonical_url: parseOptionalMetaString(raw.canonical_url),
    og_title: parseOptionalMetaString(raw.og_title),
    og_description: parseOptionalMetaString(raw.og_description),
    og_image: parseOptionalMetaString(raw.og_image),
    twitter_title: parseOptionalMetaString(raw.twitter_title),
    twitter_description: parseOptionalMetaString(raw.twitter_description),
    h1: parseHeadingList(raw.h1),
    h2: parseHeadingList(raw.h2),
    html: text.join("\n\n"),
    raw_html: typeof rawHtml === "string" ? rawHtml : undefined,
    raw_css: typeof rawCss === "string" ? rawCss : undefined,
    raw_js: typeof rawJs === "string" ? rawJs : undefined,
    links: (raw.links as string[] | undefined) ?? [],
    images,
    videos,
    imageSources: provenanceForMedia(images, pageUrl),
    videoSources: provenanceForMedia(videos, pageUrl),
  };
}

function mapServerCrawlResponse(
  data: ServerCrawlResponse,
  crawlDepth: CrawlDepth,
  options: { onLog: (line: string) => void },
): CrawlGraphResult {
  if (data.error) {
    options.onLog(`Crawl failed: ${data.error}`);
    return { pages: [], edges: [] };
  }
  const rawPages = data.pages ?? [];
  const outPages = rawPages.map((p, i) =>
    backendPageToScrapedPage(p as Record<string, unknown>, i),
  );
  const outEdges = Array.isArray(data.edges) ? data.edges : [];
  for (const e of data.errors ?? []) {
    options.onLog(`FAIL ${e.url}: ${e.error}`);
  }
  options.onLog(
    `Crawl complete: ${outPages.length} pages, ${outEdges.length} edges (depth ${crawlDepth}).`,
  );
  return { pages: outPages, edges: outEdges };
}

async function serverCrawl(
  startUrl: string,
  crawlDepth: CrawlDepth,
  options: {
    onLog: (line: string) => void;
    onProgress?: (p: CrawlProgressState) => void;
  },
): Promise<CrawlGraphResult> {
  const legacyJsonCrawl = async (): Promise<CrawlGraphResult> => {
    try {
      const response = await axios.post<ServerCrawlResponse>(
        apiUrl("/api/crawl"),
        { url: startUrl, crawl_depth: crawlDepth },
        {
          timeout: CRAWL_API_TIMEOUT_MS,
          headers: { "Content-Type": "application/json" },
        },
      );
      return mapServerCrawlResponse(response.data, crawlDepth, options);
    } catch (e: unknown) {
      if (axios.isAxiosError(e) && e.response?.data && typeof e.response.data === "object") {
        const body = e.response.data as { error?: string };
        if (body.error) {
          options.onLog(`Crawl failed: ${body.error}`);
          return { pages: [], edges: [] };
        }
      }
      const msg = axios.isAxiosError(e) ? e.message : String(e);
      options.onLog(`Crawl request failed: ${msg}`);
      return { pages: [], edges: [] };
    }
  };

  try {
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), CRAWL_API_TIMEOUT_MS);
    const res = await fetch(apiUrl("/api/crawl/stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: startUrl,
        crawl_depth: crawlDepth,
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);

    if (res.status === 404) {
      options.onLog("Stream API not found — using JSON crawl.");
      return legacyJsonCrawl();
    }
    if (!res.ok) {
      const snippet = await res.text().catch(() => "");
      options.onLog(`Crawl stream HTTP ${res.status}: ${snippet.slice(0, 160)}`);
      return legacyJsonCrawl();
    }

    const reader = res.body?.getReader();
    if (!reader) {
      options.onLog("No response body — using JSON crawl.");
      return legacyJsonCrawl();
    }

    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj: unknown;
        try {
          obj = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        if (typeof obj !== "object" || obj === null || !("type" in obj)) continue;
        const o = obj as { type: string };
        if (o.type === "progress") {
          const p = obj as unknown as {
            current: number;
            total: number;
            url: string;
          };
          options.onProgress?.({
            current: p.current,
            total: p.total,
            url: p.url,
          });
          options.onLog(`Crawl ${p.current}/${p.total}: ${p.url}`);
        } else if (o.type === "done") {
          const data = (obj as unknown as { data: ServerCrawlResponse }).data;
          return mapServerCrawlResponse(data, crawlDepth, options);
        } else if (o.type === "error") {
          const msg = (obj as { message?: string }).message ?? "Unknown error";
          options.onLog(`Crawl failed: ${msg}`);
          return { pages: [], edges: [] };
        }
      }
    }
    options.onLog("Crawl stream closed without a result — using JSON crawl.");
    return legacyJsonCrawl();
  } catch (e: unknown) {
    const aborted =
      (e instanceof Error || e instanceof DOMException) && (e as Error).name === "AbortError";
    if (aborted) {
      options.onLog("Crawl timed out.");
      return { pages: [], edges: [] };
    }
    options.onLog(
      `Crawl stream error: ${e instanceof Error ? e.message : String(e)} — trying JSON crawl.`,
    );
    return legacyJsonCrawl();
  }
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
  const [savingSitemap, setSavingSitemap] = useState(false);
  const [loadingSitemap, setLoadingSitemap] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [exportingJson, setExportingJson] = useState(false);
  const [edges, setEdges] = useState<SitemapEdge[]>([]);
  /** 1 = root only, 2 = root + direct links, 3 = one more hop (matches `/api/crawl`). */
  const [crawlDepth, setCrawlDepth] = useState<CrawlDepth>(2);
  /** Filled during NDJSON crawl stream (current/total + URL being fetched). */
  const [crawlProgress, setCrawlProgress] = useState<CrawlProgressState | null>(null);
  /** Server-side Playwright capture for the Screenshot tab. */
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [screenshotPreviewUrl, setScreenshotPreviewUrl] = useState<string | null>(null);
  const [screenshotError, setScreenshotError] = useState<ScreenshotErrorState>(null);

  /** Left table: search / filters apply only to the visible list (``pages`` is unchanged). */
  const [tableSearchQuery, setTableSearchQuery] = useState("");
  const [tableTypeFilter, setTableTypeFilter] = useState<TableTypeFilter>("all");
  const [tableMediaFilter, setTableMediaFilter] = useState<TableMediaFilter>("any");
  const [tableHttpFilter, setTableHttpFilter] = useState<TableHttpFilter>("any");

  const filteredTablePages = useMemo(
    () =>
      filterScrapedPagesForTable(pages, {
        search: tableSearchQuery,
        typeFilter: tableTypeFilter,
        mediaFilter: tableMediaFilter,
        httpFilter: tableHttpFilter,
      }),
    [pages, tableSearchQuery, tableTypeFilter, tableMediaFilter, tableHttpFilter],
  );

  useEffect(() => {
    setScreenshotPreviewUrl(null);
    setScreenshotError(null);
  }, [selectedPage?.nodeId]);

  /** Pages for the graph (hide aggregate rows so the map matches crawled URLs). */
  const graphPages = useMemo(
    () =>
      pages.filter(
        (p) => p.category !== "aggregate-images" && p.category !== "aggregate-videos",
      ),
    [pages],
  );

  const graphEdgesFiltered = useMemo(() => {
    const idSet = new Set(graphPages.map((p) => p.nodeId));
    return edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
  }, [graphPages, edges]);

  const tabs = [
    "Text View",
    "XML View",
    "HTML",
    "CSS",
    "JavaScript",
    "Metadata",
    "Tables",
    "JSON",
    "Regex Search",
    "Images",
    "Videos",
    "Screenshot",
    "Sitemap Graph",
  ];

  const handleScrapeSite = async () => {
    const start = rootUrl.trim();
    if (!start) return;

    setLoading(true);
    setCrawlProgress(null);
    setLogs((prev) => [
      ...prev,
      `Crawl from ${start} (depth ${crawlDepth}, same domain, server-side BFS, all reachable pages)…`,
    ]);

    try {
      const crawlResult = await serverCrawl(start, crawlDepth, {
        onLog: (line) => setLogs((prev) => [...prev, line]),
        onProgress: (p) => setCrawlProgress(p),
      });

      if (crawlResult.pages.length === 0) {
        setLogs((prev) => [...prev, "Crawl returned no pages (check failures above)."]);
        setPages([]);
        setEdges([]);
        setSelectedPage(null);
        return;
      }

      setPages(crawlResult.pages);
      setEdges(crawlResult.edges);
      setSelectedPage(crawlResult.pages[0]);
    } catch (error) {
      console.error(error);
      setLogs((prev) => [...prev, `ERROR crawl ${start}`]);
    } finally {
      setLoading(false);
      setCrawlProgress(null);
    }
  };

  const handleScrapeAllMedia = async (kind: "images" | "videos") => {
    const root = rootUrl.trim();
    if (!root) return;

    setLoading(true);
    setCrawlProgress(null);
    setLogs((prev) => [
      ...prev,
      `${kind === "images" ? "Scrape all images" : "Scrape all videos"} (every crawled page) — ${root}`,
    ]);

    try {
      let contentPages = pages.filter(
        (p) => p.category !== "aggregate-images" && p.category !== "aggregate-videos",
      );
      let graphEdges = edges;

      if (contentPages.length === 0) {
        setLogs((prev) => [
          ...prev,
          `No pages in the table — running crawl first (depth ${crawlDepth})…`,
        ]);
        const crawlResult = await serverCrawl(root, crawlDepth, {
          onLog: (line) => setLogs((prev) => [...prev, line]),
          onProgress: (p) => setCrawlProgress(p),
        });
        contentPages = crawlResult.pages;
        graphEdges = crawlResult.edges;
        if (contentPages.length === 0) {
          setLogs((prev) => [...prev, "Crawl returned no pages; cannot build media list."]);
          return;
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

      const mergedImgArr = Array.from(mergedImages);
      const mergedVidArr = Array.from(mergedVideos);

      const aggregateNodeId = newNodeId();
      const aggregatePage: ScrapedPage =
        kind === "images"
          ? {
              nodeId: aggregateNodeId,
              title: `All images (${mergedImgArr.length})`,
              category: "aggregate-images",
              url: root,
              paragraph_count: 0,
              preview: [],
              http_status: 200,
              status_label: "ok",
              meta_description: undefined,
              canonical_url: undefined,
              og_title: undefined,
              og_description: undefined,
              og_image: undefined,
              twitter_title: undefined,
              twitter_description: undefined,
              h1: [],
              h2: [],
              html: "",
              raw_html: undefined,
              raw_css: undefined,
              raw_js: undefined,
              links: [],
              images: mergedImgArr,
              videos: [],
              imageSources: imageProv,
              videoSources: [],
            }
          : {
              nodeId: aggregateNodeId,
              title: `All videos (${mergedVidArr.length})`,
              category: "aggregate-videos",
              url: root,
              paragraph_count: 0,
              preview: [],
              http_status: 200,
              status_label: "ok",
              meta_description: undefined,
              canonical_url: undefined,
              og_title: undefined,
              og_description: undefined,
              og_image: undefined,
              twitter_title: undefined,
              twitter_description: undefined,
              h1: [],
              h2: [],
              html: "",
              raw_html: undefined,
              links: [],
              images: [],
              videos: mergedVidArr,
              imageSources: [],
              videoSources: videoProv,
            };

      const rootPage =
        contentPages.find((p) => p.category === "home") ?? contentPages[0];
      const nextEdges = [...graphEdges];
      const edgeSeen = new Set(nextEdges.map((e) => edgeKey(e.source, e.target)));
      if (rootPage) {
        pushEdge(nextEdges, edgeSeen, rootPage.nodeId, aggregateNodeId);
      }

      setEdges(nextEdges);
      setPages([aggregatePage, ...contentPages]);
      setSelectedPage(aggregatePage);
      setActiveTab(kind === "images" ? "Images" : "Videos");
      const count = kind === "images" ? mergedImgArr.length : mergedVidArr.length;
      setLogs((prev) => [...prev, `Done: ${count} unique ${kind}`]);

      const provEntries = kind === "images" ? imageProv : videoProv;
      if (provEntries.length > 0) {
        setLogs((prev) => [
          ...prev,
          "Building ZIP: downloading each file on the server (embeds skip; large videos can take many minutes)…",
        ]);
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
      setCrawlProgress(null);
    }
  };

  const handleSaveSitemap = async () => {
    const payload: SitemapSavePayload = {
      rootUrl,
      pages,
      edges,
      selectedPage,
      logs,
      savedAt: new Date().toISOString(),
    };

    setSavingSitemap(true);
    setLogs((prev) => [...prev, "Saving sitemap…"]);
    try {
      const res = await axios.post<SitemapSaveResponse>(
        apiUrl("/api/sitemap/save"),
        payload,
        {
          headers: { "Content-Type": "application/json" },
          timeout: 60_000,
        },
      );
      const data = res.data;
      if (data.ok) {
        setLogs((prev) => [
          ...prev,
          `Sitemap saved: ${data.filename}`,
          `Path (server): ${data.path}`,
        ]);
      }
    } catch (e: unknown) {
      let msg = "Save failed";
      if (axios.isAxiosError(e) && e.response?.data && typeof e.response.data === "object") {
        const body = e.response.data as { error?: string };
        if (body.error) msg = body.error;
      } else if (e instanceof Error) {
        msg = e.message;
      }
      console.error(e);
      setLogs((prev) => [...prev, `Sitemap save error: ${msg}`]);
    } finally {
      setSavingSitemap(false);
    }
  };

  const handleLoadSitemap = async () => {
    setLoadingSitemap(true);
    try {
      const listRes = await axios.get<SitemapListResponse>(apiUrl("/api/sitemap/list"), {
        timeout: 30_000,
      });
      const files = listRes.data.files ?? [];
      if (files.length === 0) {
        setLogs((prev) => [...prev, "No saved sitemaps yet — use Save Sitemap first."]);
        return;
      }

      const lines = files.map((f, i) => `${i + 1}. ${f.filename}`).join("\n");
      const choice = window.prompt(
        `Saved sitemaps (newest first).\nEnter a number (1–${files.length}) or the exact filename:\n\n${lines}`,
      );
      if (choice === null) {
        setLogs((prev) => [...prev, "Load sitemap cancelled."]);
        return;
      }

      const trimmed = choice.trim();
      let filename: string | undefined;
      const n = parseInt(trimmed, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= files.length) {
        filename = files[n - 1].filename;
      } else {
        filename = files.find((f) => f.filename === trimmed)?.filename;
      }
      if (!filename) {
        setLogs((prev) => [...prev, `No file matched "${trimmed}".`]);
        return;
      }

      const loadRes = await axios.get<SitemapSnapshot>(apiUrl("/api/sitemap/load"), {
        params: { filename },
        timeout: 120_000,
      });
      const data = loadRes.data;
      if (typeof (data as { error?: string }).error === "string") {
        setLogs((prev) => [...prev, `Load failed: ${(data as { error: string }).error}`]);
        return;
      }

      const raw = Array.isArray(data.pages) ? data.pages : [];
      const nextPages = raw.map((row) =>
        normalizeLoadedPage(row as ScrapedPage & { id?: number }),
      );
      setRootUrl(typeof data.rootUrl === "string" ? data.rootUrl : "");
      setPages(nextPages);
      setEdges(Array.isArray(data.edges) ? data.edges : []);
      setSelectedPage(restoreSelectedPage(nextPages, data.selectedPage ?? null));
      const priorLogs = Array.isArray(data.logs) ? data.logs : [];
      setLogs([...priorLogs, `Loaded sitemap: ${filename}`]);
    } catch (e: unknown) {
      let msg = "Load failed";
      if (axios.isAxiosError(e) && e.response?.data && typeof e.response.data === "object") {
        const body = e.response.data as { error?: string };
        if (body.error) msg = body.error;
      } else if (e instanceof Error) {
        msg = e.message;
      }
      console.error(e);
      setLogs((prev) => [...prev, `Sitemap load error: ${msg}`]);
    } finally {
      setLoadingSitemap(false);
    }
  };

  const handleExportCsv = async () => {
    if (pages.length === 0) {
      setLogs((prev) => [...prev, "Nothing to export — crawl or load a sitemap first."]);
      return;
    }
    setExportingCsv(true);
    setLogs((prev) => [...prev, "Exporting pages as CSV…"]);
    try {
      await postBlobDownload("/api/export/pages-csv", { pages }, "spider-scraper-pages.csv");
      setLogs((prev) => [...prev, "CSV export finished (download started)."]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(e);
      setLogs((prev) => [...prev, `CSV export failed: ${msg}`]);
    } finally {
      setExportingCsv(false);
    }
  };

  const handleExportJson = async () => {
    if (pages.length === 0) {
      setLogs((prev) => [...prev, "Nothing to export — crawl or load a sitemap first."]);
      return;
    }
    setExportingJson(true);
    setLogs((prev) => [...prev, "Exporting full sitemap as JSON…"]);
    try {
      const payload = {
        rootUrl,
        pages,
        edges,
        selectedPage,
        logs,
        savedAt: new Date().toISOString(),
      };
      await postBlobDownload(
        "/api/export/sitemap-json",
        payload,
        "spider-scraper-sitemap.json",
      );
      setLogs((prev) => [...prev, "JSON export finished (download started)."]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(e);
      setLogs((prev) => [...prev, `JSON export failed: ${msg}`]);
    } finally {
      setExportingJson(false);
    }
  };

  const handleDownloadZip = async (mode: "images" | "videos") => {
    const entries =
      mode === "images" ? selectedPage?.imageSources : selectedPage?.videoSources;
    if (!entries?.length) return;
    setZipBusy(true);
    setLogs((prev) => [
      ...prev,
      `ZIP export (${mode}): server downloads each file — may take a while for large video sets…`,
    ]);
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

    if (page.item_type && page.item_type !== "page") {
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
      const response = await axios.post(
        apiUrl("/api/scrape"),
        { url: page.url },
        { timeout: PER_PAGE_SCRAPE_TIMEOUT_MS },
      );

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
        http_status:
          typeof result.http_status === "number" ? result.http_status : page.http_status,
        status_label: parseStatusLabel(result.status_label) ?? page.status_label,
        meta_description:
          parseOptionalMetaString(result.meta_description) ?? page.meta_description,
        canonical_url: parseOptionalMetaString(result.canonical_url) ?? page.canonical_url,
        og_title: parseOptionalMetaString(result.og_title) ?? page.og_title,
        og_description: parseOptionalMetaString(result.og_description) ?? page.og_description,
        og_image: parseOptionalMetaString(result.og_image) ?? page.og_image,
        twitter_title: parseOptionalMetaString(result.twitter_title) ?? page.twitter_title,
        twitter_description:
          parseOptionalMetaString(result.twitter_description) ?? page.twitter_description,
        h1: parseHeadingList(result.h1),
        h2: parseHeadingList(result.h2),
        raw_html:
          typeof result.raw_html === "string" ? result.raw_html : page.raw_html,
        raw_css: typeof result.raw_css === "string" ? result.raw_css : page.raw_css,
        raw_js: typeof result.raw_js === "string" ? result.raw_js : page.raw_js,
      };

      const updatedPages = pages.map((p) =>
        p.nodeId === page.nodeId ? updatedPage : p,
      );

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

  const detailPanelFillFlex =
    activeTab === "Sitemap Graph" ||
    activeTab === "HTML" ||
    activeTab === "CSS" ||
    activeTab === "JavaScript" ||
    activeTab === "Regex Search" ||
    activeTab === "Screenshot";

  const handlePageScreenshot = useCallback(async () => {
    const url = selectedPage?.url?.trim();
    if (!url) {
      setScreenshotError({ kind: "generic", message: "No page selected." });
      return;
    }
    setScreenshotBusy(true);
    setScreenshotError(null);
    try {
      const res = await axios.post<
        | { ok: true; filename: string; imageUrl: string }
        | { error: string; message?: string }
      >(apiUrl("/api/screenshot"), { url }, {
        timeout: 120_000,
        headers: { "Content-Type": "application/json" },
      });
      const d = res.data;
      if ("error" in d && d.error) {
        setScreenshotError(parseScreenshotApiError(d));
        return;
      }
      if (!("ok" in d && d.ok && d.imageUrl)) {
        setScreenshotError(parseScreenshotApiError(d));
        return;
      }
      setScreenshotPreviewUrl(`${apiUrl(d.imageUrl)}?t=${Date.now()}`);
    } catch (e: unknown) {
      if (axios.isAxiosError(e)) {
        const body = e.response?.data;
        setScreenshotError(
          body ? parseScreenshotApiError(body) : { kind: "generic", message: e.message },
        );
      } else {
        setScreenshotError({ kind: "generic", message: String(e) });
      }
    } finally {
      setScreenshotBusy(false);
    }
  }, [selectedPage?.url]);

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

        <label
          htmlFor="crawl-depth"
          style={{ fontSize: "13px", color: "#374151", whiteSpace: "nowrap" }}
        >
          Depth:
        </label>
        <select
          id="crawl-depth"
          value={crawlDepth}
          onChange={(e) => setCrawlDepth(Number(e.target.value) as CrawlDepth)}
          disabled={loading}
          style={{
            padding: "8px 10px",
            borderRadius: "8px",
            border: "1px solid #cbd5e1",
            fontSize: "13px",
            background: "#ffffff",
            cursor: loading ? "not-allowed" : "pointer",
            maxWidth: "200px",
          }}
          title="1 = start URL only. 2 = start + pages linked from it. 3 = one more level of internal links."
        >
          <option value={1}>1 — root page only</option>
          <option value={2}>2 — root + linked pages</option>
          <option value={3}>3 — root + 2 levels of links</option>
        </select>

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
          {loading ? "Crawling…" : "Crawl"}
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

        <button
          type="button"
          onClick={() => void handleSaveSitemap()}
          disabled={loading || savingSitemap}
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #cbd5e1",
            background: savingSitemap ? "#f1f5f9" : "#ffffff",
            color: "#111827",
            cursor: loading || savingSitemap || loadingSitemap ? "not-allowed" : "pointer",
            fontSize: "13px",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          {savingSitemap ? "Saving…" : "Save Sitemap"}
        </button>

        <button
          type="button"
          onClick={() => void handleLoadSitemap()}
          disabled={loading || savingSitemap || loadingSitemap}
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #cbd5e1",
            background: loadingSitemap ? "#f1f5f9" : "#ffffff",
            color: "#111827",
            cursor: loading || savingSitemap || loadingSitemap ? "not-allowed" : "pointer",
            fontSize: "13px",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          {loadingSitemap ? "Loading…" : "Load Sitemap"}
        </button>

        <button
          type="button"
          onClick={() => void handleExportCsv()}
          disabled={
            loading ||
            savingSitemap ||
            loadingSitemap ||
            exportingCsv ||
            exportingJson ||
            pages.length === 0
          }
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #0f766e",
            background: exportingCsv ? "#ccfbf1" : "#f0fdfa",
            color: "#115e59",
            cursor:
              loading ||
              savingSitemap ||
              loadingSitemap ||
              exportingCsv ||
              exportingJson ||
              pages.length === 0
                ? "not-allowed"
                : "pointer",
            fontSize: "13px",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          {exportingCsv ? "Exporting…" : "Export CSV"}
        </button>

        <button
          type="button"
          onClick={() => void handleExportJson()}
          disabled={
            loading ||
            savingSitemap ||
            loadingSitemap ||
            exportingCsv ||
            exportingJson ||
            pages.length === 0
          }
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #0369a1",
            background: exportingJson ? "#e0f2fe" : "#f0f9ff",
            color: "#0c4a6e",
            cursor:
              loading ||
              savingSitemap ||
              loadingSitemap ||
              exportingCsv ||
              exportingJson ||
              pages.length === 0
                ? "not-allowed"
                : "pointer",
            fontSize: "13px",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          {exportingJson ? "Exporting…" : "Export JSON"}
        </button>

      </div>

      <div className="scraper-main">
        <div className="scraper-left">
          <div
            style={{
              flexShrink: 0,
              padding: "10px 12px",
              borderBottom: "1px solid #cbd5e1",
              background: "#f8fafc",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "8px 12px",
                justifyContent: "space-between",
              }}
            >
              <span style={{ fontSize: "12px", fontWeight: 700, color: "#334155" }}>
                Results
              </span>
              <span style={{ fontSize: "12px", color: "#64748b" }}>
                Showing{" "}
                <strong style={{ color: "#0f172a" }}>{filteredTablePages.length}</strong> of{" "}
                {pages.length}
              </span>
            </div>
            <input
              type="search"
              value={tableSearchQuery}
              onChange={(e) => setTableSearchQuery(e.target.value)}
              placeholder="Search title or URL…"
              aria-label="Search results by title or URL"
              style={{
                width: "100%",
                maxWidth: "100%",
                boxSizing: "border-box",
                padding: "8px 10px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                fontSize: "13px",
                background: "#ffffff",
              }}
            />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: "8px",
                width: "100%",
              }}
            >
              <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", fontWeight: 600, color: "#64748b" }}>
                Type
                <select
                  value={tableTypeFilter}
                  onChange={(e) => setTableTypeFilter(e.target.value as TableTypeFilter)}
                  style={{
                    padding: "6px 8px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "12px",
                    background: "#ffffff",
                  }}
                >
                  <option value="all">All</option>
                  <option value="page">Pages only</option>
                  <option value="pdf">PDFs only</option>
                  <option value="docx">DOCX only</option>
                  <option value="epub">EPUB only</option>
                  <option value="broken">Broken only</option>
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", fontWeight: 600, color: "#64748b" }}>
                Media
                <select
                  value={tableMediaFilter}
                  onChange={(e) => setTableMediaFilter(e.target.value as TableMediaFilter)}
                  style={{
                    padding: "6px 8px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "12px",
                    background: "#ffffff",
                  }}
                >
                  <option value="any">Any</option>
                  <option value="images">Has images</option>
                  <option value="videos">Has videos</option>
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", fontWeight: 600, color: "#64748b" }}>
                HTTP
                <select
                  value={tableHttpFilter}
                  onChange={(e) => setTableHttpFilter(e.target.value as TableHttpFilter)}
                  style={{
                    padding: "6px 8px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "12px",
                    background: "#ffffff",
                  }}
                >
                  <option value="any">Any</option>
                  <option value="ok">200 OK</option>
                  <option value="redirect">Redirect</option>
                  <option value="broken">Broken</option>
                </select>
              </label>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              <button
                type="button"
                onClick={() => {
                  setTableSearchQuery("");
                  setTableTypeFilter("all");
                  setTableMediaFilter("any");
                  setTableHttpFilter("any");
                }}
                style={{
                  padding: "6px 12px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#475569",
                  cursor: "pointer",
                }}
              >
                Reset filters
              </button>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "34% 11% 11% 14% 28%",
              padding: "10px 12px",
              background: "#f1f5f9",
              borderBottom: "1px solid #cbd5e1",
              fontWeight: 700,
              fontSize: "13px",
              minWidth: "980px",
            }}
          >
            <div>Title</div>
            <div>Type</div>
            <div>Category</div>
            <div>HTTP</div>
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
            ) : filteredTablePages.length === 0 ? (
              <div style={{ padding: "16px", color: "#6b7280", fontSize: "14px" }}>
                No rows match your search and filters. Try{" "}
                <button
                  type="button"
                  onClick={() => {
                    setTableSearchQuery("");
                    setTableTypeFilter("all");
                    setTableMediaFilter("any");
                    setTableHttpFilter("any");
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#2563eb",
                    cursor: "pointer",
                    textDecoration: "underline",
                    fontSize: "inherit",
                    padding: 0,
                  }}
                >
                  resetting filters
                </button>
                .
              </div>
            ) : (
              filteredTablePages.map((page) => {
                const selected = selectedPage?.nodeId === page.nodeId;
                return (
                  <div
                    key={page.nodeId}
                    onClick={() => scrapeLinkedPage(page)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "34% 11% 11% 14% 28%",
                      padding: "10px 12px",
                      borderBottom: "1px solid #e5e7eb",
                      cursor: "pointer",
                      background: selected ? "#dbeafe" : "#ffffff",
                      color: selected ? "#1d4ed8" : "#111827",
                      fontSize: "13px",
                      minWidth: "980px",
                      alignItems: "center",
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
                    <div style={{ minWidth: 0 }}>
                      <ItemTypeBadge type={page.item_type ?? "page"} />
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
                    <div style={{ minWidth: 0 }}>
                      <StatusBadge label={page.status_label} code={page.http_status} />
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

          {selectedPage ? <DocumentAssetDetailPanel page={selectedPage} /> : null}

          <div
            style={{
              display: "flex",
              gap: "8px",
              padding: "8px 12px",
              borderBottom: "1px solid #cbd5e1",
              background: "#f8fafc",
              flexWrap: "wrap",
              alignItems: "center",
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
              padding: detailPanelFillFlex ? 0 : "16px",
              overflowY: detailPanelFillFlex ? "hidden" : "auto",
              overflowX: detailPanelFillFlex ? "hidden" : undefined,
              minHeight: 0,
              display: detailPanelFillFlex ? "flex" : "block",
              flexDirection: detailPanelFillFlex ? "column" : undefined,
              fontSize: "14px",
              lineHeight: 1.6,
              background: "#ffffff",
            }}
          >
            {activeTab === "Sitemap Graph" ? (
              <SitemapGraphView
                pages={graphPages}
                edges={graphEdgesFiltered}
                selectedPageNodeId={selectedPage?.nodeId ?? null}
                onSelectPageByNodeId={(nodeId) => {
                  const p = pages.find((x) => x.nodeId === nodeId);
                  if (p) setSelectedPage(p);
                }}
              />
            ) : activeTab === "Screenshot" ? (
              <PageScreenshotPanel
                pageUrl={selectedPage?.url}
                busy={screenshotBusy}
                previewUrl={screenshotPreviewUrl}
                error={screenshotError}
                onCapture={handlePageScreenshot}
                onRetry={handlePageScreenshot}
              />
            ) : !selectedPage ? (
              <div style={{ color: "#6b7280" }}>Scrape a site to view details here.</div>
            ) : activeTab === "Text View" ? (
              <pre
                style={{
                  margin: 0,
                  fontFamily: "Consolas, monospace",
                  whiteSpace: "pre-wrap",
                }}
              >
                {selectedPage.item_type === "pdf"
                  ? `Title: ${selectedPage.title}
PDF title (metadata): ${selectedPage.pdf_title ?? "—"}
Pages: ${selectedPage.pdf_page_count != null ? selectedPage.pdf_page_count : "—"}
File size: ${formatFileSize(selectedPage.file_size ?? undefined)}
Category: ${selectedPage.category}
Type: ${selectedPage.item_type ?? "page"}
${selectedPage.mime_type ? `MIME: ${selectedPage.mime_type}\n` : ""}${selectedPage.extension ? `Extension: ${selectedPage.extension}\n` : ""}URL: ${selectedPage.url}
HTTP: ${selectedPage.http_status != null && selectedPage.http_status > 0 ? selectedPage.http_status : "—"} (${statusLabelDisplay(selectedPage.status_label)})
${selectedPage.file_metadata && Object.keys(selectedPage.file_metadata).length > 0 ? `File metadata: ${JSON.stringify(selectedPage.file_metadata)}\n` : ""}
${selectedPage.pdf_preview_snippet ? `Preview snippet:\n${selectedPage.pdf_preview_snippet}\n\n` : ""}${selectedPage.extracted_text ? `Extracted text (full):\n${selectedPage.extracted_text}\n\n` : ""}Preview chunks:
${selectedPage.preview.join("\n\n")}`
                  : selectedPage.item_type === "docx"
                    ? `Title: ${selectedPage.title}
DOCX title (core): ${selectedPage.docx_title ?? "—"}
Non-empty paragraphs: ${selectedPage.docx_paragraph_count != null ? selectedPage.docx_paragraph_count : "—"}
File size: ${formatFileSize(selectedPage.file_size ?? undefined)}
Category: ${selectedPage.category}
Type: ${selectedPage.item_type ?? "page"}
${selectedPage.mime_type ? `MIME: ${selectedPage.mime_type}\n` : ""}${selectedPage.extension ? `Extension: ${selectedPage.extension}\n` : ""}URL: ${selectedPage.url}
HTTP: ${selectedPage.http_status != null && selectedPage.http_status > 0 ? selectedPage.http_status : "—"} (${statusLabelDisplay(selectedPage.status_label)})
${selectedPage.file_metadata && Object.keys(selectedPage.file_metadata).length > 0 ? `File metadata: ${JSON.stringify(selectedPage.file_metadata)}\n` : ""}
${selectedPage.docx_preview_snippet ? `Preview snippet:\n${selectedPage.docx_preview_snippet}\n\n` : ""}${selectedPage.extracted_text ? `Extracted text (full):\n${selectedPage.extracted_text}\n\n` : ""}Preview chunks:
${selectedPage.preview.join("\n\n")}`
                    : selectedPage.item_type === "epub"
                      ? `Title: ${selectedPage.title}
EPUB title (DC): ${selectedPage.epub_title ?? "—"}
Spine HTML documents: ${selectedPage.epub_chapter_count != null ? selectedPage.epub_chapter_count : "—"}
File size: ${formatFileSize(selectedPage.file_size ?? undefined)}
Category: ${selectedPage.category}
Type: ${selectedPage.item_type ?? "page"}
${selectedPage.mime_type ? `MIME: ${selectedPage.mime_type}\n` : ""}${selectedPage.extension ? `Extension: ${selectedPage.extension}\n` : ""}URL: ${selectedPage.url}
HTTP: ${selectedPage.http_status != null && selectedPage.http_status > 0 ? selectedPage.http_status : "—"} (${statusLabelDisplay(selectedPage.status_label)})
${selectedPage.file_metadata && Object.keys(selectedPage.file_metadata).length > 0 ? `File metadata: ${JSON.stringify(selectedPage.file_metadata)}\n` : ""}
${selectedPage.epub_preview_snippet ? `Preview snippet:\n${selectedPage.epub_preview_snippet}\n\n` : ""}${selectedPage.extracted_text ? `Extracted text (full):\n${selectedPage.extracted_text}\n\n` : ""}Preview chunks:
${selectedPage.preview.join("\n\n")}`
                  : `Title: ${selectedPage.title}
Category: ${selectedPage.category}
Type: ${selectedPage.item_type ?? "page"}
${selectedPage.mime_type ? `MIME: ${selectedPage.mime_type}\n` : ""}${selectedPage.extension ? `Extension: ${selectedPage.extension}\n` : ""}URL: ${selectedPage.url}
HTTP: ${selectedPage.http_status != null && selectedPage.http_status > 0 ? selectedPage.http_status : "—"} (${statusLabelDisplay(selectedPage.status_label)})
Paragraph Count: ${selectedPage.paragraph_count}
${selectedPage.file_metadata && Object.keys(selectedPage.file_metadata).length > 0 ? `File metadata: ${JSON.stringify(selectedPage.file_metadata)}\n` : ""}
${selectedPage.extracted_text ? `Extracted text:\n${selectedPage.extracted_text}\n\n` : ""}Preview:
${selectedPage.preview.join("\n\n")}`}
              </pre>
            ) : activeTab === "Metadata" ? (
              <PageMetadataPanel page={selectedPage} />
            ) : activeTab === "HTML" ? (
              <CodePreviewPanel
                title="HTML source"
                content={selectedPage.raw_html}
                emptyMessage="No HTML source for this page. Run a crawl or open a page after scrape."
              />
            ) : activeTab === "CSS" ? (
              <CodePreviewPanel
                title="CSS source"
                content={selectedPage.raw_css}
                emptyMessage="No inline style blocks or linked stylesheets found. External stylesheet URLs are listed as comments only (files are not fetched)."
              />
            ) : activeTab === "JavaScript" ? (
              <CodePreviewPanel
                title="JavaScript source"
                content={selectedPage.raw_js}
                emptyMessage="No inline scripts or external script tags found. JSON-LD and other non-JS script types are omitted."
              />
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
            ) : activeTab === "Regex Search" ? (
              <RegexSearchPanel page={selectedPage} />
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

      <div
        className={
          loading ||
            zipBusy ||
            savingSitemap ||
            loadingSitemap ||
            exportingCsv ||
            exportingJson
            ? "scraper-footer scraper-footer--working"
            : "scraper-footer"
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          flexWrap: "wrap",
          minHeight: crawlProgress && loading ? 52 : undefined,
        }}
      >
        <div style={{ flexShrink: 0 }}>Pages scraped: {pages.length}</div>
        {crawlProgress ? (
          <div
            style={{
              flex: "1 1 200px",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              gap: "4px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                gap: "8px",
                fontSize: "11px",
                fontWeight: 600,
                color: "rgba(255,255,255,0.95)",
              }}
            >
              <span>
                Crawl {crawlProgress.current} / {crawlProgress.total}
              </span>
              <span style={{ fontWeight: 500, opacity: 0.9 }}>in progress</span>
            </div>
            <div
              title={crawlProgress.url}
              style={{
                fontSize: "11px",
                color: "rgba(255,255,255,0.88)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "Consolas, ui-monospace, monospace",
              }}
            >
              {crawlProgress.url}
            </div>
            <div
              style={{
                height: "6px",
                borderRadius: "4px",
                background: "rgba(255,255,255,0.25)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.min(
                    100,
                    (crawlProgress.current / Math.max(1, crawlProgress.total)) * 100,
                  )}%`,
                  background: "rgba(255,255,255,0.95)",
                  borderRadius: "4px",
                  transition: "width 0.2s ease-out",
                }}
              />
            </div>
          </div>
        ) : (
          <div style={{ flex: 1 }} />
        )}
        <div style={{ flexShrink: 0, marginLeft: "auto" }}>
          {loading ||
          zipBusy ||
          savingSitemap ||
          loadingSitemap ||
          exportingCsv ||
          exportingJson
            ? "Working..."
            : "Done"}
        </div>
      </div>
    </div>
  );
}