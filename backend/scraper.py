import requests
from bs4 import BeautifulSoup

def scrape_page(url):
    response = requests.get(url)
    soup = BeautifulSoup(response.text, "html.parser")

    title = soup.title.string if soup.title else "No Title"

    return {
        "title": title,
        "url": url
    }