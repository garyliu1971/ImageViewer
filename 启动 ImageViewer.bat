@echo off
setlocal

cd /d "%~dp0"

rem Prefer plain python (py launcher adds ~80ms startup); fall back to py -3.
set "PY="
where python >nul 2>nul && set "PY=python"
if defined PY goto start
where py >nul 2>nul && set "PY=py -3"
if defined PY goto start
echo Python 3 was not found. Install Python 3 and run this file again.
pause
exit /b 1

:start
%PY% "%~dp0image_viewer.py"
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" goto done

rem App failed: only now check the interpreter and Pillow (avoids a ~100ms probe on every launch).
%PY% -c "pass" >nul 2>nul
if errorlevel 1 (
    echo "%PY%" cannot run. If this is the Microsoft Store python stub, install Python 3 from python.org.
    pause
    exit /b 1
)
%PY% -c "import PIL" >nul 2>nul
if not errorlevel 1 goto done
echo Installing Pillow...
%PY% -m pip install Pillow
if errorlevel 1 (
    echo Pillow installation failed.
    pause
    exit /b 1
)
%PY% "%~dp0image_viewer.py"
set "EXIT_CODE=%ERRORLEVEL%"

:done
endlocal & exit /b %EXIT_CODE%
