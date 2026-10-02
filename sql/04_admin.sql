-- =====================================================================
-- 04_admin.sql : 관리자 함수
--   슈퍼관리자(admin + OTP, aal2): 모든 기능
--   일반 담당자(staff, 비밀번호 로그인): 지정된 공고의 지원서 조회·다운로드만
-- 조회·다운로드·변경은 함수 안에서 admin_access_log에 함께 기록한다(직접 호출해도 기록이 남음).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.admin_me() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.rc_require_viewer();
  RETURN jsonb_build_object('role', public.rc_role(), 'email', auth.jwt() ->> 'email', 'super', public.rc_is_super(),
    'now', now());
END $$;

-- 공고 목록 (슈퍼관리자: 전체 / 담당자: 지정 공고)
CREATE OR REPLACE FUNCTION public.admin_postings() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.rc_require_viewer();
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', p.id, 'seq_no', p.seq_no, 'title', p.title, 'status', p.status, 'state', public.rc_posting_state(p),
      'opens_at', p.opens_at, 'closes_at', p.closes_at, 'retention_until', p.retention_until,
      'submitted', (SELECT count(*) FROM public.applications a WHERE a.posting_id = p.id AND a.status = 'submitted'),
      'drafts', (SELECT count(*) FROM public.applications a WHERE a.posting_id = p.id AND a.status = 'draft')
    ) ORDER BY p.created_at DESC)
    FROM public.postings p WHERE public.rc_can_view_posting(p.id)), '[]'::jsonb);
END $$;

