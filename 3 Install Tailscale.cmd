@echo off
title DLKM BizPulse - 3 Install Tailscale
echo Ini-install ang Tailscale (pindutin ang YES kapag nagtanong ang Windows)...
winget install -e --id Tailscale.Tailscale --accept-source-agreements --accept-package-agreements
echo.
echo Mag-sign in sa Tailscale sa browser na bubukas...
"C:\Program Files\Tailscale\tailscale.exe" up
echo.
pause
