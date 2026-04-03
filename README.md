# Spider Scraper Desktop

Spider Scraper Desktop is a full-stack web crawling and sitemap analysis tool built with a Python backend and a React + TypeScript frontend.

It allows users to crawl websites, inspect internal pages, extract media, detect linked files, capture screenshots, export sitemap data, and visualize page relationships.

## Features

- Crawl websites by depth
- Explore internal linked pages
- Detect and classify pages, PDFs, DOCX, EPUB, and other files
- Scrape images and videos
- HTTP status tracking
- Screenshot capture for selected pages
- Save and load sitemap projects
- Export sitemap data to CSV and JSON
- Activity log and crawl progress
- Responsive desktop-style interface
- Sitemap graph support

## Tech Stack

### Frontend
- React
- TypeScript
- Vite

### Backend
- Python
- Flask
- BeautifulSoup
- Requests
- Playwright

## Screenshots (Playwright)

Server-side screenshots need **the Playwright Python package** and **Chromium** on the same Python that runs the backend.

- **Development:** from repo root, with your venv active:
  - `pip install -r backend/requirements.txt`
  - `python desktop/install_playwright.py`  
  Or manually: `python -m playwright install chromium`
- **Packaged `.exe`:** PyInstaller bundles the Playwright package when you build with `desktop/spider_scraper.spec`. Chromium is **not** included by default (large). Either:
  - Set `SPIDER_BUNDLE_PLAYWRIGHT=1` and place browsers under repo `ms-playwright/` before build (see `desktop/spider_scraper.spec`), or
  - Install Chromium into `%LOCALAPPDATA%\SpiderScraper\ms-playwright` using the **same** Python you used to build/run tests (the launcher sets this path for frozen apps).

If capture fails, the Screenshot tab shows the backend `python_executable` to use for `pip` / `playwright install`.

## Windows installer (Inno Setup)

Build a `SpiderScraperSetup.exe` that installs the PyInstaller app and optionally copies **Playwright Chromium** into `%LOCALAPPDATA%\SpiderScraper\ms-playwright` (same path the desktop launcher uses).

1. Install [Inno Setup 6](https://jrsoftware.org/isinfo.php).
2. From repo root, build the EXE: `pyinstaller desktop/spider_scraper.spec` (after `frontend` build with `VITE_DESKTOP_MODE=1`).
3. **Optional but recommended for offline screenshots:**  
   `powershell -ExecutionPolicy Bypass -File desktop/installer/fetch_browsers_for_installer.ps1`  
   (downloads Chromium into `ms-playwright/` at repo root).
4. Stage files:  
   `powershell -ExecutionPolicy Bypass -File desktop/installer/prepare_stage.ps1`
5. Compile `desktop/installer/SpiderScraper.iss` (open in Inno Setup → Build, or run `ISCC.exe` on that file).

Output: `desktop/installer/output/SpiderScraperSetup.exe`.

Full automated pipeline: `desktop/installer/build_release.ps1` (requires Node, Python, PyInstaller, Inno Setup).

## Project Structure

```text
backend/
frontend/
data/
output/