-- =====================================================================
-- 03_applicant.sql : 지원자 함수 (이메일 인증으로 로그인한 본인만)
-- 모든 함수가 auth.uid()로 본인 지원서만 찾는다. 다른 사람의 지원서 ID를 넣어도 찾지 못한다.
-- 접수 기간 판정은 DB 서버 시각(now())으로 한다.
-- =====================================================================

-- 수정 가능한 상태인가: 접수 중이고 (임시저장 상태이거나, 제출 후 수정 허용 공고)
CREATE OR REPLACE FUNCTION public.rc_app_editable(p public.postings, a public.applications) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT public.rc_posting_state(p) = 'open' AND (a.status = 'draft' OR p.allow_edit)
$$;

CREATE OR REPLACE FUNCTION public.rc_require_open(p public.postings) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF p.id IS NULL THEN RAISE EXCEPTION '공고를 찾을 수 없습니다.'; END IF;
  CASE public.rc_posting_state(p)
    WHEN 'open' THEN RETURN;
    WHEN 'upcoming' THEN RAISE EXCEPTION '아직 접수 기간이 아닙니다.';
    ELSE RAISE EXCEPTION '접수가 마감되었습니다.';
  END CASE;
END $$;

CREATE OR REPLACE FUNCTION public.rc_attachments_json(p_app_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'doc_key', t.doc_key, 'name', t.original_name,
                                               'ext', t.ext, 'size', t.size_bytes, 'created_at', t.created_at) ORDER BY t.created_at), '[]'::jsonb)
    FROM public.attachments t WHERE t.application_id = p_app_id AND t.state = 'ready'
$$;

-- 내 지원내역 목록 (공고별로 구분)
CREATE OR REPLACE FUNCTION public.my_applications() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := public.rc_applicant();
BEGIN
  RETURN jsonb_build_object('now', now(), 'email', auth.jwt() ->> 'email', 'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'posting_id', p.id, 'posting_title', p.title, 'posting_seq', p.seq_no, 'state', public.rc_posting_state(p),
      'closes_at', p.closes_at, 'status', a.status, 'receipt_no', a.receipt_no, 'submitted_at', a.submitted_at,
      'updated_at', a.updated_at, 'can_edit', public.rc_app_editable(p, a),
      'can_cancel', a.status = 'submitted' AND p.allow_cancel AND public.rc_posting_state(p) = 'open',
      'result', CASE WHEN r.published_at IS NOT NULL AND a.status = 'submitted' THEN r.published_stage END,
      'result_notice', CASE WHEN r.published_at IS NOT NULL AND a.status = 'submitted' THEN p.result_notice END,
      'result_published_at', CASE WHEN a.status = 'submitted' THEN r.published_at END
    ) ORDER BY a.created_at DESC)
    FROM public.applications a
    JOIN public.postings p ON p.id = a.posting_id
    LEFT JOIN public.application_reviews r ON r.application_id = a.id
    WHERE a.user_id = uid), '[]'::jsonb));
END $$;

-- 이 공고에 대한 내 지원서 (없으면 application = null). 임시저장 복구에 쓴다.
CREATE OR REPLACE FUNCTION public.my_application(p_posting_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := public.rc_applicant(); p public.postings; a public.applications;
BEGIN
  SELECT * INTO p FROM public.postings WHERE id = p_posting_id AND status IN ('published', 'closed');
  IF p.id IS NULL THEN RAISE EXCEPTION '공고를 찾을 수 없습니다.'; END IF;
  SELECT * INTO a FROM public.applications WHERE posting_id = p_posting_id AND user_id = uid;
  RETURN jsonb_build_object(
    'now', now(), 'email', auth.jwt() ->> 'email',
    'posting', public.rc_public_posting_json(p, true),
    'application', CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
      'status', a.status, 'data', a.data, 'receipt_no', a.receipt_no, 'submitted_at', a.submitted_at,
      'updated_at', a.updated_at, 'can_edit', public.rc_app_editable(p, a),
      'can_cancel', a.status = 'submitted' AND p.allow_cancel AND public.rc_posting_state(p) = 'open',
      'attachments', public.rc_attachments_json(a.id)) END);
