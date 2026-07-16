@echo off
rem 로컬에서 매물 수집 후 저장소에 반영 (GitHub Actions가 막힐 경우 대안)
cd /d %~dp0
python collector\collect.py
if errorlevel 1 (
  echo 수집 실패 - 커밋하지 않음
  exit /b 1
)
git add web/public/data/listings.json
git diff --cached --quiet && echo 변경 없음 && exit /b 0
git commit -m "data: 수동 수집"
git push
