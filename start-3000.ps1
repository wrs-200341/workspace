param([switch]$Production)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:WORKSPACE_DATA_ROOT = Join-Path $PSScriptRoot 'data'
$env:DATABASE_URL = 'file:' + ((Join-Path $PSScriptRoot 'data\workspace.db') -replace '\\','/')
$env:npm_config_cache = 'D:\all_projects\.npm-cache'
$env:NEXT_TELEMETRY_DISABLED = '1'
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'data'),(Join-Path $PSScriptRoot 'logs') | Out-Null
if ($Production) { npm run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run start }
else { npm run dev }
