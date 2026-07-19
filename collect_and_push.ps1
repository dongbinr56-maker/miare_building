# 로컬 매물 수집 → 커밋 → 푸시. 작업 스케줄러 "MiareCollect"가 collect_and_push.bat을 통해 하루 2회 실행.
# 네이버가 부동산 호스트(new.land 등)를 해외 데이터센터 IP에서 차단하므로 수집은 로컬(한국 IP)에서만 가능하다.
# 두 대 이상의 PC(내 PC + 동생 PC)가 같은 작업을 등록해 두므로, 동시 수집/푸시 충돌을 안전하게 처리한다.
# 주의: 이 파일은 UTF-8 BOM 인코딩이어야 한다 (Windows PowerShell 5.1의 한글 처리).
$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
Start-Transcript -Path "collector\last_run.log" -Force | Out-Null

git pull --rebase --autostash origin main
if ($LASTEXITCODE -ne 0) {
  # 리베이스가 꼬였으면 되돌리기만 하고 진행 (사용자 작업 파일은 건드리지 않음). 푸시 단계에서 재동기화.
  git rebase --abort 2>$null
  Write-Host "pull 실패 - 무시하고 진행, 푸시 단계에서 재동기화"
}

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

function New-DataCommit {
  $now = Get-Date -Format "yyyy-MM-dd HH:mm"
  git commit -m "data: 매물 자동 수집 $now ($env:COMPUTERNAME)"
}

New-DataCommit
git push origin main
if ($LASTEXITCODE -ne 0) {
  # 다른 PC가 먼저 푸시한 경우. 내 데이터 커밋을 원격 최신 위에 다시 얹는다.
  # reset --soft(브랜치 포인터만 이동) + reset -- .(인덱스만 원격과 일치) 조합이라
  # 작업 트리의 다른 파일(개발 중 변경 등)은 절대 건드리지 않는다.
  Write-Host "푸시 거부 - 원격 최신 위에 재커밋 후 1회 재시도"
  git fetch origin
  git reset --soft origin/main
  git reset -- .
  git add web/public/data/listings.json
  git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-Host "재동기화 결과 변경 없음 (다른 PC 수집분으로 충분)"
    exit 0
  }
  New-DataCommit
  git push origin main
  if ($LASTEXITCODE -ne 0) {
    Write-Host "재시도 실패 - 다음 주기에 다시 시도"
    exit 1
  }
}
Write-Host "수집/반영 완료"
