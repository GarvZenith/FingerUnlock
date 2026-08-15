# Phase 2b test client (HTTP) — stands in for the phone.
# Locks the screen, waits, then POSTs /unlock to the running service.
# Set $Token to match C:\FingerUnlock\service.ini, run while the service is up.

$Ip    = "127.0.0.1"
$Port  = 5599
$Token = "change-this-to-a-long-random-secret"   # <-- must match service.ini

Write-Host "Locking screen; unlock request fires in ~8s..."
Start-Sleep -Seconds 2
rundll32.exe user32.dll,LockWorkStation
Start-Sleep -Seconds 8

try {
    $r = Invoke-WebRequest -Uri "http://${Ip}:${Port}/unlock" -Method POST `
         -Headers @{ "X-Token" = $Token } -UseBasicParsing
    Write-Host "Response:" $r.StatusCode $r.Content
} catch {
    Write-Host "Request failed:" $_.Exception.Message
}
