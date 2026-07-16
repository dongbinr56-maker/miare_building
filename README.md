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
┌─ collector/collect.py     Playwright로 네이버 부동산 API 수집
│    └→ web/public/data/listings.json
├─ web/                     React + Vite + Tailwind 대시보드
│    └→ GitHub Pages 배포
└─ .github/workflows/
     ├─ collect.yml         매일 07시/18시(KST) 자동 수집 → 데이터 커밋
     └─ deploy.yml          main 푸시 시 Pages 빌드·배포
```

### 왜 Playwright인가?

네이버 부동산 API는 일반 HTTP 클라이언트(requests 등)를 TLS 핑거프린팅으로 차단한다(429).
유효한 토큰이 있어도 마찬가지. 그래서 수집기는 실제 Chromium을 띄우고
**브라우저 컨텍스트 안에서(fetch)** API를 호출한다. 토큰은 페이지가 스스로 쓰는
Authorization 헤더를 가로채 재사용하므로 별도 관리가 필요 없다.

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

> GitHub Actions IP가 네이버에 차단될 경우 `collect.yml` 스케줄 수집이 실패할 수 있다.
> 그 경우 로컬에서 `collect_and_push.bat`을 주기 실행(작업 스케줄러)하는 방식으로 대체.

## 주의

- 개인 사용 목적의 비공식 수집기다. 요청 간격을 두고 하루 2회만 수집한다.
- 가격·권리금·입주 가능 여부는 반드시 중개사무소에 직접 확인할 것.
