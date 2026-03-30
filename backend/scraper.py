import re
import uuid
from collections import deque
from typing import Any, Callable, Optional

import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse, parse_qs, urlunparse

# HTTP timeout per page (seconds). Large pages / slow hosts may need more.
REQUEST_TIMEOUT = 30

# Attributes that often hold the real media URL (lazy embeds, CDNs).
_SRC_LIKE_ATTRS = (
    "src",
    "data-src",
    "data-lazy-src",
    "data-original",
    "data-url",
    "data-src-url",
    "data-video-url",
    "data-embed-url",
    "data-youtube",
    "data-vimeo",
)

# Substrings in absolute URLs that usually indicate video (embed or stream).
_VIDEO_URL_MARKERS = (
    "youtube.com",
    "youtube-nocookie.com",
    "youtu.be",
    "vimeo.com",
    "dailymotion.com",
    "dai.ly",
    "loom.com",
    "wistia.com",
    "wistia.net",
    "streamable.com",
    "tiktok.com",
    "facebook.com/plugins/video",
    "player.twitch.tv",
    "kick.com",
    "brightcove.com",
    "jwplayer.com",
    "vidyard.com",
    "microsoftstream.com",
    "office.com/embed",
    "sharepoint.com",
    "platform.twitter.com",
    "twitter.com/embed",
    "x.com/embed",
    "instagram.com/embed",
)

_VIDEO_FILE_SUFFIXES = (".mp4", ".webm", ".mov", ".m4v", ".ogg", ".ogv", ".m3u8")

# Catch embed/watch links that appear only inside scripts or JSON in HTML.
_HTML_VIDEO_URL_RES = (
    re.compile(
        r'https?://(?:www\.)?youtube(?:-nocookie)?\.com/embed/[a-zA-Z0-9_-]{11}[^"\'\s<>]*',
        re.I,
    ),
    re.compile(
        r'https?://(?:www\.)?youtube\.com/watch\?[^"\'\s<>]*v=[a-zA-Z0-9_-]{11}[^"\'\s<>]*',
        re.I,
    ),
    re.compile(r'https?://youtu\.be/[a-zA-Z0-9_-]{11}[^"\'\s<>]*', re.I),
    re.compile(
        r'https?://(?:www\.|player\.)?vimeo\.com/(?:video/)?\d+[^"\'\s<>]*',
        re.I,
    ),
)


def _urls_from_tag(tag):
    """Collect candidate URLs from common src / lazy-load attributes."""
    found = []
    for attr in _SRC_LIKE_ATTRS:
        val = tag.get(attr)
        if val and isinstance(val, str) and val.strip():
            found.append(val.strip())
    return found


def _path_suggests_video_embed(path_lower: str) -> bool:
    if not path_lower:
        return False
    return (
        "/embed/" in path_lower
        or "/video/" in path_lower
        or "/player/" in path_lower
        or path_lower.rstrip("/").endswith("/video")
    )


def _is_probably_video_url(absolute_url: str) -> bool:
    if not absolute_url or not absolute_url.startswith(("http://", "https://")):
        return False
    lower = absolute_url.lower()
    if any(m in lower for m in _VIDEO_URL_MARKERS):
        return True
    base = lower.split("?", 1)[0].split("#", 1)[0]
    if base.endswith(_VIDEO_FILE_SUFFIXES):
        return True
    parsed = urlparse(absolute_url)
    netloc = (parsed.netloc or "").lower()
    if "youtube" in netloc or "youtu.be" in netloc:
        return True
    if "vimeo" in netloc or "dailymotion" in netloc or "loom" in netloc:
        return True
    path = (parsed.path or "").lower()
    if _path_suggests_video_embed(path):
        return True
    # YouTube /watch?v= on any host we accept (usually youtube.com).
    if "youtube.com" in netloc and "/watch" in path:
        qs = parse_qs(parsed.query)
        if qs.get("v") and re.match(r"^[a-zA-Z0-9_-]{11}$", qs["v"][0] or ""):
            return True
    return False


