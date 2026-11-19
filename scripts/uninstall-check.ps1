$ErrorActionPreference = 'Stop'
# Silently removes the install that install-check.ps1 created, and records what is left.
# It refuses to touch an install that was on the machine before install-check.ps1 ran.
$root = Split-Path -Parent $PSScriptRoot
$marker = Join-Path $root '.tmp\install-created.txt'
if (-not (Test-Path $marker)) { throw 'No install created by install-check.ps1: an existing install is never removed by this script' }
$target = (Get-Content $marker -Raw).Trim()
$un = Join-Path $target 'Uninstall Panda.exe'
if (-not (Test-Path $un)) { throw "Panda is not installed at $target" }
$log = @()
$started = Get-Date
$process = Start-Process -FilePath $un -ArgumentList '/S' -Wait -PassThru
$deadline = (Get-Date).AddSeconds(60)
while ((Test-Path $target) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
$log += "uninstall exit code: $($process.ExitCode) in $([int]((Get-Date) - $started).TotalSeconds)s"
$log += "program directory left: $(Test-Path $target)"
$entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Panda*' }
$log += "uninstall entry left: $([bool]$entry)"
$log += "start menu shortcut left: $(Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Panda.lnk'))"
$log += "desktop shortcut left: $(Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Panda.lnk'))"
$log += "%APPDATA%\Panda exists after uninstall: $(Test-Path (Join-Path $env:APPDATA 'Panda')) (the uninstaller keeps user data; the E2E runs use temporary PANDA_USER_DATA_DIR profiles)"
Remove-Item $marker
$log | Add-Content -Encoding utf8 (Join-Path $root 'docs\evidence\install.txt')
$log
