@echo off
:: FingerUnlock 1-Click Double-Click Installer Launcher
:: Auto-elevates to Administrator and executes install.ps1

net session >nul 2>&1
if %errorLevel% == 0 (
    goto :admin
) else (
    echo Requesting Administrator privileges to install FingerUnlock...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:admin
cd /d "%~dp0"
echo ===================================================
echo     FingerUnlock — Windows Setup Installer
echo ===================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
echo Setup completed! Keep this window open to copy your Token and IP.
pause
