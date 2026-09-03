param(
  [int]$WaitMinutes = 60,
  [int]$PollSeconds = 10
)

$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\all_projects\workspace'
$taskFile = Join-Path $root 'data\providers\tasks.json'
$monitorDir = Join-Path $root 'data\monitor'
$stateFile = Join-Path $monitorDir 'latest-video-task.json'
$logFile = Join-Path $monitorDir 'latest-video-task.log'
New-Item -ItemType Directory -Force -Path $monitorDir | Out-Null

function Write-State([hashtable]$state) {
  $state.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  $state | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $stateFile -Encoding utf8
  ($state | ConvertTo-Json -Compress -Depth 12) | Add-Content -LiteralPath $logFile -Encoding utf8
}

function Read-Tasks {
  try { return @((Get-Content -LiteralPath $taskFile -Raw | ConvertFrom-Json)) } catch { return @() }
}

$baseline = @(Read-Tasks | ForEach-Object { $_.id })
Write-State @{ status = 'waiting'; baselineCount = $baseline.Count; taskId = $null; providerTaskId = $null; progress = 0; error = $null }
$deadline = (Get-Date).AddMinutes($WaitMinutes)
$found = $null
while ((Get-Date) -lt $deadline -and -not $found) {
  Start-Sleep -Seconds $PollSeconds
  $found = @(Read-Tasks | Where-Object { $_.id -and ($baseline -notcontains $_.id) -and $_.mode -eq 'video' } | Sort-Object createdAt -Descending | Select-Object -First 1)
  if ($found -is [array]) { $found = $found | Select-Object -First 1 }
}

if (-not $found) {
  Write-State @{ status = 'timeout'; baselineCount = $baseline.Count; taskId = $null; providerTaskId = $null; progress = 0; error = 'no_new_video_task' }
  exit 0
}

$accountId = [string]$found.accountId
$taskId = [string]$found.id
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loginBody = @{ username = 'admin'; password = 'wrs18398960402' } | ConvertTo-Json
try { Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/auth/login' -Method Post -ContentType 'application/json' -Body $loginBody -WebSession $session -UseBasicParsing | Out-Null } catch { }

Write-State @{ status = [string]$found.status; baselineCount = $baseline.Count; taskId = $taskId; providerTaskId = [string]$found.providerTaskId; provider = [string]$found.provider; model = [string]$found.model; progress = [int]$found.progress; error = $null }
for ($i = 1; $i -le 360; $i++) {
  try {
    $response = Invoke-WebRequest -Uri ("http://127.0.0.1:3000/api/workspace/accounts/{0}/video-tasks/{1}" -f $accountId, $taskId) -Method Get -WebSession $session -UseBasicParsing -TimeoutSec 30
    $payload = $response.Content | ConvertFrom-Json
    $task = $payload.data
    $state = @{ status = [string]$task.status; attempt = $i; taskId = $taskId; providerTaskId = [string]$task.providerTaskId; provider = [string]$task.provider; model = [string]$task.model; progress = [int]$task.progress; outputCount = @($task.outputUrls).Count; error = if ($task.error) { 'present' } else { $null } }
    Write-State $state
    if ([string]$task.status -in @('completed','failed','cancelled')) { exit 0 }
  } catch {
    Write-State @{ status = 'request_failed'; attempt = $i; taskId = $taskId; providerTaskId = [string]$found.providerTaskId; provider = [string]$found.provider; model = [string]$found.model; progress = 0; error = 'local_status_request_failed' }
  }
  Start-Sleep -Seconds $PollSeconds
}
Write-State @{ status = 'monitor_timeout'; taskId = $taskId; providerTaskId = [string]$found.providerTaskId; provider = [string]$found.provider; model = [string]$found.model; progress = 0; error = 'monitor_timeout' }
