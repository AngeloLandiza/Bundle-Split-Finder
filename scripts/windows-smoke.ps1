<#
  Windows smoke test for the Split Finder installer. It runs on a real Windows machine (the GitHub Actions
  windows-latest runner, see .github/workflows/windows-smoke.yml), never on a Mac.

  What it does, in order:
    1. installs the NSIS installer silently for the current user,
    2. starts the app and waits for its agent to listen on 127.0.0.1:8790,
    3. asks the agent a few questions over HTTP (the challenge, its state, who may talk to it),
    4. checks that the secret files are readable by the owner only,
    5. asks the agent to quit and checks nothing is left running,
    6. uninstalls silently and checks the install folder is gone.

  Each check prints one line, "PASS name: why" or "FAIL name: why". The script exits 1 if any check failed.
  It never prints the agent token (on GitHub Actions the token is also masked). It spends no SerpApi searches:
  the app starts with an empty store and no keys.

  What it cannot check: Mica, where the tray flyout opens, a real Chrome pairing, launch at login.

  The facts it relies on are the same ones desktop/windows-smoke.test.ts checks against the real agent code on
  the Mac (the challenge's HMAC, the shape of a fresh state, the route names). If you change one here, change
  it there.
#>
param(
  # The NSIS installer built by `tauri build` (Split Finder_<version>_x64-setup.exe).
  [Parameter(Mandatory = $true)][string]$Installer,
  # Where to install. A fixed path without spaces, so the installer's /D= switch (which cannot be quoted) works.
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'SplitFinderSmoke'),
  # The agent's address. Port 8790 is fixed by the app.
  [int]$Port = 8790,
  # The app's data folder: Tauri's app data dir for the identifier in src-tauri/tauri.conf.json.
  [string]$DataDir = (Join-Path $env:APPDATA 'com.bundlesplitfinder.desktop')
)

$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"
# The six key names from core/src/api/contract.ts (KEY_NAMES).
$keyNames = @('serpapi', 'keepa', 'anthropic', 'openai', 'ebay', 'telegram')
$failures = 0
$token = $null
$appProcess = $null

# ---------------------------------------------------------------- reporting

function Write-Check {
  param([bool]$Ok, [string]$Name, [string]$Why)
  if ($Ok) { Write-Host "PASS $Name`: $Why" }
  else { Write-Host "FAIL $Name`: $Why"; $script:failures++ }
}

# Runs one check. A thrown error is a FAIL with its message, not a crash, so the later checks still run.
function Invoke-Check {
  param([string]$Name, [scriptblock]$Body)
  try {
    $r = & $Body          # returns @($ok, $why)
    Write-Check -Ok ([bool]$r[0]) -Name $Name -Why ([string]$r[1])
  } catch {
    Write-Check -Ok $false -Name $Name -Why ("error: " + ($_.Exception.Message -replace '\s+', ' '))
  }
}

# ---------------------------------------------------------------- helpers

# One HTTP call to the agent. Returns Status (0 when nothing answered) and the body text. $Origin is sent as the
# Origin header when given (a browser always sends one; the app and the shell send none).
function Invoke-Agent {
  param([string]$Method, [string]$Path, [string]$Bearer, [string]$Origin, [int]$TimeoutSec = 10)
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
  try {
    $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($Method), "$base$Path")
    if ($Bearer) { [void]$req.Headers.TryAddWithoutValidation('Authorization', "Bearer $Bearer") }
    if ($Origin) { [void]$req.Headers.TryAddWithoutValidation('Origin', $Origin) }
    if ($Method -eq 'POST') { $req.Content = New-Object System.Net.Http.StringContent('{}', [System.Text.Encoding]::UTF8, 'application/json') }
    $res = $client.SendAsync($req).GetAwaiter().GetResult()
    $text = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return [pscustomobject]@{ Status = [int]$res.StatusCode; Body = $text }
  } catch {
    return [pscustomobject]@{ Status = 0; Body = $_.Exception.Message }
  } finally {
    $client.Dispose()
  }
}

