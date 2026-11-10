@echo off
cd /d "%~dp0"
echo ========================================================
echo   Running CICOD & 1Gov Daily Health Monitor Check
echo ========================================================
node src/runner.js --target=all
echo.
echo ========================================================
echo   Run finished. Latest report: reports\latest\index.html
echo ========================================================
pause

