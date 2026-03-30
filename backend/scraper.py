import re
from collections import deque
from typing import Any, Optional

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


def scrape_page(url):
    headers = {
        "User-Agent": "Mozilla/5.0"
    }

    response = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")

    title = soup.title.string.strip() if soup.title and soup.title.string else "No Title"

    paragraphs = []
    for p in soup.find_all("p"):
        text = p.get_text(strip=True)
        if text:
            paragraphs.append(text)

    base_domain = urlparse(url).netloc.lower()
    seen_links: set[str] = set()
    links: list[str] = []

    for link in soup.find_all("a", href=True):
        href = (link.get("href") or "").strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        absolute_url = urljoin(url, href)
        parsed = urlparse(absolute_url)
        if parsed.scheme not in ("http", "https"):
            continue
        if parsed.netloc.lower() != base_domain:
            continue
        key = normalize_url(absolute_url)
        if key and key not in seen_links:
            seen_links.add(key)
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

    return {
        "title": title,
        "url": url,
        "paragraph_count": len(paragraphs),
        "paragraphs": paragraphs,
        "preview": paragraphs,
        "links": links,
        "images": images,
        "videos": videos,
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