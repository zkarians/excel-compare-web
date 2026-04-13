@echo off
chcp 65001 > nul
TITLE Excel Data Comparison Tool
echo Starting Excel Data Comparison App...
cd /d "%~dp0"
npm start
pause
