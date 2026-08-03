param(
    [string]$Thumbprint = "FD10E795F1DC5045FA8448C6C8E99C59B127635F",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " LLM Wiki Deploy & Build Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. Build the Tauri application
if (-not $SkipBuild) {
    Write-Host "`n[1/2] Building Tauri application (npm run tauri build)..." -ForegroundColor Yellow
    npm run tauri build
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
    Write-Host "Build completed successfully!" -ForegroundColor Green
} else {
    Write-Host "`n[1/2] Skipping build step (-SkipBuild requested)..." -ForegroundColor Yellow
}

# 2. Invoke sign.ps1 to copy and sign binaries into /dist
Write-Host "`n[2/2] Signing binaries and packaging into /dist..." -ForegroundColor Yellow
& ".\sign.ps1" -Thumbprint $Thumbprint

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nDeployment completed successfully! Signed artifacts are in /dist" -ForegroundColor Green
} else {
    Write-Error "Deployment failed during signing step."
    exit $LASTEXITCODE
}