# True when something accepts a TCP connection on the agent's port.
function Test-Listening {
  $tcp = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $tcp.ConnectAsync('127.0.0.1', $Port)
    return ($task.Wait(500) -and $tcp.Connected)
  } catch { return $false }
  finally { $tcp.Dispose() }
}

# Polls $Test (a scriptblock returning bool) once a second until it is true or $Seconds pass.
function Wait-Until {
  param([scriptblock]$Test, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Test) { return $true }
    Start-Sleep -Seconds 1
  }
  return [bool](& $Test)
}

# The agent's challenge answer, worked out here from the token: HMAC-SHA256(key = token, message =
# "split-finder-hello:" + nonce), as lowercase hex. Same as Auth.helloProof in agent/auth.ts.
function Get-HelloProof {
  param([string]$Token, [string]$Nonce)
  $hmac = New-Object System.Security.Cryptography.HMACSHA256(, [System.Text.Encoding]::UTF8.GetBytes($Token))
  try {
    $bytes = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("split-finder-hello:$Nonce"))
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally { $hmac.Dispose() }
}

# A random 43-character url-safe nonce (the agent wants 32 to 128 letters, digits, - or _).
function New-Nonce {
  $b = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return ([Convert]::ToBase64String($b) -replace '\+', '-' -replace '/', '_' -replace '=', '')
}

# Who may use a path, from `icacls <path>`: the account names of its entries. icacls prints the path before the
# first entry and then "NAME:(PERMISSIONS)" per entry, e.g. "NT AUTHORITY\SYSTEM:(I)(F)".
function Get-AclNames {
  param([string]$Path)
  $out = & icacls.exe $Path 2>&1
  if ($LASTEXITCODE -ne 0) { throw "icacls failed for ${Path}: $($out -join ' ')" }
  $names = @()
  foreach ($line in $out) {
    $l = "$line".Trim()
    if ($l.StartsWith($Path, [StringComparison]::OrdinalIgnoreCase)) { $l = $l.Substring($Path.Length).Trim() }
    if ($l -match '^(?<who>.+?):\(') { $names += $Matches['who'] }
  }
  return , $names
}

function Test-IsMe { param([string]$Who) return ($Who -ieq (& whoami.exe).Trim()) }

# The processes of the app's agent sidecar (binaries/agent-dashboard in tauri.conf.json).
function Get-AgentProcesses { return @(Get-Process -Name 'agent-dashboard*' -ErrorAction SilentlyContinue) }

# ---------------------------------------------------------------- 1. install

$installed = $false
Invoke-Check 'install' {
  if (-not (Test-Path -LiteralPath $Installer)) { return @($false, "installer not found: $Installer") }
  if (Test-Listening) { return @($false, "port $Port is already in use before the install") }
  # /S is silent; /D= sets the folder and must be the last argument, unquoted. The installer is per user, so no
  # administrator prompt appears.
  $p = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$InstallDir") -Wait -PassThru
  if ($p.ExitCode -ne 0) { return @($false, "installer exited with code $($p.ExitCode)") }
  $exe = Get-ChildItem -LiteralPath $InstallDir -Filter '*.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '^uninstall' } | Select-Object -First 1
  if (-not $exe) { return @($false, "no program was installed in $InstallDir") }
  $script:installed = $true
  $script:appExe = $exe.FullName
  $uninstall = Join-Path $InstallDir 'uninstall.exe'
  if (-not (Test-Path -LiteralPath $uninstall)) { return @($false, "installed $($exe.Name) but there is no uninstall.exe") }
  return @($true, "installed $($exe.Name) for the current user, exit code 0")
}

# ---------------------------------------------------------------- 2. start, wait for the agent