def _add_video(videos: list, seen: set, absolute_url: str) -> None:
    if not absolute_url:
        return
    normalized = absolute_url.split("#", 1)[0]
    if normalized not in seen:
        seen.add(normalized)
        videos.append(normalized)


def _classify_http_status(resp: requests.Response) -> tuple[int, str]:
    """
    Map HTTP response to a stable label for site audit UI.
    Labels: ok | redirect | broken | timeout_error (timeout_error only from probe/timeouts).
    """
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


def probe_url_status(url: str) -> tuple[int, str]:
    """
    Lightweight GET (read first chunk) to classify a URL without full scrape.
    Used when scrape_page fails or for consistency checks.
    """
    headers = {"User-Agent": "Mozilla/5.0"}
    try:
        r = requests.get(url, headers=headers, timeout=12, stream=True)
        try:
            for chunk in r.iter_content(8192):
                if chunk:
                    break
        finally:
            r.close()
        return _classify_http_status(r)
    except requests.Timeout:
        return (0, "timeout_error")
    except requests.RequestException:
        return (0, "broken")


def _status_from_fetch_exception(url: str, exc: BaseException) -> tuple[int, str]:
    """Derive status code + label when scrape_page raised."""
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        return _classify_http_status(exc.response)
    if isinstance(exc, requests.Timeout):
        return (0, "timeout_error")
    return probe_url_status(url)


