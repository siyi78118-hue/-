$ErrorActionPreference = 'Stop'
function Quote-ProcessArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot 'yuqi-runtime\config.json'
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$healthUrl = "http://127.0.0.1:$($config.port)/v1/health"

try {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
  if ($health.ok) { Write-Output 'Yuqi runtime is already running.'; exit 0 }
} catch {}

if (Test-Path -LiteralPath $config.databasePath) {
  & (Get-Command node).Source (Join-Path $projectRoot 'scripts\backup-yuqi-memory.mjs') $configPath | Out-Null
}

$vaultRoot = Split-Path -Parent (Split-Path -Parent $config.databasePath)
$logsDir = Join-Path $vaultRoot 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$stdoutPath = Join-Path $logsDir 'yuqi-runtime.stdout.log'
$stderrPath = Join-Path $logsDir 'yuqi-runtime.stderr.log'
$mainArgument = Quote-ProcessArgument (Join-Path $projectRoot 'yuqi-runtime\src\main.mjs')
$configArgument = Quote-ProcessArgument $configPath
$process = Start-Process -FilePath (Get-Command node).Source `
  -ArgumentList @($mainArgument, $configArgument) `
  -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
Set-Content -LiteralPath (Join-Path $vaultRoot 'yuqi-runtime.pid') -Value $process.Id -Encoding ASCII

for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($health.ok) { Write-Output "Yuqi runtime started. PID=$($process.Id)"; exit 0 }
  } catch {}
  if ($process.HasExited) { throw "Yuqi runtime exited early. See $stderrPath" }
}
throw 'Yuqi runtime did not become healthy within 15 seconds.'
