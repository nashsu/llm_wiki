# Sync this fork with nashsu/llm_wiki: fast-forward main, merge into web-mode.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
git fetch upstream --tags
$current = (git rev-parse --abbrev-ref HEAD).Trim()
git checkout -q main
git merge --ff-only upstream/main
git checkout -q web-mode
git merge --no-edit main
if ($LASTEXITCODE -ne 0) {
  Write-Host "Merge conflicts - resolve them, then: git add -A; git commit"
  exit 1
}
Write-Host "web-mode is up to date with upstream/main ($(git rev-parse --short main))."
Write-Host "Next: npm run build; npm run web:check"
if ($current -ne "web-mode") { git checkout -q $current }
