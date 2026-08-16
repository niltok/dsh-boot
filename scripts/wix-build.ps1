param(
  [string]$RuntimeDir = "dist\runtime-win32-x64",
  [string]$OutDir = "dist",
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"

if ($Version -eq "") {
  $Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
}

$RuntimeDir = (Resolve-Path $RuntimeDir).Path
$OutDir = (Resolve-Path $OutDir).Path
$Work = Join-Path $OutDir "wix-obj"
New-Item -ItemType Directory -Force -Path $Work | Out-Null

Write-Host "dsh-boot: harvesting $RuntimeDir"
$Components = Join-Path $Work "runtime-components.wxs"
& heat.exe dir $RuntimeDir -gg -g1 -cg RuntimeComponents -dr INSTALLDIR -srd -sreg -var var.SourceDir -out $Components
if ($LASTEXITCODE -ne 0) { throw "heat.exe failed with exit code $LASTEXITCODE" }

foreach ($Scope in @("per-user", "per-machine")) {
  $Source = "packaging\windows\dsh-boot-$Scope.wxs"
  $ProductObj = Join-Path $Work "Product-$Scope.wixobj"
  $ComponentsObj = Join-Path $Work "Components-$Scope.wixobj"
  $CandleOut = $Work.TrimEnd('\') + '\'
  $SourceObj = Join-Path $Work ((Split-Path $Source -Leaf) -replace '\.wxs$', '.wixobj')
  $RuntimeObj = Join-Path $Work "runtime-components.wixobj"

  Write-Host "dsh-boot: compiling $Scope MSI"
  & candle.exe -nologo -arch x64 "-dSourceDir=$RuntimeDir" "-dVersion=$Version" $Source $Components "-out" $CandleOut
  if ($LASTEXITCODE -ne 0) { throw "candle.exe failed for $Scope with exit code $LASTEXITCODE" }

  # Move the two objects aside so the next scope's compile cannot overwrite them.
  Move-Item $SourceObj $ProductObj -Force
  Move-Item $RuntimeObj $ComponentsObj -Force

  $Msi = Join-Path $OutDir "dsh-boot-$Version-win32-x64-$Scope.msi"
  Write-Host "dsh-boot: linking $Msi"
  # -sval skips MSI ICE validation. ICE needs a fully functional Windows
  # Installer service and non-interactive CI runners (and local sandboxes)
  # are not a reliable host for it; heat/candle/link still catch source errors.
  & light.exe -nologo -sval -b $RuntimeDir -out $Msi $ProductObj $ComponentsObj
  if ($LASTEXITCODE -ne 0) { throw "light.exe failed for $Scope with exit code $LASTEXITCODE" }
  Write-Host "dsh-boot: built $Msi"
}

Write-Host "dsh-boot: Windows packages complete"