$listening = $false
if ($installed) {
  Invoke-Check 'start' {
    # The installer may have started the app itself; do not start a second one.
    if (-not (Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($script:appExe)) -ErrorAction SilentlyContinue)) {
      $script:appProcess = Start-Process -FilePath $script:appExe -PassThru
    }
    $up = Wait-Until -Seconds 60 -Test { Test-Listening }
    $script:listening = $up
    if ($up) { return @($true, "127.0.0.1:$Port accepts connections") }
    return @($false, "nothing listened on 127.0.0.1:$Port within 60 s")
  }
} else {
  Write-Check $false 'start' 'skipped, the install failed'
}

# ---------------------------------------------------------------- 3. the token (never printed)

if ($listening) {
  Invoke-Check 'token file' {
    $path = Join-Path $DataDir 'agent-token'
    # The agent writes it before it listens, but allow a moment.
    [void](Wait-Until -Seconds 10 -Test { Test-Path -LiteralPath $path })
    if (-not (Test-Path -LiteralPath $path)) { return @($false, "no agent-token in $DataDir") }
    $t = (Get-Content -LiteralPath $path -Raw).Trim()
    if ($t.Length -lt 32) { return @($false, "agent-token is shorter than 32 characters") }
    $script:token = $t
    # Keep it out of the Actions log even if something below were to echo it.
    if ($env:GITHUB_ACTIONS) { Write-Host "::add-mask::$t" }
    return @($true, "read the token ($($t.Length) characters), not shown")
  }
}

# ---------------------------------------------------------------- 4. the HTTP checks

if ($listening -and $token) {
  Invoke-Check 'hello challenge' {
    $nonce = New-Nonce
    $r = Invoke-Agent -Method GET -Path "/api/hello?nonce=$nonce"
    if ($r.Status -ne 200) { return @($false, "GET /api/hello answered $($r.Status)") }
    $got = ($r.Body | ConvertFrom-Json).proof
    $want = Get-HelloProof -Token $script:token -Nonce $nonce
    if ($got -ceq $want) { return @($true, 'the HMAC answer matches the token in the data folder') }
    return @($false, 'the answer is not HMAC-SHA256(token, "split-finder-hello:" + nonce)')
  }

  Invoke-Check 'state shape' {
    $r = Invoke-Agent -Method GET -Path '/api/state' -Bearer $script:token
    if ($r.Status -ne 200) { return @($false, "GET /api/state answered $($r.Status)") }
    $s = $r.Body | ConvertFrom-Json
    $problems = @()
    if ($s.agent.status -ne 'idle') { $problems += "agent.status is '$($s.agent.status)', not 'idle'" }
    if ($s.helper.paired -ne $false) { $problems += 'helper.paired is not false' }
    foreach ($k in $keyNames) {
      if ($null -eq $s.keys.$k) { $problems += "keys.$k is missing" }
      elseif ($s.keys.$k -ne $false) { $problems += "keys.$k is not false" }
    }
    if ($problems.Count) { return @($false, ($problems -join '; ')) }
    return @($true, "agent idle, helper unpaired, all $($keyNames.Count) keys false")
  }

  Invoke-Check 'no token is refused' {
    $r = Invoke-Agent -Method GET -Path '/api/state'
    if ($r.Status -eq 401) { return @($true, 'GET /api/state without a token answered 401') }
    return @($false, "GET /api/state without a token answered $($r.Status), not 401")
  }

  Invoke-Check 'foreign origin is refused' {
    $r = Invoke-Agent -Method GET -Path '/api/state' -Bearer $script:token -Origin 'https://evil.example'
    if ($r.Status -eq 403) { return @($true, 'a valid token with Origin https://evil.example answered 403') }
    return @($false, "a foreign Origin answered $($r.Status), not 403")
  }

  Invoke-Check 'own origin is accepted' {
    # The control for the check above: the app's own origin with the same token must work, so a 403 there means
    # the origin rule and not a broken token.
    $r = Invoke-Agent -Method GET -Path '/api/state' -Bearer $script:token -Origin "http://127.0.0.1:$Port"
    if ($r.Status -eq 200) { return @($true, "Origin http://127.0.0.1:$Port answered 200") }
    return @($false, "the app's own origin answered $($r.Status), not 200")
  }
}

