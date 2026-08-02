# 매물 데이터 보호 원칙

`collector/collect.py`가 생성하는 `web/public/data/listings.json`에는 매물과 연결된
정확 주소·좌표가 포함될 수 있다. 이 파일은 소스 코드가 아니라 민감한 실행
산출물로 취급한다.

## 저장 분리

- 운영 데이터: Cloudflare production KV에만 저장
- 사용자 즐겨찾기·차단 목록: Access 인증 이메일의 SHA-256 식별자별 production KV
- Git/Pages fallback: `web/public/data/listings.fallback.json`(매물 0건)
- 수집 생성본: `web/public/data/listings.json`(Git ignore, 일시 파일)
- 로컬 백업: `.private/generated-data/`(Git ignore, 권한 `600` 권장)
- 외부 요청 캐시·로그: `collector/.cache/`, `*.log`(Git ignore)

GitHub Actions 수집 러너는 생성 JSON을 production KV에 반영한 뒤 종료한다.
생성 JSON을 커밋하거나 Actions artifact로 업로드하지 않는다.

즐겨찾기와 차단 목록 API는 서명·AUD·허용 이메일 검증을 통과한 Access JWT의
`email` claim만 사용한다. 요청 헤더가 주장하는 이메일은 사용하지 않고, KV 키에도
이메일 원문을 넣지 않는다. 브라우저 localStorage에는 현재 계정의 오프라인 캐시가
남을 수 있으므로 공용 PC에서는 사용 후 사이트 데이터를 삭제한다.

## 로컬 수집 시

로컬에서 수집한 결과를 보존해야 하면 공개 `web/public` 아래에 두지 말고
다음처럼 옮긴다.

```bash
mkdir -p .private/generated-data
chmod 700 .private .private/generated-data
mv web/public/data/listings.json .private/generated-data/listings-local.json
chmod 600 .private/generated-data/listings-local.json
```

Vite는 `web/public` 아래의 모든 파일을 정적 배포물에 복사한다. 로컬 빌드·배포 전에
반드시 다음 검사가 통과해야 한다.

```bash
test ! -f web/public/data/listings.json
git check-ignore web/public/data/listings.json
```

## 커밋 전 확인

```bash
git status --short
git ls-files web/public/data/listings.json
git grep -n '"roadAddress"\|"jibunAddress"' -- 'web/public/data/*.json'
```

`git ls-files` 결과에 생성 `listings.json`이 나오거나 안전 fallback에 주소 필드가
발견되면 커밋하지 않는다.

`.gitignore`는 이후 커밋만 막으며 이미 커밋된 데이터를 Git 히스토리에서
제거하지 못한다. 과거에 생성 데이터를 푸시한 적이 있다면 저장소를 먼저
Private으로 전환하고, 영향 범위를 확인한 후 별도 승인된 절차로 히스토리
재작성과 캐시 파기를 진행한다.