def _empty_metadata() -> dict[str, Any]:
    """Default metadata when HTML was not parsed."""
    return {
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


def extract_metadata(soup: BeautifulSoup, base_url: str) -> dict[str, Any]:
    """
    Extract common SEO / social metadata and heading structure.
    Missing values are None or empty lists.
    """
    meta_description: Optional[str] = None
    canonical_url: Optional[str] = None
    og_title: Optional[str] = None
    og_description: Optional[str] = None
    og_image: Optional[str] = None
    twitter_title: Optional[str] = None
    twitter_description: Optional[str] = None

    for tag in soup.find_all("meta"):
        if tag.name != "meta":
            continue
        prop = (tag.get("property") or "").strip().lower()
        nom = (tag.get("name") or "").strip().lower()
        content = tag.get("content")
        if not content or not isinstance(content, str):
            continue
        c = content.strip()
        if not c:
            continue
        if nom == "description" and meta_description is None:
            meta_description = c
        elif prop == "og:title":
            og_title = c
        elif prop == "og:description":
            og_description = c
        elif prop == "og:image":
            og_image = urljoin(base_url, c)
        elif nom == "twitter:title":
            twitter_title = c
        elif nom == "twitter:description":
            twitter_description = c

    for tag in soup.find_all("link", href=True):
        rel = tag.get("rel")
        if isinstance(rel, list):
            rel_s = " ".join(rel).lower()
        else:
            rel_s = str(rel or "").lower()
        if "canonical" in rel_s:
            href = tag.get("href")
            if href and isinstance(href, str) and href.strip():
                canonical_url = urljoin(base_url, href.strip())
            break

    h1: list[str] = []
    for tag in soup.find_all("h1"):
        t = tag.get_text(strip=True)
        if t:
            h1.append(t)

    h2: list[str] = []
    for tag in soup.find_all("h2"):
        t = tag.get_text(strip=True)
        if t:
            h2.append(t)

    return {
        "meta_description": meta_description,
        "canonical_url": canonical_url,
        "og_title": og_title,
        "og_description": og_description,
        "og_image": og_image,
        "twitter_title": twitter_title,
        "twitter_description": twitter_description,
        "h1": h1,
        "h2": h2,
    }


def normalize_url(url: str) -> Optional[str]:
    """
    Canonical form for deduplicating crawl queue (fragment stripped, host lowercased,
    trailing slash on non-root paths removed).
    """
    try:
        raw = (url or "").strip()
        p = urlparse(raw)
        if p.scheme not in ("http", "https"):
            return None
        netloc = p.netloc.lower()
        path = p.path or "/"
        if path != "/" and path.endswith("/"):
            path = path.rstrip("/") or "/"
        return urlunparse((p.scheme.lower(), netloc, path, "", p.query, ""))
    except Exception:
        return None


def _extract_document_css(soup: BeautifulSoup, base_url: str) -> str:
    """Inline `<style>` text plus `/* linked stylesheet: … */` markers for `<link rel=stylesheet>`."""
    parts: list[str] = []
    for style in soup.find_all("style"):
        text = (style.string or style.get_text() or "").strip()
        if text:
            parts.append(text)
    for link in soup.find_all("link", href=True):
        rel = link.get("rel")
        if isinstance(rel, list):
            rel_s = " ".join(rel).lower()
        else:
            rel_s = str(rel or "").lower()
        if "stylesheet" not in rel_s:
            continue
        href = (link.get("href") or "").strip()
        if not href:
            continue
        abs_url = urljoin(base_url, href)
        parts.append(f"/* linked stylesheet: {abs_url} */\n")
    return "\n\n/* --- */\n\n".join(parts) if parts else ""


_JS_SKIP_TYPES = frozenset(
    {
        "application/json",
        "application/ld+json",
        "text/template",
        "importmap",
        "text/html",
        "text/css",
    }
)


def _extract_document_js(soup: BeautifulSoup, base_url: str) -> str:
    """Inline script bodies; `// external script: …` for `<script src>`. Skips JSON-LD / templates."""
    parts: list[str] = []
    for script in soup.find_all("script"):
        stype = (script.get("type") or "").strip().lower()
        if stype in _JS_SKIP_TYPES:
            continue
        src = script.get("src")
        if src and isinstance(src, str) and src.strip():
            abs_url = urljoin(base_url, src.strip())
            parts.append(f"// external script: {abs_url}\n")
            continue
        text = (script.string or script.get_text() or "").strip()
        if text:
            parts.append(text)
    return "\n\n// ---\n\n".join(parts) if parts else ""


def scrape_page(url):
    headers = {
        "User-Agent": "Mozilla/5.0"
    }

    response = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    http_status, status_label = _classify_http_status(response)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")

    title = soup.title.string.strip() if soup.title and soup.title.string else "No Title"

    paragraphs = []
    for p in soup.find_all("p"):
        text = p.get_text(strip=True)
        if text:
            paragraphs.append(text)

    base_domain = urlparse(url).netloc.lower()
    seen_internal_norm: set[str] = set()
    seen_external_norm: set[str] = set()
    links: list[str] = []
    external_links: list[str] = []

    for link in soup.find_all("a", href=True):
        href = (link.get("href") or "").strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        absolute_url = urljoin(url, href)
        parsed = urlparse(absolute_url)
        if parsed.scheme not in ("http", "https"):
            continue
        if parsed.netloc.lower() != base_domain:
            key = normalize_url(absolute_url)
            if key and key not in seen_external_norm:
                seen_external_norm.add(key)
                external_links.append(absolute_url)
            continue
        key = normalize_url(absolute_url)
        if key and key not in seen_internal_norm:
            seen_internal_norm.add(key)
            links.append(absolute_url)

    seen_images: set[str] = set()
    images: list[str] = []
    for img in soup.find_all("img"):
        for raw in _urls_from_tag(img):
            if not raw:
                continue
            absolute_img = urljoin(url, raw.strip())
            if absolute_img.startswith(("http://", "https://")) and absolute_img not in seen_images:
                seen_images.add(absolute_img)
                images.append(absolute_img)
        src = img.get("src")
        if src and isinstance(src, str) and src.strip():
            absolute_img = urljoin(url, src.strip())
            if absolute_img.startswith(("http://", "https://")) and absolute_img not in seen_images:
                seen_images.add(absolute_img)
                images.append(absolute_img)

    videos = []
    video_seen = set()

    for video in soup.find_all("video"):
        for raw in _urls_from_tag(video):
            absolute_video = urljoin(url, raw)
            if _is_probably_video_url(absolute_video):
                _add_video(videos, video_seen, absolute_video)

        for source in video.find_all("source"):
            for raw in _urls_from_tag(source):
                if not raw:
                    continue
                absolute_source = urljoin(url, raw)
                if _is_probably_video_url(absolute_source):
                    _add_video(videos, video_seen, absolute_source)

    for iframe in soup.find_all("iframe"):
        for raw in _urls_from_tag(iframe):
            absolute_iframe = urljoin(url, raw)
            if _is_probably_video_url(absolute_iframe):
                _add_video(videos, video_seen, absolute_iframe)

    for embed in soup.find_all("embed"):
        for raw in _urls_from_tag(embed):
            absolute_embed = urljoin(url, raw)
            if _is_probably_video_url(absolute_embed):
                _add_video(videos, video_seen, absolute_embed)

    for obj in soup.find_all("object"):
        for raw in _urls_from_tag(obj):
            absolute_obj = urljoin(url, raw)
            if _is_probably_video_url(absolute_obj):
                _add_video(videos, video_seen, absolute_obj)
        data = obj.get("data")
        if data and isinstance(data, str) and data.strip():
            absolute_data = urljoin(url, data.strip())
            if _is_probably_video_url(absolute_data):
                _add_video(videos, video_seen, absolute_data)

    for link in soup.find_all("a", href=True):
        href = link["href"]
        absolute_url = urljoin(url, href)
        if _is_probably_video_url(absolute_url):
            _add_video(videos, video_seen, absolute_url)

    for meta in soup.find_all("meta"):
        prop = (meta.get("property") or meta.get("name") or "").lower()
        if prop in (
            "og:video",
            "og:video:url",
            "og:video:secure_url",
            "twitter:player:stream",
            "twitter:player",
        ):
            content = meta.get("content")
            if content and isinstance(content, str) and content.strip():
                absolute_meta = urljoin(url, content.strip())
                if _is_probably_video_url(absolute_meta):
                    _add_video(videos, video_seen, absolute_meta)

    # URLs that only appear in inline scripts / JSON-LD (no iframe in static HTML).
    for pattern in _HTML_VIDEO_URL_RES:
        for match in pattern.findall(response.text):
            absolute_m = urljoin(url, match)
            if _is_probably_video_url(absolute_m):
                _add_video(videos, video_seen, absolute_m)

    meta = extract_metadata(soup, url)
    css_text = _extract_document_css(soup, url)
    js_text = _extract_document_js(soup, url)

    return {
        "title": title,
        "url": url,
        "paragraph_count": len(paragraphs),
        "paragraphs": paragraphs,
        "preview": paragraphs,
        "links": links,
        "external_links": external_links,
        "images": images,
        "videos": videos,
        "http_status": http_status,
        "status_label": status_label,
        "raw_html": response.text,
        "raw_css": css_text if css_text else None,
        "raw_js": js_text if js_text else None,
        **meta,
    }


def crawl_site(start_url: str, max_pages: Optional[int] = None) -> dict[str, Any]:
    """
    Breadth-first crawl of all pages reachable via same-site <a href> links.
    max_pages: stop after this many successfully fetched pages (None = no limit).
    """
    start_url = (start_url or "").strip()
    if not start_url.startswith(("http://", "https://")):
        raise ValueError("start URL must be http(s)")

    base_netloc = urlparse(start_url).netloc.lower()
    start_norm = normalize_url(start_url)
    if not start_norm:
        raise ValueError("invalid start URL")

    queue: deque[str] = deque([start_url])
    visited_norm: set[str] = set()
    queued_norm: set[str] = {start_norm}
    pages: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    fetched = 0

    while queue:
        if max_pages is not None and fetched >= max_pages:
            break

        current = queue.popleft()
        norm = normalize_url(current)
        if not norm or norm in visited_norm:
            continue

        visited_norm.add(norm)

        try:
            data = scrape_page(current)
        except Exception as e:
            errors.append({"url": current, "error": str(e)})
            continue

        fetched += 1
        pages.append(data)

        for link in data.get("links") or []:
            ln = normalize_url(link)
            if not ln:
                continue
            if urlparse(link).netloc.lower() != base_netloc:
                continue
            if ln in visited_norm or ln in queued_norm:
                continue
            queued_norm.add(ln)
            queue.append(link)

    return {
        "start_url": start_url,
        "total_pages": len(pages),
        "pages": pages,
        "errors": errors,
        "discovered_in_queue": len(queued_norm),
        "visited": len(visited_norm),
    }


def _new_node_id() -> str:
    return str(uuid.uuid4())


# Cap list sizes in crawl_stats (samples for UI / debugging).
_MAX_CRAWL_STATS_SAMPLES = 500


def _crawl_append_skipped_sample(
    bucket: list[dict[str, str]],
    normalized: str,
    reason: str,
    from_url: str,
) -> None:
    if len(bucket) >= _MAX_CRAWL_STATS_SAMPLES:
        return
    bucket.append(
        {
            "normalized": normalized,
            "reason": reason,
            "from_page": from_url,
        }
    )


def crawl_site_depth(
    start_url: str,
    crawl_depth: int = 2,
    max_pages: Optional[int] = None,
    on_progress: Optional[Callable[[dict[str, Any]], None]] = None,
) -> dict[str, Any]:
    """
    Breadth-first crawl on the same host only, limited by depth.

    max_pages: if set, stop after this many fetched pages; None = no cap (within crawl_depth).

    Frontier (BFS) data structures:
      - queue: deque of (absolute_url, depth) — pending fetches (FIFO).
      - queued_norm: normalized URLs ever enqueued (dedupe key for “in queue or done”).
      - visited_norm: normalized URLs we have started processing (popped + accepted).

    crawl_depth (1–3):
      1 = root URL only
      2 = root + pages linked directly from the root
      3 = root + two hops of internal links

    Internal same-domain links come from scrape_page["links"]. Off-site hrefs are listed in
    scrape_page["external_links"] and aggregated into crawl_stats (not crawled).

    Edges record parent→child when a child URL is first discovered (tree edges for flowcharts).

    on_progress: optional callback invoked before each page fetch with a dict:
      type "progress", phase "page_start", current (1-based), total (estimated),
      url (string). Safe to use for streaming / UI progress bars.

    crawl_stats documents queue/visit/duplicate/external decisions for sitemap tooling.
    broken_links is reserved for future same-domain link health checks.
    """
    start_url = (start_url or "").strip()
    if not start_url.startswith(("http://", "https://")):
        raise ValueError("start URL must be http(s)")

    try:
        crawl_depth = int(crawl_depth)
    except (TypeError, ValueError):
        crawl_depth = 2
    crawl_depth = max(1, min(3, crawl_depth))

    base_netloc = urlparse(start_url).netloc.lower()
    start_norm = normalize_url(start_url)
    if not start_norm:
        raise ValueError("invalid start URL")

    # --- Frontier ---
    queue: deque[tuple[str, int]] = deque([(start_url, 0)])
    queued_norm: set[str] = {start_norm}
    visited_norm: set[str] = set()
    url_to_node_id: dict[str, str] = {start_norm: _new_node_id()}

    # --- Page results (unchanged API for frontend) ---
    pages: list[dict[str, Any]] = []
    edges: list[dict[str, str]] = []
    edge_seen: set[str] = set()
    errors: list[dict[str, str]] = []

    # --- Crawl statistics (structured, extensible) ---
    skipped_duplicates: list[dict[str, str]] = []
    skipped_duplicate_count = 0
    depth_skipped_link_count = 0
    external_norm_seen: set[str] = set()
    external_urls_unique: list[str] = []

    def push_edge(source: str, target: str) -> None:
        k = f"{source}\t{target}"
        if k in edge_seen:
            return
        edge_seen.add(k)
        edges.append({"source": source, "target": target})

    def merge_external_from_page(row: dict[str, Any]) -> None:
        for ext in row.get("external_links") or []:
            en = normalize_url(ext)
            if en and en not in external_norm_seen:
                external_norm_seen.add(en)
                external_urls_unique.append(ext)

    while queue:
        if max_pages is not None and len(pages) >= max_pages:
            break

        current, depth = queue.popleft()
        norm = normalize_url(current)
        if not norm:
            continue

        if norm in visited_norm:
            skipped_duplicate_count += 1
            _crawl_append_skipped_sample(
                skipped_duplicates, norm, "already_visited", current
            )
            continue

        if depth >= crawl_depth:
            continue

        visited_norm.add(norm)
        parent_id = url_to_node_id.get(norm)
        if not parent_id:
            continue

        cap = max_pages if max_pages is not None else len(pages) + len(queue) + 10_000
        total_est = min(cap, len(pages) + 1 + len(queue))
        if on_progress:
            on_progress(
                {
                    "type": "progress",
                    "phase": "page_start",
                    "current": len(pages) + 1,
                    "total": max(total_est, len(pages) + 1),
                    "url": current,
                }
            )

        try:
            data = scrape_page(current)
        except Exception as e:
            errors.append({"url": current, "error": str(e)})
            st_code, st_label = _status_from_fetch_exception(current, e)
            failed_row: dict[str, Any] = {
                "nodeId": parent_id,
                "url": current,
                "title": "(fetch failed)",
                "category": "home" if norm == start_norm else "crawled-page",
                "paragraph_count": 0,
                "paragraphs": [],
                "preview": [],
                "links": [],
                "external_links": [],
                "images": [],
                "videos": [],
                "http_status": st_code,
                "status_label": st_label,
                "raw_html": None,
                "raw_css": None,
                "raw_js": None,
            }
            failed_row.update(_empty_metadata())
            pages.append(failed_row)
            continue

        page_url = data.get("url") or current
        row = {
            **data,
            "url": page_url,
            "nodeId": parent_id,
            "category": "home" if norm == start_norm else "crawled-page",
        }
        pages.append(row)
        merge_external_from_page(row)

        if depth + 1 >= crawl_depth:
            depth_skipped_link_count += len(data.get("links") or [])
            continue

        for link in data.get("links") or []:
            ln = normalize_url(link)
            if not ln:
                continue
            if urlparse(link).netloc.lower() != base_netloc:
                continue
            if ln in visited_norm:
                skipped_duplicate_count += 1
                _crawl_append_skipped_sample(
                    skipped_duplicates, ln, "already_visited", page_url
                )
                continue
            if ln in queued_norm:
                skipped_duplicate_count += 1
                _crawl_append_skipped_sample(
                    skipped_duplicates, ln, "already_queued", page_url
                )
                continue
            if ln not in url_to_node_id:
                url_to_node_id[ln] = _new_node_id()
            child_id = url_to_node_id[ln]
            queued_norm.add(ln)
            queue.append((link, depth + 1))
            push_edge(parent_id, child_id)

    pending_queue: list[dict[str, Any]] = []
    for u, d in queue:
        nu = normalize_url(u)
        if nu:
            pending_queue.append({"url": u, "normalized": nu, "depth": d})

    crawl_stats: dict[str, Any] = {
        "counts": {
            "pages_recorded": len(pages),
            "visited_unique": len(visited_norm),
            "enqueued_unique": len(queued_norm),
            "pending_in_queue": len(queue),
            "skipped_duplicate": skipped_duplicate_count,
            "depth_skipped_links": depth_skipped_link_count,
            "external_urls_unique": len(external_urls_unique),
        },
        "visited_urls": sorted(visited_norm),
        "queued_urls": sorted(queued_norm),
        "pending": pending_queue,
        "skipped_duplicates_sample": skipped_duplicates,
        "external_urls": external_urls_unique[:_MAX_CRAWL_STATS_SAMPLES],
        "external_urls_truncated": len(external_urls_unique) > _MAX_CRAWL_STATS_SAMPLES,
        "broken_links": [],
    }

    return {
        "start_url": start_url,
        "crawl_depth": crawl_depth,
        "total_pages": len(pages),
        "pages": pages,
        "edges": edges,
        "errors": errors,
        "crawl_stats": crawl_stats,
        "visited": len(visited_norm),
        "queued": len(queued_norm),
    }