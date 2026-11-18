@echo off
setlocal
set "helper_dir=%LOCALAPPDATA%\PacketTracerHelper"
set "helper_exe=%helper_dir%\PacketTracerHelper.exe"
set "helper_csc=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%helper_csc%" set "helper_csc=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"

if /i "%~1"=="--rebuild" goto compile
if exist "%helper_exe%" goto run

:compile
if not exist "%helper_dir%" mkdir "%helper_dir%"
"%helper_csc%" /nologo /target:winexe /optimize+ /out:"%helper_exe%" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "%~dp0app\Tray.cs"
if errorlevel 1 (
    echo Could not build Packet Tracer Helper.
    pause
    exit /b 1
)

:run
start "" "%helper_exe%" "%~dp0helper.mjs"
