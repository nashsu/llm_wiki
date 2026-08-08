param(
    [string]$Thumbprint = "FD10E795F1DC5045FA8448C6C8E99C59B127635F"
)

# 1. Locate signtool.exe (hardcoded default with automatic SDK fallback)
$signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
if (-Not (Test-Path $signtool)) {
    $found = Get-Command "signtool.exe" -ErrorAction SilentlyContinue
    if ($found) {
        $signtool = $found.Source
    } else {
        $sdkPaths = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue
        if ($sdkPaths) {
            $signtool = $sdkPaths[-1].FullName
        } else {
            Write-Error "signtool.exe not found. Please check your Windows SDK installation."
            exit 1
        }
    }
}

$sourceExe = "src-tauri\target\release\llm-wiki.exe"
$distDir = "dist"
$targetExe = Join-Path $distDir "llm-wiki.exe"

# 2. Verify the binary exists
if (-Not (Test-Path $sourceExe)) {
    Write-Error "Standalone binary not found at $sourceExe. Please run '.\deploy.ps1' or 'npm run tauri build' first."
    exit 1
}

# 3. Create the /dist folder if it doesn't exist
if (-Not (Test-Path $distDir)) {
    Write-Host "Creating directory $distDir..."
    New-Item -ItemType Directory -Path $distDir | Out-Null
}

# 4. Copy standalone binary to /dist
Write-Host "Copying binary to $targetExe..."
Copy-Item -Path $sourceExe -Destination $targetExe -Force

# 5. Copy NSIS installer to /dist if present
$nsisSetup = Get-ChildItem "src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($nsisSetup) {
    $targetSetup = Join-Path $distDir $nsisSetup.Name
    Write-Host "Copying NSIS setup to $targetSetup..."
    Copy-Item -Path $nsisSetup.FullName -Destination $targetSetup -Force
}

# 6. Sign all executables in /dist
$filesToSign = Get-ChildItem -Path $distDir -Filter "*.exe"

foreach ($file in $filesToSign) {
    Write-Host "Signing $($file.Name) using Certum (time.certum.pl) timestamp server..."
    & $signtool sign /sha1 $Thumbprint /tr http://time.certum.pl/ /td sha512 /fd sha512 $file.FullName
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to sign $($file.Name)."
        exit $LASTEXITCODE
    }
}

Write-Host "All binaries signed and packaged into /$distDir successfully!"