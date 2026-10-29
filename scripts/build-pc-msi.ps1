$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$version = '0.1.0'
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
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'node_modules') | Out-Null
& robocopy.exe (Join-Path $project 'node_modules') (Join-Path $stage 'node_modules') /E /XD (Join-Path $project 'node_modules\.cache') (Join-Path $project 'node_modules\.vite') (Join-Path $project 'node_modules\@capacitor\android\android') /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) { throw 'Failed to copy node_modules.' }
Copy-Item -LiteralPath (Join-Path $project 'package.json') -Destination $stage -Force
Copy-Item -LiteralPath (Join-Path $project 'package-lock.json') -Destination $stage -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $project 'work\pc-webview-compact\rmdex-pc-3x4.exe') -Destination $stage -Force
Copy-Item -LiteralPath (Join-Path $project 'work\pc-webview-compact\Microsoft.Web.WebView2.Core.dll'),(Join-Path $project 'work\pc-webview-compact\Microsoft.Web.WebView2.WinForms.dll'),(Join-Path $project 'work\pc-webview-compact\WebView2Loader.dll') -Destination $stage -Force

$runtime = Join-Path $stage 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Get-ChildItem -LiteralPath (Join-Path $stage 'node_modules') -Directory -Recurse | Where-Object { $_.Name -in @('build','.gradle','.vite','.cache') } | Sort-Object FullName -Descending | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $stage 'node_modules\@capacitor\android\capacitor\build') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath 'D:\bin\nodejs\node.exe' -Destination $runtime -Force

$files = Get-ChildItem -LiteralPath $stage -File
$components = New-Object System.Text.StringBuilder
$dirMap = @{ '' = 'INSTALLFOLDER' }
$dirRows = New-Object System.Collections.Generic.List[object]
$index = 0
foreach ($file in $files) {
  $relative = $file.FullName.Substring($stage.Length + 1)
  $parts = $relative -split '[\\/]'
  $dirParts = if ($parts.Count -gt 1) { $parts[0..($parts.Count - 2)] } else { @() }
  $parent = 'INSTALLFOLDER'; $key = ''
    if (-not $dirMap.ContainsKey($key)) {
      $id = 'DIR_' + ([Math]::Abs($key.GetHashCode())).ToString()
      $dirMap[$key] = $id
      [void]$dirRows.Add([pscustomobject]@{ Id=$id; Parent=$parent; Name=$part; Key=$key })
    }
    $parent = $dirMap[$key]
  $componentId = "CMP$index"; $fileId = "FIL$index"
  $source = $file.FullName.Replace('&','&amp;').Replace('"','&quot;')
  $name = $file.Name.Replace('&','&amp;').Replace('"','&quot;')
  $guid = [Guid]::NewGuid().ToString().ToUpper()
  [void]$components.AppendLine(("      <Component Id='{0}' Directory='{1}' Guid='{5}'><File Id='{2}' Source='{3}' Name='{4}' KeyPath='yes' /></Component>" -f $componentId,$parent,$fileId,$source,$name,$guid))
  $index++
}

$dirs = New-Object System.Text.StringBuilder
foreach ($row in ($dirRows | Sort-Object { $_.Key.Length })) {
  [void]$dirs.AppendLine(("        <Directory Id='{0}' Name='{1}' />" -f $row.Id,$row.Name))
}
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
$dirs
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
& $light -nologo -out $msi $obj
& $light -nologo -sice:ICE30 -out $msi $obj
Write-Host "Built $msi"
