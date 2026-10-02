# 작업 인수인계 (다른 PC·다른 AI 도구에서 이어서 작업하기)

마지막 갱신: 2026-10-02 · 기준 브랜치: `main`

## 1. 현재 상태 한 줄 요약
첫 운영 버전의 **코드와 로컬 검증은 끝났다**. Supabase 프로젝트 `dcci-recruit`(서울) 생성·SQL 01~05 실행·점검 정상(2026-10-02), 이메일 OTP 8자리·10분 설정, SMTP는 임시 Gmail로 설정 중. Netlify 사이트·Turnstile·슈퍼관리자 계정은 아직(운영 확인 미실시).

## 2. 이어서 작업하는 방법
```bash
git clone https://github.com/hitchkim84/dcci-recruit.git
cd dcci-recruit
npm install
npm test            # 1~2초
npm run test:db     # PostgreSQL 14+ 필요 (Ubuntu: sudo apt install postgresql)
npm run test:e2e    # + Playwright Chromium 필요 (npx playwright install chromium)
npm run dev         # http://localhost:8888 에서 화면 확인 (가상 데이터)
```
- Windows 회사 PC: `npm test`는 그대로 된다. `test:db`·`test:e2e`·`dev`는 PostgreSQL 설치가 필요하다(또는 WSL 사용).
- AI 도구에게 맡길 때: "CLAUDE.md와 HANDOVER.md를 먼저 읽고 작업해줘"라고 시작한다.

## 3. 지금까지 결정한 것
| 결정 | 내용 | 근거 |
|---|---|---|
| 별도 저장소·DB·배포 | `hitchkim84/dcci-recruit`(공개), 별도 Supabase 프로젝트, 별도 Netlify 사이트 | 교육 홈페이지에 영향 없음 |
| 기술 | Netlify(정적 화면·서버 함수·예약 실행) + Supabase(PostgreSQL·Auth·Storage) | `docs/DESIGN.md` 4장 |
| 지원자 본인 확인 | 이메일 일회용 코드(비밀번호 회원가입 없음) | 요청 사항 |
| 관리자 등급 | 슈퍼관리자 OTP 필수 / 일반 담당자 OTP 없음·지정 공고 조회·다운로드만 | 요청 사항(확정 운영 조건) |
| DB 접근 | 표 직접 접근 금지, 검사 기능이 있는 DB 함수로만 | 직접 호출 우회 방지 |
| 지원서 PDF | 브라우저 인쇄 → PDF 저장(라이브러리 추가 없음) | 단순 유지 |
| 제출 취소 | 공고 설정 시 마감 전 취소 → 임시저장으로 돌아가고 접수번호 무효 | 재제출 가능 |
| 로고 | 교육 홈페이지의 대구상공회의소 로고 사본 사용 | 사용자 승인(2026-10-02) |

## 4. 남은 일 (우선순위 순)
1. **실제 환경 만들기**: `docs/SETUP.md` 순서대로 Supabase 프로젝트 → SQL 01~05 → Auth 설정(메일 템플릿 `{{ .Token }}`, SMTP, CAPTCHA) → 슈퍼관리자 계정 → Netlify 사이트·환경변수 → 도메인.
2. **운영 확인**: `docs/OPERATIONS.md` 3장 점검표 실행 후 `docs/TEST_REPORT.md` ③열 갱신.
3. **기관 자료·업무 기준 받기**(받기 전에는 비워 두거나 `검토 필요`로 둔다):
   - 채용 문의 전화·이메일·주소(설정 탭), 실제 전형 절차 문구
   - 개인정보 수집·이용 동의문 확정본, 개인정보처리방침, **지원서 보관기한**, 관리자 기록 보관 기간
   - 채용 사이트 도메인 주소, 이메일 발송 방식(회사 SMTP 또는 발송 서비스) 결정
4. 메일 발송: 현재 임시로 팀 공용 Gmail SMTP 사용(하루 약 500통 한도). 운영 전 회사 메일(korcham.net) SMTP로 교체 — 전산 담당자에게 SMTP 주소·포트, 해외 서버의 SMTP 인증 발송 허용 여부, 발송 한도, 발송 전용 계정을 확인한 뒤 Supabase SMTP Settings만 바꾸면 된다(코드 변경 없음).
5. 참고 사이트 화면 캡처를 받으면 화면 흐름 비교·보완(`docs/DESIGN.md` 1장).
6. 향후 과제(`docs/DESIGN.md` 5장): 메일 알림, 블라인드 모드, 바이러스 검사 등 — 요청 시.

## 5. 파일 지도
- 입력 규칙을 바꿀 때: `public/js/rules.js` **와** `sql/02_common_public.sql`의 `rc_validate_application`을 같이 바꾸고 새 SQL 파일로 배포
- 권한을 바꿀 때: `netlify/functions/admin.js`(STAFF_ACTIONS) **와** `sql/04_admin.sql`을 같이 바꾸고 `tests/db/db.test.js`에 차단 테스트 추가
- 화면 문구: `public/*.html`, `public/js/*.js` (인라인 스크립트·onclick 금지 — CSP)
- 디자인: `public/css/style.css` (흰색·남색 변수는 맨 위 `:root`)

## 6. 주의
- 운영 DB에서 테스트하지 않는다. `sql/dev/dev_seed.sql`은 운영에 실행하지 않는다.
- 비밀값(키·비밀번호·실제 관리자 이메일)을 커밋하지 않는다. 저장소는 공개다.
- `main`에 머지하면 바로 운영 배포된다(Netlify 연결 후).
