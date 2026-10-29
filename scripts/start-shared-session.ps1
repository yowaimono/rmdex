$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = 'D:\bin\nodejs\node.exe'
$tsx = Join-Path $project 'node_modules\tsx\dist\cli.mjs'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$socket = if ($env:RMDEX_CODEX_SOCKET) { $env:RMDEX_CODEX_SOCKET } else { Join-Path $codexHome 'app-server-control\app-server-control.sock' }
$port = if ($env:RMDEX_AGENT_PORT) { $env:RMDEX_AGENT_PORT } else { '18787' }

if (-not (Test-Path -LiteralPath $tsx)) { throw "Missing $tsx. Run npm install in $project first." }

$existing = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue
if ($existing) { throw "Port $port is already in use. Stop the existing rmdex agent before starting a shared session." }

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
if (-not $env:RMDEX_DEVICE_TOKEN -and (Test-Path -LiteralPath $tokenPath)) { $env:RMDEX_DEVICE_TOKEN = (Get-Content -Raw -LiteralPath $tokenPath).Trim() }

Write-Host 'Starting the managed Codex app-server daemon...'
& $env:RMDEX_CODEX app-server daemon start
if ($LASTEXITCODE -ne 0) { throw "Codex managed daemon failed to start (exit $LASTEXITCODE)." }

$agent = Start-Process -FilePath $node -ArgumentList @('--import', 'tsx', (Join-Path $project 'server\index.ts')) -WorkingDirectory $project -PassThru -WindowStyle Hidden
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/models" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { break }
    } catch { }
    if ([DateTime]::UtcNow -gt $deadline) { throw "Shared rmdex agent did not become ready on port $port." }
  } while ($true)

  Write-Host 'Shared rmdex agent is ready. Close all Codex Desktop windows when you are ready; the launcher will start a Desktop client on the same app-server.'
  Write-Host "Shared launcher is waiting for the Desktop app-server to exit. Log: $project\work\shared-session.stdout.log"
  & $node --import tsx (Join-Path $project 'scripts\start-shared-desktop.ts') --wait-for-desktop-exit --ensure-daemon
  if ($LASTEXITCODE -ne 0) { throw "Shared Codex Desktop launcher failed (exit $LASTEXITCODE)." }
} finally {
  if ($agent -and -not $agent.HasExited) {
    & taskkill.exe /PID $agent.Id /T /F | Out-Null
  }
}
