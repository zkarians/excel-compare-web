@echo off
title Excel Compare Loader
echo [0/2] Cleaning up previous server...
powershell -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue).OwningProcess -ErrorAction SilentlyContinue"
echo [1/2] Local Server starting...
start /min node server.js
timeout /t 2 >nul
echo [2/2] Electron App starting...
npm start
exit
