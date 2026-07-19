@echo off
rem ASCII-only launcher. All logic lives in setup_collector_pc.ps1 (UTF-8 BOM).
rem Korean text or chcp inside a .bat breaks cmd parsing on UTF-8/LF files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_collector_pc.ps1"
pause
