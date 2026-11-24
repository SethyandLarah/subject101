@echo off
title DLKM BizPulse - 1 Go live
cd /d "%~dp0"
echo.
if exist "data\store.sqlite" (
  echo  ================================================================
  echo   BABALA: MAY STORE NA. MABUBURA ANG LAHAT NG BENTA, STOCK,
  echo   ATTENDANCE AT STAFF kapag itinuloy mo ito. Isara ang window na ito
  echo   kung hindi mo talaga gustong burahin. ^(May backup sa data\backups.^)
  echo  ================================================================
  echo.
)
echo Gagawin nitong ZERO ang data at Admin lang ang matitira.
echo Ilagay ang BAGONG Admin password (8+ letra), ulitin, tapos i-type ang RESET.
echo.
call npm.cmd run go-live
echo.
pause