-- 공고 상세(편집용)
CREATE OR REPLACE FUNCTION public.admin_posting(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.postings;
BEGIN
  PERFORM public.rc_require_viewer();
  IF NOT public.rc_can_view_posting(p_id) THEN RAISE EXCEPTION '이 공고에 대한 권한이 없습니다.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO p FROM public.postings WHERE id = p_id;
  IF p.id IS NULL THEN RAISE EXCEPTION '공고를 찾을 수 없습니다.'; END IF;
  RETURN to_jsonb(p) || jsonb_build_object('state', public.rc_posting_state(p),
    'staff', CASE WHEN public.rc_is_super() THEN (SELECT coalesce(jsonb_agg(s.user_id), '[]'::jsonb) FROM public.posting_staff s WHERE s.posting_id = p.id) END);
END $$;

-- 공고 입력값 정리(검증)
CREATE OR REPLACE FUNCTION public.rc_clean_posting(d jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  cfg jsonb := coalesce(d -> 'form_config', '{}'::jsonb); out_cfg jsonb; fields jsonb := '[]'::jsonb; f jsonb;
  essays jsonb := '[]'::jsonb; docs jsonb := '[]'::jsonb; e jsonb; keys text[] := ARRAY[]::text[]; k text; t text;
BEGIN
  IF btrim(coalesce(d ->> 'title', '')) = '' THEN RAISE EXCEPTION '공고 제목을 입력해주세요.'; END IF;
  IF char_length(d ->> 'title') > 200 THEN RAISE EXCEPTION '공고 제목이 너무 깁니다.'; END IF;
  IF coalesce(d ->> 'opens_at', '') = '' OR coalesce(d ->> 'closes_at', '') = '' THEN RAISE EXCEPTION '접수 시작·마감 일시를 입력해주세요.'; END IF;
  IF (d ->> 'closes_at')::timestamptz <= (d ->> 'opens_at')::timestamptz THEN RAISE EXCEPTION '접수 마감은 시작보다 뒤여야 합니다.'; END IF;
  FOREACH t IN ARRAY ARRAY['qualifications','preferences','conditions','process','documents','contact','etc','consent_text','result_notice'] LOOP
    IF char_length(coalesce(d ->> t, '')) > 10000 THEN RAISE EXCEPTION '입력값이 너무 깁니다. (%)', t; END IF;
  END LOOP;
  IF jsonb_typeof(coalesce(d -> 'fields', '[]'::jsonb)) <> 'array' OR jsonb_array_length(coalesce(d -> 'fields', '[]'::jsonb)) > 20 THEN
    RAISE EXCEPTION '모집 분야는 20개까지 입력할 수 있습니다.';
  END IF;
  FOR f IN SELECT * FROM jsonb_array_elements(coalesce(d -> 'fields', '[]'::jsonb)) LOOP
    IF btrim(coalesce(f ->> 'name', '')) = '' THEN CONTINUE; END IF;
    IF char_length(f ->> 'name') > 100 OR char_length(coalesce(f ->> 'headcount', '')) > 30 OR char_length(coalesce(f ->> 'duties', '')) > 3000 THEN
      RAISE EXCEPTION '모집 분야 입력값이 너무 깁니다.';
    END IF;
    fields := fields || jsonb_build_array(jsonb_build_object('name', btrim(f ->> 'name'), 'headcount', btrim(coalesce(f ->> 'headcount', '')), 'duties', coalesce(f ->> 'duties', '')));
  END LOOP;

  IF jsonb_array_length(coalesce(cfg -> 'essays', '[]'::jsonb)) > 10 THEN RAISE EXCEPTION '자기소개 문항은 10개까지입니다.'; END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(coalesce(cfg -> 'essays', '[]'::jsonb)) LOOP
    IF btrim(coalesce(e ->> 'question', '')) = '' THEN CONTINUE; END IF;
    IF char_length(e ->> 'question') > 500 THEN RAISE EXCEPTION '자기소개 문항이 너무 깁니다.'; END IF;
    essays := essays || jsonb_build_array(jsonb_build_object('question', btrim(e ->> 'question'),
      'max_len', least(greatest(coalesce(nullif(e ->> 'max_len', '')::int, 1000), 100), 5000),
      'required', coalesce((e ->> 'required')::boolean, false)));
  END LOOP;
  IF jsonb_array_length(coalesce(cfg -> 'attachments', '[]'::jsonb)) > 10 THEN RAISE EXCEPTION '첨부서류 종류는 10개까지입니다.'; END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(coalesce(cfg -> 'attachments', '[]'::jsonb)) LOOP
    IF btrim(coalesce(e ->> 'label', '')) = '' THEN CONTINUE; END IF;
    k := coalesce(e ->> 'key', '');
    IF k !~ '^[a-z0-9_]{1,30}$' OR k = ANY (keys) THEN RAISE EXCEPTION '첨부서류 구분값(key)은 영문 소문자·숫자·_로 서로 다르게 입력해주세요.'; END IF;
    IF char_length(e ->> 'label') > 50 THEN RAISE EXCEPTION '첨부서류 이름이 너무 깁니다.'; END IF;
    keys := keys || k;
    docs := docs || jsonb_build_array(jsonb_build_object('key', k, 'label', btrim(e ->> 'label'), 'required', coalesce((e ->> 'required')::boolean, false)));
  END LOOP;
  out_cfg := jsonb_build_object(
    'basic', jsonb_build_object('birth', coalesce((cfg -> 'basic' ->> 'birth')::boolean, false),
                                'address', coalesce((cfg -> 'basic' ->> 'address')::boolean, false),
                                'military', coalesce((cfg -> 'basic' ->> 'military')::boolean, false)),
    'education', jsonb_build_object('use', coalesce((cfg -> 'education' ->> 'use')::boolean, false), 'required', coalesce((cfg -> 'education' ->> 'required')::boolean, false)),
    'career', jsonb_build_object('use', coalesce((cfg -> 'career' ->> 'use')::boolean, false), 'required', coalesce((cfg -> 'career' ->> 'required')::boolean, false)),
    'certs', jsonb_build_object('use', coalesce((cfg -> 'certs' ->> 'use')::boolean, false), 'required', coalesce((cfg -> 'certs' ->> 'required')::boolean, false)),
    'essays', essays, 'attachments', docs,
    'max_file_mb', least(greatest(coalesce(nullif(cfg ->> 'max_file_mb', '')::int, 10), 1), 10));
  RETURN jsonb_build_object('fields', fields, 'form_config', out_cfg);
END $$;

-- 공고 등록(p_id = null)·수정 (슈퍼관리자)
CREATE OR REPLACE FUNCTION public.admin_save_posting(p_id uuid, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c jsonb; new_id uuid;
BEGIN
  PERFORM public.rc_require_super();
  c := public.rc_clean_posting(p_data);
  IF p_id IS NULL THEN
    INSERT INTO public.postings (title, employment_type, fields, qualifications, preferences, conditions, process, documents,
      contact, etc, opens_at, closes_at, form_config, allow_edit, allow_cancel, consent_text, retention_until, result_notice)
    VALUES (btrim(p_data ->> 'title'), left(coalesce(p_data ->> 'employment_type', ''), 100), c -> 'fields',
      coalesce(p_data ->> 'qualifications', ''), coalesce(p_data ->> 'preferences', ''), coalesce(p_data ->> 'conditions', ''),
      coalesce(p_data ->> 'process', ''), coalesce(p_data ->> 'documents', ''), coalesce(p_data ->> 'contact', ''), coalesce(p_data ->> 'etc', ''),
      (p_data ->> 'opens_at')::timestamptz, (p_data ->> 'closes_at')::timestamptz, c -> 'form_config',
      coalesce((p_data ->> 'allow_edit')::boolean, false), coalesce((p_data ->> 'allow_cancel')::boolean, false),
      coalesce(p_data ->> 'consent_text', ''), nullif(p_data ->> 'retention_until', '')::date, coalesce(p_data ->> 'result_notice', ''))
    RETURNING id INTO new_id;
    PERFORM public.rc_log('posting_create', new_id::text, NULL);
  ELSE
    UPDATE public.postings SET title = btrim(p_data ->> 'title'), employment_type = left(coalesce(p_data ->> 'employment_type', ''), 100),
      fields = c -> 'fields', qualifications = coalesce(p_data ->> 'qualifications', ''), preferences = coalesce(p_data ->> 'preferences', ''),
      conditions = coalesce(p_data ->> 'conditions', ''), process = coalesce(p_data ->> 'process', ''), documents = coalesce(p_data ->> 'documents', ''),
      contact = coalesce(p_data ->> 'contact', ''), etc = coalesce(p_data ->> 'etc', ''),
      opens_at = (p_data ->> 'opens_at')::timestamptz, closes_at = (p_data ->> 'closes_at')::timestamptz, form_config = c -> 'form_config',
      allow_edit = coalesce((p_data ->> 'allow_edit')::boolean, false), allow_cancel = coalesce((p_data ->> 'allow_cancel')::boolean, false),
      consent_text = coalesce(p_data ->> 'consent_text', ''), retention_until = nullif(p_data ->> 'retention_until', '')::date,
      result_notice = coalesce(p_data ->> 'result_notice', ''), updated_at = now()
    WHERE id = p_id RETURNING id INTO new_id;
    IF new_id IS NULL THEN RAISE EXCEPTION '공고를 찾을 수 없습니다.'; END IF;
    PERFORM public.rc_log('posting_update', new_id::text, NULL);
  END IF;
  RETURN jsonb_build_object('id', new_id);
END $$;

-- 게시·마감·보관·초안 (슈퍼관리자)
CREATE OR REPLACE FUNCTION public.admin_set_posting_status(p_id uuid, p_status text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.rc_require_super();
  IF p_status NOT IN ('draft', 'published', 'closed', 'archived') THEN RAISE EXCEPTION '잘못된 상태입니다.'; END IF;
  UPDATE public.postings SET status = p_status, updated_at = now() WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION '공고를 찾을 수 없습니다.'; END IF;
  PERFORM public.rc_log('posting_status', p_id::text, p_status);
  RETURN jsonb_build_object('ok', true);
END $$;

-- 공고 삭제 (지원서가 하나도 없을 때만. 지원서가 있으면 '보관'을 쓴다)
CREATE OR REPLACE FUNCTION public.admin_delete_posting(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.rc_require_super();
  IF EXISTS (SELECT 1 FROM public.applications WHERE posting_id = p_id) THEN
    RAISE EXCEPTION '지원서(임시저장 포함)가 있는 공고는 삭제할 수 없습니다. [보관]을 사용해주세요.';
  END IF;
  DELETE FROM public.postings WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION '공고를 찾을 수 없습니다.'; END IF;
  PERFORM public.rc_log('posting_delete', p_id::text, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- 담당자 지정 (슈퍼관리자). 지정할 수 있는 사람은 role=staff 계정뿐이다.
CREATE OR REPLACE FUNCTION public.admin_set_posting_staff(p_posting_id uuid, p_user_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.rc_require_super();
  IF NOT EXISTS (SELECT 1 FROM public.postings WHERE id = p_posting_id) THEN RAISE EXCEPTION '공고를 찾을 수 없습니다.'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_user_ids, ARRAY[]::uuid[])) u
              WHERE NOT EXISTS (SELECT 1 FROM auth.users x WHERE x.id = u AND x.raw_app_meta_data ->> 'role' = 'staff')) THEN
    RAISE EXCEPTION '일반 담당자 계정만 지정할 수 있습니다.';
  END IF;
  DELETE FROM public.posting_staff WHERE posting_id = p_posting_id;
  INSERT INTO public.posting_staff (posting_id, user_id) SELECT DISTINCT p_posting_id, u FROM unnest(coalesce(p_user_ids, ARRAY[]::uuid[])) u;
  PERFORM public.rc_log('posting_staff', p_posting_id::text, coalesce(array_length(p_user_ids, 1), 0)::text || '명');
  RETURN jsonb_build_object('ok', true);
END $$;

-- 일반 담당자 계정 목록(지정 공고 포함) — 계정 생성·삭제는 서버(Supabase Auth 관리 API)에서 한다
CREATE OR REPLACE FUNCTION public.admin_staff_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.rc_require_super();
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email,
      'postings', (SELECT coalesce(jsonb_agg(s.posting_id), '[]'::jsonb) FROM public.posting_staff s WHERE s.user_id = u.id)) ORDER BY u.email)
    FROM auth.users u WHERE u.raw_app_meta_data ->> 'role' = 'staff'), '[]'::jsonb);
