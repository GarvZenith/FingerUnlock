# FingerUnlock uninstaller — RUN AS ADMINISTRATOR.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'SilentlyContinue'

$dst   = 'C:\FingerUnlock'
$clsid = '{2B5B8F1A-9C3D-4E7A-B12C-3D4E5F607182}'

Unregister-ScheduledTask -TaskName 'FingerUnlock' -Confirm:$false
Get-Process FingerUnlockSvc | Stop-Process -Force

Remove-Item "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\$clsid" -Recurse -Force
Remove-Item "HKLM:\SOFTWARE\Classes\CLSID\$clsid" -Recurse -Force
netsh advfirewall firewall delete rule name="FingerUnlock" | Out-Null

Write-Host "Removed: startup task, credential-provider registration, firewall rule."
Write-Host "Files remain in $dst (service.ini has your token). Delete manually if desired."
Write-Host "Reboot to fully unload the credential provider from the logon screen."
