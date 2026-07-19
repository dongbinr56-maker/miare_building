# MIARE 매물 레이더 📷

광주 광산구에서 **증명사진관 창업용 상가 매물**을 자동으로 수집·필터링해서 보여주는 개인용 대시보드.

부동산 사이트를 매번 직접 뒤지는 대신, 조건에 맞는 매물만 골라 한 화면에서 확인한다.

## 매물 조건 (사업계획 기준)

| 항목 | 조건 |
|---|---|
| 보증금 | 500만원 이하 |
| 월세 | 45만원 이하 |
| 층 | 1층 |
| 면적 | 4~10평 (전용 기준) |
| 권리금 | 없음 (설명에 "무권리" 표기 시 뱃지) |
| 지역 | 신가동 · 신창동 · 하남동 · 수완동 |

4개 조건을 모두 만족하면 **조건 충족**, 3개면 **근접**으로 분류된다.
조건 수정은 [collector/config.json](collector/config.json)에서.

## 구조

```
┌─ collector/collect.py     수집 오케스트레이터 (네이버 + 당근 병합)
│   ├─ (내장) 네이버 부동산: new.land API를 브라우저 컨텍스트에서 호출
│   ├─ daangn.py            당근 부동산: region API + GraphQL(APQ) 순수 HTTP 수집
│   └─ rules.py             조건 평가 공통 로직
│    └→ web/public/data/listings.json
├─ web/                     React + Vite + Tailwind 대시보드
│    └→ GitHub Pages 배포
├─ collect_and_push.bat     수집 → 커밋 → 푸시 (각 수집 PC의 작업 스케줄러가 07:10/18:10 실행)
├─ setup_collector_pc.bat   수집 PC 원클릭 셋업 (SETUP_COLLECTOR_PC.md 참고)
└─ .github/workflows/
     ├─ collect.yml         수동 실행 전용 (네이버가 Actions IP 차단 → 스케줄 폐기, 아래 참고)
     └─ deploy.yml          main 푸시 시 Pages 빌드·배포
```

### 왜 Playwright인가? (두 소스 모두)

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

## 로컬 실행

```bash
# 수집 (Python 3.10+, playwright 필요)
pip install -r collector/requirements.txt
playwright install chromium
python collector/collect.py

# 대시보드 개발 서버
cd web && npm install && npm run dev
# → http://localhost:5173/miare_building/
```

수집 후 바로 반영하려면 `collect_and_push.bat` 실행 (수집 → 커밋 → 푸시).

## 배포 (최초 1회 설정)

1. GitHub 저장소 → **Settings → Pages → Source: GitHub Actions** 선택
2. main에 푸시하면 자동 배포: `https://<계정>.github.io/miare_building/`
3. 무료 플랜은 **공개 저장소만 Pages 지원** — 민감 문서는 `docs/`에 두면 커밋에서 제외됨(.gitignore)

> **자동 수집은 수집 PC(내 PC·동생 PC)가 담당한다.** 네이버가 부동산 호스트
> (new.land/m.land/fin.land)를 해외 데이터센터 IP에서 네트워크 레벨로 차단해 GitHub
> Actions에서는 접속이 불가능함을 확인했다(2026-07-19 러너 진단: www.naver.com 200,
> new.land TCP 타임아웃 — 당근 API는 러너에서도 정상). 각 수집 PC의 작업 스케줄러
> **MiareCollect**가 매일 07:10/18:10(KST)에 `collect_and_push.bat`을 실행하며, 트리거
> 시각에 PC가 꺼져 있었으면 다음 부팅 후 실행된다(= PC를 켜는 것이 곧 새로고침).
> 여러 PC가 동시에 수집해도 푸시 충돌은 자동 정리된다. 수집 PC 추가는
> [SETUP_COLLECTOR_PC.md](SETUP_COLLECTOR_PC.md) 참고 (`setup_collector_pc.bat` 1회 실행).

## 주의

- 개인 사용 목적의 비공식 수집기다. 요청 간격을 두고 하루 2회만 수집한다.
- 가격·권리금·입주 가능 여부는 반드시 중개사무소에 직접 확인할 것.
