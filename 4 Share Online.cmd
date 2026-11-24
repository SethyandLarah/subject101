@echo off
title DLKM BizPulse - 4 Ilabas sa internet
"C:\Program Files\Tailscale\tailscale.exe" funnel --bg 8787
echo.
"C:\Program Files\Tailscale\tailscale.exe" funnel status
echo.
pause
