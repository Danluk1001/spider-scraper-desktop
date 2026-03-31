"""
Fetch metadata and extracted text for discovered document URLs during crawl.

Uses **pypdf** (PDF), **python-docx** (DOCX), **ebooklib** (EPUB). Binaries are downloaded
then read from memory (DOCX) or a **temporary file** (PDF, EPUB), then deleted when done.

HTML pages use :func:`scraper.scrape_page` — this module is for non-HTML items only.
"""

from __future__ import annotations

import os
import re
import tempfile
from io import BytesIO
from typing import Any, Optional

import requests
from urllib.parse import urlparse

from link_classification import is_pdf_content_type

REQUEST_TIMEOUT = 30
MAX_DOCUMENT_BYTES = 15 * 1024 * 1024
PREVIEW_SNIPPET_CHARS = 600


def _classify_http_status(resp: requests.Response) -> tuple[int, str]:
    code = resp.status_code
    if resp.history:
        return (code, "redirect")
    if 200 <= code < 300:
        return (code, "ok")
    if 300 <= code < 400:
        return (code, "redirect")
    if 400 <= code < 600:
        return (code, "broken")
    return (code, "broken")


def _filename_from_content_disposition(header: Optional[str]) -> Optional[str]:
    if not header:
        return None
    m = re.search(r"filename\*?=(?:UTF-8''|\"?)([^\";]+)", header, re.I)
    if m:
        return m.group(1).strip().strip('"')
    return None


def _preview_from_text(text: str, max_chunks: int = 8) -> list[str]:
    if not text or not text.strip():
        return []
    parts = [p.strip() for p in text.split("\n\n") if p.strip()]
    return parts[:max_chunks]


def _make_preview_snippet(extracted: Optional[str]) -> Optional[str]:
    if not extracted or not extracted.strip():
        return None
    snippet = extracted.strip()
    if len(snippet) > PREVIEW_SNIPPET_CHARS:
        return snippet[: PREVIEW_SNIPPET_CHARS - 1] + "…"
    return snippet


def _bytes_look_like_pdf(data: bytes) -> bool:
    return len(data) >= 4 and data[:4] == b"%PDF"


def _extract_pdf_with_pypdf(data: bytes, meta: dict[str, Any]) -> tuple[Optional[str], Optional[str], int, Optional[str]]:
    try:
        from pypdf import PdfReader
    except ImportError:
        meta["extraction_error"] = "pypdf is not installed"
        return None, None, 0, None

    path: Optional[str] = None
    try:
        fd, path = tempfile.mkstemp(suffix=".pdf")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        reader = PdfReader(path)

        page_count = len(reader.pages)
        pdf_title: Optional[str] = None
        md = reader.metadata
        if md is not None:
            raw_title = getattr(md, "title", None)
            if raw_title:
                pdf_title = str(raw_title).strip() or None
            if not pdf_title and isinstance(md, dict):
                raw = md.get("/Title") or md.get("Title")
                if raw:
                    pdf_title = str(raw).strip() or None

        parts: list[str] = []
        for page in reader.pages:
            t = page.extract_text()
            if t:
                parts.append(t)
        extracted_text = "\n".join(parts)[:500_000]
        preview_snippet = _make_preview_snippet(extracted_text)

        return extracted_text, pdf_title, page_count, preview_snippet
    except Exception as ex:
        meta["extraction_error"] = str(ex).strip()[:300] or "pdf read failed"
        return None, None, 0, None
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


def _extract_docx(data: bytes, meta: dict[str, Any]) -> tuple[Optional[str], Optional[str], Optional[str], int]:
    try:
        from docx import Document
    except ImportError:
        meta["extraction_error"] = "python-docx is not installed"
        return None, None, None, 0

    try:
        doc = Document(BytesIO(data))
        parts: list[str] = []
        for p in doc.paragraphs:
            t = (p.text or "").strip()
            if t:
                parts.append(t)
        extracted = "\n\n".join(parts)[:500_000]
        dtitle: Optional[str] = None
        cp = doc.core_properties
        if cp.title:
            dtitle = str(cp.title).strip() or None
        snippet = _make_preview_snippet(extracted)
        return extracted, dtitle, snippet, len(parts)
    except Exception as ex:
        meta["extraction_error"] = str(ex).strip()[:300] or "docx read failed"
        return None, None, None, 0


def _extract_epub(data: bytes, meta: dict[str, Any]) -> tuple[Optional[str], Optional[str], Optional[str], int]:
    try:
        import ebooklib
        from ebooklib import epub
    except ImportError:
        meta["extraction_error"] = "ebooklib is not installed"
        return None, None, None, 0

    from bs4 import BeautifulSoup

    path: Optional[str] = None
    try:
        fd, path = tempfile.mkstemp(suffix=".epub")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        book = epub.read_epub(path)

        etitle: Optional[str] = None
        tmeta = book.get_metadata("DC", "title")
        if tmeta and len(tmeta) > 0 and tmeta[0][0]:
            etitle = str(tmeta[0][0]).strip() or None

        text_parts: list[str] = []
        n_docs = 0
        for item in book.get_items():
            if item.get_type() == ebooklib.ITEM_DOCUMENT:
                n_docs += 1
                try:
                    soup = BeautifulSoup(item.get_content(), "html.parser")
                    t = soup.get_text(separator="\n", strip=True)
                    if t:
                        text_parts.append(t)
                except Exception:
                    pass

        extracted = "\n\n".join(text_parts)[:500_000]
        snippet = _make_preview_snippet(extracted)
        return extracted, etitle, snippet, n_docs
    except Exception as ex:
        meta["extraction_error"] = str(ex).strip()[:300] or "epub read failed"
        return None, None, None, 0
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


