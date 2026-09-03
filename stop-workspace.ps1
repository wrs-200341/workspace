$ErrorActionPreference = 'SilentlyContinue'
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
  if ($process.CommandLine -like '*D:\all_projects\workspace*') { Stop-Process -Id $_.OwningProcess -Force }
}
