<#
.SYNOPSIS
  Manual execution wrapper for CICOD & 1Gov Daily Health Monitor.
#>
param(
  [string]$Target = "all",
  [switch]$NoAI,
  [switch]$Notify,
  [switch]$Headed
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$ArgsList = @("src/runner.js", "--target=$Target")
if ($NoAI) { $ArgsList += "--no-ai" }
if ($Notify) { $ArgsList += "--notify" }
if ($Headed) { $ArgsList += "--headed" }

Write-Host "Executing Health Monitor ($Target)..." -ForegroundColor Cyan
& node @ArgsList

Write-Host "`nCheck completed. Report generated at reports\latest\index.html" -ForegroundColor Green

