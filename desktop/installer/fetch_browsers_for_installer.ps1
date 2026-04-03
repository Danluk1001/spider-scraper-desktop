# Download Playwright Chromium into repo\ms-playwright for packaging into the setup.
# Run from repository root (same Python as your build venv):
#   powershell -ExecutionPolicy Bypass -File desktop\installer\fetch_browsers_for_installer.ps1
#
# Requires: pip install playwright
# Output:   ms-playwright\ at repo root (~300MB+). Add to .gitignore if you don't commit binaries.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$BrowserDir = Join-Path $Root "ms-playwright"

New-Item -ItemType Directory -Force -Path $BrowserDir | Out-Null
$env:PLAYWRIGHT_BROWSERS_PATH = $BrowserDir

Write-Host "PLAYWRIGHT_BROWSERS_PATH=$BrowserDir"
Write-Host "Installing Chromium with: python -m playwright install chromium"

Push-Location $Root
try {
    python -m playwright install chromium
    if ($LASTEXITCODE -ne 0) {
        throw "playwright install failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

Write-Host "Done. Run prepare_stage.ps1 then compile SpiderScraper.iss to include browsers in setup."
