# 로컬 매물 수집 → 커밋 → 푸시. 작업 스케줄러 "MiareCollect"가 collect_and_push.bat을 통해 하루 2회 실행.
# 네이버가 부동산 호스트(new.land 등)를 해외 데이터센터 IP에서 차단하므로 수집은 로컬에서만 가능하다.
# 주의: 이 파일은 UTF-8 BOM 인코딩이어야 한다 (Windows PowerShell 5.1의 한글 처리).
$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

git pull --rebase --autostash origin main

python collector\collect.py
if ($LASTEXITCODE -ne 0) {
  Write-Host "수집 실패 - 커밋하지 않음"
  exit 1
}

git add web/public/data/listings.json
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Host "변경 없음"
  exit 0
}

$now = Get-Date -Format "yyyy-MM-dd HH:mm"
git commit -m "data: 매물 자동 수집 $now (로컬)"
git push origin main
exit $LASTEXITCODE
