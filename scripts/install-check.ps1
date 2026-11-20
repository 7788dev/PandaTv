$ErrorActionPreference = 'Stop'
# Installs the current release silently and records what is on disk afterwards.
# A silent NSIS install reuses the directory of an existing install, so the location is read
# from the uninstall entry, never assumed. An install that was already there is upgraded in
# place and is NOT marked as removable by uninstall-check.ps1.
$root = Split-Path -Parent $PSScriptRoot
$desktopVersion = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$setup = Join-Path $root "release\Panda-$desktopVersion-Setup.exe"
$marker = Join-Path $root ".tmp\install-created-$desktopVersion.txt"
$evidence = Join-Path $root "docs\evidence\install-$desktopVersion.txt"
function Get-PandaEntry { Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Panda*' } | Select-Object -First 1 }
function Get-PandaDirectory($entry) { if ($entry -and $entry.UninstallString -match '^"([^"]+)\\[^"\\]+"') { $Matches[1] } }

$log = @()
$log += "installer: $((Get-Item $setup).Length) bytes, sha256 $((Get-FileHash $setup -Algorithm SHA256).Hash)"
$before = Get-PandaDirectory (Get-PandaEntry)
if ($before) { $log += "existing install found at $before before this run: upgraded in place, not removed afterwards" }
Remove-Item $marker -ErrorAction SilentlyContinue
$started = Get-Date
$process = Start-Process -FilePath $setup -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
$log += "install exit code: $($process.ExitCode) in $([int]((Get-Date) - $started).TotalSeconds)s"
$entry = Get-PandaEntry
$target = Get-PandaDirectory $entry
if (-not $target) { throw 'The installer left no uninstall entry' }
if (-not $before) { New-Item -ItemType Directory -Force (Split-Path $marker) | Out-Null; Set-Content -Encoding utf8 $marker $target }
$exe = Join-Path $target 'Panda.exe'
$log += "install directory: $target"
$log += "installed exe exists: $(Test-Path $exe)"
$log += "uninstall entry: $($entry.DisplayName) | $($entry.DisplayVersion) | $($entry.Publisher)"
$log += "start menu shortcut: $(Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Panda.lnk'))"
$log += "desktop shortcut: $(Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Panda.lnk'))"
$files = Get-ChildItem $target -Recurse -File
$log += "installed size: $([int](($files | Measure-Object Length -Sum).Sum / 1MB)) MB in $($files.Count) files"
$log += "resources: $((Get-ChildItem (Join-Path $target 'resources') | ForEach-Object { $_.Name + ' ' + $_.Length }) -join ', ')"
$version = (Get-Item $exe).VersionInfo
$log += "installed exe version info: $($version.ProductName) | $($version.FileVersion) | $($version.CompanyName); authenticode: $((Get-AuthenticodeSignature $exe).Status)"
$log | Set-Content -Encoding utf8 $evidence
$log
