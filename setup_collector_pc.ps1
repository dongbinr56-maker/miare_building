# ============================================================================
# 미아레 매물 레이더 - 수집 PC 원클릭 셋업
# 동생 PC(또는 아무 Windows PC)에서 setup_collector_pc.bat 더블클릭으로 1회 실행.
#   1) git / python / Node.js 없으면 winget으로 설치
#   2) 저장소 클론 (이미 저장소 안에서 실행했다면 그 폴더 사용)
#   3) 수집기 의존성 설치 (pip + Playwright Chromium)
#   4) Cloudflare Wrangler 로그인
#   5) 로그인 시 KV 요청 에이전트 시작 (예약 수집은 등록하지 않음)
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
Step "git / python / Node.js 확인"
$needGit = -not (Get-Command git -ErrorAction SilentlyContinue)
$needPy  = -not (Test-RealPython)
$needNode = -not (Get-Command npm -ErrorAction SilentlyContinue)
if ($needGit -or $needPy -or $needNode) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail "winget이 없어 자동 설치 불가. 직접 설치 후 이 스크립트를 다시 실행하세요."
    Write-Host "  git    : https://git-scm.com/download/win"
    Write-Host "  python : https://www.python.org/downloads/  (설치 시 'Add python.exe to PATH' 체크)"
    Write-Host "  Node.js: https://nodejs.org/"
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
  if ($needNode) {
    Step "Node.js LTS 설치 중 (winget)"
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  }
  Refresh-Path
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git이 아직 안 잡힙니다. 새 창에서 스크립트를 다시 실행하세요."; exit 1 }
  if (-not (Test-RealPython)) { Fail "python이 아직 안 잡힙니다. 새 창에서 스크립트를 다시 실행하세요."; exit 1 }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail "npm이 아직 안 잡힙니다. 새 창에서 스크립트를 다시 실행하세요."; exit 1 }
}
Ok "git / python / Node.js 준비됨"

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

# --- 4) 대시보드 번들 + Cloudflare KV 인증 ---------------------------------
Step "Wrangler 준비"
Push-Location web
npm ci
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm 의존성 설치 실패"; exit 1 }
if (-not $NoPrompt) {
  npx wrangler whoami | Out-Null
  if ($LASTEXITCODE -ne 0) { npx wrangler login }
  npx wrangler whoami | Out-Null
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "Cloudflare 로그인 실패"; exit 1 }
  Ok "Cloudflare KV 인증 확인 완료"
}
Pop-Location

# --- 5) 버튼 요청 에이전트 ---------------------------------------------------
if (-not $NoPrompt) {
  Step "기존 예약 수집 제거"
  Unregister-ScheduledTask -TaskName "MiareCollect" -Confirm:$false -ErrorAction SilentlyContinue
  Ok "07:10 / 18:10 예약 수집을 사용하지 않음"

  Step "로그인 시 버튼 요청 에이전트 시작"
  $action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$repo\start_refresh_agent.bat`"" -WorkingDirectory $repo
  $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName "MiareRefreshAgent" -Action $action -Trigger $trigger -Settings $settings `
    -Description "미아레 매물 레이더: 대시보드 버튼 요청이 있을 때만 수집" -Force | Out-Null
  if (-not $?) { Fail "에이전트 작업 등록 실패"; exit 1 }
  Start-ScheduledTask -TaskName "MiareRefreshAgent"
  Ok "MiareRefreshAgent 등록 및 시작 완료"

  Step "셋업 완료"
  Write-Host "   예약 수집은 없습니다. 대시보드에서 '매물 새로고침'을 눌렀을 때만 수집합니다."
} else {
  Step "NoPrompt 모드: Cloudflare 로그인/작업등록 생략"
}
