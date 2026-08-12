@echo off
set NODE_NO_WARNINGS=1

rem Safe Mode: bootstrap.bat --safe-mode -> nonaktifkan startup scripts (rc.local)
set SAFE_MODE=
if "%1"=="--safe-mode" set SAFE_MODE=--safe-mode

:loop
echo.
echo ========================================
echo   TSIX Bootstrap - Starting System
if defined SAFE_MODE echo   SAFE MODE (startup scripts disabled)
echo ========================================
echo.

node -r esbuild-register -r tsconfig-paths/register --max-old-space-size=8192 src/main.ts %SAFE_MODE%
set EXIT_CODE=%ERRORLEVEL%

if %EXIT_CODE% EQU 0 (
    echo.
    echo ========================================
    echo   System halted.
    echo ========================================
    goto end
)

if %EXIT_CODE% EQU 1 (
    echo.
    echo ========================================
    echo   System is rebooting...
    echo ========================================
    timeout /t 2 /nobreak >nul
    goto loop
)

echo.
echo ========================================
echo   Unexpected error: %EXIT_CODE%
echo ========================================

:end
