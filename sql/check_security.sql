-- =====================================================================
-- check_security.sql : 운영 DB 보안 상태 점검 (읽기 전용, 아무것도 바꾸지 않는다)
-- Supabase SQL Editor에 붙여 넣고 실행한다. 결과의 '확인 필요' 줄을 확인한다.
-- =====================================================================
WITH tbl AS (
  SELECT c.relname, c.relrowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
), checks AS (
  -- 1) 모든 표에 RLS가 켜져 있어야 한다
  SELECT 1 AS no, 'RLS 켜짐: ' || relname AS 점검, CASE WHEN relrowsecurity THEN '정상' ELSE '확인 필요' END AS 상태 FROM tbl
  UNION ALL
  -- 2) public 표에 정책이 없어야 한다(모든 접근은 DB 함수로만)
  SELECT 2, '정책 없음(public): ' || coalesce(string_agg(tablename || '.' || policyname, ', '), '없음'),
         CASE WHEN count(*) = 0 THEN '정상' ELSE '확인 필요' END
    FROM pg_policies WHERE schemaname = 'public'
  UNION ALL
  -- 3) 홈페이지 키(anon)·로그인 사용자(authenticated)에게 표 권한이 없어야 한다
  SELECT 3, '표 직접 권한(anon/authenticated): ' || coalesce(string_agg(DISTINCT table_name || ':' || grantee || ':' || privilege_type, ', '), '없음'),
         CASE WHEN count(*) = 0 THEN '정상' ELSE '확인 필요' END
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
  UNION ALL
  -- 4) 홈페이지 키(anon)로 실행 가능한 함수는 공개 조회 3개뿐이어야 한다
  SELECT 4, 'anon 실행 가능 함수: ' || coalesce(string_agg(p.proname, ', ' ORDER BY p.proname), '없음'),
         CASE WHEN coalesce(array_agg(p.proname::text ORDER BY p.proname), ARRAY[]::text[]) <@ ARRAY['public_board','public_posting','public_postings']
              THEN '정상' ELSE '확인 필요' END
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND p.prorettype <> 'event_trigger'::regtype  -- 이벤트 트리거 함수는 API로 호출할 수 없다(12번에 따로 표시)
  UNION ALL
  -- 5) 서버 전용 함수는 로그인 사용자도 실행할 수 없어야 한다
  SELECT 5, '서버 전용 함수를 authenticated가 실행 가능: ' || coalesce(string_agg(p.proname, ', '), '없음'),
         CASE WHEN count(*) = 0 THEN '정상' ELSE '확인 필요' END
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('finalize_attachment','attachment_for_check','purge_expired','pending_files','files_deleted','record_purge','log_server_action')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  UNION ALL
  -- 6) SECURITY DEFINER 함수는 search_path가 고정되어 있어야 한다
  SELECT 6, 'search_path 미고정 DEFINER 함수: ' || coalesce(string_agg(p.proname, ', '), '없음'),
         CASE WHEN count(*) = 0 THEN '정상' ELSE '확인 필요' END
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef AND NOT coalesce(p.proconfig::text[] && ARRAY['search_path=""', 'search_path='], false)
     AND p.prorettype <> 'event_trigger'::regtype
  UNION ALL
  -- 7) 첨부파일 저장소는 비공개여야 한다
  SELECT 7, '첨부 저장소 비공개(applicant-files)',
         CASE WHEN EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'applicant-files' AND public = false) THEN '정상' ELSE '확인 필요' END
  UNION ALL
  -- 8) Storage 정책이 없어야 한다(서버 키만 접근). 다른 용도의 정책이 있으면 applicant-files를 허용하지 않는지 확인
  SELECT 8, 'Storage 정책: ' || coalesce(string_agg(policyname, ', '), '없음'),
         CASE WHEN count(*) = 0 THEN '정상' ELSE '확인 필요' END
    FROM pg_policies WHERE schemaname = 'storage'
  UNION ALL
  -- 9) 관리자 계정 현황 (이메일은 표시하지 않음)
  SELECT 9, '관리자 계정 수: 슈퍼관리자 ' || count(*) FILTER (WHERE raw_app_meta_data ->> 'role' = 'admin')
            || '명, 일반 담당자 ' || count(*) FILTER (WHERE raw_app_meta_data ->> 'role' = 'staff') || '명', '참고'
    FROM auth.users
  UNION ALL
  -- 10) 보관기한이 비어 있는 공고(자동 파기 안 됨)
  SELECT 10, '보관기한 미입력 공고: ' || count(*) || '개 (자동 파기 대상 아님)', CASE WHEN count(*) = 0 THEN '정상' ELSE '확인 필요' END
    FROM public.postings WHERE retention_until IS NULL AND status <> 'draft'
  UNION ALL
  -- 11) 지우지 못한 파일
  SELECT 11, '삭제 대기 파일: ' || count(*) || '개', CASE WHEN count(*) = 0 THEN '정상' ELSE '확인 필요' END FROM public.pending_file_deletes
  UNION ALL
  -- 12) 이벤트 트리거 함수(예: 프로젝트 생성 시 'Enable automatic RLS'가 만든 rls_auto_enable).
  --     표를 만들 때 DB가 스스로 실행하며, 홈페이지 키로 호출하면 PostgreSQL이 거절한다(위험 없음).
  SELECT 12, '이벤트 트리거 함수(API로 호출 불가): ' || coalesce(string_agg(p.proname, ', '), '없음'), '참고'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prorettype = 'event_trigger'::regtype
)
SELECT no, 점검, 상태 FROM checks ORDER BY no, 점검;