END $$;

-- 지원자 목록 (제출 완료만). 검색: 이름·접수번호·이메일·전화 일부 / 필터: 전형 단계
CREATE OR REPLACE FUNCTION public.admin_applications(p_posting_id uuid, p_q text, p_stage text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb; q text := btrim(coalesce(p_q, ''));
BEGIN
  PERFORM public.rc_require_viewer();
  IF NOT public.rc_can_view_posting(p_posting_id) THEN RAISE EXCEPTION '이 공고에 대한 권한이 없습니다.' USING ERRCODE = '42501'; END IF;
  IF char_length(q) > 100 THEN RAISE EXCEPTION '검색어가 너무 깁니다.'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'receipt_no', a.receipt_no, 'name', a.data -> 'basic' ->> 'name', 'phone', a.data -> 'basic' ->> 'phone',
      'email', a.email, 'field', a.data ->> 'field', 'submitted_at', a.submitted_at, 'updated_at', a.updated_at,
      'stage', r.stage, 'published_stage', r.published_stage, 'published_at', r.published_at,
      'files', (SELECT count(*) FROM public.attachments t WHERE t.application_id = a.id AND t.state = 'ready')
    ) ORDER BY a.submitted_at), '[]'::jsonb) INTO result
    FROM public.applications a LEFT JOIN public.application_reviews r ON r.application_id = a.id
   WHERE a.posting_id = p_posting_id AND a.status = 'submitted'
     AND (coalesce(p_stage, '') = '' OR r.stage = p_stage)
     AND (q = '' OR strpos(coalesce(a.data -> 'basic' ->> 'name', ''), q) > 0 OR strpos(coalesce(a.receipt_no, ''), q) > 0
          OR strpos(lower(a.email), lower(q)) > 0
          OR (regexp_replace(q, '\D', '', 'g') <> '' AND strpos(regexp_replace(coalesce(a.data -> 'basic' ->> 'phone', ''), '\D', '', 'g'), regexp_replace(q, '\D', '', 'g')) > 0));
  PERFORM public.rc_log('view_list', p_posting_id::text, jsonb_array_length(result)::text || '건' || CASE WHEN q <> '' THEN ' (검색)' ELSE '' END);
  RETURN result;
