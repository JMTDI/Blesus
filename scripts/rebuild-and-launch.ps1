<#
.SYNOPSIS
  Rebuilds the Blesus frontend + Tauri release binary and relaunches it.

.DESCRIPTION
  This is the *only* build command you should run for normal development
  iteration on Blesus. It avoids two foot-guns we've hit before:

  1. Running `cargo build` directly produces `src-tauri/target/debug/Blesus.exe`
     (unoptimized, ~3× larger) which uses a **separate database** at
     `src-tauri/target/debug/blesus-files/blesus.db`. Launching that binary
     looks like the app has "lost" your mailbox because it's reading from
     a different DB than the release binary you've been using.
  2. Chained `npm run build; npm run tauri build` in PowerShell pipelines
     sometimes terminates the second command early when Vite emits a
     chunk-size warning on stderr.

  This script:
    * Kills any running Blesus.exe so file locks don't block the rebuild.
    * Strips stray `GIT_CONFIG_*` env vars that occasionally appear in
      this workspace and break git.
    * Runs `npm run build` (frontend).
    * Runs `npm run tauri build` (release binary, embeds dist/ correctly).
    * Launches `src-tauri/target/release/Blesus.exe` — the binary that
      ships and that uses the *production* DB next to it.

  Use `-NoLaunch` to rebuild without launching, e.g. before a `git commit`.

.EXAMPLE
  .\scripts\rebuild-and-launch.ps1

.EXAMPLE
  .\scripts\rebuild-and-launch.ps1 -NoLaunch
#>
param(
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Continue'

# Stray GIT_CONFIG_* env vars sometimes break git in this workspace.
foreach ($name in 'GIT_CONFIG_COUNT', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_0') {
  if (Test-Path "env:$name") { Remove-Item "env:$name" -ErrorAction SilentlyContinue }
}

# 1. Stop any running Blesus instance(s) so the .exe can be overwritten.
Write-Host "→ Stopping any running Blesus.exe…" -ForegroundColor Cyan
Get-Process -Name Blesus -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "  killing PID $($_.Id)" -ForegroundColor DarkGray
  Stop-Process -Id $_.Id -Force
}
Start-Sleep -Seconds 2

# 2. Frontend rebuild.
Write-Host "→ npm run build (frontend → dist/)…" -ForegroundColor Cyan
npm run build 2>&1 | Out-Null
if (-not (Test-Path 'dist/index.html')) {
  Write-Host "ERROR: dist/index.html not produced — frontend build failed." -ForegroundColor Red
  exit 1
}
Write-Host "  dist/ updated at $(Get-Item dist/index.html | Select-Object -Expand LastWriteTime)" -ForegroundColor DarkGray

# 3. Tauri release build (NOT `cargo build` — see file header).
Write-Host "→ npm run tauri build (release binary)…" -ForegroundColor Cyan
$buildStart = Get-Date
npm run tauri build 2>&1 | Out-Null
$exe = 'src-tauri/target/release/Blesus.exe'
if (-not (Test-Path $exe)) {
  Write-Host "ERROR: $exe not produced — Tauri build failed." -ForegroundColor Red
  exit 1
}
$exeTime = (Get-Item $exe).LastWriteTime
if ($exeTime -lt $buildStart) {
  Write-Host "WARNING: $exe is older than this build run — re-embed may not have happened." -ForegroundColor Yellow
}
Write-Host "  $exe built at $exeTime" -ForegroundColor DarkGray

# 4. Launch.
if ($NoLaunch) {
  Write-Host "→ -NoLaunch given; not starting the app." -ForegroundColor Cyan
} else {
  Write-Host "→ Launching $exe…" -ForegroundColor Cyan
  Start-Process -FilePath $exe
  Start-Sleep -Seconds 3
  $p = Get-Process -Name Blesus -ErrorAction SilentlyContinue
  if ($p) {
    Write-Host "  running as PID $($p.Id), started $($p.StartTime)" -ForegroundColor Green
  } else {
    Write-Host "WARNING: launched but process not visible after 3 s." -ForegroundColor Yellow
  }
}

Write-Host "`nDone." -ForegroundColor Green
