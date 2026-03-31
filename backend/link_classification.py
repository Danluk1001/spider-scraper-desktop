"""
Classify discovered URLs as HTML pages vs downloadable documents (by path extension).

MIME sniffing can refine types later; v1 uses URL path only (query is ignored).
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

# Treat as normal web pages (crawl as HTML).
_HTML_LIKE_SUFFIXES = frozenset(
    {
        ".html",
        ".htm",
        ".php",
        ".php3",
        ".php4",
        ".phtml",
        ".asp",
        ".aspx",
        ".jsp",
        ".cgi",
    }
)

# Known document buckets (item_type matches requirement labels).
_KNOWN_DOC_TYPES: dict[str, str] = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".doc": "doc",
    ".epub": "epub",
}

# Other static / binary files — still listed, not crawled as HTML.
_OTHER_FILE_SUFFIXES = frozenset(
    {
        ".zip",
        ".xls",
        ".xlsx",
        ".ppt",
        ".pptx",
        ".csv",
        ".txt",
        ".rtf",
        ".odt",
        ".ods",
        ".7z",
        ".rar",
        ".gz",
        ".tar",
    }
)


def is_pdf_content_type(mime: str) -> bool:
    """True if Content-Type indicates a PDF (allows vendor suffixes like ``application/pdf;charset=…``)."""
    if not mime:
        return False
    base = (mime or "").split(";")[0].strip().lower()
    return base == "application/pdf"


def classify_url(url: str) -> dict[str, Any]:
    """
    Return ``item_type`` in:
    ``page`` | ``pdf`` | ``docx`` | ``doc`` | ``epub`` | ``file``
    plus ``extension`` (lowercase, includes dot, or "").
    """
    raw = (url or "").strip()
    path = (urlparse(raw).path or "").lower()
    base = path.rsplit("/", 1)[-1]
    if "." in base:
        ext = "." + base.rsplit(".", 1)[-1]
    else:
        ext = ""

    if ext in _HTML_LIKE_SUFFIXES:
        return {"item_type": "page", "extension": ext}
    if ext in _KNOWN_DOC_TYPES:
        return {"item_type": _KNOWN_DOC_TYPES[ext], "extension": ext}
    if ext in _OTHER_FILE_SUFFIXES:
        return {"item_type": "file", "extension": ext}
    # No extension or unknown — assume HTML navigation target.
    return {"item_type": "page", "extension": ext}
