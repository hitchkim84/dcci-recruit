# 처음 설치 (Supabase · Netlify · 이메일 · 로봇 확인)

교육 홈페이지와 **다른 Supabase 프로젝트, 다른 Netlify 사이트**를 만든다. 교육 홈페이지의 설정·키를 재사용하지 않는다.
비밀값은 이 문서·코드·GitHub에 적지 않는다.

## 0. 비용·외부 연결 정리 (확정 전 검토)
| 항목 | 필요 이유 | 선택지·비용(각 사 요금표에서 최신 가격 확인 필요) |
|---|---|---|
| Supabase 프로젝트 | DB·로그인·파일 저장 | Free: 1주 미사용 시 일시 정지·백업 제한 → **운영은 Pro 권장**(월 약 25달러, 같은 조직의 추가 프로젝트는 컴퓨트 비용 추가) |
| Netlify 사이트 | 화면·서버 함수·자동 파기 | 교육 홈페이지와 같은 팀의 크레딧을 함께 쓴다(배포 횟수에 따라 크레딧 소모). 별도 팀이면 무료 플랜부터 |
| 이메일 발송(SMTP) | 지원자 인증코드 메일 | ① 회사 메일(Google Workspace 등) SMTP: 추가 비용 없음, 일 발송 한도 확인 ② Resend 등 발송 서비스: 무료 구간(월 수천 건 수준) 후 유료, 도메인 DNS(SPF·DKIM) 설정 필요 ③ AWS SES: 건당 과금, 설정 복잡 |
| Cloudflare Turnstile | 로봇 확인 | 무료 |
| 도메인 | 채용 사이트 주소(예: recruit.회사도메인) | 기존 회사 도메인에 하위 주소 추가(DNS 설정만) — **주소 미정** |

예상 메일량: 지원자 1명당 인증코드 1~3통. 공고 1건에 수백 명 규모면 무료 구간으로 충분한지 확인한다.

## 1. Supabase
1. 조직(예: DCCI_EDU)에서 **새 프로젝트** 생성(지역: Northeast Asia (Seoul)). DB 비밀번호는 회사가 관리하는 곳에 보관.
2. SQL Editor에서 `sql/01_schema.sql` → `02_common_public.sql` → `03_applicant.sql` → `04_admin.sql` → `05_server_only.sql` 순서로 각각 붙여 넣고 실행. (여러 번 실행해도 안전)
3. `sql/check_security.sql` 실행 → '확인 필요'가 없는지 확인. 9·12번은 `참고`(12번 `rls_auto_enable`은 프로젝트 생성 시 Enable automatic RLS가 만든 이벤트 트리거 함수로, API로 호출할 수 없어 정상).
4. **Authentication → Sign In / Providers → Email**
   - Enable Email provider: 켬, Confirm email: 켬, Allow new users to sign up: **켬**(지원자 이메일 인증에 필요)
   - Email OTP Expiration: 600초(10분) 권장, OTP Length: 6
5. **Authentication → Emails → Templates → Magic Link**: 본문에 인증코드가 보이게 `{{ .Token }}`을 넣는다(링크 대신 코드 입력 방식). 예:
   ```
   <h2>대구상공회의소 채용 지원 인증코드</h2>
   <p>인증코드: <strong>{{ .Token }}</strong></p>
   <p>10분 안에 입력해주세요. 요청하지 않았다면 이 메일을 무시하세요.</p>
   ```
6. **Authentication → Emails → SMTP Settings**: 0번에서 고른 SMTP 정보 입력(비밀값은 여기에만). 보내는 주소는 회사 도메인 주소.
7. **Authentication → Attack Protection → Enable Captcha protection**: Cloudflare Turnstile 선택, Turnstile **비밀 키** 입력.
   (켜면 지원자 인증코드 요청과 관리자 로그인 모두 로봇 확인이 필요하다. Supabase가 서버에서 검증하므로 화면을 거치지 않은 직접 호출도 막힌다.)
8. **Authentication → Multi-Factor**: TOTP 사용(기본 켬) 확인.
9. **Authentication → URL Configuration**: Site URL을 채용 사이트 주소로.
10. Rate Limits(Authentication → Rate Limits): 이메일 발송 한도를 SMTP 한도에 맞게 조정.
11. **Project Settings → API Keys**에서 공개용 키(anon/publishable)와 서버 키(service_role/secret)를 확인해 Netlify에 넣는다(3번).

### 슈퍼관리자 계정 만들기
1. Authentication → Users → Add user → Create new user: 회사 이메일, 비밀번호 **16자 이상·다른 곳에서 쓰지 않는 것**, Auto Confirm 체크.
2. SQL Editor에서 실행 후 쿼리 내용 삭제:
   ```sql
   UPDATE auth.users SET raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
   WHERE email = '관리자이메일';
   ```
3. `/admin.html` 로그인 → QR이 나오면 휴대폰 인증 앱(Google Authenticator 등)으로 등록 → 6자리 입력.
- 일반 담당자 계정은 관리자 화면 [담당자 계정]에서 만든다(SQL 불필요).

## 2. Cloudflare Turnstile
1. Cloudflare 대시보드 → Turnstile → Add widget. 도메인: 채용 사이트 주소(테스트 시 Netlify 주소도).
2. 사이트 키 → Netlify `TURNSTILE_SITE_KEY`, 비밀 키 → Supabase Captcha 설정(1-7).

## 3. Netlify
1. Add new site → Import from GitHub → `hitchkim84/dcci-recruit`.
2. Base directory: (비움 = 저장소 최상위), Build command: (비움), Publish directory: `public`, Functions directory: `netlify/functions` (`netlify.toml`에 이미 지정).
3. Production branch: `main`.
4. Environment variables (README 표 참고): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`(Secret, Scopes=Functions, Deploy contexts=**Production만**), `TURNSTILE_SITE_KEY`, `STAFF_EMAIL_DOMAIN`.
   - 공개 저장소이므로 외부인 PR의 Deploy Preview가 서버 키를 읽지 못하게 Production에만 둔다. 미리보기 확인이 필요하면 별도 테스트용 Supabase 프로젝트 값을 Deploy Preview 범위에 넣는다.
5. 도메인 연결(Domain management) 후 HTTPS 확인.
6. Functions → `purge`가 Scheduled로 표시되는지 확인(매일 03:10 KST).

## 4. 첫 운영 전 확인 (운영 확인 — 실제 환경에서만 가능)
`docs/OPERATIONS.md`의 '운영 점검표'를 따라 실제 메일 수신, 로봇 확인, OTP, 업로드·열람, 링크 만료(60초 후), 담당자 권한 차단을 확인한다.
