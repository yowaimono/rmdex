$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$version = '1.0.4314.35'
$sdk = Join-Path $project 'work\webview2-sdk'
$package = Join-Path $sdk 'package'
$out = Join-Path $project 'work\pc-webview-compact'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4.x compiler not found.' }
if (-not (Test-Path -LiteralPath (Join-Path $package 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'))) {
  New-Item -ItemType Directory -Force -Path $sdk | Out-Null
  $archive = Join-Path $sdk 'webview2.zip'
  Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg" -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $package -Force
}
New-Item -ItemType Directory -Force -Path $out | Out-Null
$core = Join-Path $package 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$forms = Join-Path $package 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
Copy-Item -LiteralPath $core,$forms,(Join-Path $package 'build\native\x64\WebView2Loader.dll') -Destination $out -Force
$exe = Join-Path $out 'rmdex-pc-3x4.exe'
& $compiler /nologo /target:winexe /platform:x64 "/out:$exe" /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll "/reference:$core" "/reference:$forms" (Join-Path $project 'pc\windows\Dashboard.cs')
if ($LASTEXITCODE -ne 0) { throw "WebView2 host build failed (exit $LASTEXITCODE)." }
Write-Host "Built $exe"
