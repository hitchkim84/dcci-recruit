# DCCI 채용 홈페이지 작업 기준

대구상공회의소 채용 홈페이지(교육 홈페이지 `dcciedu`와 별도 프로젝트). 판단 우선순위: 1 보안 → 2 안정성 → 3 쉬운 수정. 충돌하면 앞 번호를 따른다.
작업 전에 `HANDOVER.md`(현재 상태·남은 일)를 읽는다.

## 1. 보안
- 지원자는 이메일 일회용 코드로 인증한 **본인 지원서만** 본다. 이름·전화·이메일 입력만으로 지원내역을 보여주지 않는다.
- 등급(`app_metadata.role`): `admin` = 슈퍼관리자(OTP aal2 필수, 모든 기능), `staff` = 일반 담당자(비밀번호 로그인, 지정 공고 조회·다운로드만, OTP 없음 — 확정된 운영 조건). 등급은 화면(`public/js/admin.js`)·서버(`netlify/functions/admin.js`)·DB(`sql/04_admin.sql`) 세 곳에서 확인한다.
- 모든 표는 RLS + 정책 없음 + anon/authenticated 권한 회수. 새 표를 만들면 `sql/01`의 회수 목록에 넣는다. 데이터 접근은 검사가 들어간 DB 함수로만.
- SECURITY DEFINER 함수는 `SET search_path = ''`, 표는 `public.` 접두어. 실행 권한은 필요한 역할에만(서버 전용은 service_role).
- 첨부파일: 비공개 버킷, Storage 정책 없음, 서버가 발급한 서명 업로드 주소로만 업로드, 업로드 후 서버가 실제 형식 확인, 열람은 권한 확인·기록 후 60초 서명 주소.
- 입력값 검증은 `public/js/rules.js`(화면·서버)와 DB 함수에 같은 기준으로 둔다.
- 화면 출력은 `RC.esc()`로 이스케이프. CSP로 인라인 스크립트 금지(onclick 금지, 코드는 `public/js/`). 새 외부 주소는 `netlify.toml` CSP에 추가.
- CSV는 수식 실행 방지(`csvCell`). 관리자 조회·다운로드·변경은 기록한다(기록 실패 시 작업 중단).
- 비밀값(키·비밀번호·실제 관리자 이메일)은 코드·GitHub·문서에 두지 않는다. 저장소는 공개다. `SUPABASE_SERVICE_ROLE_KEY`는 서버 함수에서만, Netlify Production 범위에만.
- 개인정보를 URL·로그·샘플 데이터에 넣지 않는다. 개발 데이터는 `[개발용 가상]` 표시.
- 담당자가 입력하지 않은 채용 조건·기관 제도·법적 문구를 만들어 넣지 않는다. 미확정 문구는 `검토 필요`로 표시.
- 변경 후 개인정보가 새로 노출되는 경로가 없는지 확인한다.

## 2. 안정성
- `main` 머지 = 운영 배포. 작업 브랜치에서 모아서 사용자 확인 후 한 번에 배포한다.
- 배포 전: `npm test` 통과. SQL을 바꿨으면 `npm run test:db`(실제 PostgreSQL), 화면·흐름을 바꿨으면 `npm run test:e2e`도 통과. 가짜·흉내 서버 결과만으로 실제 Supabase 차단을 주장하지 않는다(`docs/TEST_REPORT.md`처럼 구분해 보고).
- DB 변경은 `sql/`에 번호를 붙인 새 파일로, 여러 번 실행해도 안전하게. Supabase SQL Editor에서 직접 실행 후 `sql/check_security.sql`.

## 3. 쉬운 수정
- 구조: 정적 화면(`public/`), 서버 함수(`netlify/functions/`, 공통 `netlify/lib/`), SQL(`sql/`). 빌드 단계·새 라이브러리를 늘리지 않는다.
- 주석·문서는 한국어, 파일은 UTF-8.
