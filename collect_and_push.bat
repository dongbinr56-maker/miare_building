@echo off
>nul chcp 65001
rem 로컬에서 매물 수집 후 저장소에 반영 (작업 스케줄러 "MiareCollect"가 하루 2회 실행)
rem 네이버가 부동산 호스트를 해외 데이터센터 IP에서 차단하므로 수집은 로컬에서만 가능하다.
cd /d %~dp0
git pull --rebase --autostash origin main
python collector\collect.py
if errorlevel 1 (
  echo 수집 실패 - 커밋하지 않음
  exit /b 1
)
git add web/public/data/listings.json
git diff --cached --quiet && echo 변경 없음 && exit /b 0
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm'"`) do set NOW=%%i
git commit -m "data: 매물 자동 수집 %NOW% (로컬)"
git push origin main
