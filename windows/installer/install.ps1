# FingerUnlock installer — RUN AS ADMINISTRATOR.
# Copies binaries, registers the credential provider, auto-starts the service at
# logon (hidden, elevated), generates a token, opens firewall + Tailscale page.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$src   = $PSScriptRoot
$dst   = 'C:\FingerUnlock'
$clsid = '{2B5B8F1A-9C3D-4E7A-B12C-3D4E5F607182}'

Write-Host "Installing FingerUnlock to $dst ..."
New-Item -ItemType Directory -Force -Path $dst | Out-Null

# 1) Binaries
Copy-Item "$src\FingerUnlockCP.dll"  "$dst\" -Force
Copy-Item "$src\FingerUnlockSvc.exe" "$dst\" -Force
Copy-Item "$src\run-hidden.vbs"      "$dst\" -Force

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

# 5) Auto-start at logon (hidden window, highest privileges, in the user session)
$action    = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$dst\run-hidden.vbs`""
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Highest -LogonType Interactive
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'FingerUnlock' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'FingerUnlock'

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
Write-Host "Lock with Win+L to test. To remove: run uninstall.ps1 as admin."