END $$;

-- 임시저장
CREATE OR REPLACE FUNCTION public.save_draft(p_posting_id uuid, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := public.rc_applicant(); p public.postings; a public.applications; cleaned jsonb;
BEGIN
  SELECT * INTO p FROM public.postings WHERE id = p_posting_id FOR SHARE;
  PERFORM public.rc_require_open(p);
  SELECT * INTO a FROM public.applications WHERE posting_id = p_posting_id AND user_id = uid FOR UPDATE;
  IF a.status = 'submitted' THEN
    RAISE EXCEPTION '이미 제출된 지원서는 임시저장할 수 없습니다. 수정이 허용된 공고는 [수정 내용 제출]을 눌러주세요.';
  END IF;
  cleaned := public.rc_validate_application(p, p_data, false);
  INSERT INTO public.applications (posting_id, user_id, email, data)
  VALUES (p_posting_id, uid, auth.jwt() ->> 'email', cleaned)
  ON CONFLICT (posting_id, user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
  RETURNING * INTO a;
  RETURN jsonb_build_object('saved_at', a.updated_at);
END $$;

-- 최종 제출. 같은 내용으로 두 번 눌려도 한 번만 접수된다(행 잠금 + 공고당 1건 제약).
CREATE OR REPLACE FUNCTION public.submit_application(p_posting_id uuid, p_data jsonb, p_consent boolean, p_consent_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := public.rc_applicant(); p public.postings; a public.applications; cleaned jsonb;
  doc jsonb; seq int; receipt text;
BEGIN
  SELECT * INTO p FROM public.postings WHERE id = p_posting_id FOR UPDATE;
  PERFORM public.rc_require_open(p);
  IF p_consent IS NOT TRUE THEN RAISE EXCEPTION '개인정보 수집·이용에 동의해야 제출할 수 있습니다.'; END IF;
  -- 동의문 없이 개인정보를 받지 않는다(담당자가 공고에 동의문을 입력해야 접수 가능)
  IF btrim(p.consent_text) = '' THEN RAISE EXCEPTION '이 공고에 개인정보 수집·이용 동의문이 등록되지 않아 제출할 수 없습니다. 문의처로 연락해주세요.'; END IF;
  cleaned := public.rc_validate_application(p, p_data, true);

  SELECT * INTO a FROM public.applications WHERE posting_id = p_posting_id AND user_id = uid FOR UPDATE;
  IF a.id IS NULL THEN
    INSERT INTO public.applications (posting_id, user_id, email, data)
    VALUES (p_posting_id, uid, auth.jwt() ->> 'email', cleaned) RETURNING * INTO a;
  END IF;

  -- 필수 첨부서류 확인
  FOR doc IN SELECT * FROM jsonb_array_elements(coalesce(p.form_config -> 'attachments', '[]'::jsonb)) LOOP
    IF coalesce((doc ->> 'required')::boolean, false) AND NOT EXISTS (
        SELECT 1 FROM public.attachments t WHERE t.application_id = a.id AND t.doc_key = doc ->> 'key' AND t.state = 'ready') THEN
      RAISE EXCEPTION '필수 첨부서류(%)를 올려주세요.', doc ->> 'label';
    END IF;
  END LOOP;
  IF coalesce((p.form_config -> 'photo' ->> 'use')::boolean, false) AND coalesce((p.form_config -> 'photo' ->> 'required')::boolean, false)
     AND NOT EXISTS (SELECT 1 FROM public.attachments t WHERE t.application_id = a.id AND t.doc_key = 'photo' AND t.state = 'ready') THEN
    RAISE EXCEPTION '증명사진을 올려주세요.';
  END IF;

  IF a.status = 'submitted' THEN
    -- 이미 접수됨: 같은 내용이면(중복 클릭) 기존 접수번호를 돌려주고, 다른 내용이면 수정 허용 여부 확인
    IF a.data = cleaned THEN
      RETURN jsonb_build_object('receipt_no', a.receipt_no, 'submitted_at', a.submitted_at, 'duplicate', true);
    END IF;
    IF NOT p.allow_edit THEN
      RAISE EXCEPTION '이미 제출된 지원서입니다(접수번호 %). 이 공고는 제출 후 수정할 수 없습니다.', a.receipt_no;
    END IF;
    UPDATE public.applications SET data = cleaned, consent_at = now(), consent_hash = left(p_consent_hash, 128), updated_at = now()
     WHERE id = a.id RETURNING * INTO a;
    INSERT INTO public.application_events (application_id, event) VALUES (a.id, 'resubmitted');
    RETURN jsonb_build_object('receipt_no', a.receipt_no, 'submitted_at', a.submitted_at, 'updated_at', a.updated_at, 'resubmitted', true);
  END IF;

  UPDATE public.postings SET receipt_seq = receipt_seq + 1 WHERE id = p.id RETURNING receipt_seq INTO seq;
  receipt := to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY') || '-' || lpad(p.seq_no::text, 3, '0') || '-' || lpad(seq::text, 4, '0');
  UPDATE public.applications
     SET data = cleaned, status = 'submitted', receipt_no = receipt, submitted_at = now(),
         consent_at = now(), consent_hash = left(p_consent_hash, 128), updated_at = now()
   WHERE id = a.id RETURNING * INTO a;
  INSERT INTO public.application_reviews (application_id) VALUES (a.id)
    ON CONFLICT (application_id) DO UPDATE SET stage = 'received', published_stage = NULL, published_at = NULL, updated_at = now();
  INSERT INTO public.application_events (application_id, event) VALUES (a.id, 'submitted');
  RETURN jsonb_build_object('receipt_no', a.receipt_no, 'submitted_at', a.submitted_at);
END $$;

-- 제출 취소 (공고에서 허용하고 접수 중일 때만). 임시저장 상태로 돌아가며 접수번호는 무효가 된다.
CREATE OR REPLACE FUNCTION public.cancel_submission(p_posting_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := public.rc_applicant(); p public.postings; a public.applications;
BEGIN
  SELECT * INTO p FROM public.postings WHERE id = p_posting_id FOR SHARE;
  PERFORM public.rc_require_open(p);
  SELECT * INTO a FROM public.applications WHERE posting_id = p_posting_id AND user_id = uid FOR UPDATE;
  IF a.id IS NULL OR a.status <> 'submitted' THEN RAISE EXCEPTION '제출된 지원서가 없습니다.'; END IF;
  IF NOT p.allow_cancel THEN RAISE EXCEPTION '이 공고는 제출 취소를 허용하지 않습니다.'; END IF;
  UPDATE public.applications SET status = 'draft', receipt_no = NULL, submitted_at = NULL, updated_at = now() WHERE id = a.id;
  DELETE FROM public.application_reviews WHERE application_id = a.id;
  INSERT INTO public.application_events (application_id, event) VALUES (a.id, 'cancelled:' || coalesce(a.receipt_no, ''));
  RETURN jsonb_build_object('ok', true);
END $$;

-- 임시저장 지원서 삭제(제출 전, 언제든). 첨부파일 경로를 삭제 대기 목록에 넣고 돌려준다.
CREATE OR REPLACE FUNCTION public.delete_my_draft(p_posting_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := public.rc_applicant(); a public.applications; paths jsonb;
BEGIN
  SELECT * INTO a FROM public.applications WHERE posting_id = p_posting_id AND user_id = uid FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION '삭제할 지원서가 없습니다.'; END IF;
  IF a.status <> 'draft' THEN RAISE EXCEPTION '제출된 지원서는 삭제할 수 없습니다.'; END IF;
  SELECT coalesce(jsonb_agg(storage_path), '[]'::jsonb) INTO paths FROM public.attachments WHERE application_id = a.id;
  INSERT INTO public.pending_file_deletes (storage_path, reason)
    SELECT storage_path, 'draft_deleted' FROM public.attachments WHERE application_id = a.id ON CONFLICT DO NOTHING;
  DELETE FROM public.applications WHERE id = a.id;
  RETURN jsonb_build_object('paths', paths);
END $$;

-- 첨부 시작: 권한·개수·확장자·크기를 확인하고 저장 경로를 정한다. 서버가 이 경로로 서명된 업로드 주소를 만든다.
CREATE OR REPLACE FUNCTION public.begin_attachment(p_posting_id uuid, p_doc_key text, p_filename text, p_ext text, p_size int)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  uid uuid := public.rc_applicant(); p public.postings; a public.applications;
  max_mb int; v_ext text := lower(coalesce(p_ext, '')); att_id uuid := gen_random_uuid(); path text;
BEGIN
  SELECT * INTO p FROM public.postings WHERE id = p_posting_id FOR SHARE;
  PERFORM public.rc_require_open(p);
  IF p_doc_key = 'photo' THEN
    -- 증명사진(공고 설정 photo.use일 때만): JPG·PNG, 2MB 이하
    IF NOT coalesce((p.form_config -> 'photo' ->> 'use')::boolean, false) THEN RAISE EXCEPTION '이 공고에서 받지 않는 서류입니다.'; END IF;
    IF v_ext NOT IN ('jpg', 'jpeg', 'png') THEN RAISE EXCEPTION '증명사진은 JPG 또는 PNG 파일만 올릴 수 있습니다.'; END IF;
    max_mb := 2;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p.form_config -> 'attachments', '[]'::jsonb)) d WHERE d ->> 'key' = p_doc_key) THEN
      RAISE EXCEPTION '이 공고에서 받지 않는 서류입니다.';
    END IF;
    IF NOT (v_ext = ANY (public.rc_allowed_ext())) THEN RAISE EXCEPTION '올릴 수 없는 파일 형식입니다. (PDF, JPG, PNG, HWP, HWPX, DOCX)'; END IF;
    max_mb := least(greatest(coalesce((p.form_config ->> 'max_file_mb')::int, 10), 1), 10);
  END IF;
  IF p_size IS NULL OR p_size < 1 OR p_size > max_mb * 1048576 THEN RAISE EXCEPTION '파일은 %MB 이하만 올릴 수 있습니다.', max_mb; END IF;

  SELECT * INTO a FROM public.applications WHERE posting_id = p_posting_id AND user_id = uid FOR UPDATE;
  IF a.id IS NULL THEN
    INSERT INTO public.applications (posting_id, user_id, email) VALUES (p_posting_id, uid, auth.jwt() ->> 'email') RETURNING * INTO a;
  END IF;
  IF NOT public.rc_app_editable(p, a) THEN RAISE EXCEPTION '제출된 지원서는 수정할 수 없습니다.'; END IF;
  -- 증명사진은 교체 중에만 잠시 2장(새 사진을 올린 뒤 화면이 옛 사진을 지운다)
  IF p_doc_key = 'photo' AND (SELECT count(*) FROM public.attachments WHERE application_id = a.id AND doc_key = 'photo') >= 2 THEN
    RAISE EXCEPTION '증명사진은 1장만 올릴 수 있습니다. 기존 사진을 지운 뒤 올려주세요.';
  END IF;
  IF (SELECT count(*) FROM public.attachments WHERE application_id = a.id AND doc_key = p_doc_key) >= 3 THEN
    RAISE EXCEPTION '서류 한 종류에 파일은 3개까지 올릴 수 있습니다.';
  END IF;
  IF (SELECT count(*) FROM public.attachments WHERE application_id = a.id) >= 20 THEN
    RAISE EXCEPTION '첨부파일은 모두 20개까지 올릴 수 있습니다.';
  END IF;
  path := a.id::text || '/' || att_id::text || '.' || v_ext;
  INSERT INTO public.attachments (id, application_id, doc_key, original_name, ext, size_bytes, storage_path)
  VALUES (att_id, a.id, p_doc_key, left(regexp_replace(coalesce(p_filename, ''), '[\\/\x00-\x1f]', '_', 'g'), 200), v_ext, p_size, path);
  RETURN jsonb_build_object('attachment_id', att_id, 'path', path, 'max_bytes', max_mb * 1048576);
END $$;

-- 첨부 삭제 (수정 가능한 상태일 때만)
CREATE OR REPLACE FUNCTION public.remove_my_attachment(p_attachment_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := public.rc_applicant(); t public.attachments; a public.applications; p public.postings;
BEGIN
  SELECT t2.* INTO t FROM public.attachments t2 JOIN public.applications a2 ON a2.id = t2.application_id
   WHERE t2.id = p_attachment_id AND a2.user_id = uid;
  IF t.id IS NULL THEN RAISE EXCEPTION '파일을 찾을 수 없습니다.'; END IF;
  SELECT * INTO a FROM public.applications WHERE id = t.application_id FOR UPDATE;
  SELECT * INTO p FROM public.postings WHERE id = a.posting_id;
  IF NOT public.rc_app_editable(p, a) THEN RAISE EXCEPTION '지금은 첨부파일을 바꿀 수 없습니다.'; END IF;
  -- 제출된 지원서에서 필수 서류의 마지막 파일은 지울 수 없다(새 파일을 먼저 올린 뒤 지운다)
  IF a.status = 'submitted' AND t.state = 'ready'
     AND (EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p.form_config -> 'attachments', '[]'::jsonb)) d
                  WHERE d ->> 'key' = t.doc_key AND coalesce((d ->> 'required')::boolean, false))
          OR (t.doc_key = 'photo' AND coalesce((p.form_config -> 'photo' ->> 'required')::boolean, false)))
     AND (SELECT count(*) FROM public.attachments WHERE application_id = a.id AND doc_key = t.doc_key AND state = 'ready') <= 1 THEN
    RAISE EXCEPTION '제출된 지원서의 필수 서류입니다. 새 파일을 먼저 올린 뒤 지워주세요.';
  END IF;
  IF a.status = 'submitted' THEN
    INSERT INTO public.application_events (application_id, event) VALUES (a.id, 'file_removed:' || t.doc_key);
  END IF;
  INSERT INTO public.pending_file_deletes (storage_path, reason) VALUES (t.storage_path, 'applicant_removed') ON CONFLICT DO NOTHING;
  DELETE FROM public.attachments WHERE id = t.id;
  RETURN jsonb_build_object('path', t.storage_path);
