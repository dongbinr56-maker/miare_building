# MIARE 매물 레이더 📷

광주 광산구에서 **증명사진관 창업용 상가 매물**을 사용자의 요청에 따라 수집·필터링해서 보여주는 비공개 개인용 대시보드.

운영 주소: <https://snapspot-studio-finder.pages.dev>

Cloudflare Access의 이메일 OTP 인증을 통과한 `miraemom7@gmail.com`,
`dongbinr56@gmail.com`, `sunnydongbin@naver.com`만 접근할 수 있다.

부동산 사이트를 매번 직접 뒤지는 대신, 조건에 맞는 매물만 골라 한 화면에서 확인한다.

## 매물 조건 (사업계획 기준)

| 항목 | 조건 |
|---|---|
| 보증금 | 500~1,000만원 (경계값 포함) |
| 월세 | 60만원 이하 (관리비 별도) |
| 층 | 지하 1층(B1)~지상 2층 |
| 권리금 | 없음 필수 (미표기는 확인 필요로 판정) |
| 면적·주차 | 판정 조건에서 제외 |
| 지역 | 광산구 전체 법정동 (네이버 지역 API에서 매번 동적 조회) |
| 생활권 | 매물 경계에서 500m 이내 초·중·고·대학교 또는 아파트 단지 필수 |

가격·층·무권리 조건을 모두 만족하고 생활권 근거까지 확인된 매물만 최종 데이터에
포함한다. 흐림 좌표나 생활권 확인 실패 매물은 보수적으로 제외한다. 조건 수정은
[collector/config.json](collector/config.json)에서 한다.

생활권 데이터는 개별 아파트 동(`building=apartments`)이 아니라 OSM의 학교와
아파트 단지 경계만 받는다. 광산구 전체 카탈로그를 매물 수집 전에 준비하고,
Overpass 결과는 KV에 24시간 보관해 같은 기간의 추가 새로고침에서는 재호출하지
않는다. 지도 버튼을 누르면 매물 중심 500m 원과 반경 안 시설 경계를 폴리곤으로
표시한다.

권리금은 `있음 > 근거 있는 무권리 > 확인 불가` 순서로 보수 판정한다. 구조화
금액이 정확히 0만원이거나 공개 설명에 `무권리`·`권리금 없음`이 단정된 경우만
무권리이며, 미기재·질문형·미확인 문구는 제외한다. 구조화 데이터나 설명 중 한
곳이라도 양수 금액이 확인되면 금액 크기와 관계없이 조건에서 제외하고, 중복 병합
후에도 이 우선순위를 유지한다.

## 구조

```
┌─ collector/collect.py     수집 오케스트레이터 (네이버 + 당근 병합)
│   ├─ (내장) 네이버 부동산: new.land API를 브라우저 컨텍스트에서 호출
│   ├─ daangn.py            당근 부동산: region API + GraphQL(APQ) 순수 HTTP 수집
│   ├─ rules.py             조건 평가 공통 로직
│   ├─ change_history.py    직전 수집 대비 신규·가격·설명·사라짐·재등록 추정
│   └─ nearby.py            500m 학교·아파트 생활권 검증
│    └→ web/public/data/listings.json (임시 생성본, Git 제외)
├─ web/                     React + Vite + Tailwind 대시보드
│   ├─ public/data/listings.fallback.json  빈 안전 fallback
│   └─ Cloudflare Pages + Access OTP + KV 운영 데이터
├─ refresh_agent.py         GitHub 작업 점유 → 1회 수집 → KV 반영
├─ start_refresh_agent.*    이전 로컬 상주 방식(현재 운영 미사용)
└─ .github/workflows/
     └─ refresh.yml         버튼 요청 시 GitHub 클라우드 수집 후 KV 반영
```

### 왜 Playwright인가? (네이버)

- **네이버**: 부동산 API는 일반 HTTP 클라이언트(requests 등)를 TLS 핑거프린팅으로
  차단한다(429). 유효한 토큰이 있어도 마찬가지. 그래서 실제 Chromium을 띄우고
  **브라우저 컨텍스트 안에서(fetch)** API를 호출한다. 토큰은 페이지가 스스로 쓰는
  Authorization 헤더를 가로채 재사용한다.
