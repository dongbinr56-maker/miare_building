# 버튼 기반 매물 새로고침

대시보드의 **매물 새로고침** 버튼을 누를 때만 GitHub 클라우드 수집기가
네이버·당근 매물을 수집한다. 예약 또는 주기 실행은 사용하지 않는다.

## 실행 흐름

1. Cloudflare Access OTP 인증을 통과한 사용자가 버튼을 누른다.
2. Pages Function이 `REFRESH_KV`에 `pending` 작업을 기록하고, 동일한
   `job_id`로 GitHub Actions의 `.github/workflows/refresh.yml`을 실행한다.
3. GitHub 워크플로가 해당 작업을 `running`으로 점유한다.
4. 러너는 KV의 `nearby:facilities:v2`를 복원한다. 24시간이 지난 경우에만
   Overpass에서 광산구 학교·아파트 단지를 다시 받고, 네이버는 Cloudflare
   Browser Rendering CDP, 당근은 Actions 러너의 HTTP 요청으로 수집한다.
5. 수집 결과를 검증한 뒤 GitHub 워크플로가 `listings:latest`와 상태를
   production KV에 직접 저장한다. 검증된 생활권 캐시도 함께 저장하므로 같은
   24시간 안에 버튼을 여러 번 눌러도 Overpass는 다시 호출하지 않는다.
6. 대시보드가 완료 상태를 확인하고 KV의 최신 데이터를 다시 불러온다.

생성된 `web/public/data/listings.json`은 러너 임시 작업 공간에서만 사용하며
Git 커밋·Actions artifact·Pages 정적 빌드에 포함하지 않는다. 운영
데이터는 Access가 보호하는 `/api/listings`를 통해서만 제공된다.

업로드 직전에는 보증금·월세·층수 값을 고정 운영 기준으로 다시 계산하고, 권리금
감사 카운터·상태·근거·병합 ID를 재검증한다. 양수 권리금 오분류, 근거 없는
무권리, 확인 불가 매물의 최종 선택, 회귀 매물 `daangn:2970853` 중 하나라도
발견되면 기존 KV를 보존하고 작업을 실패 처리한다.

## 상태 표시

| 상태 | 의미 | UI 동작 |
|---|---|---|
| `pending` | GitHub 클라우드 수집기 시작 대기 | 스피너, 중복 요청 차단 |
| `running` | 최신 매물 수집·검증 중 | 스피너, 중복 요청 차단 |
| `succeeded` | KV 갱신 완료 | 최신 매물 자동 재로드 |
| `failed` | 실행 또는 데이터 반영 실패 | 실패 사유와 재시도 표시 |
| 시간 초과 | `pending` 30분 또는 `running` 2시간 초과 | 재시도 활성화 |

시간을 초과한 작업은 다음 버튼 요청이 새 `job_id`로 교체한다. 이전 작업이
늦게 결과를 보내더라도 `job_id` 불일치로 반영되지 않는다.

## Cloudflare Pages 설정

production/preview 환경에 `REFRESH_KV` binding을 연결한다. production namespace에
`refresh:state`, `listings:latest`, `listings:meta`, `nearby:facilities:v2` 키가
저장된다.

Pages 환경 변수:

- `GITHUB_REPOSITORY`: `owner/repository`
- `GITHUB_WORKFLOW_ID`: `refresh.yml`

Pages 암호화 secret:

- `GITHUB_ACTIONS_TOKEN`: 해당 저장소의 Actions 워크플로 실행 권한을 가진 토큰

`/api/refresh/request`, `/api/refresh/status`, `/api/listings`는 기존 Cloudflare Access JWT와
3개 이메일 허용 목록 검증을 그대로 적용한다.

## GitHub Actions 설정

저장소 **Settings → Secrets and variables → Actions**에 다음 secret을 등록한다.

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

API Token에는 해당 계정의 **Browser Rendering Edit**와
**Workers KV Storage Edit** 권한만 부여한다. 토큰 값은 로그·생성 JSON·Git
어느 곳에도 기록하지 않는다.

Workers Free의 Browser Run 사용량은 하루 10분이다. 전체 수집이 끝나면 브라우저
세션을 즉시 닫는다. 같은 날 반복 요청으로 무료 한도를 소진하면 해당 작업은 실패
상태가 되며 다음 UTC 일자에 다시 실행할 수 있다.

## 로컬 PC 이전 방식

`refresh_agent.py`와 `start_refresh_agent.*`를 상주 실행하는 방식은 현재 운영에서
사용하지 않는다. 로컬 PC의 작업 스케줄러에 이전 `MiareRefreshAgent`나
`MiareCollect`이 남아 있다면 비활성화한다.
