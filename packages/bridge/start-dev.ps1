#!/usr/bin/env pwsh
# Start the full development stack: bridge server + headed Chromium with extension.
#
# Usage:
#   .\packages\bridge\start-dev.ps1           # start both
#   .\packages\bridge\start-dev.ps1 --stop    # kill both
#
# Logs:
#   $env:TEMP\cr-bridge.log          # bridge server output
#   $env:TEMP\cr-browser.log         # browser launcher output

param(
    [switch]$Stop
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$BridgeLog  = "$env:TEMP\cr-bridge.log"
$BrowserLog = "$env:TEMP\cr-browser.log"

function Stop-DevStack {
    Write-Host "[dev] Stopping bridge + browser..."

    # Kill node processes running our specific scripts
    $targets = @('server.mjs', 'launch-browser.mjs')
    foreach ($target in $targets) {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
            Where-Object { $_.CommandLine -match [regex]::Escape($target) } |
            ForEach-Object {
                Write-Host "[dev] Killing PID $($_.ProcessId) ($target)"
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
    }

    Write-Host "[dev] Stopped."
}

if ($Stop) {
    Stop-DevStack
    exit 0
}

# --- Stop anything already running ---
Stop-DevStack

Set-Location $Root

# --- Start bridge server ---
Write-Host "[dev] Starting bridge server..."
$BridgeErrLog = "$env:TEMP\cr-bridge-err.log"
$bridgeProc = Start-Process `
    -FilePath "node" `
    -ArgumentList "packages/bridge/server.mjs" `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $BridgeLog `
    -RedirectStandardError  $BridgeErrLog `
    -WindowStyle Hidden `
    -PassThru

Write-Host "[dev] Bridge PID: $($bridgeProc.Id)  (log: $BridgeLog)"

# --- Wait for port 9876 ---
Write-Host "[dev] Waiting for bridge on port 9876..."
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $conn = Get-NetTCPConnection -LocalPort 9876 -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $ready = $true
        Write-Host "[dev] Bridge server ready on port 9876"
        break
    }
}

if (-not $ready) {
    Write-Host "[dev] Bridge did not start in time. Last log output:"
    Get-Content $BridgeLog -Tail 20 -ErrorAction SilentlyContinue
    exit 1
}

# --- Launch browser (headed) in a new visible window ---
# A new PowerShell window keeps the node process alive and shows output.
Write-Host "[dev] Launching headed Chromium with extension..."
$browserProc = Start-Process `
    -FilePath "powershell" `
    -ArgumentList "-NoProfile", "-Command",
        "Set-Location '$Root'; node packages/bridge/launch-browser.mjs 2>&1 | Tee-Object -FilePath '$BrowserLog'; Write-Host '[browser] exited'; Read-Host 'Press Enter to close'" `
    -WindowStyle Normal `
    -PassThru

Write-Host "[dev] Browser PID: $($browserProc.Id)  (log: $BrowserLog)"
Write-Host ""
Write-Host "[dev] Stack is running."
Write-Host "[dev]   Bridge log : $BridgeLog"
Write-Host "[dev]   Browser log: $BrowserLog"
Write-Host "[dev]   Stop with  : .\packages\bridge\start-dev.ps1 --stop"
