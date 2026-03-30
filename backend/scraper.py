import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse

def scrape_page(url):
    headers = {
        "User-Agent": "Mozilla/5.0"
    }

    response = requests.get(url, headers=headers, timeout=10)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")

    title = soup.title.string.strip() if soup.title and soup.title.string else "No Title"

    paragraphs = []
    for p in soup.find_all("p"):
        text = p.get_text(strip=True)
        if text:
            paragraphs.append(text)

    links = []
    base_domain = urlparse(url).netloc

    for link in soup.find_all("a", href=True):
        href = link["href"]
        absolute_url = urljoin(url, href)
        parsed = urlparse(absolute_url)

        if parsed.netloc == base_domain:
            if absolute_url not in links:
                links.append(absolute_url)

    images = []
    for img in soup.find_all("img", src=True):
        src = img.get("src")
        absolute_img = urljoin(url, src)
        if absolute_img not in images:
            images.append(absolute_img)

    videos = []

    for video in soup.find_all("video"):
        video_src = video.get("src")
        if video_src:
            absolute_video = urljoin(url, video_src)
            if absolute_video not in videos:
                videos.append(absolute_video)

        for source in video.find_all("source", src=True):
            absolute_source = urljoin(url, source["src"])
            if absolute_source not in videos:
                videos.append(absolute_source)

    for iframe in soup.find_all("iframe", src=True):
        src = iframe["src"]
        absolute_iframe = urljoin(url, src)
        if "youtube.com" in absolute_iframe or "youtu.be" in absolute_iframe or "vimeo.com" in absolute_iframe:
            if absolute_iframe not in videos:
                videos.append(absolute_iframe)

    for link in soup.find_all("a", href=True):
        href = link["href"]
        absolute_url = urljoin(url, href)
        lower_url = absolute_url.lower()

        if lower_url.endswith((".mp4", ".webm", ".mov", ".m4v")):
            if absolute_url not in videos:
                videos.append(absolute_url)

    return {
        "title": title,
        "url": url,
        "paragraph_count": len(paragraphs),
        "preview": paragraphs[:5],
        "links": links[:20],
        "images": images[:20],
        "videos": videos[:20]
    }