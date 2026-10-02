-- =====================================================================
-- 02_common_public.sql : 공통 확인 함수, 지원서 입력값 검증, 공개 조회 함수
-- 모든 함수는 SET search_path = '' 로 만들고 표 이름에 public. 을 붙인다.
-- =====================================================================

-- 로그인 정보(JWT)의 관리자 등급. 지원자는 ''.
CREATE OR REPLACE FUNCTION public.rc_role() RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')
$$;

-- 슈퍼관리자: role=admin 이고 OTP까지 통과한 로그인(aal2)
CREATE OR REPLACE FUNCTION public.rc_is_super() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT public.rc_role() = 'admin' AND coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;

-- 일반 담당자: role=staff 이고 비밀번호로 로그인한 경우만(이메일 일회용 코드 로그인은 담당자 로그인으로 보지 않음)
CREATE OR REPLACE FUNCTION public.rc_is_staff() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT public.rc_role() = 'staff'
     AND coalesce(auth.jwt() -> 'amr', '[]'::jsonb) @> '[{"method":"password"}]'::jsonb
$$;

-- 이 공고의 지원서를 볼 수 있는가: 슈퍼관리자 또는 이 공고에 지정된 일반 담당자
CREATE OR REPLACE FUNCTION public.rc_can_view_posting(p_posting_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.rc_is_super()
      OR (public.rc_is_staff() AND EXISTS (
            SELECT 1 FROM public.posting_staff s WHERE s.posting_id = p_posting_id AND s.user_id = auth.uid()))
$$;

CREATE OR REPLACE FUNCTION public.rc_require_super() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF NOT public.rc_is_super() THEN
    RAISE EXCEPTION '슈퍼관리자(OTP 인증)만 할 수 있는 작업입니다.' USING ERRCODE = '42501';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rc_require_viewer() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF NOT (public.rc_is_super() OR public.rc_is_staff()) THEN
    RAISE EXCEPTION '관리자 권한이 없습니다.' USING ERRCODE = '42501';
  END IF;
END $$;

-- 지원자 본인: 로그인했고 관리자 등급이 아닌 사용자. 사용자 ID를 돌려준다.
CREATE OR REPLACE FUNCTION public.rc_applicant() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR coalesce(auth.jwt() ->> 'email', '') = '' THEN
    RAISE EXCEPTION '이메일 인증이 필요합니다.' USING ERRCODE = '42501';
  END IF;
  IF public.rc_role() <> '' THEN
    RAISE EXCEPTION '관리자 계정으로는 지원할 수 없습니다.' USING ERRCODE = '42501';
  END IF;
  RETURN auth.uid();
END $$;

-- 관리자 활동 기록 (함수 안에서 호출)
CREATE OR REPLACE FUNCTION public.rc_log(p_action text, p_target text, p_detail text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.admin_access_log (user_id, user_email, user_role, action, target, detail)
  VALUES (auth.uid(), coalesce(auth.jwt() ->> 'email', ''), public.rc_role(), p_action, left(p_target, 200), left(p_detail, 500))
$$;

-- 공고 접수 상태: upcoming(접수 예정) / open(접수 중) / closed(마감). 서버 시각(now) 기준.
-- 접수 시작·마감 시각은 timestamptz로 저장하므로 한국 시간으로 입력한 값이 그대로 비교된다.
CREATE OR REPLACE FUNCTION public.rc_posting_state(p public.postings) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p.status IN ('closed', 'archived') THEN 'closed'
    WHEN p.status <> 'published' THEN 'draft'
    WHEN now() < p.opens_at THEN 'upcoming'
    WHEN now() >= p.closes_at THEN 'closed'
    ELSE 'open' END
$$;

-- 전형 단계 이름 (화면 public/js/rules.js 의 STAGES와 같게 유지)
CREATE OR REPLACE FUNCTION public.rc_stages() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['received','doc_pass','doc_fail','written_pass','written_fail','interview_pass',
               'interview_fail','final_pass','final_fail','hold']
$$;

-- 첨부 가능한 확장자 (public/js/rules.js 의 ALLOWED_EXT와 같게 유지)
CREATE OR REPLACE FUNCTION public.rc_allowed_ext() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['pdf','jpg','jpeg','png','hwp','hwpx','docx']
$$;

-- ---------------------------------------------------------------------
-- 지원서 입력값 검증. 서버(netlify/lib, public/js/rules.js)와 같은 기준.
-- p_final=false(임시저장): 길이·개수만 확인 / true(제출): 필수값까지 확인
-- 알려진 항목만 골라 정리한 jsonb를 돌려준다(그 밖의 값은 저장하지 않음).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rc_clean_items(p_arr jsonb, p_max int, p_keys text[], p_label text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE item jsonb; k text; v text; result jsonb := '[]'::jsonb; cleaned jsonb;
BEGIN
  IF p_arr IS NULL OR jsonb_typeof(p_arr) = 'null' THEN RETURN '[]'::jsonb; END IF;
  IF jsonb_typeof(p_arr) <> 'array' THEN RAISE EXCEPTION '% 형식이 올바르지 않습니다.', p_label; END IF;
  IF jsonb_array_length(p_arr) > p_max THEN RAISE EXCEPTION '%은(는) 최대 %개까지 입력할 수 있습니다.', p_label, p_max; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_arr) LOOP
    IF jsonb_typeof(item) <> 'object' THEN RAISE EXCEPTION '% 형식이 올바르지 않습니다.', p_label; END IF;
    cleaned := '{}'::jsonb;
    FOREACH k IN ARRAY p_keys LOOP
      v := coalesce(item ->> k, '');
      IF jsonb_typeof(item -> k) NOT IN ('string', 'number') AND item ? k AND jsonb_typeof(item -> k) <> 'null' THEN
        RAISE EXCEPTION '% 형식이 올바르지 않습니다.', p_label;
      END IF;
      IF char_length(v) > (CASE WHEN k = 'duties' THEN 1000 ELSE 100 END) THEN
        RAISE EXCEPTION '% 항목의 입력값이 너무 깁니다.', p_label;
      END IF;
      cleaned := cleaned || jsonb_build_object(k, btrim(v));
    END LOOP;
    -- 모든 칸이 빈 줄은 저장하지 않는다
    IF EXISTS (SELECT 1 FROM jsonb_each_text(cleaned) e WHERE e.value <> '') THEN
      result := result || jsonb_build_array(cleaned);
    END IF;
  END LOOP;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.rc_validate_application(p public.postings, p_data jsonb, p_final boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  cfg jsonb := coalesce(p.form_config, '{}'::jsonb);
  basic jsonb; b jsonb := '{}'::jsonb;
  v_name text; v_phone text; v_birth text; v_addr text; v_mil text;
  v_field text := ''; field_names text[];
  edu jsonb; car jsonb; cer jsonb;
  essays_cfg jsonb := coalesce(cfg -> 'essays', '[]'::jsonb);
  answers jsonb; ans text; out_answers jsonb := '[]'::jsonb; i int; q jsonb;
BEGIN
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION '지원서 형식이 올바르지 않습니다.'; END IF;
  IF octet_length(p_data::text) > 200000 THEN RAISE EXCEPTION '지원서 내용이 너무 깁니다.'; END IF;

  basic := coalesce(p_data -> 'basic', '{}'::jsonb);
  IF jsonb_typeof(basic) <> 'object' THEN RAISE EXCEPTION '기본정보 형식이 올바르지 않습니다.'; END IF;
  v_name  := btrim(coalesce(basic ->> 'name', ''));
  v_phone := btrim(coalesce(basic ->> 'phone', ''));
  v_birth := btrim(coalesce(basic ->> 'birth', ''));
  v_addr  := btrim(coalesce(basic ->> 'address', ''));
  v_mil   := btrim(coalesce(basic ->> 'military', ''));
  IF char_length(v_name) > 50 OR char_length(v_phone) > 20 OR char_length(v_addr) > 200 OR char_length(v_mil) > 50 THEN
    RAISE EXCEPTION '기본정보 입력값이 너무 깁니다.';
  END IF;
  IF v_phone <> '' AND (v_phone !~ '^[0-9 -]+$' OR char_length(regexp_replace(v_phone, '\D', '', 'g')) NOT BETWEEN 9 AND 11) THEN
    RAISE EXCEPTION '휴대폰 번호를 정확히 입력해주세요.';
  END IF;
  IF v_birth <> '' AND v_birth !~ '^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$' THEN
    RAISE EXCEPTION '생년월일은 YYYY-MM-DD 형식으로 입력해주세요.';
  END IF;
  IF p_final THEN
    IF v_name = '' THEN RAISE EXCEPTION '성명을 입력해주세요.'; END IF;
    IF v_phone = '' THEN RAISE EXCEPTION '휴대폰 번호를 입력해주세요.'; END IF;
    IF coalesce((cfg -> 'basic' ->> 'birth')::boolean, false) AND v_birth = '' THEN RAISE EXCEPTION '생년월일을 입력해주세요.'; END IF;
    IF coalesce((cfg -> 'basic' ->> 'address')::boolean, false) AND v_addr = '' THEN RAISE EXCEPTION '주소를 입력해주세요.'; END IF;
  END IF;
  b := jsonb_build_object('name', v_name, 'phone', v_phone);
  IF coalesce((cfg -> 'basic' ->> 'birth')::boolean, false) THEN b := b || jsonb_build_object('birth', v_birth); END IF;
  IF coalesce((cfg -> 'basic' ->> 'address')::boolean, false) THEN b := b || jsonb_build_object('address', v_addr); END IF;
  IF coalesce((cfg -> 'basic' ->> 'military')::boolean, false) THEN b := b || jsonb_build_object('military', v_mil); END IF;

  -- 모집 분야: 2개 이상이면 하나를 골라야 한다
  SELECT coalesce(array_agg(f ->> 'name'), ARRAY[]::text[]) INTO field_names
    FROM jsonb_array_elements(coalesce(p.fields, '[]'::jsonb)) f WHERE coalesce(f ->> 'name', '') <> '';
  v_field := btrim(coalesce(p_data ->> 'field', ''));
  IF array_length(field_names, 1) = 1 THEN v_field := field_names[1];
  ELSIF v_field <> '' AND NOT (v_field = ANY (field_names)) THEN RAISE EXCEPTION '모집 분야를 다시 선택해주세요.';
  ELSIF p_final AND coalesce(array_length(field_names, 1), 0) > 1 AND v_field = '' THEN RAISE EXCEPTION '지원 분야를 선택해주세요.';
  END IF;

  edu := public.rc_clean_items(p_data -> 'education', 10, ARRAY['school','major','degree','from','to','state'], '학력');
  car := public.rc_clean_items(p_data -> 'career', 20, ARRAY['org','dept','title','from','to','duties'], '경력');
  cer := public.rc_clean_items(p_data -> 'certs', 20, ARRAY['name','issuer','date'], '자격사항');
  IF NOT coalesce((cfg -> 'education' ->> 'use')::boolean, false) THEN edu := '[]'::jsonb; END IF;
  IF NOT coalesce((cfg -> 'career' ->> 'use')::boolean, false) THEN car := '[]'::jsonb; END IF;
  IF NOT coalesce((cfg -> 'certs' ->> 'use')::boolean, false) THEN cer := '[]'::jsonb; END IF;
  IF p_final THEN
    IF coalesce((cfg -> 'education' ->> 'required')::boolean, false) AND jsonb_array_length(edu) = 0 THEN RAISE EXCEPTION '학력을 1개 이상 입력해주세요.'; END IF;
    IF coalesce((cfg -> 'career' ->> 'required')::boolean, false) AND jsonb_array_length(car) = 0 THEN RAISE EXCEPTION '경력을 1개 이상 입력해주세요.'; END IF;
    IF coalesce((cfg -> 'certs' ->> 'required')::boolean, false) AND jsonb_array_length(cer) = 0 THEN RAISE EXCEPTION '자격사항을 1개 이상 입력해주세요.'; END IF;
  END IF;

  -- 자기소개(문항별 답변)
  answers := coalesce(p_data -> 'essays', '[]'::jsonb);
  IF jsonb_typeof(answers) <> 'array' THEN RAISE EXCEPTION '자기소개 형식이 올바르지 않습니다.'; END IF;
  FOR i IN 0 .. jsonb_array_length(essays_cfg) - 1 LOOP
    q := essays_cfg -> i;
    ans := coalesce(answers ->> i, '');
    IF char_length(ans) > coalesce((q ->> 'max_len')::int, 1000) THEN
      RAISE EXCEPTION '자기소개 %번 문항은 %자 이내로 작성해주세요.', i + 1, coalesce((q ->> 'max_len')::int, 1000);
    END IF;
    IF p_final AND coalesce((q ->> 'required')::boolean, false) AND btrim(ans) = '' THEN
      RAISE EXCEPTION '자기소개 %번 문항을 작성해주세요.', i + 1;
    END IF;
    out_answers := out_answers || to_jsonb(ans);
  END LOOP;

  RETURN jsonb_build_object('basic', b, 'field', v_field, 'education', edu, 'career', car, 'certs', cer, 'essays', out_answers);
END $$;

-- ---------------------------------------------------------------------
-- 공개 조회 (홈페이지 키로 호출 가능, 개인정보 없음)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rc_public_posting_json(p public.postings, p_full boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'id', p.id, 'seq_no', p.seq_no, 'title', p.title, 'employment_type', p.employment_type,
    'fields', p.fields, 'opens_at', p.opens_at, 'closes_at', p.closes_at, 'state', public.rc_posting_state(p)
  ) || CASE WHEN p_full THEN jsonb_build_object(
    'qualifications', p.qualifications, 'preferences', p.preferences, 'conditions', p.conditions,
    'process', p.process, 'documents', p.documents, 'contact', p.contact, 'etc', p.etc,
    'form_config', p.form_config, 'allow_edit', p.allow_edit, 'allow_cancel', p.allow_cancel,
    'consent_text', p.consent_text, 'retention_until', p.retention_until
  ) ELSE '{}'::jsonb END
$$;

CREATE OR REPLACE FUNCTION public.public_postings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('now', now(), 'items', coalesce(jsonb_agg(public.rc_public_posting_json(p, false) ORDER BY p.closes_at DESC), '[]'::jsonb))
    FROM public.postings p WHERE p.status IN ('published', 'closed')
$$;

CREATE OR REPLACE FUNCTION public.public_posting(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('now', now(), 'item', public.rc_public_posting_json(p, true))
    FROM public.postings p WHERE p.id = p_id AND p.status IN ('published', 'closed')
$$;

-- 공지사항·FAQ·문의처 (게시한 것만)
CREATE OR REPLACE FUNCTION public.public_board() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'notices', coalesce((SELECT jsonb_agg(jsonb_build_object('id', n.id, 'title', n.title, 'body', n.body, 'pinned', n.pinned, 'created_at', n.created_at)
                                ORDER BY n.pinned DESC, n.created_at DESC)
                           FROM public.notices n WHERE n.published), '[]'::jsonb),
    'faqs', coalesce((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'question', f.question, 'answer', f.answer) ORDER BY f.sort, f.created_at)
                        FROM public.faqs f WHERE f.published), '[]'::jsonb),
    'settings', (SELECT jsonb_build_object(
                   'contact_phone', coalesce(s.data ->> 'contact_phone', ''),
                   'contact_email', coalesce(s.data ->> 'contact_email', ''),
                   'contact_hours', coalesce(s.data ->> 'contact_hours', ''),
                   'address', coalesce(s.data ->> 'address', ''),
                   'privacy_policy', coalesce(s.data ->> 'privacy_policy', ''),
                   'process_steps', coalesce(s.data ->> 'process_steps', ''))
                 FROM public.site_settings s WHERE s.id = 1)
  )
$$;

-- 실행 권한: 공개 조회만 홈페이지 키에 연다. 나머지 내부 함수는 닫는다.
REVOKE ALL ON FUNCTION public.rc_role(), public.rc_is_super(), public.rc_is_staff(), public.rc_can_view_posting(uuid),
  public.rc_require_super(), public.rc_require_viewer(), public.rc_applicant(), public.rc_log(text, text, text),
  public.rc_posting_state(public.postings), public.rc_stages(), public.rc_allowed_ext(),
  public.rc_clean_items(jsonb, int, text[], text), public.rc_validate_application(public.postings, jsonb, boolean),
  public.rc_public_posting_json(public.postings, boolean),
  public.public_postings(), public.public_posting(uuid), public.public_board() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_postings(), public.public_posting(uuid), public.public_board() TO anon, authenticated, service_role;