- **당근**: 브라우저가 필요 없다. ① 지역 해석 API
  (`www.daangn.com/kr/api/v1/regions/keyword`)로 동 이름 → region id를 얻고,
  ② GraphQL(`realty.kr.karrotmarket.com/graphql`)에 `articleByClusterId`
  persisted query(APQ)를 커서 페이지네이션으로 호출한다. 응답이 이미
  `originalId`·`trades`(보증금/월세)·`area`(㎡)·`floor`·`premiumMoney`(권리금)
  같은 구조화된 필드를 주므로 텍스트 파싱 없이 정규화한다. 인증 토큰 불필요.
  - **APQ 해시 주의**: 당근 프론트엔드 배포 시 persisted query 해시가 바뀔 수
    있다. GraphQL이 `PersistedQueryNotFound`를 반환하면 개발자도구 Network에서
    graphql 요청의 `sha256Hash`를 확인해 `config.json`의 `daangn.articleHash`를
    갱신한다.

두 소스 매물은 `id`에 `naver:` / `daangn:` 접두어를 붙여 구분하고, 대시보드에서
출처 뱃지·필터로 나눠 볼 수 있다.

수집 범위는 `config.json`의 `regionCortarNo`(광산구 `1233000000`)를 기준으로
네이버 `/api/regions/list`에서 하위 `sec` 법정동 전체를 매 실행 시 조회한다. 이때
확정한 동일 동 목록을 네이버와 당근 수집기에 함께 전달하므로 두 출처의 지역 범위가
어긋나지 않는다. 지역 목록 조회에 실패하면 일부 동만 반영하지 않고 수집을 중단해
직전 데이터 파일을 보존한다.

당근 매물 중 조건 충족 후보는 공개 상세 페이지의 구조화 데이터에서
`Article → PropComplex → PropBuilding` 연결을 확인한다. 단일 연결 건물의 주소와
단지 페이지의 동일 건물 ID·주소가 일치하면 `PropComplex.coordinate`를 건물 위치로
사용한다. 연결 검증이나 좌표 추출에 실패하면 기존 공개 흐림 좌표를 유지하며,
요청 상한과 로컬 캐시(`collector/.cache/`)로 외부 요청량을 제한한다.

중복 병합 시에는 카드에 포함된 모든 `naver:<articleNo>`와
`daangn:<originalId>`를 보존한다. 카드의 **다신 보지 않음**을 누르면 이 ID들을
Cloudflare Access가 검증한 이메일별 KV 차단 목록에 저장하므로 다른 PC에서도
동일 계정으로 로그인하면 계속 숨겨진다. **숨긴 매물 관리**에서 개별 또는 전체
복구할 수 있고, 새 번호로 다시 등록된 매물은 새 매물로 표시된다. 즐겨찾기도 같은
방식으로 이메일 계정에 동기화하며 브라우저 localStorage는 오프라인 캐시로 유지한다.
카드의 **메모 추가**로 작성한 개인 메모도 인증 이메일별 KV에 저장되고, 병합 카드의
모든 플랫폼 매물 번호에 연결되어 다른 기기와 새 수집 데이터에서도 정체성을 유지한다.
카드마다 `검토 중·전화 예정·방문 예약·보류·최종 후보·탈락` 진행 상태를 지정하고,
최대 3개 매물을 비교표에 담을 수 있다. 두 설정은 인증 이메일별 후보 작업공간으로
KV에 동기화되며 병합된 원본 매물 번호를 기준으로 유지된다. 수집 후에는 직전 최종
스냅샷과 비교해 신규·보증금/월세 변경·설명 변경·목록에서 사라짐을 기록한다. 새 번호
재등록은 동일 주소 또는 고신뢰 건물 좌표와 층·면적이 유일하게 일치할 때만 추정한다.
지역 선택 목록은 최종 적합 매물이 1건 이상인 법정동만 표시한다.

## 로컬 실행

```bash
# 수집 (Python 3.10+, playwright 필요)
pip install -r collector/requirements.txt
playwright install chromium
python collector/collect.py

# 정확 주소가 포함된 생성본은 로컬 비공개 경로로 옮긴 다음 빌드
mkdir -p .private/generated-data
mv web/public/data/listings.json .private/generated-data/listings-local.json

# 대시보드 개발 서버
cd web && npm install && npm run dev
# → http://localhost:5173/
```

운영 데이터 갱신은 대시보드의 **매물 새로고침** 버튼으로 요청한다. 자세한 흐름과
GitHub 클라우드 수집기 설정은 [MANUAL_REFRESH.md](MANUAL_REFRESH.md)를 참고한다.
생성 데이터·로컬 백업 취급 원칙은 [DATA_PRIVACY.md](DATA_PRIVACY.md)에 정리했다.

