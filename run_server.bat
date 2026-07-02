@echo off
title LMS Local Server
echo ===================================================
echo   LMS Local Web Server Bootstrapper
echo ===================================================
echo.
echo [1/2] Launching your browser to http://localhost:8080...
start http://localhost:8080
echo.
echo [2/2] Starting HTTP Server using Node.js/npx...
echo (This avoids browser file:// CORS security errors)
echo.
npx -y http-server -p 8080
pause
