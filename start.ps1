param(
  [switch]$SkipDocker
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step($msg) {
  Write-Host "`n>> $msg" -ForegroundColor Cyan
}

# --- OSRM (Docker) ---
if (-not $SkipDocker) {
  Write-Step "Starting OSRM routing engine..."
  $running = docker ps --filter "publish=5000" --format "{{.ID}}"
  
  if ($running) {
    Write-Host "   OSRM already running (container $running)" -ForegroundColor Yellow
  } else {
    $dataPath = "$root\backend\osrm-data"
    docker run -d -p 5000:5000 -v "${dataPath}:/data" osrm/osrm-backend osrm-routed --algorithm mld /data/bangladesh-latest.osrm
    Write-Host "   OSRM started." -ForegroundColor Green
  }
} else {
  Write-Host "   Skipping Docker (--SkipDocker flag set)" -ForegroundColor Yellow
}

Write-Host "`n✓ OSRM check complete." -ForegroundColor Green
Write-Host "  OSRM     : http://localhost:5000" -ForegroundColor White
Write-Host "  API Docs : http://localhost:8000/docs" -ForegroundColor White
Write-Host "  Frontend : http://localhost:5173" -ForegroundColor White

# --- Backend & Frontend (Combined inside VS Code) ---
Write-Step "Starting FastAPI & Vite in this terminal (Press Ctrl+C to stop both)..."

# We use npx to run concurrently. It runs commands in standard command prompt (cmd), 
# so we use standard 'cd folder && command' syntax inside the quotes.
npx --yes concurrently -c "blue.bold,green.bold" -n "BACKEND,FRONTEND" `
  "cd backend && .\venv\Scripts\python.exe -m uvicorn main:app --reload" `
  "cd frontend && npm run dev"