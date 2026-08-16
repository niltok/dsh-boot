param(
  [string]$RuntimeDir = "dist\runtime-win32-x64",
  [string]$OutDir = "dist",
  [string]$Version = "",
  [string]$WixTool = ""
)

$ErrorActionPreference = "Stop"

if ($Version -eq "") {
  $Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
}

$RuntimeDir = (Resolve-Path $RuntimeDir).Path
$OutDir = (Resolve-Path $OutDir).Path
$Work = Join-Path $OutDir "wix-obj"
New-Item -ItemType Directory -Force -Path $Work | Out-Null

if ($WixTool -eq "") {
  $WixTool = $env:DSH_BOOT_WIX
}
if ($WixTool -eq "") {
  $WixTool = (Get-Command wix.exe -ErrorAction SilentlyContinue).Source
}
if ($WixTool -eq "") {
  throw "WiX v4 (wix.exe) was not found. Install it with: dotnet tool install --global wix --version 4.0.6"
}

# Resolve WixToolset.UI.wixext. Local builds can point DSH_BOOT_WIX_UI_EXT at
# a checked-out DLL; CI downloads the nupkg from nuget.org.
$UiExt = [string]$env:DSH_BOOT_WIX_UI_EXT
if ([string]::IsNullOrEmpty($UiExt) -or -not (Test-Path $UiExt)) {
  $UiVersion = "4.0.6"
  $UiExtDir = Join-Path $Work "wixext-ui-$UiVersion"
  $UiExt = Join-Path $UiExtDir "wixext4\WixToolset.UI.wixext.dll"
  if (-not (Test-Path $UiExt)) {
    $UiNupkg = Join-Path $Work "WixToolset.UI.wixext.$UiVersion.nupkg"
    Write-Host "dsh-boot: downloading WixToolset.UI.wixext $UiVersion"
    Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/wixtoolset.ui.wixext/$UiVersion/wixtoolset.ui.wixext.$UiVersion.nupkg" -OutFile $UiNupkg
    New-Item -ItemType Directory -Force -Path $UiExtDir | Out-Null
    & tar.exe -xf $UiNupkg -C $UiExtDir
    if ($LASTEXITCODE -ne 0) { throw "failed to extract WixToolset.UI.wixext" }
  }
}

$Components = Join-Path $Work "runtime-components.wxs"
Write-Host "dsh-boot: generating v4 component manifest from $RuntimeDir"
& node scripts\generate-wix-components.mjs $RuntimeDir $Components
if ($LASTEXITCODE -ne 0) { throw "component manifest generation failed" }

$Msi = Join-Path $OutDir "dsh-boot-$Version-win32-x64.msi"
Write-Host "dsh-boot: building single dual-scope MSI -> $Msi"
& $WixTool build packaging\windows\dsh-boot.wxs $Components -arch x64 -d Version=$Version -d SourceDir=$RuntimeDir -o $Msi -ext $UiExt
if ($LASTEXITCODE -ne 0) { throw "wix build failed with exit code $LASTEXITCODE" }

Write-Host "dsh-boot: built $Msi"
