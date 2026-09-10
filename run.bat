@echo off
REM run.bat
REM ======
REM Windows wrapper around run.py so users can launch the game by
REM double-clicking this file in Explorer. Forwards any extra args.
REM
REM Usage:
REM   run.bat
REM   run.bat --port 8080 --difficulty hard

setlocal

REM Resolve the directory this script lives in.
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

REM Pick a Python interpreter. Prefer `py` (Windows Python launcher),
REM fall back to `python`.
where py >nul 2>nul
if %errorlevel%==0 (
    set "PY=py"
) else (
    where python >nul 2>nul
    if %errorlevel%==0 (
        set "PY=python"
    ) else (
        echo Error: Python is not installed or not on PATH.
        echo Please install Python 3.9+ from https://www.python.org/downloads/
        exit /b 1
    )
)

REM Forward all arguments to run.py.
%PY% "%SCRIPT_DIR%run.py" %*

endlocal