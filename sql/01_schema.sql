-- =====================================================================
-- 01_schema.sql : 채용 홈페이지 표(테이블)·저장소(Storage)·접근 차단
-- Supabase SQL Editor에서 01 → 02 → 03 → 04 → 05 순서로 실행한다.
-- 여러 번 실행해도 안전하게 작성했다(이미 있으면 건너뜀).
--
-- 접근 원칙
--  * 모든 표에 RLS를 켜고 정책(policy)을 하나도 만들지 않는다 = 홈페이지 키(anon)·로그인 사용자
--    (authenticated)는 표를 직접 읽거나 쓸 수 없다.
--  * 화면은 02~05의 DB 함수로만 데이터를 다룬다. 함수 안에서 로그인한 사람(auth.uid())과
--    등급(app_metadata.role)·OTP 여부(aal)·지정 공고를 확인한다.
--  * 첨부파일 저장소(applicant-files)는 비공개이고 Storage 정책도 만들지 않는다 = 서버 키만 접근.
-- =====================================================================

-- 사이트 설정(1줄): 문의처·개인정보 안내문 기본값 등. 확정되지 않은 값은 비워 둔다.
CREATE TABLE IF NOT EXISTS public.site_settings (
  id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.site_settings (id, data) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;

-- 채용공고
CREATE TABLE IF NOT EXISTS public.postings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq_no          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'archived')),
  employment_type text NOT NULL DEFAULT '' CHECK (char_length(employment_type) <= 100),
  fields          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fields) = 'array'),  -- [{name, headcount, duties}]
  qualifications  text NOT NULL DEFAULT '',
  preferences     text NOT NULL DEFAULT '',
  conditions      text NOT NULL DEFAULT '',
  process         text NOT NULL DEFAULT '',
  documents       text NOT NULL DEFAULT '',
  contact         text NOT NULL DEFAULT '',
  etc             text NOT NULL DEFAULT '',
  opens_at        timestamptz NOT NULL,
  closes_at       timestamptz NOT NULL,
  form_config     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(form_config) = 'object'),
  allow_edit      boolean NOT NULL DEFAULT false,   -- 마감 전 제출한 지원서 수정 허용
  allow_cancel    boolean NOT NULL DEFAULT false,   -- 마감 전 제출 취소 허용
  consent_text    text NOT NULL DEFAULT '',         -- 개인정보 수집·이용 동의문(공고별)
  retention_until date,                             -- 이 날짜가 지나면 지원서·첨부파일 자동 파기. 비어 있으면 파기하지 않음(미정)
  result_notice   text NOT NULL DEFAULT '',         -- 결과 공개 시 지원자에게 함께 보여줄 안내
  receipt_seq     int NOT NULL DEFAULT 0,           -- 접수번호 일련번호
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT postings_period_check CHECK (closes_at > opens_at)
);

-- 지원서 (공고당 1명 1건). user_id는 이메일 인증으로 만들어진 Supabase Auth 사용자
CREATE TABLE IF NOT EXISTS public.applications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_id   uuid NOT NULL REFERENCES public.postings(id) ON DELETE RESTRICT,
  user_id      uuid NOT NULL,
  email        text NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  receipt_no   text UNIQUE,
  consent_at   timestamptz,
  consent_hash text,
  submitted_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applications_one_per_posting UNIQUE (posting_id, user_id)
);
CREATE INDEX IF NOT EXISTS applications_posting_idx ON public.applications (posting_id, status);

