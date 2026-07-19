# 수집 PC 추가 가이드 (동생 PC 설치용)

네이버가 GitHub Actions(해외 IP)를 차단하기 때문에 매물 수집은 **한국 IP의 Windows PC**에서 돈다.
이 가이드대로 하면 그 PC는:

- 매일 **07:10 / 18:10** 자동 수집 (그 시각에 꺼져 있었다면 **다음 부팅 후 1~2분 내 자동 실행**)
- 바탕화면 **"매물 새로고침"** 아이콘 더블클릭으로 언제든 즉시 수집
- 수집 후 3~4분이면 대시보드에 반영

여러 PC에 설치해도 된다(내 PC + 동생 PC). 먼저 켜진 쪽이 갱신하고, 동시에 돌아도 자동으로 정리된다.

## 1. 푸시 토큰 발급 (저장소 주인이 1회, 본인 PC에서)

1. github.com 로그인 → 우상단 프로필 → **Settings** → 맨 아래 **Developer settings**
2. **Personal access tokens → Fine-grained tokens → Generate new token**
3. 설정:
   - Token name: `miare-collector`
   - Expiration: **1년** (만료되면 아래 셋업만 다시 실행해 새 토큰 입력)
   - Repository access: **Only select repositories → `miare_building`**
   - Permissions → Repository permissions → **Contents: Read and write**
4. 생성된 `github_pat_...` 문자열 복사 (이 화면을 벗어나면 다시 못 봄)

## 2. 동생 PC에서 셋업 (5~10분)

1. 브라우저에서 저장소 → 초록 **Code** 버튼 → **Download ZIP** → 압축 풀기
2. 푼 폴더 안의 **`setup_collector_pc.bat` 더블클릭**
   - git/python이 없으면 자동 설치된다 (설치 후 "새 창에서 다시 실행" 안내가 나오면 bat을 한 번 더 더블클릭)
   - "토큰 붙여넣기"가 나오면 1번에서 복사한 토큰 붙여넣기 (화면에는 안 보임)
   - 마지막에 `y` 입력하면 바로 1회 수집해서 정상 동작 확인
3. 스크립트는 `C:\Users\<계정>\miare_building`에 정식 저장소를 만든다. **ZIP 푼 폴더는 지워도 됨**

## 3. 확인

- 수집 3~4분 후 대시보드 새로고침 → 헤더의 업데이트 시각이 방금으로 바뀌면 성공
- 작업 스케줄러 확인: `Win+R` → `taskschd.msc` → "MiareCollect"

## 문제 해결

- 실행 로그: 저장소 폴더의 `collector\last_run.log`
- 푸시 인증 오류: 토큰 만료 가능성 → `setup_collector_pc.bat` 다시 실행해 새 토큰 입력
- 수집 0건/토큰 캡처 실패: 네이버 개편 가능성 → 저장소 주인에게 알려줄 것