## 비공개 배포 (최초 1회 설정)

### 1. Cloudflare Pages와 GitHub Actions

1. Cloudflare **Workers & Pages**에서 Direct Upload 프로젝트
   `snapspot-studio-finder`를 만들고 Production branch를 `main`으로 설정한다.
2. GitHub 저장소 **Settings → Secrets and variables → Actions**에 다음 secrets를
   등록한다.
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN`: **Cloudflare Pages Edit**,
     **Workers KV Storage Edit**, **Browser Run**(대시보드에 따라
     Browser Rendering Write/Edit로 표시) 권한을 해당 Account에만 허용한 토큰
3. Pages production 설정에 `GITHUB_REPOSITORY`, `GITHUB_WORKFLOW_ID` 변수를 두고,
   해당 저장소의 Actions 실행 권한을 가진 `GITHUB_ACTIONS_TOKEN`을 secret으로 둔다.
4. GitHub **Settings → Pages**에서 GitHub Pages를 비활성화한다. 저장소가 공개 상태면
   소스 자체도 비공개로 유지하려면 저장소를 Private으로 전환한다.
   `web/public/data/listings.json`은 Git에 추가하지 않고, 정적 빌드에는 빈
   `listings.fallback.json`만 포함한다.
5. 소스 변경은 로컬 검증 후 Wrangler로 Cloudflare Pages production에 직접 배포한다.
   매물 데이터 갱신은 `main`의 `refresh.yml`만 실행한다.

### 2. Cloudflare Access OTP

1. Cloudflare Zero Trust에서 **Settings → Authentication → Login methods**에
   **One-time PIN**을 추가한다.
2. Pages 프로젝트 **Settings → General → Enable access policy**를 활성화한다.
3. **Access controls → Applications**에서 production 호스트
   `snapspot-studio-finder.pages.dev`와 배포 URL용
   `*.snapspot-studio-finder.pages.dev`를 모두 보호한다.
4. 두 애플리케이션의 Allow 정책을 아래처럼 동일하게 설정한다.
   - Include → **Emails** → `miraemom7@gmail.com`, `dongbinr56@gmail.com`,
     `sunnydongbin@naver.com`
   - Require → **Login methods** → `One-time PIN`
5. `Everyone`, `Emails ending in @gmail.com`, OTP 로그인 방식만을 Include하는 규칙은
   추가하지 않는다. 허용된 세 주소가 아니면 Cloudflare가 OTP를 발송하지 않는다.
6. Pages 프로젝트 **Settings → Variables and Secrets → Production**에 아래 런타임
   변수를 등록한다. 미설정 또는 값 불일치 시 미들웨어가 모든 요청을 차단한다.
   - `TEAM_DOMAIN`: `https://<team-name>.cloudflareaccess.com`
   - `POLICY_AUD`: production과 배포 URL용 wildcard Access 애플리케이션의
     **Application Audience (AUD)** 두 값을 쉼표로 연결
   - `ACCESS_ALLOWED_EMAILS`:
     `miraemom7@gmail.com,dongbinr56@gmail.com,sunnydongbin@naver.com`

### 로컬 수동 배포

```bash
cd web
test ! -f public/data/listings.json  # 정확 주소 생성본이 있으면 배포 중단
npm ci
npm run build
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<api-token> \
npx wrangler pages deploy dist --project-name=snapspot-studio-finder --branch=main
```

수동 배포도 `--branch=main`을 유지해야 production으로 배포된다. API Token은 파일에
저장하거나 커밋하지 않는다.

> **예약 자동 수집은 사용하지 않는다.** OTP 사용자가 버튼을 누른 경우에만
> Cloudflare가 GitHub 클라우드 수집기를 호출한다. 생성 JSON은 Git 커밋·Actions
> artifact·Pages 정적 파일로 올리지 않고, GitHub 워크플로가 Cloudflare KV에만
> 직접 반영한다.

## 주의

- 개인 사용 목적의 비공식 수집기다. 필요한 경우에만 새로고침을 요청하고 연속 요청을 피한다.
- 생성된 `listings.json`은 정확 주소·좌표를 포함할 수 있으므로 Git에 커밋하지 않는다.
- 가격·권리금·입주 가능 여부는 반드시 중개사무소에 직접 확인할 것.
