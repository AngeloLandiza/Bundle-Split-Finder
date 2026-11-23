param(
  [Parameter(Mandatory = $true)]
  [string] $RepoRoot
)

$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$win = Join-Path $RepoRoot 'windows'

$WshShell = New-Object -ComObject WScript.Shell

$setup = $WshShell.CreateShortcut((Join-Path $desktop 'Split Finder Setup.lnk'))
$setup.TargetPath = Join-Path $win 'SplitFinder-Setup.bat'
$setup.WorkingDirectory = $RepoRoot
$setup.Description = 'Install deps and unpack Split Finder for Chrome'
$setup.Save()

$start = $WshShell.CreateShortcut((Join-Path $desktop 'Split Finder Start.lnk'))
$start.TargetPath = Join-Path $win 'SplitFinder-Start.vbs'
$start.WorkingDirectory = $RepoRoot
$start.Description = 'Agent dashboard + open Chrome extensions'
$start.Save()

Write-Host "Desktop shortcuts created."