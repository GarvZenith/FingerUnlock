@echo off
REM ============================================================================
REM  Build FingerUnlockCP.dll
REM  Run this from an "x64 Native Tools Command Prompt for VS" (so cl.exe and the
REM  Windows SDK are on PATH). Produces a 64-bit COM DLL.
REM ============================================================================
setlocal
cl /nologo /LD /EHsc /W3 /DUNICODE /D_UNICODE ^
   dll.cpp helpers.cpp CFingerUnlockProvider.cpp CFingerUnlockCredential.cpp ^
   /link /DEF:FingerUnlockCP.def ^
   ole32.lib shlwapi.lib secur32.lib advapi32.lib user32.lib ^
   /OUT:FingerUnlockCP.dll

if %ERRORLEVEL%==0 (
    echo.
    echo  BUILD OK  -^>  FingerUnlockCP.dll
) else (
    echo.
    echo  BUILD FAILED  (errorlevel %ERRORLEVEL%^)
)
endlocal
