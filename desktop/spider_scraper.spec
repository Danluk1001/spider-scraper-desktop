# PyInstaller spec for Spider Scraper (Windows).
#
# Prerequisites (from repo root):
#   cd frontend && set VITE_DESKTOP_MODE=1 && npm run build
#   pip install -r backend/requirements.txt pyinstaller
#
# Build:
#   pyinstaller desktop/spider_scraper.spec
#
# Output: dist/SpiderScraper.exe (one-file). Bundled data lands under sys._MEIPASS
# at runtime; desktop/launcher.py and backend/data_paths.py already resolve
# frontend/dist from there when frozen.

import os
from pathlib import Path

block_cipher = None

_repo_root = Path(__file__).resolve().parent.parent
_launcher = _repo_root / "desktop" / "launcher.py"
_dist = _repo_root / "frontend" / "dist"
_resources = _repo_root / "desktop" / "resources"
_icon = _resources / "icon.ico"
_playwright = _repo_root / "ms-playwright"
_bundle_playwright = os.environ.get("SPIDER_BUNDLE_PLAYWRIGHT", "0").lower() in ("1", "true", "yes")

_datas = []
if _dist.is_dir() and (_dist / "index.html").is_file():
    _datas.append((str(_dist), "frontend/dist"))
if _resources.is_dir():
    _datas.append((str(_resources), "desktop/resources"))
if _bundle_playwright and _playwright.is_dir():
    _datas.append((str(_playwright), "ms-playwright"))

a = Analysis(
    [str(_launcher)],
    pathex=[str(_repo_root / "backend"), str(_repo_root)],
    binaries=[],
    datas=_datas,
    hiddenimports=[
        "app",
        "app_config",
        "data_paths",
        "page_screenshot",
        "media_zip",
        "scraper",
        "flask",
        "flask_cors",
        "webview",
        "clr_loader",
        "pythonnet",
        "waitress",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

_exe_kw = dict(
    name="Spider-Scraper",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

if _icon.is_file():
    _exe_kw["icon"] = str(_icon)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    **_exe_kw,
)
