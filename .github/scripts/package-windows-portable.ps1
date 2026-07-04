param(
  [Parameter(Mandatory = $true)]
  [string]$Version
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$ExePath = Join-Path $RepoRoot "src-tauri/target/release/llm-wiki.exe"
$PdfiumPath = Join-Path $RepoRoot "src-tauri/pdfium/pdfium.dll"
$McpRoot = Join-Path $RepoRoot "mcp-server"
$DistRoot = Join-Path $RepoRoot "dist-portable"
$PortableRoot = Join-Path $DistRoot "LLM-Wiki-$Version-windows-x64-portable"
$ZipPath = Join-Path $DistRoot "LLM-Wiki-$Version-windows-x64-portable.zip"

if (!(Test-Path $ExePath)) {
  throw "Tauri executable was not found at $ExePath"
}
if (!(Test-Path $PdfiumPath)) {
  throw "PDFium DLL was not found at $PdfiumPath"
}
foreach ($Path in @(
  (Join-Path $McpRoot "package.json"),
  (Join-Path $McpRoot "dist"),
  (Join-Path $McpRoot "node_modules")
)) {
  if (!(Test-Path $Path)) {
    throw "Required MCP resource was not found at $Path. Run npm --prefix mcp-server ci and npm run mcp:build first."
  }
}

if (Test-Path $PortableRoot) {
  Remove-Item -Recurse -Force $PortableRoot
}
if (Test-Path $ZipPath) {
  Remove-Item -Force $ZipPath
}
New-Item -ItemType Directory -Force $PortableRoot | Out-Null

Copy-Item $ExePath (Join-Path $PortableRoot "LLM Wiki.exe")

New-Item -ItemType Directory -Force (Join-Path $PortableRoot "pdfium") | Out-Null
Copy-Item $PdfiumPath (Join-Path $PortableRoot "pdfium/pdfium.dll")

$PortableMcpRoot = Join-Path $PortableRoot "mcp-server"
New-Item -ItemType Directory -Force $PortableMcpRoot | Out-Null
Copy-Item (Join-Path $McpRoot "package.json") (Join-Path $PortableMcpRoot "package.json")
Copy-Item -Recurse (Join-Path $McpRoot "dist") (Join-Path $PortableMcpRoot "dist")
Copy-Item -Recurse (Join-Path $McpRoot "node_modules") (Join-Path $PortableMcpRoot "node_modules")

@"
LLM Wiki Windows Portable

Run "LLM Wiki.exe" from this folder. Keep the pdfium/ and mcp-server/ folders next to the executable.

This portable package does not install start-menu shortcuts or auto-update hooks. It still stores app data in the normal LLM Wiki application data directory.
"@ | Set-Content -Encoding UTF8 (Join-Path $PortableRoot "README-portable.txt")

Compress-Archive -Path (Join-Path $PortableRoot "*") -DestinationPath $ZipPath -CompressionLevel Optimal
Write-Host "Created $ZipPath"