# ---------------------------------------------------------------- 5. owner-only files

if ($listening) {
  Invoke-Check 'token file is owner-only' {
    # The agent narrows this file with icacls (agent/winAcl.ts): one entry, the current user.
    $names = Get-AclNames (Join-Path $DataDir 'agent-token')
    $others = @($names | Where-Object { -not (Test-IsMe $_) })
    if ($names.Count -eq 1 -and $others.Count -eq 0) { return @($true, "only $($names[0]) may use it") }
    return @($false, "entries: $($names -join ', ') (expected only $((& whoami.exe).Trim()))")
  }

  Invoke-Check 'store files are owner-only' {
    # Every file the agent has written under store\ must be the current user alone. The folder keeps the ACL it
    # inherits from %APPDATA% (the user, SYSTEM, Administrators), so for the folder the rule is: nobody wider.
    $storeDir = Join-Path $DataDir 'store'
    if (-not (Test-Path -LiteralPath $storeDir)) { return @($false, "no store folder in $DataDir") }
    $bad = @()
    $files = @(Get-ChildItem -LiteralPath $storeDir -File -Recurse -ErrorAction SilentlyContinue)
    foreach ($f in $files) {
      $names = Get-AclNames $f.FullName
      if (@($names | Where-Object { -not (Test-IsMe $_) }).Count -gt 0) { $bad += "$($f.Name): $($names -join ', ')" }
    }
    $dirNames = Get-AclNames $storeDir
    $wide = @($dirNames | Where-Object { $_ -match '(?i)^(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users|NT AUTHORITY\\INTERACTIVE)$' })
    if ($wide.Count) { $bad += "store folder: $($wide -join ', ')" }
    if ($bad.Count) { return @($false, ($bad -join ' | ')) }
    return @($true, "$($files.Count) store file(s) owner-only; the store folder has no group-wide entry")
  }
}

# ---------------------------------------------------------------- 6. quit

if ($listening -and $token) {
  Invoke-Check 'quit leaves no agent' {
    $r = Invoke-Agent -Method POST -Path '/api/agent/quit' -Bearer $script:token
    if ($r.Status -ne 200) { return @($false, "POST /api/agent/quit answered $($r.Status)") }
    $gone = Wait-Until -Seconds 10 -Test { (Get-AgentProcesses).Count -eq 0 }
    $closed = -not (Test-Listening)
    if ($gone -and $closed) { return @($true, 'no agent-dashboard process and the port is closed within 10 s') }
    $left = (Get-AgentProcesses | ForEach-Object { $_.Id }) -join ', '
    return @($false, "after 10 s: agent-dashboard process ids [$left], port closed: $closed")
  }
}

# ---------------------------------------------------------------- 7. uninstall

# Stop what is left of the app first, so its files are not in use.
Get-AgentProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
if ($script:appExe) {
  Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($script:appExe)) -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
}

if ($installed) {
  Invoke-Check 'uninstall' {
    $uninstall = Join-Path $InstallDir 'uninstall.exe'
    # NSIS copies the uninstaller to a temp folder and returns at once, so -Wait is not enough: poll for the folder.
    [void](Start-Process -FilePath $uninstall -ArgumentList '/S' -Wait -PassThru)
    $gone = Wait-Until -Seconds 30 -Test { -not (Test-Path -LiteralPath $InstallDir) }
    if ($gone) { return @($true, "$InstallDir is gone") }
    $left = @(Get-ChildItem -LiteralPath $InstallDir -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ', '
    return @($false, "$InstallDir is still there after 30 s: $left")
  }
} else {
  Write-Check $false 'uninstall' 'skipped, the install failed'
}

# ---------------------------------------------------------------- result

if ($failures -gt 0) {
  Write-Host "$failures check(s) FAILED"
  exit 1
}
Write-Host 'All checks passed'
exit 0
