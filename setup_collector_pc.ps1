# ============================================================================
# 미아레 매물 레이더 - 수집 PC 원클릭 셋업
# 동생 PC(또는 아무 Windows PC)에서 setup_collector_pc.bat 더블클릭으로 1회 실행.
#   1) git / python 없으면 winget으로 설치
#   2) 저장소 클론 (이미 저장소 안에서 실행했다면 그 폴더 사용)
#   3) 수집기 의존성 설치 (pip + Playwright Chromium)
#   4) GitHub 푸시 토큰(PAT) 등록
#   5) 작업 스케줄러 등록: 매일 07:10 / 18:10, 놓친 일정은 부팅 후 자동 실행
#   6) 바탕화면 "매물 새로고침" 아이콘 생성
# 주의: 이 파일은 UTF-8 BOM 인코딩이어야 한다 (Windows PowerShell 5.1의 한글 처리).
# ============================================================================
param(
  [switch]$NoPrompt,          # 테스트용: 입력/작업등록/바로가기/첫수집 생략
  [string]$TargetDir = ""     # 테스트용: 클론 위치 재정의
)
$ErrorActionPreference = "Continue"
$RepoUrl = "https://github.com/dongbinr56-maker/miare_building.git"

function Step($m)  { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m)    { Write-Host "   OK: $m" -ForegroundColor Green }
function Fail($m)  { Write-Host "   실패: $m" -ForegroundColor Red }

function Test-RealPython {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if (-not $cmd) { return $false }
  if ($cmd.Source -like "*\WindowsApps\*") { return $false }   # 스토어 설치 안내용 가짜 python
  return $true
}

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User")
}

# --- 1) 필수 도구 ------------------------------------------------------------
Step "git / python 확인"
$needGit = -not (Get-Command git -ErrorAction SilentlyContinue)
$needPy  = -not (Test-RealPython)
if ($needGit -or $needPy) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail "winget이 없어 자동 설치 불가. 직접 설치 후 이 스크립트를 다시 실행하세요."
    Write-Host "  git    : https://git-scm.com/download/win"
    Write-Host "  python : https://www.python.org/downloads/  (설치 시 'Add python.exe to PATH' 체크)"
    exit 1
  }
  if ($needGit) {
    Step "git 설치 중 (winget)"
    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
  }
  if ($needPy) {
    Step "python 3.12 설치 중 (winget)"
    winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
  }
  Refresh-Path
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git이 아직 안 잡힙니다. 새 창에서 스크립트를 다시 실행하세요."; exit 1 }
  if (-not (Test-RealPython)) { Fail "python이 아직 안 잡힙니다. 새 창에서 스크립트를 다시 실행하세요."; exit 1 }
}
Ok "git / python 준비됨"

# --- 2) 저장소 위치 ----------------------------------------------------------
Step "저장소 준비"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if ((Test-Path (Join-Path $here "collector\collect.py")) -and (Test-Path (Join-Path $here ".git"))) {
  $repo = $here
  Ok "이미 저장소 안에서 실행됨: $repo"
} else {
  if ($TargetDir) { $repo = $TargetDir } else { $repo = Join-Path $env:USERPROFILE "miare_building" }
  if (Test-Path (Join-Path $repo ".git")) {
    Ok "기존 클론 사용: $repo"
  } else {
    git clone $RepoUrl $repo
    if ($LASTEXITCODE -ne 0) { Fail "클론 실패. 인터넷 연결을 확인하세요."; exit 1 }
    Ok "클론 완료: $repo"
  }
}
Set-Location $repo

# --- 3) 수집기 의존성 --------------------------------------------------------
Step "수집기 의존성 설치 (수 분 소요, Chromium 약 150MB)"
python -m pip install --disable-pip-version-check -q -r collector\requirements.txt
if ($LASTEXITCODE -ne 0) { Fail "pip 설치 실패"; exit 1 }
python -m playwright install chromium
if ($LASTEXITCODE -ne 0) { Fail "Playwright Chromium 설치 실패"; exit 1 }
Ok "의존성 설치 완료"

# --- 4) git 신원 + 푸시 토큰 -------------------------------------------------
Step "git 설정"
$name = git config user.name
if (-not $name) {
  git config user.name  "miare-collector-$env:COMPUTERNAME"
  git config user.email "miare-collector@users.noreply.github.com"
  Ok "커밋 신원 설정 (이 저장소 한정)"
} else {
  Ok "커밋 신원 이미 있음: $name"
}

if (-not $NoPrompt) {
  Write-Host "   푸시용 GitHub 토큰(PAT)이 필요합니다. 이미 푸시가 되는 PC면 그냥 Enter."
  $sec = Read-Host "   토큰 붙여넣기 (입력 숨김)" -AsSecureString
  $pat = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  if ($pat) {
    $cred = "protocol=https`nhost=github.com`nusername=miare`npassword=$pat`n`n"
    $cred | git credential approve
    Ok "토큰을 Windows 자격 증명 관리자에 저장"
  }
  git push --dry-run origin main
  if ($LASTEXITCODE -eq 0) { Ok "푸시 인증 확인 완료" }
  else { Fail "푸시 인증 실패 - SETUP_COLLECTOR_PC.md의 토큰 발급 절차를 확인하세요 (셋업은 계속 진행)" }
}

# --- 5) 작업 스케줄러 + 바탕화면 아이콘 --------------------------------------
if (-not $NoPrompt) {
  Step "작업 스케줄러 등록 (매일 07:10 / 18:10, 놓치면 부팅 후 실행)"
  $action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$repo\collect_and_push.bat`"" -WorkingDirectory $repo
  $t1       = New-ScheduledTaskTrigger -Daily -At 07:10
  $t2       = New-ScheduledTaskTrigger -Daily -At 18:10
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName "MiareCollect" -Action $action -Trigger $t1, $t2 -Settings $settings `
    -Description "미아레 매물 레이더: 네이버+당근 수집 후 GitHub 푸시 (하루 2회). 저장소 README 참고" -Force | Out-Null
  if ($?) { Ok "MiareCollect 등록 완료" } else { Fail "작업 등록 실패 - README의 수동 등록 명령을 사용하세요" }

  Step "바탕화면 아이콘 생성"
  $ws  = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "매물 새로고침.lnk"))
  $lnk.TargetPath = "cmd.exe"
  $lnk.Arguments = "/c `"$repo\collect_and_push.bat`""
  $lnk.WorkingDirectory = $repo
  $lnk.Save()
  Ok "'매물 새로고침' 아이콘 생성 (더블클릭 = 즉시 수집)"

  Step "셋업 완료"
  Write-Host "   매일 07:10 / 18:10에 자동 수집되고, 그 시각에 PC가 꺼져 있었다면 다음 부팅 후 자동 실행됩니다."
  Write-Host "   지금 바로 1회 수집해 볼까요? (약 4-5분)"
  $run = Read-Host "   실행하려면 y 입력"
  if ($run -eq "y") { cmd /c "$repo\collect_and_push.bat" }
} else {
  Step "NoPrompt 모드: 토큰/작업등록/아이콘/첫수집 생략"
}
