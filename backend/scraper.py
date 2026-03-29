import requests
from bs4 import BeautifulSoup

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

    return {
        "title": title,
        "url": url,
        "paragraph_count": len(paragraphs),
        "preview": paragraphs[:5]
    }