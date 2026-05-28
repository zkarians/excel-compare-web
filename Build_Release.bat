@echo off
title ExcelCompare Build Tool

echo.
echo ============================================
echo   ExcelCompare - Build Release Tool
echo ============================================
echo.

:: dist 폴더 초기화 여부 확인
set /p CLEAN="Clean dist folder before build? (Y/N): "
if /I "%CLEAN%"=="Y" (
    echo.
    echo [1/4] Removing existing dist folder...
    if exist "dist" (
        rmdir /s /q "dist"
        echo       Done.
    ) else (
        echo       dist folder not found. Skipping.
    )
) else (
    echo.
    echo [1/4] Keeping existing dist folder.
)

echo.
echo [2/4] Checking node_modules...
if not exist "node_modules" (
    echo       node_modules not found - Running npm install...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo.
        echo ERROR: npm install failed. Aborting.
        pause
        exit /b 1
    )
    echo       npm install complete.
) else (
    echo       node_modules OK.
)

echo.
echo [3/4] Building... (this may take a few minutes)
echo       - NSIS Installer
echo       - Portable EXE
echo.

call npm run build

if %ERRORLEVEL% neq 0 (
    echo.
    echo ============================================
    echo   BUILD FAILED. Check errors above.
    echo ============================================
    pause
    exit /b 1
)

echo.
echo [4/4] Checking output files in dist folder...
echo.
echo ============================================
echo   BUILD SUCCEEDED!
echo ============================================
echo.
echo Generated files:
echo --------------------------------------------
dir /b "dist\*.exe" 2>nul
echo --------------------------------------------
echo.
echo Opening dist folder...
explorer "dist"
echo.
pause
