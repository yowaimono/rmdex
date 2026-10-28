$project = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$tokenPath = Join-Path $project '.device-token'
if (-not (Test-Path -LiteralPath $tokenPath)) { throw "Missing $tokenPath. Register this computer from the device panel first." }
$env:RMDEX_RELAY_URL = 'wss://code.kyeai.xyz/agent'
$env:RMDEX_DEVICE_TOKEN = (Get-Content -Raw -LiteralPath $tokenPath).Trim()
$env:RMDEX_AGENT_PORT = '18787'
Set-Location $project
& 'D:\bin\nodejs\node.exe' (Join-Path $project 'node_modules\tsx\dist\cli.mjs') (Join-Path $project 'server\index.ts')
