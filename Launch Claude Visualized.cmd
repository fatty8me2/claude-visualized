@echo off
rem Starts Claude Visualized: the installed app if present, otherwise the latest local build.
set "APP=%LOCALAPPDATA%\Programs\Claude Visualized\Claude Visualized.exe"
if exist "%APP%" (
  start "" "%APP%"
  exit /b
)
set "BUILD="
for /d %%D in ("%~dp0release\*") do if exist "%%D\win-unpacked\Claude Visualized.exe" set "BUILD=%%D\win-unpacked\Claude Visualized.exe"
if defined BUILD (
  start "" "%BUILD%"
  exit /b
)
echo Claude Visualized is not installed or built yet.
echo Build it with:  npm install  then  npm run dist:win
echo then run the installer in the release folder.
pause
