param(
  [Parameter(Mandatory = $true)]
  [string] $RepoRoot
)

$ErrorActionPreference = 'Stop'
Set-Location $RepoRoot

$outDir = Join-Path $RepoRoot 'output'
if (-not (Test-Path $outDir)) {
  throw "No output/ folder. Run npm run package first."
}

$zip = Get-ChildItem -Path $outDir -Filter '*-chrome.zip' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($null -eq $zip) {
  throw "No bundle-split-finder-*-chrome.zip in output/."
}

$dest = Join-Path $env:LOCALAPPDATA 'SplitFinder\chrome-extension'
if (Test-Path $dest) {
  Remove-Item -LiteralPath $dest -Recurse -Force
}
New-Item -ItemType Directory -Path $dest -Force | Out-Null

Expand-Archive -LiteralPath $zip.FullName -DestinationPath $dest -Force

# WXT zip is usually one top-level folder (chrome-mv3). Flatten if needed.
$inner = Get-ChildItem -Path $dest -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'manifest.json') } | Select-Object -First 1
if ($null -ne $inner) {
  Get-ChildItem -LiteralPath $inner.FullName | ForEach-Object {
    Move-Item -LiteralPath $_.FullName -Destination $dest -Force
  }
  Remove-Item -LiteralPath $inner.FullName -Recurse -Force
}

if (-not (Test-Path (Join-Path $dest 'manifest.json'))) {
  throw "Unpacked zip does not contain manifest.json at $dest"
}

Write-Host "Extension ready: $dest"