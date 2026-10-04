@echo off
rem ============================================================================
rem  Ideas -- the double-clickable launcher for the idea board in ideas\.
rem
rem  There is no install step and no packaging: the board borrows the Electron
rem  that town\ already downloaded, so a fresh clone needs `npm install` in
rem  town\ and nothing else.
rem
rem  Every path is derived from %~dp0 (this file's own folder), so the launcher
rem  works from any working directory, from a shortcut, or from the Run box.
rem
rem  No arguments  -> detached launch; this console closes immediately.
rem  With arguments -> stays attached and passes them through, so the offscreen
rem                    verification run (--shot=... --shot-delay=...) can be
rem                    scripted and its exit code read.
rem ============================================================================
setlocal

set "ROOT=%~dp0"
rem The app is launched by its main FILE, not its folder: electron resolves a
rem folder argument the way require() does, so "%ROOT%ideas" would find the
rem board's data file ideas.json first and try to run that.
set "APP=%ROOT%ideas\src\main.js"
set "ELECTRON=%ROOT%town\node_modules\electron\dist\electron.exe"

if not exist "%APP%" goto :noapp
if not exist "%ELECTRON%" goto :noelectron

rem Run from the repo root: ideas.json lives there, and anything that resolves
rem it relative to the process should land on the same file the agents use.
pushd "%ROOT%"

if not "%~1"=="" goto :foreground

rem Double-clicked. `start` (deliberately without /b) hands the app its own
rem process; electron.exe is a GUI-subsystem binary, so it never inherits or
rem needs this console, which dies with the batch file a moment later.
start "Ideas" "%ELECTRON%" "%APP%"
popd
endlocal
exit /b 0

:foreground
"%ELECTRON%" "%APP%" %*
set "CODE=%ERRORLEVEL%"
popd
endlocal & exit /b %CODE%

:noapp
echo.
echo   Ideas can't find its app files.
echo.
echo   Expected to find:
echo       %APP%
echo.
echo   This launcher has to sit in the repo root, next to the ideas\ folder.
echo.
goto :fail

:noelectron
echo.
echo   Ideas needs Electron, and it isn't installed yet.
echo.
echo   Ideas doesn't ship its own copy -- it borrows the one Token Town uses.
echo   Run this once, then double-click Ideas again:
echo.
echo       cd /d "%ROOT%town"
echo       npm install
echo.
echo   (Looked for it at %ELECTRON%)
echo.
goto :fail

:fail
rem A double-clicked failure needs the window to stay up long enough to read;
rem a scripted one must not hang.
if "%~1"=="" pause
endlocal
exit /b 1
