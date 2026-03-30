import concurrent.futures
import csv
import hashlib
import io
import json
import re
import tempfile
import zipfile
from pathlib import PurePath
from typing import Optional
from urllib.parse import urlparse

import requests

REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
}
# Per-file cap to avoid huge downloads (adjust if needed).
MAX_MEDIA_BYTES = 120 * 1024 * 1024

_CT_EXT = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "application/octet-stream": ".bin",
}


def _ext_from_url(url: str) -> str:
    path = urlparse(url).path.lower()
    for ext in (
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
        ".svg",
        ".bmp",
        ".mp4",
        ".webm",
        ".mov",
        ".m4v",
        ".ogv",
        ".m3u8",
    ):
        if path.endswith(ext):
            return ".jpeg" if ext == ".jpg" else ext
    return ""


def _ext_from_content_type(ct: str) -> str:
    base = (ct or "").split(";")[0].strip().lower()
    return _CT_EXT.get(base, "")


def fetch_url_for_download(
    url: str,
    session: Optional[requests.Session] = None,
) -> tuple[Optional[bytes], str, str]:
    """
    Download remote bytes for a single file attachment.
    Returns (data, filename, error). error is empty on success.
    """
    if not url.startswith(("http://", "https://")):
        return None, "", "invalid_url"

    sess = session or requests.Session()

    try:
        with sess.get(
            url,
            headers=REQUEST_HEADERS,
            timeout=45,
            stream=True,
            allow_redirects=True,
        ) as r:
            ct = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if r.status_code >= 400:
                return None, "", f"HTTP {r.status_code}"

            if "text/html" in ct:
                return None, "", "not_direct_media"

            ext = _ext_from_url(url) or _ext_from_content_type(ct) or ".bin"

            path = urlparse(url).path
            seg = path.rstrip("/").split("/")[-1] if path else ""
            seg = seg.split("?")[0] if seg else ""
            if seg and "." in seg and len(seg) <= 200:
                raw_name = seg
            else:
                raw_name = "download" + ext
            safe = re.sub(r"[^a-zA-Z0-9._\-]", "_", raw_name).strip("._") or "download"
            if len(safe) > 180:
                safe = safe[:180]
            if not PurePath(safe).suffix and ext:
                safe = safe + ext

            size = 0
            buf = io.BytesIO()
            for chunk in r.iter_content(chunk_size=65536):
                if chunk:
                    size += len(chunk)
                    if size > MAX_MEDIA_BYTES:
                        return None, "", "file_too_large"
                    buf.write(chunk)

            data = buf.getvalue()
            if len(data) == 0:
                return None, "", "empty_response"

            return data, safe, ""
    except requests.RequestException as e:
        return None, "", f"request_failed:{e}"
    except Exception as e:
        return None, "", str(e)


def _write_fetched_bytes_to_zip(
    zf: zipfile.ZipFile,
    url: str,
    file_idx: int,
    data: bytes,
    fname: str,
) -> tuple[str, str]:
    """Write already-downloaded bytes into the archive. Returns (archive_path, status)."""
    safe_base = f"media/{file_idx:04d}_{hashlib.md5(url.encode('utf-8')).hexdigest()[:10]}"
    ext = PurePath(fname).suffix.lower() or _ext_from_url(url) or ".bin"
    arc = f"{safe_base}{ext}"
    compress = (
        zipfile.ZIP_STORED
        if ext in (".mp4", ".webm", ".mov", ".m4v", ".m3u8")
        else zipfile.ZIP_DEFLATED
    )
    zi = zipfile.ZipInfo(arc)
    zi.compress_type = compress
    zf.writestr(zi, data)
    return arc, "downloaded"


def _prefetch_urls_parallel(urls: list[str], max_workers: int = 4) -> dict[str, tuple[Optional[bytes], str, str]]:
    """Download many URLs concurrently (each uses its own requests session)."""
    out: dict[str, tuple[Optional[bytes], str, str]] = {}
    if not urls:
        return out
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_to_url = {
            pool.submit(fetch_url_for_download, u, None): u for u in urls
        }
        for fut in concurrent.futures.as_completed(future_to_url):
            u = future_to_url[fut]
            try:
                out[u] = fut.result()
            except Exception as e:
                out[u] = (None, "", str(e))
    return out


def create_media_zip(entries: list[dict], mode: str) -> str:
    """
    Build a temp zip with downloaded files plus manifest.csv and sources.json.
    entries: [{"mediaUrl": str, "sourcePageUrl": str}, ...]
    Returns filesystem path to the zip (caller should delete after send).
    """
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    tmp.close()
    zip_path = tmp.name

    unique_urls: list[str] = []
    seen_u: set[str] = set()
    for entry in entries:
        mu = (entry.get("mediaUrl") or "").strip()
        if mu and mu not in seen_u:
            seen_u.add(mu)
            unique_urls.append(mu)

    prefetch = _prefetch_urls_parallel(unique_urls, max_workers=4)

    url_result: dict[str, tuple[str, str]] = {}
    file_idx = 0

    manifest_rows: list[dict] = []

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for media_url in unique_urls:
            data, fname, err = prefetch.get(
                media_url, (None, "", "missing_prefetch")
            )
            if err or not data:
                url_result[media_url] = ("", err or "failed")
                continue
            arc, _st = _write_fetched_bytes_to_zip(zf, media_url, file_idx, data, fname)
            url_result[media_url] = (arc, "downloaded")
            file_idx += 1

        for entry in entries:
            media_url = (entry.get("mediaUrl") or "").strip()
            source_url = (entry.get("sourcePageUrl") or "").strip()

            if not media_url:
                manifest_rows.append(
                    {
                        "source_page_url": source_url,
                        "media_url": media_url,
                        "file_in_archive": "",
                        "status": "missing_media_url",
                    }
                )
                continue

            arc, status = url_result.get(media_url, ("", "missing"))
            manifest_rows.append(
                {
                    "source_page_url": source_url,
                    "media_url": media_url,
                    "file_in_archive": arc,
                    "status": "downloaded" if arc else status,
                }
            )

        buf_csv = io.StringIO()
        w = csv.writer(buf_csv)
        w.writerow(["source_page_url", "media_url", "file_in_archive", "status"])
        for row in manifest_rows:
            w.writerow(
                [
                    row["source_page_url"],
                    row["media_url"],
                    row["file_in_archive"],
                    row["status"],
                ]
            )
        zf.writestr(
            "manifest.csv",
            buf_csv.getvalue().encode("utf-8-sig"),
        )

        zf.writestr(
            "sources.json",
            json.dumps(manifest_rows, indent=2).encode("utf-8"),
        )

        readme = (
            "Spider Scraper export\n"
            f"Mode: {mode}\n"
            "- manifest.csv: each row is one media URL as found on a source page.\n"
            "- sources.json: same data as JSON.\n"
            "- media/: downloaded files when status is 'downloaded'.\n"
            "Embed-only URLs (YouTube, Vimeo, etc.) are listed but not downloaded.\n"
        )
        zf.writestr("README.txt", readme.encode("utf-8"))

    return zip_path
