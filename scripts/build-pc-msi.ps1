$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$version = '0.1.6'
$work = Join-Path $project 'work\pc-msi'
$stage = Join-Path $work 'payload'
$wix = 'D:\WorkSpace\frametell\node_modules\.pnpm\electron-winstaller@5.4.0\node_modules\electron-winstaller\vendor'
$candle = Join-Path $wix 'candle.exe'
$light = Join-Path $wix 'light.exe'
$outDir = Join-Path $project 'artifacts'
$msi = Join-Path $outDir "rmdex-pc-$version-win-x64.msi"

if (-not (Test-Path -LiteralPath $candle) -or -not (Test-Path -LiteralPath $light)) { throw 'WiX candle.exe/light.exe not found.' }
if (-not (Test-Path -LiteralPath (Join-Path $project 'dist-pc\index.html'))) { throw 'dist-pc is missing; run npm run pc:build first.' }

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage,$outDir | Out-Null

Copy-Item -LiteralPath (Join-Path $project 'dist-pc') -Destination $stage -Recurse -Force
Copy-Item -LiteralPath (Join-Path $project 'pc') -Destination $stage -Recurse -Force
Copy-Item -LiteralPath (Join-Path $project 'server') -Destination $stage -Recurse -Force
Copy-Item -LiteralPath (Join-Path $project 'src') -Destination $stage -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $project 'scripts\\start-shared-desktop.ts') -Destination (Join-Path $stage 'scripts') -Force
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'node_modules') | Out-Null
& robocopy.exe (Join-Path $project 'node_modules') (Join-Path $stage 'node_modules') /E /XD (Join-Path $project 'node_modules\.cache') (Join-Path $project 'node_modules\.vite') (Join-Path $project 'node_modules\@capacitor\android\android') /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) { throw 'Failed to copy node_modules.' }
Copy-Item -LiteralPath (Join-Path $project 'package.json') -Destination $stage -Force
Copy-Item -LiteralPath (Join-Path $project 'package-lock.json') -Destination $stage -Force -ErrorAction SilentlyContinue
foreach ($secretName in @('.device-token', '.web-client-token')) {
  $secretPath = Join-Path $project $secretName
  if (Test-Path -LiteralPath $secretPath) { Copy-Item -LiteralPath $secretPath -Destination $stage -Force }
}
Copy-Item -LiteralPath (Join-Path $project 'work\pc-webview-compact\rmdex-pc-3x4.exe') -Destination $stage -Force
Copy-Item -LiteralPath (Join-Path $project 'work\pc-webview-compact\Microsoft.Web.WebView2.Core.dll'),(Join-Path $project 'work\pc-webview-compact\Microsoft.Web.WebView2.WinForms.dll'),(Join-Path $project 'work\pc-webview-compact\WebView2Loader.dll') -Destination $stage -Force

$runtime = Join-Path $stage 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Get-ChildItem -LiteralPath (Join-Path $stage 'node_modules') -Directory -Recurse | Where-Object { $_.Name -in @('build','.gradle','.vite','.cache') } | Sort-Object FullName -Descending | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $stage 'node_modules\@capacitor\android\capacitor\build') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath 'D:\bin\nodejs\node.exe' -Destination $runtime -Force

# Android/Vite build outputs are not needed by the PC service and can contain
# transient files that disappear while WiX is compiling the manifest.
$files = Get-ChildItem -LiteralPath $stage -File -Recurse | Where-Object {
  $_.FullName -notmatch '\\node_modules\\.*\\(?:build|\.gradle|\.vite|\.cache)(?:\\|$)'
}
$components = New-Object System.Text.StringBuilder
$dirMap = @{ '' = 'INSTALLFOLDER' }
$dirNames = @{ '' = '' }
$children = @{ '' = New-Object System.Collections.Generic.List[string] }
$index = 0
function Escape-Xml([string]$value) {
  return [System.Security.SecurityElement]::Escape($value)
}
foreach ($file in $files) {
  $relative = $file.FullName.Substring($stage.Length + 1)
  $parts = $relative -split '[\\/]'
  $dirParts = if ($parts.Count -gt 1) { @($parts[0..($parts.Count - 2)]) } else { @() }
  $key = ''
  foreach ($part in $dirParts) {
    $next = if ($key) { "$key\$part" } else { $part }
    if (-not $dirMap.ContainsKey($next)) {
      $dirMap[$next] = 'DIR' + $dirMap.Count
      $dirNames[$next] = $part
      $children[$next] = New-Object System.Collections.Generic.List[string]
      [void]$children[$key].Add($next)
    }
    $key = $next
  }
  $parent = $dirMap[$key]
  $componentId = "CMP$index"; $fileId = "FIL$index"
  $source = Escape-Xml $file.FullName
  $name = Escape-Xml $file.Name
  $guid = [Guid]::NewGuid().ToString().ToUpper()
  [void]$components.AppendLine(("      <Component Id='{0}' Directory='{1}' Guid='{5}'><File Id='{2}' Source='{3}' Name='{4}' KeyPath='yes' /></Component>" -f $componentId,$parent,$fileId,$source,$name,$guid))
  $index++
}

