@echo off
rem Starts the app on Windows. On the first run it creates .venv and installs the libraries.
setlocal
pushd "%~dp0"

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY goto :no_python
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if errorlevel 1 goto :no_python

if exist ".venv\Scripts\python.exe" goto :install
echo Vytvarim virtualni prostredi .venv ...
%PY% -m venv .venv
if errorlevel 1 goto :error

:install
set "VPY=.venv\Scripts\python.exe"
fc /b requirements.txt .venv\requirements.installed >nul 2>nul
if not errorlevel 1 goto :start
echo Instaluji knihovny - poprve to trva nekolik minut ...
"%VPY%" -m pip install --upgrade pip >nul
"%VPY%" -m pip install -r requirements.txt
if errorlevel 1 goto :error
copy /y requirements.txt .venv\requirements.installed >nul

:start
"%VPY%" app.py %*
if errorlevel 1 pause
exit /b

:no_python
echo Je potreba Python 3.11 nebo novejsi: https://www.python.org/downloads/
echo Pri instalaci zaskrtni volbu "Add python.exe to PATH".
pause
exit /b 1

:error
echo Neco se nepovedlo - viz hlaseni vyse.
pause
exit /b 1
