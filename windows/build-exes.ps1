# Optional: run once inside the Windows VM to turn launchers into .exe files.
# Requires: Install-Module ps2exe -Scope CurrentUser
param(
  [string] $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Module -ListAvailable -Name ps2exe)) {
  Write-Host "Installing ps2exe module..."
  Install-Module ps2exe -Scope CurrentUser -Force
}

$out = Join-Path $RepoRoot 'windows\bin'
New-Item -ItemType Directory -Path $out -Force | Out-Null

$setupPs1 = Join-Path $env:TEMP 'split-finder-setup-launcher.ps1'
$startPs1 = Join-Path $env:TEMP 'split-finder-start-launcher.ps1'
@"
Set-Location '$RepoRoot'
& '$($PSScriptRoot)\SplitFinder-Setup.bat'
"@ | Set-Content -LiteralPath $setupPs1 -Encoding UTF8
@"
Set-Location '$RepoRoot'
& '$($PSScriptRoot)\SplitFinder-Start.bat'
"@ | Set-Content -LiteralPath $startPs1 -Encoding UTF8

Invoke-ps2exe -inputFile $setupPs1 -outputFile (Join-Path $out 'SplitFinder-Setup.exe') -title 'Split Finder Setup' -noConsole:$false
Invoke-ps2exe -inputFile $startPs1 -outputFile (Join-Path $out 'SplitFinder-Start.exe') -title 'Split Finder' -noConsole:$false

Write-Host "Wrote $($out)\SplitFinder-Setup.exe and SplitFinder-Start.exe"