$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$matches = rg -n -i --hidden -g '!node_modules/**' -g '!.next/**' -g '*.log' -g '!check-storage.ps1' 'C:\\Users\\EDY\\3000-cinema-clone|C:\\Users\\EDY\\design-system|C:\\Users\\EDY\\Desktop\\' .
if ($LASTEXITCODE -eq 0 -and $matches) { Write-Error "Found forbidden legacy path references:`n$matches" }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'data'))
if (-not $root.ToLower().StartsWith('d:\all_projects\workspace\')) { Write-Error "Data root escaped D:\all_projects\workspace: $root" }
Write-Output "OK: project=$PSScriptRoot"
Write-Output "OK: data=$root"
