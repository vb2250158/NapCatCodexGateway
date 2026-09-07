@echo off
setlocal
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-RabiRouteFromSource.ps1"
set "result=%errorlevel%"
popd
if not "%result%"=="0" (
  echo RabiRoute source startup failed. See the error above and logs\source-start.
  pause
)
exit /b %result%
