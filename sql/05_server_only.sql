-- =====================================================================
-- 05_server_only.sql : 서버 키(service_role)로만 호출하는 함수
--   첨부파일 확인 완료 처리, 자동 파기, 파일 삭제 대기 목록, 서버 작업 기록
-- =====================================================================

-- 서버가 업로드된 파일의 실제 형식·크기를 확인한 뒤 호출한다. 통과하면 ready, 아니면 행을 지우고 파일을 삭제 대기 목록에 넣는다.
CREATE OR REPLACE FUNCTION public.finalize_attachment(p_attachment_id uuid, p_ok boolean, p_size int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.attachments; a public.applications;
BEGIN
  SELECT * INTO t FROM public.attachments WHERE id = p_attachment_id FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION '파일을 찾을 수 없습니다.'; END IF;
  IF p_ok THEN
    UPDATE public.attachments SET state = 'ready', size_bytes = p_size WHERE id = t.id;
    SELECT * INTO a FROM public.applications WHERE id = t.application_id;
    IF a.status = 'submitted' THEN
      INSERT INTO public.application_events (application_id, event) VALUES (a.id, 'file_added:' || t.doc_key);
    END IF;
  ELSE
    INSERT INTO public.pending_file_deletes (storage_path, reason) VALUES (t.storage_path, 'rejected') ON CONFLICT DO NOTHING;
    DELETE FROM public.attachments WHERE id = t.id;
  END IF;
  RETURN jsonb_build_object('ok', p_ok);
END $$;

-- 업로드할 첨부 정보 (서버가 확인용으로 조회). 지원자 본인 것인지 함께 확인한다.
CREATE OR REPLACE FUNCTION public.attachment_for_check(p_attachment_id uuid, p_user_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', t.id, 'path', t.storage_path, 'ext', t.ext, 'state', t.state, 'declared_size', t.size_bytes,
         'max_bytes', least(greatest(coalesce((p.form_config ->> 'max_file_mb')::int, 10), 1), 10) * 1048576)
    FROM public.attachments t
    JOIN public.applications a ON a.id = t.application_id
    JOIN public.postings p ON p.id = a.posting_id
   WHERE t.id = p_attachment_id AND a.user_id = p_user_id
$$;

-- 자동 파기 1단계: 보관기한(공고의 retention_until)이 지난 지원서 삭제 + 하루 지난 미완료 업로드 정리
--   + 관리자 기록 보관 일수(site_settings.log_retention_days)가 정해져 있으면 그보다 오래된 기록 삭제.
-- 한국 날짜 기준으로 retention_until 다음 날부터 지운다. retention_until이 비어 있는 공고는 지우지 않는다.
-- 파일은 경로를 pending_file_deletes에 넣고, 서버가 Storage에서 실제로 지운다(2단계).
CREATE OR REPLACE FUNCTION public.purge_expired() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n_apps int; n_stale int; n_logs int := 0; days text;
BEGIN
  INSERT INTO public.pending_file_deletes (storage_path, reason)
    SELECT t.storage_path, 'retention' FROM public.attachments t
      JOIN public.applications a ON a.id = t.application_id JOIN public.postings p ON p.id = a.posting_id
     WHERE p.retention_until IS NOT NULL AND p.retention_until < (now() AT TIME ZONE 'Asia/Seoul')::date
    ON CONFLICT DO NOTHING;
  DELETE FROM public.applications a USING public.postings p
   WHERE p.id = a.posting_id AND p.retention_until IS NOT NULL AND p.retention_until < (now() AT TIME ZONE 'Asia/Seoul')::date;
  GET DIAGNOSTICS n_apps = ROW_COUNT;

  INSERT INTO public.pending_file_deletes (storage_path, reason)
    SELECT storage_path, 'stale_upload' FROM public.attachments WHERE state = 'pending' AND created_at < now() - interval '1 day'
    ON CONFLICT DO NOTHING;
  DELETE FROM public.attachments WHERE state = 'pending' AND created_at < now() - interval '1 day';
  GET DIAGNOSTICS n_stale = ROW_COUNT;

  SELECT data ->> 'log_retention_days' INTO days FROM public.site_settings WHERE id = 1;
  IF coalesce(days, '') ~ '^[0-9]{1,5}$' AND days::int >= 365 THEN
    DELETE FROM public.admin_access_log WHERE created_at < now() - make_interval(days => days::int);
    GET DIAGNOSTICS n_logs = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('applications', n_apps, 'stale_uploads', n_stale, 'logs', n_logs);
END $$;

CREATE OR REPLACE FUNCTION public.pending_files(p_limit int) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(storage_path), '[]'::jsonb)
    FROM (SELECT storage_path FROM public.pending_file_deletes ORDER BY created_at LIMIT least(greatest(coalesce(p_limit, 500), 1), 1000)) x
$$;

-- Storage에서 지운(또는 이미 없는) 파일을 대기 목록에서 뺀다
CREATE OR REPLACE FUNCTION public.files_deleted(p_paths text[]) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n int;
BEGIN
  DELETE FROM public.pending_file_deletes WHERE storage_path = ANY (p_paths);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.record_purge(p_trigger text, p_apps int, p_files_deleted int, p_files_failed int, p_logs int, p_ok boolean, p_detail text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.purge_log (trigger_type, applications_deleted, files_deleted, files_failed, files_remaining, logs_deleted, ok, detail)
  VALUES (left(p_trigger, 20), p_apps, p_files_deleted, p_files_failed, (SELECT count(*) FROM public.pending_file_deletes), p_logs, p_ok, left(p_detail, 1000))
$$;

-- 서버에서 한 관리 작업(계정 생성·삭제 등) 기록
CREATE OR REPLACE FUNCTION public.log_server_action(p_user_id uuid, p_email text, p_role text, p_action text, p_target text, p_detail text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.admin_access_log (user_id, user_email, user_role, action, target, detail)
  VALUES (p_user_id, left(coalesce(p_email, ''), 200), left(coalesce(p_role, ''), 20), left(p_action, 50), left(p_target, 200), left(p_detail, 500))
$$;

REVOKE ALL ON FUNCTION public.finalize_attachment(uuid, boolean, int), public.attachment_for_check(uuid, uuid), public.purge_expired(),
  public.pending_files(int), public.files_deleted(text[]), public.record_purge(text, int, int, int, int, boolean, text),
  public.log_server_action(uuid, text, text, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_attachment(uuid, boolean, int), public.attachment_for_check(uuid, uuid), public.purge_expired(),
  public.pending_files(int), public.files_deleted(text[]), public.record_purge(text, int, int, int, int, boolean, text),
  public.log_server_action(uuid, text, text, text, text, text) TO service_role;
