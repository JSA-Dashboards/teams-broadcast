@echo off
setlocal

set "WA_DIR=C:\Users\KoltenPostin\OneDrive - John Stewart and Associates\Desktop\Claude Code\TeamsBroadcast\whatsapp-service"
set "CF_EXE=C:\Program Files (x86)\cloudflared\cloudflared.exe"
set "CF_CFG=%USERPROFILE%\.cloudflared\config.yml"

echo WA_DIR: %WA_DIR%
echo CF_EXE: %CF_EXE%
echo CF_CFG: %CF_CFG%
echo.

if not exist "%WA_DIR%" (
    echo ERROR: Cannot find whatsapp-service folder at:
    echo   %WA_DIR%
    pause
    exit /b 1
)

if not exist "%CF_EXE%" (
    echo ERROR: cloudflared.exe not found at:
    echo   %CF_EXE%
    pause
    exit /b 1
)

echo Starting WhatsApp Service...
start "WhatsApp Service" /D "%WA_DIR%" cmd /k node server.js

timeout /t 4 /nobreak > nul

echo Starting Cloudflare Tunnel (wa.jsa-whatsapp.us)...
"%CF_EXE%" tunnel --config "%CF_CFG%" run jpsi-whatsapp
pause