END $$;

-- 지원서 상세 (첨부 목록·전형 상태·제출 기록 포함)
CREATE OR REPLACE FUNCTION public.admin_application(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.applications; p public.postings; r public.application_reviews;
BEGIN
  PERFORM public.rc_require_viewer();
  SELECT * INTO a FROM public.applications WHERE id = p_id AND status = 'submitted';
  IF a.id IS NULL OR NOT public.rc_can_view_posting(a.posting_id) THEN
    RAISE EXCEPTION '지원서를 찾을 수 없거나 권한이 없습니다.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO p FROM public.postings WHERE id = a.posting_id;
  SELECT * INTO r FROM public.application_reviews WHERE application_id = a.id;
  PERFORM public.rc_log('view_detail', a.id::text, a.receipt_no);
  RETURN jsonb_build_object('id', a.id, 'receipt_no', a.receipt_no, 'email', a.email, 'data', a.data,
    'submitted_at', a.submitted_at, 'updated_at', a.updated_at, 'consent_at', a.consent_at,
    'posting', jsonb_build_object('id', p.id, 'title', p.title, 'seq_no', p.seq_no, 'form_config', p.form_config, 'fields', p.fields),
    'stage', r.stage, 'memo', CASE WHEN public.rc_is_super() THEN r.memo END,
    'published_stage', r.published_stage, 'published_at', r.published_at,
    'attachments', public.rc_attachments_json(a.id),
    'events', (SELECT coalesce(jsonb_agg(jsonb_build_object('event', e.event, 'at', e.created_at) ORDER BY e.created_at), '[]'::jsonb)
                 FROM public.application_events e WHERE e.application_id = a.id));
END $$;

-- CSV 다운로드용 데이터. 기록과 데이터 조회가 한 번에 처리되므로 기록 없이 내려받을 수 없다.
CREATE OR REPLACE FUNCTION public.admin_export(p_posting_id uuid, p_stage text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.rc_require_viewer();
  IF NOT public.rc_can_view_posting(p_posting_id) THEN RAISE EXCEPTION '이 공고에 대한 권한이 없습니다.' USING ERRCODE = '42501'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('receipt_no', a.receipt_no, 'email', a.email, 'data', a.data,
      'submitted_at', a.submitted_at, 'stage', r.stage, 'published_stage', r.published_stage) ORDER BY a.submitted_at), '[]'::jsonb)
    INTO result
    FROM public.applications a LEFT JOIN public.application_reviews r ON r.application_id = a.id
   WHERE a.posting_id = p_posting_id AND a.status = 'submitted' AND (coalesce(p_stage, '') = '' OR r.stage = p_stage);
  PERFORM public.rc_log('download_csv', p_posting_id::text, jsonb_array_length(result)::text || '건');
  RETURN result;
