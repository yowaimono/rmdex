$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -LiteralPath $project
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { throw '找不到 npm.cmd，请先安装 Node.js 22 或更高版本。' }

Write-Host 'Building rmdex-pc...'
& $npm.Source run pc:build
if ($LASTEXITCODE -ne 0) { throw "rmdex-pc 构建失败（exit $LASTEXITCODE）。" }

$port = if ($env:RMDEX_PC_PORT) { $env:RMDEX_PC_PORT } else { '18788' }
$url = "http://127.0.0.1:$port"
Write-Host "Starting rmdex-pc on $url ..."
# Open the dashboard only after its status endpoint responds.
$browserJob = Start-Job -ArgumentList $url -ScriptBlock {
  param($url)
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $status = Invoke-RestMethod -Uri "$url/pc-api/status" -TimeoutSec 2
      if ($status.phase -and $status.appServer) { Start-Process $url; return }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
}
& $npm.Source run pc:server
