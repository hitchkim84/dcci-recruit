# 대구상공회의소 채용 홈페이지 (dcci-recruit)

입사지원자가 채용공고를 확인하고 이메일 인증만으로 지원서를 작성·임시저장·제출하며, 채용 담당자가 지원서를 조회·관리하는 홈페이지입니다.
교육센터 홈페이지(`hitchkim84/dcciedu`)와 **저장소·배포·DB를 완전히 분리**한 별도 프로젝트입니다.

- 처음 이어서 작업한다면: [HANDOVER.md](HANDOVER.md) (인수인계·현재 상태·남은 일)
- 처음 설치(Supabase·Netlify 설정): [docs/SETUP.md](docs/SETUP.md)
- 관리자 운영 방법·배포·복구: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- 권한 구조·검증 결과·잔여 위험: [docs/SECURITY.md](docs/SECURITY.md), [docs/TEST_REPORT.md](docs/TEST_REPORT.md)
- 참고 사이트 확인 결과·화면·DB 설계·향후 과제: [docs/DESIGN.md](docs/DESIGN.md)
- AI 도구 작업 기준: [CLAUDE.md](CLAUDE.md)

## 구성 (빌드 단계 없음)
| 폴더 | 내용 |
|---|---|
| `public/` | 정적 화면. `index.html`(메인) `posting.html`(공고 상세) `apply.html`(지원서) `my.html`(지원내역) `admin.html`(관리자) `privacy.html` |
| `public/js/` | 화면 코드. `rules.js`는 화면과 서버가 함께 쓰는 입력 규칙 |
| `public/vendor/` | Supabase 브라우저 라이브러리(버전 고정, 외부 CDN 미사용) |
| `netlify/functions/` | 서버 함수: `public`(공개 조회) `applicant`(지원자) `admin`(관리자) `purge`(매일 자동 파기) |
| `netlify/lib/` | 서버 공통 코드(로그인 확인, 파일 형식 확인, CSV, 파기) |
| `sql/` | Supabase SQL Editor에서 01→05 순서로 실행. `check_security.sql`은 읽기 전용 점검 |
| `sql/dev/` | **개발용 가상 데이터**(운영 DB에 실행 금지) |
| `tests/` | `unit`(가짜 서비스) · `db`(실제 PostgreSQL) · `e2e`(브라우저 + 실제 PostgreSQL + Supabase 흉내) |

## 실행·테스트
```bash
npm install                 # supabase-js(서버용), pg(테스트용)
npm test                    # 서버 함수 단위 테스트 (가짜 Supabase)
npm run test:db             # 실제 PostgreSQL 임시 DB에서 권한·마감·중복 제출·파기 확인 (PostgreSQL 14+ 필요)
npm run test:e2e            # 브라우저 통합 검증 (PostgreSQL + Playwright/Chromium 필요). 화면 캡처는 test-results/
npm run dev                 # 로컬 개발 서버 http://localhost:8888 (가상 데이터, Supabase 흉내)
```
`npm run dev` 관리자 로그인: `admin@dev.local` / `dev-admin-password-0000` / OTP `246810` (로컬 흉내 서버 전용 값).
이메일 인증코드는 `http://127.0.0.1:54321/__dev/otp?email=입력한이메일`에서 확인합니다.

## 환경변수 (Netlify → Site configuration → Environment variables)
| 이름 | 필수 | 설명 |
|---|---|---|
| `SUPABASE_URL` | 예 | Supabase 프로젝트 주소 |
| `SUPABASE_ANON_KEY` | 예 | 공개용 키(anon 또는 publishable). 브라우저에도 내려간다 |
| `SUPABASE_SERVICE_ROLE_KEY` | 예 | **서버 전용** 키(service_role 또는 secret). Secret 표시, Functions 범위, Production에만 |
| `TURNSTILE_SITE_KEY` | 운영 필수 | Cloudflare Turnstile 사이트 키(공개값). 비밀 키는 Supabase 대시보드에 넣는다 |
| `STAFF_EMAIL_DOMAIN` | 예 | 일반 담당자 로그인용 가상 이메일 도메인(예: `staff.채용사이트도메인`). 메일을 받지 않는 주소 |
| `SITE_ORIGIN` | 선택 | 다른 주소에서 API를 부를 때만 CORS 허용 주소(보통 비워 둠, 같은 주소에서만 호출) |

비밀값은 코드·GitHub·문서에 적지 않습니다. 이메일 발송 비밀값(SMTP)과 Turnstile 비밀 키는 Supabase 대시보드에만 둡니다.
