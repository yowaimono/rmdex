$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = 'D:\bin\nodejs\node.exe'
$tsx = Join-Path $project 'node_modules\tsx\dist\cli.mjs'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$socket = if ($env:RMDEX_CODEX_SOCKET) { $env:RMDEX_CODEX_SOCKET } else { Join-Path $codexHome 'app-server-control\app-server-control.sock' }
$port = if ($env:RMDEX_AGENT_PORT) { $env:RMDEX_AGENT_PORT } else { '18787' }

if (-not (Test-Path -LiteralPath $tsx)) { throw "Missing $tsx. Run npm install in $project first." }

$desktopAppServer = Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" | Where-Object {
  $_.CommandLine -match 'app-server.*analytics-default-enabled|features\.code_mode_host=true.*app-server'
}
if ($desktopAppServer) {
  $pids = ($desktopAppServer.ProcessId -join ', ')
  throw "Codex Desktop is still running (app-server PID: $pids). Exit Codex Desktop completely, then double-click this shortcut again."
}

$existing = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue
if ($existing) { throw "Port $port is already in use by PID $($existing.OwningProcess). Stop the existing rmdex agent before starting shared mode." }

if (-not $env:RMDEX_CODEX) {
  $codexCandidates = @(
    Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Filter 'codex.exe' -File -Recurse -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -ExpandProperty FullName
  )
  $codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
  if ($codexCommand) { $codexCandidates += $codexCommand.Source }
  $env:RMDEX_CODEX = $codexCandidates | Select-Object -First 1
}
if (-not $env:RMDEX_CODEX -or -not (Test-Path -LiteralPath $env:RMDEX_CODEX)) {
  throw 'Cannot find codex.exe. Set RMDEX_CODEX to the absolute path of Codex CLI.'
}
Write-Host "Using Codex CLI: $env:RMDEX_CODEX"
$env:RMDEX_CODEX_MODE = 'shared'
$env:RMDEX_CODEX_SOCKET = $socket
$env:RMDEX_AGENT_PORT = $port
$env:RMDEX_RELAY_URL = if ($env:RMDEX_RELAY_URL) { $env:RMDEX_RELAY_URL } else { 'wss://code.kyeai.xyz/agent' }
$tokenPath = Join-Path $project '.device-token'
$logDir = Join-Path $project 'work'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$agentOut = Join-Path $logDir 'shared-manual-agent.stdout.log'
$agentErr = Join-Path $logDir 'shared-manual-agent.stderr.log'
if (-not $env:RMDEX_DEVICE_TOKEN -and (Test-Path -LiteralPath $tokenPath)) { $env:RMDEX_DEVICE_TOKEN = (Get-Content -Raw -LiteralPath $tokenPath).Trim() }

Write-Host 'Starting the managed Codex app-server daemon...'
& $env:RMDEX_CODEX app-server daemon start
if ($LASTEXITCODE -ne 0) { throw "Codex managed daemon failed to start (exit $LASTEXITCODE)." }

$socketDeadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  if (Test-Path -LiteralPath $socket) { break }
  Start-Sleep -Milliseconds 500
  if ([DateTime]::UtcNow -gt $socketDeadline) { throw "Codex managed daemon socket was not ready: $socket" }
} while ($true)

$agent = Start-Process -FilePath $node -ArgumentList @('--import', 'tsx', (Join-Path $project 'server\index.ts')) -WorkingDirectory $project -RedirectStandardOutput $agentOut -RedirectStandardError $agentErr -PassThru -WindowStyle Hidden
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 250
    if ($agent.HasExited) {
      $diagnostics = if (Test-Path -LiteralPath $agentErr) { (Get-Content -Tail 30 -LiteralPath $agentErr -ErrorAction SilentlyContinue) -join [Environment]::NewLine } else { 'No agent stderr was captured.' }
      throw "Shared rmdex agent exited before becoming ready (exit $($agent.ExitCode)).`n$diagnostics"
    }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/models" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { break }
    } catch { }
    if ([DateTime]::UtcNow -gt $deadline) {
      $diagnostics = if (Test-Path -LiteralPath $agentErr) { (Get-Content -Tail 30 -LiteralPath $agentErr -ErrorAction SilentlyContinue) -join [Environment]::NewLine } else { 'No agent stderr was captured.' }
      throw "Shared rmdex agent did not become ready on port $port.`n$diagnostics"
    }
  } while ($true)

  Write-Host 'Shared rmdex agent is ready. Starting Codex Desktop on the same app-server.'
  & $node --import tsx (Join-Path $project 'scripts\start-shared-desktop.ts') --ensure-daemon
  if ($LASTEXITCODE -ne 0) { throw "Shared Codex Desktop launcher failed (exit $LASTEXITCODE)." }
} finally {
  if ($agent -and -not $agent.HasExited) { & taskkill.exe /PID $agent.Id /T /F | Out-Null }
}