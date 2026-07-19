@echo off
rem ASCII-only launcher. All logic lives in collect_and_push.ps1 (UTF-8 BOM).
rem Korean text or chcp inside a .bat breaks cmd parsing on UTF-8/LF files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect_and_push.ps1"
exit /b %ERRORLEVEL%
