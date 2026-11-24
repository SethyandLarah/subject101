@echo off
title DLKM BizPulse (online) - huwag isara
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22 or newer is required. & pause & exit /b 1)
if not exist "data\store.sqlite" (echo Wala pang store. I-run muna ang "1 Go Live.cmd". & pause & exit /b 1)
echo DLKM BizPulse is running. HUWAG isara ang window na ito.
node server.mjs --online
pause
