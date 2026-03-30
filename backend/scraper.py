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

    return {
        "title": title,
        "url": url,
        "paragraph_count": len(paragraphs),
        "preview": paragraphs[:5],
        "links": links[:20]
    }