-- ⚠ 개발·로컬 검증 전용 가상 데이터. 운영 Supabase에서 실행하지 않는다.
-- 실제 기관 정보·개인정보가 아니다. 계정 비밀번호(dev_password)는 로컬 흉내 서버에서만 쓰인다.
INSERT INTO auth.users (id, email, raw_app_meta_data, dev_password) VALUES
  ('00000000-0000-4000-8000-00000000ad01', 'admin@dev.local', '{"role":"admin"}', 'dev-admin-password-0000')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.postings (id, title, status, employment_type, fields, qualifications, conditions, process, documents, contact,
  opens_at, closes_at, form_config, allow_edit, allow_cancel, consent_text, retention_until)
VALUES ('20000000-0000-4000-8000-000000000001', '[개발용 가상] 일반직 직원 채용', 'published', '[개발용 가상] 정규직',
  '[{"name":"일반행정","headcount":"0명(가상)","duties":"[개발용 가상] 업무 설명"},{"name":"전산","headcount":"0명(가상)","duties":"[개발용 가상] 업무 설명"}]',
  '[개발용 가상] 지원자격 예시', '[개발용 가상] 근무조건 예시', '[개발용 가상] 서류전형 → 면접전형', '[개발용 가상] 이력서', '[개발용 가상] 문의처 예시',
  now() - interval '1 day', now() + interval '7 days',
  '{"basic":{"birth":true,"address":false,"military":false},"education":{"use":true,"required":true},"career":{"use":true,"required":false},"certs":{"use":true,"required":false},
    "essays":[{"question":"[개발용 가상] 지원 동기","max_len":500,"required":true}],"attachments":[{"key":"resume","label":"이력서","required":true},{"key":"doc1","label":"자격증 사본","required":false}],"max_file_mb":5}',
  true, true, '[개발용 가상] 개인정보 수집·이용 동의문 예시입니다.', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.postings (id, title, status, fields, opens_at, closes_at, form_config, consent_text)
VALUES ('20000000-0000-4000-8000-000000000002', '[개발용 가상] 지난 채용(마감)', 'published', '[{"name":"일반행정","headcount":"0명(가상)","duties":""}]',
  now() - interval '30 days', now() - interval '20 days', '{}', '[개발용 가상] 동의문')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.notices (title, body, published, pinned) VALUES ('[개발용 가상] 공지사항 예시', '[개발용 가상] 공지 내용입니다.', true, true);
INSERT INTO public.faqs (question, answer, sort, published) VALUES ('[개발용 가상] 지원서를 수정할 수 있나요?', '[개발용 가상] 공고마다 다릅니다. 공고 안내를 확인하세요.', 1, true);
