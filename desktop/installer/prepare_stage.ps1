# Stage files for Inno Setup (desktop\installer\SpiderScraper.iss).
# Run from repository root:
#   powershell -ExecutionPolicy Bypass -File desktop\installer\prepare_stage.ps1
#
# Expects dist\Spider-Scraper.exe from: pyinstaller desktop\spider_scraper.spec
# Optional: repo\ms-playwright (from fetch_browsers_for_installer.ps1) for offline screenshots.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$DistExe = Join-Path $Root "dist\Spider-Scraper.exe"
$Stage = Join-Path $PSScriptRoot "stage"
$StagePlaywright = Join-Path $Stage "ms-playwright"
$RepoPlaywright = Join-Path $Root "ms-playwright"

New-Item -ItemType Directory -Force -Path $Stage | Out-Null

if (-not (Test-Path -LiteralPath $DistExe)) {
    Write-Error "Missing $DistExe — build first: pyinstaller desktop\spider_scraper.spec"
}

Copy-Item -LiteralPath $DistExe -Destination (Join-Path $Stage "Spider-Scraper.exe") -Force
Write-Host "Staged: Spider-Scraper.exe"

if (Test-Path -LiteralPath $RepoPlaywright) {
    if (Test-Path -LiteralPath $StagePlaywright) {
        Remove-Item -LiteralPath $StagePlaywright -Recurse -Force
    }
    Copy-Item -LiteralPath $RepoPlaywright -Destination $StagePlaywright -Recurse -Force
    Write-Host "Staged: ms-playwright (Chromium bundle for installer)"
} else {
    Write-Warning "No repo\ms-playwright — installer will not include Chromium. Run fetch_browsers_for_installer.ps1 first, or users need network for first screenshot setup."
}

Write-Host "Next: compile desktop\installer\SpiderScraper.iss with Inno Setup (ISCC.exe)."
