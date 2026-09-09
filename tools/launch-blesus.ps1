# Launcher for Blesus dev build. Ensures the Vite dev server is running,
# then starts the debug binary detached. Safe to run while Vite / the app
# are already up — it skips the steps that are already done.
#
# Resolves all paths relative to the repo root (the parent of `tools/`).

$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$bin  = Join-Path $root "src-tauri\target\debug\Blesus.exe"
$wd   = Join-Path $root "src-tauri"

function Test-Vite {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:1420" -TimeoutSec 1 -ErrorAction Stop
        return $r.StatusCode -eq 200
    } catch { return $false }
}

if (-not (Test-Vite)) {
    Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c","npm run dev" `
        -WorkingDirectory $root `
        -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if (Test-Vite) { break }
        Start-Sleep -Seconds 1
    }
}

$already = Get-Process -Name "Blesus" -ErrorAction SilentlyContinue
if (-not $already) {
    Start-Process -FilePath $bin `
        -WorkingDirectory $wd `
        -NoNewWindow
}
