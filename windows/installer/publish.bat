@echo off
REM ============================================================================
REM  Build the distributable into windows\installer\dist\
REM  RUN FROM: "x64 Native Tools Command Prompt for VS 2022" (needs cl.exe + dotnet)
REM ============================================================================
setlocal
set HERE=%~dp0
set WIN=%HERE%..
set OUT=%HERE%dist
if not exist "%OUT%" mkdir "%OUT%"

echo === Credential provider DLL ===
pushd "%WIN%\FingerUnlockCP"
call build.bat || (echo CP build FAILED & popd & exit /b 1)
copy /Y FingerUnlockCP.dll "%OUT%\" >nul
popd

echo === Service EXE (self-contained, single file, no .NET needed on target) ===
pushd "%WIN%\FingerUnlockSvc"
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "%HERE%_svcpub" || (echo publish FAILED & popd & exit /b 1)
copy /Y "%HERE%_svcpub\FingerUnlockSvc.exe" "%OUT%\" >nul
popd
rmdir /s /q "%HERE%_svcpub"

copy /Y "%HERE%install.ps1"    "%OUT%\" >nul
copy /Y "%HERE%uninstall.ps1"  "%OUT%\" >nul
copy /Y "%HERE%run-hidden.vbs" "%OUT%\" >nul

echo.
echo  DONE -^> %OUT%
echo  Zip the dist\ folder and attach it to a GitHub Release.
echo  Users: right-click install.ps1 -^> Run with PowerShell (as admin).
endlocal