END $$;

-- 첨부파일 열람 허가 (서버가 이 결과로 60초짜리 서명 주소를 만든다)
CREATE OR REPLACE FUNCTION public.admin_attachment(p_attachment_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record;
BEGIN
  PERFORM public.rc_require_viewer();
  SELECT t.storage_path, t.doc_key, t.ext, a.receipt_no, a.posting_id INTO r
    FROM public.attachments t JOIN public.applications a ON a.id = t.application_id
   WHERE t.id = p_attachment_id AND t.state = 'ready' AND a.status = 'submitted';
  IF r.storage_path IS NULL OR NOT public.rc_can_view_posting(r.posting_id) THEN
    RAISE EXCEPTION '파일을 찾을 수 없거나 권한이 없습니다.' USING ERRCODE = '42501';
  END IF;
  PERFORM public.rc_log('download_file', p_attachment_id::text, r.receipt_no || ' ' || r.doc_key);
  RETURN jsonb_build_object('path', r.storage_path, 'download_name', r.receipt_no || '_' || r.doc_key || '.' || r.ext);
END $$;

-- 전형 단계·메모 변경 (슈퍼관리자, 한 번에 최대 500건)
CREATE OR REPLACE FUNCTION public.admin_set_stage(p_ids uuid[], p_stage text, p_memo text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n int;
BEGIN
  PERFORM public.rc_require_super();
  IF NOT (p_stage = ANY (public.rc_stages())) THEN RAISE EXCEPTION '잘못된 전형 단계입니다.'; END IF;
  IF coalesce(array_length(p_ids, 1), 0) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION '1~500건을 선택해주세요.'; END IF;
  IF char_length(coalesce(p_memo, '')) > 2000 THEN RAISE EXCEPTION '메모가 너무 깁니다.'; END IF;
  UPDATE public.application_reviews r SET stage = p_stage, memo = CASE WHEN p_memo IS NULL THEN r.memo ELSE p_memo END, updated_at = now()
   WHERE r.application_id = ANY (p_ids)
     AND EXISTS (SELECT 1 FROM public.applications a WHERE a.id = r.application_id AND a.status = 'submitted');
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM public.rc_log('set_stage', NULL, p_stage || ' ' || n || '건');
  RETURN jsonb_build_object('updated', n);
END $$;

-- 결과 공개/공개 취소 (슈퍼관리자). 공개하면 현재 전형 단계가 지원자 본인에게 보인다.
CREATE OR REPLACE FUNCTION public.admin_publish_results(p_ids uuid[], p_publish boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n int;
BEGIN
  PERFORM public.rc_require_super();
  IF coalesce(array_length(p_ids, 1), 0) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION '1~500건을 선택해주세요.'; END IF;
  UPDATE public.application_reviews r
     SET published_stage = CASE WHEN p_publish THEN r.stage END, published_at = CASE WHEN p_publish THEN now() END, updated_at = now()
   WHERE r.application_id = ANY (p_ids)
     AND EXISTS (SELECT 1 FROM public.applications a WHERE a.id = r.application_id AND a.status = 'submitted');
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM public.rc_log(CASE WHEN p_publish THEN 'publish_result' ELSE 'unpublish_result' END, NULL, n || '건');
  RETURN jsonb_build_object('updated', n);
END $$;

-- 지원서 삭제 (슈퍼관리자, 최대 100건). 첨부파일 경로를 삭제 대기 목록에 넣고 돌려준다. 되돌릴 수 없다.
CREATE OR REPLACE FUNCTION public.admin_delete_applications(p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n int; paths jsonb;
BEGIN
  PERFORM public.rc_require_super();
  IF coalesce(array_length(p_ids, 1), 0) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION '1~100건을 선택해주세요.'; END IF;
  SELECT coalesce(jsonb_agg(storage_path), '[]'::jsonb) INTO paths FROM public.attachments WHERE application_id = ANY (p_ids);
  INSERT INTO public.pending_file_deletes (storage_path, reason)
    SELECT storage_path, 'admin_deleted' FROM public.attachments WHERE application_id = ANY (p_ids) ON CONFLICT DO NOTHING;
  DELETE FROM public.applications WHERE id = ANY (p_ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM public.rc_log('delete_applications', NULL, '요청 ' || array_length(p_ids, 1) || '건, 삭제 ' || n || '건');
  RETURN jsonb_build_object('deleted', n, 'paths', paths);
END $$;

-- 공지사항·FAQ 관리 (슈퍼관리자)
CREATE OR REPLACE FUNCTION public.admin_board() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.rc_require_super();
  RETURN jsonb_build_object(
    'notices', (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.pinned DESC, n.created_at DESC), '[]'::jsonb) FROM public.notices n),
    'faqs', (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.sort, f.created_at), '[]'::jsonb) FROM public.faqs f),
    'settings', (SELECT data FROM public.site_settings WHERE id = 1));
END $$;

CREATE OR REPLACE FUNCTION public.admin_save_notice(p_id uuid, p_title text, p_body text, p_published boolean, p_pinned boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE new_id uuid;
BEGIN
  PERFORM public.rc_require_super();
  IF btrim(coalesce(p_title, '')) = '' THEN RAISE EXCEPTION '제목을 입력해주세요.'; END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.notices (title, body, published, pinned) VALUES (btrim(p_title), coalesce(p_body, ''), coalesce(p_published, false), coalesce(p_pinned, false)) RETURNING id INTO new_id;
  ELSE
    UPDATE public.notices SET title = btrim(p_title), body = coalesce(p_body, ''), published = coalesce(p_published, false),
      pinned = coalesce(p_pinned, false), updated_at = now() WHERE id = p_id RETURNING id INTO new_id;
    IF new_id IS NULL THEN RAISE EXCEPTION '공지를 찾을 수 없습니다.'; END IF;
  END IF;
  PERFORM public.rc_log('notice_save', new_id::text, NULL);
  RETURN jsonb_build_object('id', new_id);
END $$;

CREATE OR REPLACE FUNCTION public.admin_save_faq(p_id uuid, p_question text, p_answer text, p_sort int, p_published boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE new_id uuid;
BEGIN
  PERFORM public.rc_require_super();
  IF btrim(coalesce(p_question, '')) = '' THEN RAISE EXCEPTION '질문을 입력해주세요.'; END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.faqs (question, answer, sort, published) VALUES (btrim(p_question), coalesce(p_answer, ''), coalesce(p_sort, 0), coalesce(p_published, false)) RETURNING id INTO new_id;
  ELSE
    UPDATE public.faqs SET question = btrim(p_question), answer = coalesce(p_answer, ''), sort = coalesce(p_sort, 0),
      published = coalesce(p_published, false), updated_at = now() WHERE id = p_id RETURNING id INTO new_id;
    IF new_id IS NULL THEN RAISE EXCEPTION 'FAQ를 찾을 수 없습니다.'; END IF;
  END IF;
  PERFORM public.rc_log('faq_save', new_id::text, NULL);
  RETURN jsonb_build_object('id', new_id);
END $$;

CREATE OR REPLACE FUNCTION public.admin_delete_board_item(p_kind text, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.rc_require_super();
  IF p_kind = 'notice' THEN DELETE FROM public.notices WHERE id = p_id;
  ELSIF p_kind = 'faq' THEN DELETE FROM public.faqs WHERE id = p_id;
  ELSE RAISE EXCEPTION '잘못된 요청입니다.'; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION '항목을 찾을 수 없습니다.'; END IF;
  PERFORM public.rc_log(p_kind || '_delete', p_id::text, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- 사이트 설정 저장 (정해진 항목만)
CREATE OR REPLACE FUNCTION public.admin_save_settings(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k text; out_data jsonb := '{}'::jsonb;
BEGIN
  PERFORM public.rc_require_super();
  FOREACH k IN ARRAY ARRAY['contact_phone','contact_email','contact_hours','address','privacy_policy','process_steps','consent_default','log_retention_days'] LOOP
    IF char_length(coalesce(p_data ->> k, '')) > 20000 THEN RAISE EXCEPTION '입력값이 너무 깁니다. (%)', k; END IF;
    out_data := out_data || jsonb_build_object(k, coalesce(p_data ->> k, ''));
  END LOOP;
  IF (out_data ->> 'log_retention_days') <> '' AND (out_data ->> 'log_retention_days') !~ '^[0-9]{1,5}$' THEN
    RAISE EXCEPTION '기록 보관 일수는 숫자로 입력해주세요(비우면 삭제하지 않음).';
  END IF;
  IF (out_data ->> 'log_retention_days') <> '' AND (out_data ->> 'log_retention_days')::int < 365 THEN
    RAISE EXCEPTION '기록 보관 일수는 365일 이상으로 입력해주세요.';
  END IF;
  UPDATE public.site_settings SET data = out_data, updated_at = now() WHERE id = 1;
  PERFORM public.rc_log('settings_save', NULL, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- 활동 기록·파기 기록 조회 (슈퍼관리자)
CREATE OR REPLACE FUNCTION public.admin_logs(p_limit int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.rc_require_super();
  RETURN jsonb_build_object(
    'access', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC), '[]'::jsonb)
                 FROM (SELECT * FROM public.admin_access_log ORDER BY created_at DESC LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000)) l),
    'purge', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.run_at DESC), '[]'::jsonb)
                FROM (SELECT * FROM public.purge_log ORDER BY run_at DESC LIMIT 50) x),
    'pending_files', (SELECT count(*) FROM public.pending_file_deletes));
END $$;

REVOKE ALL ON FUNCTION public.admin_me(), public.admin_postings(), public.admin_posting(uuid), public.rc_clean_posting(jsonb),
  public.admin_save_posting(uuid, jsonb), public.admin_set_posting_status(uuid, text), public.admin_delete_posting(uuid),
  public.admin_set_posting_staff(uuid, uuid[]), public.admin_staff_list(), public.admin_applications(uuid, text, text),
  public.admin_application(uuid), public.admin_export(uuid, text), public.admin_attachment(uuid),
  public.admin_set_stage(uuid[], text, text), public.admin_publish_results(uuid[], boolean), public.admin_delete_applications(uuid[]),
  public.admin_board(), public.admin_save_notice(uuid, text, text, boolean, boolean), public.admin_save_faq(uuid, text, text, int, boolean),
  public.admin_delete_board_item(text, uuid), public.admin_save_settings(jsonb), public.admin_logs(int)
  FROM public, anon, authenticated;
-- 로그인 사용자만 호출 가능. 함수 안에서 등급·OTP·지정 공고를 확인한다.
GRANT EXECUTE ON FUNCTION public.admin_me(), public.admin_postings(), public.admin_posting(uuid),
  public.admin_save_posting(uuid, jsonb), public.admin_set_posting_status(uuid, text), public.admin_delete_posting(uuid),
  public.admin_set_posting_staff(uuid, uuid[]), public.admin_staff_list(), public.admin_applications(uuid, text, text),
  public.admin_application(uuid), public.admin_export(uuid, text), public.admin_attachment(uuid),
  public.admin_set_stage(uuid[], text, text), public.admin_publish_results(uuid[], boolean), public.admin_delete_applications(uuid[]),
  public.admin_board(), public.admin_save_notice(uuid, text, text, boolean, boolean), public.admin_save_faq(uuid, text, text, int, boolean),
  public.admin_delete_board_item(text, uuid), public.admin_save_settings(jsonb), public.admin_logs(int)
  TO authenticated;
