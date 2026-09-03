param([switch]$Force)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:WORKSPACE_DATA_ROOT = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'data\auth') | Out-Null
Write-Output '为 workspace 初始化三级账号。密码不会回显，也不会写入 .env.local。'
function Convert-Secure([Security.SecureString]$value) { $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($value); try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) } }
$admin = Convert-Secure (Read-Host '管理员 admin 密码（至少 10 位）' -AsSecureString)
$workspace = Convert-Secure (Read-Host '工作台账号 workspace 密码（至少 10 位）' -AsSecureString)
$operator = Convert-Secure (Read-Host '运营账号 operator 密码（至少 10 位）' -AsSecureString)
$env:WORKSPACE_ADMIN_PASSWORD = $admin
$env:WORKSPACE_WORKSPACE_PASSWORD = $workspace
$env:WORKSPACE_OPERATOR_PASSWORD = $operator
$forceArg = if ($Force) { '--force' } else { '' }
try { node .\scripts\bootstrap-auth.mjs $forceArg; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
finally { Remove-Item Env:WORKSPACE_ADMIN_PASSWORD,Env:WORKSPACE_WORKSPACE_PASSWORD,Env:WORKSPACE_OPERATOR_PASSWORD -ErrorAction SilentlyContinue }
Write-Output '三级账号已写入 D:\all_projects\workspace\data\auth，密码只保存为哈希。'