def _empty_document_fields() -> dict[str, Any]:
    return {
        "pdf_page_count": None,
        "pdf_title": None,
        "pdf_preview_snippet": None,
        "docx_title": None,
        "docx_preview_snippet": None,
        "docx_paragraph_count": None,
        "epub_title": None,
        "epub_preview_snippet": None,
        "epub_chapter_count": None,
    }


def fetch_discovered_document(url: str, item_type: str, extension: str) -> dict[str, Any]:
    """
    Download the resource; extract PDF / DOCX / EPUB text when applicable.

    PDF detection: extension, ``Content-Type``, or ``%PDF`` magic bytes.
    """
    headers = {"User-Agent": "Mozilla/5.0"}
    path_tail = (urlparse(url).path or "").rsplit("/", 1)[-1]
    title = path_tail or url
    meta: dict[str, Any] = {}

    ext_l = (extension or "").lower()

    fields = _empty_document_fields()
    extracted_text: Optional[str] = None

    try:
        r = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT, stream=True)
        http_status, status_label = _classify_http_status(r)
        mime_type = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        fn = _filename_from_content_disposition(r.headers.get("Content-Disposition"))
        if fn:
            title = fn

        cl = r.headers.get("Content-Length")
        if cl and str(cl).isdigit():
            meta["size_bytes"] = int(cl)

        chunks: list[bytes] = []
        received = 0
        try:
            for chunk in r.iter_content(65536):
                if chunk:
                    received += len(chunk)
                    if received > MAX_DOCUMENT_BYTES:
                        meta["extraction_error"] = "file too large for extraction"
                        break
                    chunks.append(chunk)
        finally:
            r.close()

        data = b"".join(chunks)
        file_size = len(data)

        effective_item = item_type
        if effective_item != "pdf":
            if ext_l == ".pdf" or is_pdf_content_type(mime_type) or _bytes_look_like_pdf(data):
                effective_item = "pdf"

        if "extraction_error" not in meta and data:
            if effective_item == "pdf":
                etext, pt, pc, sn = _extract_pdf_with_pypdf(data, meta)
                extracted_text = etext
                fields["pdf_title"] = pt
                fields["pdf_page_count"] = pc if pc > 0 else None
                fields["pdf_preview_snippet"] = sn
                if pt:
                    title = pt
            elif effective_item == "docx":
                etext, dt, sn, pcount = _extract_docx(data, meta)
                extracted_text = etext
                fields["docx_title"] = dt
                fields["docx_preview_snippet"] = sn
                fields["docx_paragraph_count"] = pcount if pcount > 0 else None
                if dt:
                    title = dt
            elif effective_item == "epub":
                etext, et, sn, nch = _extract_epub(data, meta)
                extracted_text = etext
                fields["epub_title"] = et
                fields["epub_preview_snippet"] = sn
                fields["epub_chapter_count"] = nch if nch > 0 else None
                if et:
                    title = et

        if effective_item == "pdf":
            preview = _preview_from_text(extracted_text) if extracted_text else []
        elif effective_item in ("docx", "epub"):
            preview = _preview_from_text(extracted_text) if extracted_text else []
        else:
            preview = []
        paragraphs = preview

        ext_out = extension if extension else None
        if not ext_out and effective_item == "pdf":
            ext_out = ".pdf"
        elif not ext_out and effective_item == "docx":
            ext_out = ".docx"
        elif not ext_out and effective_item == "epub":
            ext_out = ".epub"

        out = {
            "url": url,
            "title": title,
            "item_type": effective_item,
            "mime_type": mime_type or None,
            "extension": ext_out,
            "extracted_text": extracted_text,
            "file_size": file_size,
            "file_metadata": meta if meta else None,
            "category": effective_item,
            "paragraph_count": len(paragraphs),
            "paragraphs": paragraphs,
            "preview": preview,
            "links": [],
            "external_links": [],
            "images": [],
            "videos": [],
            "http_status": http_status,
            "status_label": status_label,
            "raw_html": None,
            "raw_css": None,
            "raw_js": None,
            "meta_description": None,
            "canonical_url": None,
            "og_title": None,
            "og_description": None,
            "og_image": None,
            "twitter_title": None,
            "twitter_description": None,
            "h1": [],
            "h2": [],
        }
        out.update(fields)
        return out
    except Exception as e:
        return _failed_document_row(url, item_type, extension, title, str(e))


def _failed_document_row(
    url: str,
    item_type: str,
    extension: str,
    title: str,
    err: str,
) -> dict[str, Any]:
    base = {
        "url": url,
        "title": title,
        "item_type": item_type,
        "mime_type": None,
        "extension": extension or None,
        "extracted_text": None,
        "file_size": None,
        "file_metadata": {"fetch_error": err[:500]},
        "category": item_type,
        "paragraph_count": 0,
        "paragraphs": [],
        "preview": [],
        "links": [],
        "external_links": [],
        "images": [],
        "videos": [],
        "http_status": 0,
        "status_label": "broken",
        "raw_html": None,
        "raw_css": None,
        "raw_js": None,
        "meta_description": None,
        "canonical_url": None,
        "og_title": None,
        "og_description": None,
        "og_image": None,
        "twitter_title": None,
        "twitter_description": None,
        "h1": [],
        "h2": [],
    }
    base.update(_empty_document_fields())
    return base
