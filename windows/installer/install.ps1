# FingerUnlock installer — RUN AS ADMINISTRATOR.
# Copies binaries, registers the credential provider, installs the push service as
# a boot-time LocalSystem Windows service (so it's alive at the cold-boot logon
# screen), generates a token, opens firewall + Tailscale page.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$src   = $PSScriptRoot
$dst   = 'C:\FingerUnlock'
$clsid = '{2B5B8F1A-9C3D-4E7A-B12C-3D4E5F607182}'
$svc   = 'FingerUnlockSvc'

Write-Host "Installing FingerUnlock to $dst ..."
New-Item -ItemType Directory -Force -Path $dst | Out-Null

# 0) Stop anything from a previous install so we can overwrite the exe
if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
  Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
  sc.exe delete $svc | Out-Null
  Start-Sleep -Seconds 1
}
Unregister-ScheduledTask -TaskName 'FingerUnlock' -Confirm:$false -ErrorAction SilentlyContinue   # legacy per-user task
Get-Process FingerUnlockSvc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 1) Binaries
Copy-Item "$src\FingerUnlockCP.dll"  "$dst\" -Force
Copy-Item "$src\FingerUnlockSvc.exe" "$dst\" -Force

# 2) Register the credential provider (machine-wide)
$clsPath  = "HKLM:\SOFTWARE\Classes\CLSID\$clsid"
$inproc   = "$clsPath\InprocServer32"
$provPath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\$clsid"
New-Item -Path $clsPath -Force | Out-Null
Set-ItemProperty -Path $clsPath -Name '(default)' -Value 'FingerUnlock Credential Provider'
New-Item -Path $inproc -Force | Out-Null
Set-ItemProperty -Path $inproc -Name '(default)' -Value "$dst\FingerUnlockCP.dll"
Set-ItemProperty -Path $inproc -Name 'ThreadingModel' -Value 'Apartment'
New-Item -Path $provPath -Force | Out-Null
Set-ItemProperty -Path $provPath -Name '(default)' -Value 'FingerUnlock Credential Provider'

# 3) Config + token (preserve an existing token on re-install)
$ini = "$dst\service.ini"
if (-not (Test-Path $ini)) {
  $tok = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
  Set-Content -Path $ini -Value @('port=5599', "token=$tok", 'pushtoken=')
}
$token = ((Get-Content $ini | Where-Object { $_ -like 'token=*' }) -replace '^token=','').Trim()

# 4) Firewall
netsh advfirewall firewall delete rule name="FingerUnlock" 2>$null | Out-Null
netsh advfirewall firewall add rule name="FingerUnlock" dir=in action=allow protocol=TCP localport=5599 | Out-Null

# 5) Boot-SYSTEM Windows service (runs in session 0, before anyone logs in ->
#    cold-boot unlock; lock/logon/logoff detected via WTS session notifications)
New-Service -Name $svc -BinaryPathName "`"$dst\FingerUnlockSvc.exe`" --service" `
            -DisplayName 'FingerUnlock' -StartupType Automatic | Out-Null
Start-Service -Name $svc

# 6) Pairing info + Tailscale
Write-Host ""
Write-Host "==================== FingerUnlock installed ===================="
Write-Host "Pair the phone app with:"
Write-Host "  Token : $token"
Write-Host "  IP    : (this PC)"
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' }).IPAddress | ForEach-Object { Write-Host "          $_" }
Write-Host ""
Write-Host "For unlock over the internet: install Tailscale on this PC AND your phone."
Start-Process 'https://tailscale.com/download/windows'
Write-Host "Test: lock with Win+L, and (for cold boot) reboot and unlock from the phone."
Write-Host "To remove: run uninstall.ps1 as admin."
