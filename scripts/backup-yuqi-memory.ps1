$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot 'yuqi-runtime\config.json'
& (Get-Command node).Source (Join-Path $projectRoot 'scripts\backup-yuqi-memory.mjs') $configPath
