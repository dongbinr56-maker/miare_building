@echo off
rem Polls Cloudflare KV and collects only after a dashboard refresh request.
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" refresh_agent.py
  exit /b %ERRORLEVEL%
)
python refresh_agent.py
exit /b %ERRORLEVEL%