-- 전형 상태(담당자 전용). 지원자에게는 published_stage가 채워진 경우에만 보인다.
CREATE TABLE IF NOT EXISTS public.application_reviews (
  application_id  uuid PRIMARY KEY REFERENCES public.applications(id) ON DELETE CASCADE,
  stage           text NOT NULL DEFAULT 'received',
  memo            text NOT NULL DEFAULT '' CHECK (char_length(memo) <= 2000),
  published_stage text,
  published_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 첨부서류 메타정보. 실제 파일은 Storage(applicant-files)의 storage_path에 있다.
-- 경로는 '지원서ID/첨부ID.확장자'로만 만들어 이름 등 개인정보가 경로에 들어가지 않는다.
CREATE TABLE IF NOT EXISTS public.attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES public.applications(id) ON DELETE CASCADE,
  doc_key        text NOT NULL,
  original_name  text NOT NULL DEFAULT '',
  ext            text NOT NULL,
  size_bytes     int NOT NULL DEFAULT 0,
  storage_path   text NOT NULL UNIQUE,
  state          text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_app_idx ON public.attachments (application_id);

-- 제출·취소·재제출 기록 (분쟁 시 확인용)
CREATE TABLE IF NOT EXISTS public.application_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES public.applications(id) ON DELETE CASCADE,
  event          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- 일반 담당자(staff)에게 지정한 공고
CREATE TABLE IF NOT EXISTS public.posting_staff (
  posting_id uuid NOT NULL REFERENCES public.postings(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (posting_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.notices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body       text NOT NULL DEFAULT '' CHECK (char_length(body) <= 20000),
  published  boolean NOT NULL DEFAULT false,
  pinned     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.faqs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question   text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 300),
  answer     text NOT NULL DEFAULT '' CHECK (char_length(answer) <= 5000),
  sort       int NOT NULL DEFAULT 0,
  published  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 관리자 활동 기록(명단 조회·상세 조회·다운로드·삭제·설정 변경 등). DB 함수와 서버 키로만 쓴다.
CREATE TABLE IF NOT EXISTS public.admin_access_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id    uuid,
  user_email text NOT NULL DEFAULT '',
  user_role  text NOT NULL DEFAULT '',
  action     text NOT NULL,
  target     text,
  detail     text
);
CREATE INDEX IF NOT EXISTS admin_access_log_created_idx ON public.admin_access_log (created_at DESC);

-- 지워야 할 Storage 파일 목록. DB 행을 먼저 지우고 경로를 여기에 남긴 뒤 서버가 실제 파일을 지운다.
-- 서버가 지우다 실패하면 남아 있다가 다음 자동 실행 때 다시 지운다.
CREATE TABLE IF NOT EXISTS public.pending_file_deletes (
  storage_path text PRIMARY KEY,
  reason       text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 자동 파기 실행 결과
CREATE TABLE IF NOT EXISTS public.purge_log (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_at               timestamptz NOT NULL DEFAULT now(),
  trigger_type         text NOT NULL DEFAULT 'schedule',
  applications_deleted int NOT NULL DEFAULT 0,
  files_deleted        int NOT NULL DEFAULT 0,
  files_failed         int NOT NULL DEFAULT 0,
  files_remaining      int NOT NULL DEFAULT 0,
  logs_deleted         int NOT NULL DEFAULT 0,
  ok                   boolean NOT NULL DEFAULT true,
  detail               text
);

-- ---------------------------------------------------------------------
-- 접근 차단: RLS 켜기 + 홈페이지 키·로그인 사용자 권한 회수 (정책은 만들지 않는다)
-- (FORCE는 쓰지 않는다: 표 주인이 만든 DB 함수(SECURITY DEFINER)는 RLS를 거치지 않고 함수 안의 확인으로 막는다)
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_settings','postings','applications','application_reviews','attachments',
                           'application_events','posting_staff','notices','faqs','admin_access_log',
                           'pending_file_deletes','purge_log'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- 앞으로 public에 새로 만드는 표·함수도 자동으로 열리지 않게 한다(Supabase 기본값은 모두 허용).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, public;

-- ---------------------------------------------------------------------
-- 첨부파일 저장소: 비공개, 최대 10MB(파일 크기는 서버·DB 함수에서도 확인)
-- Storage 정책(storage.objects policy)은 만들지 않는다 = 서버 키(service_role)만 읽고 쓸 수 있다.
-- 업로드는 서버가 권한을 확인한 뒤 발급하는 '서명된 업로드 주소'로만 한다.
-- ---------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('applicant-files', 'applicant-files', false, 10485760,
        ARRAY['application/pdf','image/jpeg','image/png','application/x-hwp','application/haansofthwp',
              'application/vnd.hancom.hwp','application/vnd.hancom.hwpx','application/hwp+zip',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/octet-stream'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit,
                               allowed_mime_types = EXCLUDED.allowed_mime_types;
