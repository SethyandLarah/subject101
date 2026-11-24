@echo off
title JS ALAAN HARDWARE (demo)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22 or newer is required. Download it from https://nodejs.org & pause & exit /b 1)
start "" http://localhost:8787
node server.mjs --demo
pause
