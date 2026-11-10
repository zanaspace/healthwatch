param(
  [string]$TaskName = "CicodHealthMonitorAgent",
  [string]$Target = "all",
  [string]$DailyAt = "08:00",
  [int]$RepeatMinutes = 0,
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName' (if it existed)."
  exit 0
}

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $ProjectRoot "reports"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "scheduled_run.log"

$NodeExe = (Get-Command node -ErrorAction Stop).Source
$InnerCommand = "Set-Location '$ProjectRoot'; & '$NodeExe' 'src\runner.js' --target=$Target --notify *> '$LogFile'"
$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -Command `"$InnerCommand`"" `
  -WorkingDirectory $ProjectRoot

if ($RepeatMinutes -gt 0) {
  $Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $RepeatMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  $ScheduleDesc = "every $RepeatMinutes minute(s)"
} else {
  $Trigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
  $ScheduleDesc = "daily at $DailyAt"
}

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

$Principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description "Autonomous AI QA & Health Monitor Agent for staging targets ($Target)." `
  -Force | Out-Null

Write-Host "Registered Windows Scheduled Task '$TaskName' ($ScheduleDesc)."
Write-Host "Target: $Target | Log: $LogFile"
Write-Host "Test immediately with: Start-ScheduledTask -TaskName '$TaskName'"