$directoryXml = New-Object System.Text.StringBuilder
function Add-DirectoryXml([string]$parentKey, [int]$indent) {
  foreach ($key in ($children[$parentKey] | Sort-Object)) {
    $padding = (' ' * $indent)
    $id = $dirMap[$key]
    $name = Escape-Xml $dirNames[$key]
    [void]$directoryXml.AppendLine("$padding<Directory Id='$id' Name='$name'>")
    Add-DirectoryXml $key ($indent + 2)
    [void]$directoryXml.AppendLine("$padding</Directory>")
  }
}
Add-DirectoryXml '' 8
$wxs = Join-Path $work 'rmdex.wxs'
$xml = @"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="rmdex PC" Language="2052" Codepage="65001" Version="$version" Manufacturer="rmdex" UpgradeCode="A0D8E5A2-2CB3-47C7-9A13-2B1D9B4B8A10">
    <Package InstallerVersion="300" Compressed="yes" InstallScope="perUser" Platform="x64" />
    <MajorUpgrade DowngradeErrorMessage="已安装更高版本的 rmdex PC。" />
    <MediaTemplate EmbedCab="yes" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="LocalAppDataFolder">
        <Directory Id="INSTALLFOLDER" Name="rmdex-pc">
$directoryXml
        </Directory>
      </Directory>
      <Directory Id="ProgramMenuFolder"><Directory Id="ApplicationProgramsFolder" Name="rmdex PC" /></Directory>
      <Directory Id="DesktopFolder" />
    </Directory>
    <DirectoryRef Id="ApplicationProgramsFolder"><Component Id="ShortcutComponent" Guid="*"><Shortcut Id="StartMenuShortcut" Name="rmdex PC" Target="[INSTALLFOLDER]rmdex-pc-3x4.exe" WorkingDirectory="INSTALLFOLDER" /><RemoveFolder Id="RemoveApplicationProgramsFolder" On="uninstall" /><RegistryValue Root="HKCU" Key="Software\rmdex\rmdex-pc" Name="installed" Type="integer" Value="1" KeyPath="yes" /></Component></DirectoryRef>
    <DirectoryRef Id="DesktopFolder"><Component Id="DesktopShortcutComponent" Guid="*"><Shortcut Id="DesktopShortcut" Name="rmdex PC" Target="[INSTALLFOLDER]rmdex-pc-3x4.exe" WorkingDirectory="INSTALLFOLDER" /><RegistryValue Root="HKCU" Key="Software\rmdex\rmdex-pc" Name="desktop" Type="integer" Value="1" KeyPath="yes" /></Component></DirectoryRef>
    <Feature Id="MainFeature" Title="rmdex PC" Level="1"><ComponentGroupRef Id="Files" /><ComponentRef Id="ShortcutComponent" /><ComponentRef Id="DesktopShortcutComponent" /></Feature>
  </Product>
  <Fragment><ComponentGroup Id="Files">$components</ComponentGroup></Fragment>
</Wix>
"@
[IO.File]::WriteAllText($wxs, $xml, [Text.Encoding]::UTF8)
$obj = Join-Path $work 'rmdex.wixobj'
& $candle -nologo -out $obj $wxs
if ($LASTEXITCODE -ne 0) { throw "WiX candle failed: $LASTEXITCODE" }
& $light -nologo -sice:ICE30 -sice:ICE38 -sice:ICE64 -sice:ICE91 -out $msi $obj
if ($LASTEXITCODE -ne 0) { throw "WiX light failed: $LASTEXITCODE" }
Write-Host "Built $msi"
