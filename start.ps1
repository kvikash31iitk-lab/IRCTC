$Background = $false
$OpenBrowser = $false

foreach ($arg in $args) {
    if ($arg -eq "-Background") {
        $Background = $true
    }
    if ($arg -eq "-OpenBrowser") {
        $OpenBrowser = $true
    }
}

$pythonCandidates = @(
    "C:\Program Files\WindowsApps\PythonSoftwareFoundation.PythonManager_26.0.240.0_x64__3847v3x7pw1km\python.exe",
    "python",
    "py"
)

$pythonCommand = $null

foreach ($candidate in $pythonCandidates) {
    if ($candidate -like "*\python.exe") {
        if (Test-Path $candidate) {
            $pythonCommand = "& '$candidate'"
            break
        }
        continue
    }

    $resolved = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($resolved) {
        if ($candidate -eq "py") {
            $pythonCommand = "py"
        } else {
            $pythonCommand = "python"
        }
        break
    }
}

if (-not $pythonCommand) {
    Write-Host "Python was not found. Install Python or update start.ps1 with the correct path." -ForegroundColor Red
    exit 1
}

if ($Background) {
    $launchCommand = "$pythonCommand .\app.py"
    Start-Process powershell -ArgumentList @(
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "Set-Location '$PSScriptRoot'; $launchCommand"
    )

    if ($OpenBrowser) {
        Start-Sleep -Seconds 3
        Start-Process "http://127.0.0.1:5000"
    }

    Write-Host "IRCTC Helper started in the background." -ForegroundColor Green
    exit 0
}

Write-Host "Starting IRCTC Helper..." -ForegroundColor Cyan
Invoke-Expression "$pythonCommand .\app.py"
