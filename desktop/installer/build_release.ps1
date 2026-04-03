# Full release pipeline (optional): frontend build, PyInstaller, stage, Inno Setup.
# Run from repository root. Adjust Python/npm paths if needed.
#
#   powershell -ExecutionPolicy Bypass -File desktop\installer\build_release.ps1
#
# Environment:
#   $env:SPIDER_BUNDLE_PLAYWRIGHT = "1"  — embed ms-playwright inside EXE (huge); usually omit
#   $env:SKIP_BROWSER_FETCH = "1"       — skip downloading Chromium into repo\ms-playwright
#   $env:SKIP_INNO = "1"                  — stop after prepare_stage (no ISCC)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

Write-Host "== Frontend build (VITE_DESKTOP_MODE=1) =="
$env:VITE_DESKTOP_MODE = "1"
Push-Location (Join-Path $Root "frontend")
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} finally {
    Pop-Location
}

if (-not $env:SKIP_BROWSER_FETCH) {
    Write-Host "== Fetch Playwright Chromium into ms-playwright =="
    & powershell -ExecutionPolicy Bypass -File (Join-Path $Root "desktop\installer\fetch_browsers_for_installer.ps1")
} else {
    Write-Host "SKIP_BROWSER_FETCH: not downloading Chromium"
}

Write-Host "== PyInstaller =="
pyinstaller desktop\spider_scraper.spec
if ($LASTEXITCODE -ne 0) { throw "pyinstaller failed" }

Write-Host "== Prepare Inno stage =="
& powershell -ExecutionPolicy Bypass -File (Join-Path $Root "desktop\installer\prepare_stage.ps1")

if ($env:SKIP_INNO -eq "1") {
    Write-Host "SKIP_INNO: not running ISCC"
    exit 0
}

$iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $iscc) {
    Write-Warning "Inno Setup 6 not found. Install from https://jrsoftware.org/isinfo.php then run ISCC on desktop\installer\SpiderScraper.iss"
    exit 0
}

Write-Host "== Inno Setup: $iscc =="
& $iscc (Join-Path $Root "desktop\installer\SpiderScraper.iss")
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }

Write-Host "Setup output: desktop\installer\output\SpiderScraperSetup.exe"
