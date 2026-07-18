$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'yuqi-runtime\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$vaultRoot = Split-Path -Parent (Split-Path -Parent $config.databasePath)
$pidPath = Join-Path $vaultRoot 'yuqi-runtime.pid'
if (-not (Test-Path -LiteralPath $pidPath)) { Write-Output 'Yuqi runtime is not recorded as running.'; exit 0 }
$runtimePid = [int](Get-Content -LiteralPath $pidPath -Raw)
$process = Get-Process -Id $runtimePid -ErrorAction SilentlyContinue
if ($process) { Stop-Process -Id $runtimePid -Force }
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Write-Output 'Yuqi runtime stopped.'