END $$;

-- 내 첨부파일 열람용 경로 (본인 파일만). 서버가 짧게 유효한 서명 주소로 바꿔 준다.
CREATE OR REPLACE FUNCTION public.my_attachment(p_attachment_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := public.rc_applicant(); r record;
BEGIN
  SELECT t.storage_path, t.doc_key, t.ext INTO r FROM public.attachments t JOIN public.applications a ON a.id = t.application_id
   WHERE t.id = p_attachment_id AND a.user_id = uid AND t.state = 'ready';
  IF r.storage_path IS NULL THEN RAISE EXCEPTION '파일을 찾을 수 없습니다.'; END IF;
  RETURN jsonb_build_object('path', r.storage_path, 'download_name', 'my_' || r.doc_key || '.' || r.ext);
END $$;

REVOKE ALL ON FUNCTION public.rc_app_editable(public.postings, public.applications), public.rc_require_open(public.postings),
  public.rc_attachments_json(uuid), public.my_applications(), public.my_application(uuid), public.save_draft(uuid, jsonb),
  public.submit_application(uuid, jsonb, boolean, text), public.cancel_submission(uuid), public.delete_my_draft(uuid),
  public.begin_attachment(uuid, text, text, text, int), public.remove_my_attachment(uuid), public.my_attachment(uuid)
  FROM public, anon, authenticated;
-- 로그인한 사용자(이메일 인증)만 호출 가능. 함수 안에서 본인 여부·관리자 계정 여부를 다시 확인한다.
GRANT EXECUTE ON FUNCTION public.my_applications(), public.my_application(uuid), public.save_draft(uuid, jsonb),
  public.submit_application(uuid, jsonb, boolean, text), public.cancel_submission(uuid), public.delete_my_draft(uuid),
  public.begin_attachment(uuid, text, text, text, int), public.remove_my_attachment(uuid), public.my_attachment(uuid)
  TO authenticated;
