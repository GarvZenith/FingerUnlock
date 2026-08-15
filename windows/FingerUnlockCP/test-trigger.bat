@echo off
REM Phase 1b test: locks the workstation, then fires the unlock signal after 10s.
REM The credential provider's watcher should see the flag and auto-unlock — no click.
REM (This cmd keeps running while locked, which is how the flag gets written.)
echo Locking now... auto-unlock should fire in ~10 seconds.
timeout /t 2 >nul
rundll32.exe user32.dll,LockWorkStation
timeout /t 10 >nul
echo unlock > C:\FingerUnlock\unlock.flag
