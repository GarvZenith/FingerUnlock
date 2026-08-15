# Phase 2a test client (stands in for the Android app).
# Locks the screen, waits, then sends an UNLOCK request to the running service.
# The service writes the flag -> the credential provider auto-unlocks.
#
# Usage: set $Token to match C:\FingerUnlock\service.ini, then run this while the
# service (dotnet run) is running in another window.

$Host_ = "127.0.0.1"
$Port  = 5599
$Token = "change-this-to-a-long-random-secret"   # <-- must match service.ini

Write-Host "Locking screen; unlock request will fire in ~8s..."
Start-Sleep -Seconds 2
rundll32.exe user32.dll,LockWorkStation
Start-Sleep -Seconds 8

$client = New-Object System.Net.Sockets.TcpClient($Host_, $Port)
$stream = $client.GetStream()
$bytes  = [System.Text.Encoding]::UTF8.GetBytes("UNLOCK $Token")
$stream.Write($bytes, 0, $bytes.Length)
$stream.Flush()
Start-Sleep -Milliseconds 300
$client.Close()
