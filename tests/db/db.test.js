// 실제 PostgreSQL에서 DB 함수·권한을 확인한다. tests/db/run.sh가 임시 DB를 만든 뒤 실행한다(직접 실행하지 않음).
// 로그인 상태는 Supabase처럼 request.jwt.claims 설정 + 역할 전환(SET ROLE)으로 흉내 낸다.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const pool = new Pool({ max: 20 });
const U = {
  a1: '00000000-0000-4000-8000-0000000000a1',
  a2: '00000000-0000-4000-8000-0000000000a2',
  admin: '00000000-0000-4000-8000-00000000ad01',
  staff: '00000000-0000-4000-8000-000000005701',
  staff2: '00000000-0000-4000-8000-000000005702'
};
const P = {
  open: '10000000-0000-4000-8000-000000000001',
  other: '10000000-0000-4000-8000-000000000002',
  closed: '10000000-0000-4000-8000-000000000003',
  upcoming: '10000000-0000-4000-8000-000000000004',
  edit: '10000000-0000-4000-8000-000000000005'
};

const applicant = (sub, email) => ({ role: 'authenticated', sub, email, aal: 'aal1', amr: [{ method: 'otp' }], app_metadata: {} });
const C = {
  anon: { role: 'anon' },
  a1: applicant(U.a1, 'a1@example.com'),
  a2: applicant(U.a2, 'a2@example.com'),
  super: { role: 'authenticated', sub: U.admin, email: 'admin@example.com', aal: 'aal2', amr: [{ method: 'totp' }, { method: 'password' }], app_metadata: { role: 'admin' } },
  superAal1: { role: 'authenticated', sub: U.admin, email: 'admin@example.com', aal: 'aal1', amr: [{ method: 'password' }], app_metadata: { role: 'admin' } },
  staff: { role: 'authenticated', sub: U.staff, email: 'kim@staff.test', aal: 'aal1', amr: [{ method: 'password' }], app_metadata: { role: 'staff' } },
  staffOtp: { role: 'authenticated', sub: U.staff, email: 'kim@staff.test', aal: 'aal1', amr: [{ method: 'otp' }], app_metadata: { role: 'staff' } },
  staff2: { role: 'authenticated', sub: U.staff2, email: 'lee@staff.test', aal: 'aal1', amr: [{ method: 'password' }], app_metadata: { role: 'staff' } },
  service: { role: 'service_role' }
};

// claims로 로그인한 상태에서 SQL 실행
async function as(claims, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${claims.role}`);
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r.rows;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
const call = async (claims, fn, args = []) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await as(claims, `SELECT public.${fn}(${ph}) AS r`, args);
  return rows[0].r;
};
const sys = (sql, params) => pool.query(sql, params).then(r => r.rows);
async function rejects(promise, pattern, code) {
  try { await promise; } catch (e) {
    if (code) assert.strictEqual(e.code, code, `기대 오류코드 ${code}, 실제 ${e.code}: ${e.message}`);
    if (pattern) assert.match(e.message, pattern);
    return e;
  }
  assert.fail('오류가 나야 하는데 성공함');
}

const fullConfig = {
  basic: { birth: true, address: false, military: false },
  education: { use: true, required: true }, career: { use: true, required: false }, certs: { use: true, required: false },
  essays: [{ question: '지원 동기', max_len: 200, required: true }],
  attachments: [{ key: 'resume', label: '이력서', required: true }, { key: 'etc', label: '기타', required: false }],
  max_file_mb: 5
};
const goodData = {
  basic: { name: '가상지원자', phone: '010-0000-0000', birth: '1995-01-01', hacker: 'x' },
  field: '일반행정',
  education: [{ school: '가상대학교', major: '경영', degree: '학사', from: '2014-03', to: '2018-02', state: '졸업', evil: 'x' }],
  essays: ['가상 답변입니다.'],
  extra: 'should be dropped'
};

before(async () => {
  await sys(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES
    ($1,'a1@example.com','{}'),($2,'a2@example.com','{}'),($3,'admin@example.com','{"role":"admin"}'),
    ($4,'kim@staff.test','{"role":"staff"}'),($5,'lee@staff.test','{"role":"staff"}')`, [U.a1, U.a2, U.admin, U.staff, U.staff2]);
  const ins = `INSERT INTO public.postings (id, title, status, fields, opens_at, closes_at, form_config, allow_edit, allow_cancel, consent_text)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '[테스트] 가상 동의문')`;
  const fields = JSON.stringify([{ name: '일반행정', headcount: '0명', duties: '' }, { name: '전산', headcount: '0명', duties: '' }]);
  await sys(ins, [P.open, '[테스트] 접수중', 'published', fields, new Date(Date.now() - 86400e3), new Date(Date.now() + 86400e3), fullConfig, false, true]);
  await sys(ins, [P.other, '[테스트] 다른 공고', 'published', '[]', new Date(Date.now() - 86400e3), new Date(Date.now() + 86400e3), {}, false, false]);
  await sys(ins, [P.closed, '[테스트] 마감', 'published', '[]', new Date(Date.now() - 2 * 86400e3), new Date(Date.now() - 1000), {}, false, false]);
  await sys(ins, [P.upcoming, '[테스트] 예정', 'published', '[]', new Date(Date.now() + 86400e3), new Date(Date.now() + 2 * 86400e3), {}, false, false]);
  await sys(ins, [P.edit, '[테스트] 수정허용', 'published', '[]', new Date(Date.now() - 86400e3), new Date(Date.now() + 86400e3), {}, true, false]);
  await sys(`INSERT INTO public.posting_staff (posting_id, user_id) VALUES ($1, $2)`, [P.open, U.staff]);
  await sys(`INSERT INTO public.postings (title, status, opens_at, closes_at) VALUES ('[테스트] 초안', 'draft', now(), now() + interval '1 day')`);
});
after(() => pool.end());

// 업로드 완료까지(서버가 하는 finalize 포함)
async function uploadReady(claims, postingId, docKey) {
  const r = await call(claims, 'begin_attachment', [postingId, docKey, '가상.pdf', 'pdf', 1000]);
  await call(C.service, 'finalize_attachment', [r.attachment_id, true, 1000]);
  return r;
}

test('표 직접 접근 차단: anon·로그인 사용자는 어떤 표도 읽거나 쓸 수 없다', async () => {
  for (const t of ['postings', 'applications', 'attachments', 'application_reviews', 'admin_access_log', 'notices', 'site_settings', 'posting_staff']) {
    for (const who of [C.anon, C.a1, C.super, C.staff]) {
      await rejects(as(who, `SELECT * FROM public.${t} LIMIT 1`), /permission denied/);
    }
  }
  await rejects(as(C.a1, `INSERT INTO public.applications (posting_id, user_id, email) VALUES ($1, $2, 'x')`, [P.open, U.a1]), /permission denied/);
  await rejects(as(C.super, `UPDATE public.application_reviews SET stage = 'final_pass'`), /permission denied/);
});

test('함수 실행 권한: anon은 공개 조회만, 로그인 사용자는 서버 전용 함수 불가', async () => {
  const pub = await call(C.anon, 'public_postings');
  assert.ok(pub.items.every(p => p.title !== '[테스트] 초안'), '초안 공고는 공개되지 않는다');
  assert.ok(!JSON.stringify(pub).includes('receipt_seq'));
  await rejects(call(C.anon, 'my_applications'), /permission denied/);
  await rejects(call(C.anon, 'admin_postings'), /permission denied/);
  await rejects(call(C.anon, 'save_draft', [P.open, {}]), /permission denied/);
  for (const fn of ['purge_expired()', 'pending_files(10)']) {
    await rejects(as(C.a1, `SELECT public.${fn}`), /permission denied/);
    await rejects(as(C.super, `SELECT public.${fn}`), /permission denied/);
  }
  await rejects(call(C.a1, 'finalize_attachment', ['10000000-0000-4000-8000-0000000000ff', true, 1]), /permission denied/);
  await rejects(call(C.super, 'log_server_action', [U.admin, 'x', 'admin', 'fake', null, null]), /permission denied/);
});

test('임시저장 → 복구 → 검증(알 수 없는 값 제거)', async () => {
  const r = await call(C.a1, 'save_draft', [P.open, { basic: { name: '가상' } }]);
  assert.ok(r.saved_at);
  await call(C.a1, 'save_draft', [P.open, goodData]);
  const mine = await call(C.a1, 'my_application', [P.open]);
  assert.strictEqual(mine.application.status, 'draft');
  assert.strictEqual(mine.application.data.basic.name, '가상지원자');
  assert.strictEqual(mine.application.data.basic.hacker, undefined, '정해지지 않은 항목은 저장하지 않는다');
  assert.strictEqual(mine.application.data.extra, undefined);
  assert.strictEqual(mine.application.data.education[0].evil, undefined);
});

test('동의문이 없는 공고는 제출 불가', async () => {
  await sys(`UPDATE public.postings SET consent_text = '' WHERE id = $1`, [P.other]);
  await rejects(call(C.a2, 'submit_application', [P.other, { basic: { name: 'x', phone: '01000000000' } }, true, 'h']), /동의문이 등록되지 않아/);
  await sys(`UPDATE public.postings SET consent_text = '[테스트] 가상 동의문' WHERE id = $1`, [P.other]);
});

test('입력값 검증: 형식·길이·문항 글자 수·분야', async () => {
  await rejects(call(C.a1, 'save_draft', [P.open, { basic: { phone: '010-abc' } }]), /휴대폰/);
  await rejects(call(C.a1, 'save_draft', [P.open, { basic: { name: 'x'.repeat(51) } }]), /너무 깁니다/);
  await rejects(call(C.a1, 'save_draft', [P.open, { essays: ['가'.repeat(201)] }]), /200자/);
  await rejects(call(C.a1, 'save_draft', [P.open, { field: '없는분야' }]), /모집 분야/);
  await rejects(call(C.a1, 'save_draft', [P.open, { education: Array(11).fill({ school: 'x' }) }]), /최대 10개/);
  await rejects(call(C.a1, 'save_draft', [P.open, JSON.stringify('not-object')]), /형식/);
});

test('제출: 동의·필수값·필수 첨부 확인 후 접수번호 발급, 중복 클릭은 같은 접수번호', async () => {
  await rejects(call(C.a1, 'submit_application', [P.open, goodData, false, 'h']), /동의/);
  await rejects(call(C.a1, 'submit_application', [P.open, { ...goodData, basic: { name: '가상지원자', phone: '010-0000-0000' } }, true, 'h']), /생년월일/);
  await rejects(call(C.a1, 'submit_application', [P.open, { ...goodData, essays: [''] }, true, 'h']), /자기소개 1번/);
  await rejects(call(C.a1, 'submit_application', [P.open, goodData, true, 'h']), /필수 첨부서류\(이력서\)/);
  await uploadReady(C.a1, P.open, 'resume');
  const r1 = await call(C.a1, 'submit_application', [P.open, goodData, true, 'h']);
  assert.match(r1.receipt_no, /^\d{4}-\d{3}-0001$/);
  const r2 = await call(C.a1, 'submit_application', [P.open, goodData, true, 'h']);
  assert.strictEqual(r2.receipt_no, r1.receipt_no);
  assert.strictEqual(r2.duplicate, true);
  // 수정 불가 공고: 다른 내용으로 다시 제출 불가, 임시저장도 불가
  await rejects(call(C.a1, 'submit_application', [P.open, { ...goodData, essays: ['바꾼 답변'] }, true, 'h']), /수정할 수 없습니다/);
  await rejects(call(C.a1, 'save_draft', [P.open, goodData]), /이미 제출/);
  await rejects(call(C.a1, 'begin_attachment', [P.open, 'etc', 'x.pdf', 'pdf', 10]), /수정할 수 없습니다/);
  const list = await call(C.a1, 'my_applications');
  const item = list.items.find(i => i.posting_id === P.open);
  assert.strictEqual(item.status, 'submitted');
  assert.strictEqual(item.receipt_no, r1.receipt_no);
});

test('동시에 여러 번 제출해도 접수는 1건', async () => {
  const data = { basic: { name: '동시', phone: '01000000000' } };
  await call(C.a2, 'save_draft', [P.other, data]);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => call(C.a2, 'submit_application', [P.other, data, true, 'h'])));
  const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value.receipt_no);
  assert.ok(ok.length >= 1);
  assert.strictEqual(new Set(ok).size, 1, '모든 성공 응답의 접수번호가 같아야 한다');
  const rows = await sys(`SELECT count(*)::int AS n, max(receipt_seq) AS seq FROM public.applications a JOIN public.postings p ON p.id = a.posting_id WHERE p.id = $1 AND a.status = 'submitted'`, [P.other]);
  assert.strictEqual(rows[0].n, 1);
  assert.strictEqual(rows[0].seq, 1, '접수 일련번호는 한 번만 증가');
});

test('다른 지원자의 지원서·첨부파일 접근 차단', async () => {
  const mine = await call(C.a2, 'my_application', [P.open]);
  assert.strictEqual(mine.application, null, 'a2는 a1의 지원서를 볼 수 없다');
  const att = await sys(`SELECT t.id FROM public.attachments t JOIN public.applications a ON a.id = t.application_id WHERE a.user_id = $1 LIMIT 1`, [U.a1]);
  await rejects(call(C.a2, 'my_attachment', [att[0].id]), /찾을 수 없습니다/);
  await rejects(call(C.a2, 'remove_my_attachment', [att[0].id]), /찾을 수 없습니다/);
  // 서버 확인용 조회도 사용자 ID가 다르면 빈 값
  const chk = await call(C.service, 'attachment_for_check', [att[0].id, U.a2]);
  assert.strictEqual(chk, null);
  const list = await call(C.a2, 'my_applications');
  assert.ok(list.items.every(i => i.posting_id !== P.open));
});

test('접수 기간: 마감·예정·마감 처리된 공고는 저장·제출·첨부 불가 (서버 시각 기준)', async () => {
  for (const pid of [P.closed, P.upcoming]) {
    await rejects(call(C.a2, 'save_draft', [pid, {}]), /마감|접수 기간/);
    await rejects(call(C.a2, 'submit_application', [pid, { basic: { name: 'x', phone: '01000000000' } }, true, 'h']), /마감|접수 기간/);
    await rejects(call(C.a2, 'begin_attachment', [pid, 'resume', 'x.pdf', 'pdf', 10]), /마감|접수 기간/);
  }
  // 접수 중이던 공고를 관리자가 마감 처리하면 즉시 막힌다
  await call(C.a2, 'save_draft', [P.edit, { basic: { name: '임시' } }]);
  await call(C.super, 'admin_set_posting_status', [P.edit, 'closed']);
  await rejects(call(C.a2, 'save_draft', [P.edit, {}]), /마감/);
  await call(C.super, 'admin_set_posting_status', [P.edit, 'published']);
  // 마감 시각이 지나면(시각을 과거로 바꿔서 확인) 막힌다
  await sys(`UPDATE public.postings SET closes_at = now() - interval '1 second' WHERE id = $1`, [P.edit]);
  await rejects(call(C.a2, 'submit_application', [P.edit, { basic: { name: 'x', phone: '01000000000' } }, true, 'h']), /마감/);
  await sys(`UPDATE public.postings SET closes_at = now() + interval '1 day' WHERE id = $1`, [P.edit]);
});

test('제출 후 수정 허용 공고: 수정 재제출 가능, 접수번호 유지', async () => {
  const d = { basic: { name: '수정자', phone: '01000000000' } };
  const r1 = await call(C.a2, 'submit_application', [P.edit, d, true, 'h']);
  const r2 = await call(C.a2, 'submit_application', [P.edit, { basic: { name: '수정자', phone: '01011112222' } }, true, 'h']);
  assert.strictEqual(r2.receipt_no, r1.receipt_no);
  assert.strictEqual(r2.resubmitted, true);
});

test('제출 취소: 허용하지 않는 공고는 불가, 허용 공고는 임시저장으로 돌아가고 접수번호 무효', async () => {
  await rejects(call(C.a2, 'cancel_submission', [P.edit]), /허용하지 않습니다/);
  // P.open은 allow_cancel=true
  const r = await call(C.a1, 'cancel_submission', [P.open]);
  assert.strictEqual(r.ok, true);
  const mine = await call(C.a1, 'my_application', [P.open]);
  assert.strictEqual(mine.application.status, 'draft');
  assert.strictEqual(mine.application.receipt_no, null);
  const again = await call(C.a1, 'submit_application', [P.open, goodData, true, 'h']);
  assert.match(again.receipt_no, /-0002$/, '다시 제출하면 새 접수번호');
});

test('첨부: 받지 않는 서류·확장자·크기·개수 제한, 거절된 파일은 삭제 대기', async () => {
  await call(C.a2, 'save_draft', [P.open, {}]);
  await rejects(call(C.a2, 'begin_attachment', [P.open, 'unknown', 'x.pdf', 'pdf', 10]), /받지 않는 서류/);
  await rejects(call(C.a2, 'begin_attachment', [P.open, 'resume', 'x.exe', 'exe', 10]), /형식/);
  await rejects(call(C.a2, 'begin_attachment', [P.open, 'resume', 'x.pdf', 'pdf', 5 * 1048576 + 1]), /5MB/);
  const r = await call(C.a2, 'begin_attachment', [P.open, 'resume', '../../etc/passwd.pdf', 'pdf', 100]);
  assert.match(r.path, /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/, '저장 경로에 파일 이름이 들어가지 않는다');
  await call(C.service, 'finalize_attachment', [r.attachment_id, false, 100]);
  const pend = await sys(`SELECT 1 FROM public.pending_file_deletes WHERE storage_path = $1`, [r.path]);
  assert.strictEqual(pend.length, 1);
  for (let i = 0; i < 3; i++) await call(C.a2, 'begin_attachment', [P.open, 'etc', 'x.png', 'png', 10]);
  await rejects(call(C.a2, 'begin_attachment', [P.open, 'etc', 'x.png', 'png', 10]), /3개까지/);
});

test('관리자 계정으로는 지원할 수 없다', async () => {
  await rejects(call(C.super, 'save_draft', [P.open, {}]), /관리자 계정/);
  await rejects(call(C.staff, 'my_applications'), /관리자 계정/);
});

test('OTP 없는 슈퍼관리자(aal1)는 모든 관리 기능 차단', async () => {
  await rejects(call(C.superAal1, 'admin_postings'), /권한/, '42501');
  await rejects(call(C.superAal1, 'admin_applications', [P.open, '', '']), /권한/, '42501');
  await rejects(call(C.superAal1, 'admin_save_posting', [null, { title: 'x' }]), /슈퍼관리자/, '42501');
});

test('일반 담당자: 지정 공고만 조회·다운로드, 수정·삭제·계정·설정은 차단', async () => {
  const list = await call(C.staff, 'admin_postings');
  assert.deepStrictEqual(list.map(p => p.id), [P.open]);
  const apps = await call(C.staff, 'admin_applications', [P.open, '', '']);
  assert.ok(apps.length >= 1);
  await rejects(call(C.staff, 'admin_applications', [P.other, '', '']), /권한/, '42501');
  await rejects(call(C.staff2, 'admin_applications', [P.open, '', '']), /권한/, '42501');
  const otherApp = await sys(`SELECT id FROM public.applications WHERE posting_id = $1 AND status = 'submitted'`, [P.other]);
  await rejects(call(C.staff, 'admin_application', [otherApp[0].id]), /권한/, '42501');
  await rejects(call(C.staff, 'admin_export', [P.other, '']), /권한/, '42501');
  const detail = await call(C.staff, 'admin_application', [apps[0].id]);
  assert.strictEqual(detail.memo, null, '담당자에게는 내부 메모를 보여주지 않는다');
  const ex = await call(C.staff, 'admin_export', [P.open, '']);
  assert.ok(ex.length >= 1);
  const att = await sys(`SELECT t.id FROM public.attachments t JOIN public.applications a ON a.id = t.application_id WHERE a.posting_id = $1 AND a.status = 'submitted' AND t.state = 'ready' LIMIT 1`, [P.open]);
  const file = await call(C.staff, 'admin_attachment', [att[0].id]);
  assert.match(file.download_name, /^\d{4}-\d{3}-\d{4}_resume\.pdf$/);
  const otherAtt = await uploadReady(C.a2, P.edit, 'x').catch(() => null); // P.edit은 첨부 설정이 없어 실패하는 것이 정상
  assert.strictEqual(otherAtt, null);
  // 쓰기 기능 전부 차단
  const ids = `{${apps[0].id}}`;
  await rejects(call(C.staff, 'admin_save_posting', [null, { title: 'x', opens_at: '2026-01-01', closes_at: '2026-01-02' }]), /슈퍼관리자/, '42501');
  await rejects(call(C.staff, 'admin_save_posting', [P.open, { title: 'x', opens_at: '2026-01-01', closes_at: '2026-01-02' }]), /슈퍼관리자/, '42501');
  await rejects(call(C.staff, 'admin_set_posting_status', [P.open, 'closed']), /슈퍼관리자/, '42501');
  await rejects(call(C.staff, 'admin_delete_posting', [P.open]), /슈퍼관리자/, '42501');
  await rejects(call(C.staff, 'admin_set_stage', [ids, 'final_pass', null]), /슈퍼관리자/, '42501');
  await rejects(call(C.staff, 'admin_publish_results', [ids, true]), /슈퍼관리자/, '42501');
  await rejects(call(C.staff, 'admin_delete_applications', [ids]), /슈퍼관리자/, '42501');
  await rejects(call(C.staff, 'admin_set_posting_staff', [P.other, `{${U.staff}}`]), /슈퍼관리자/, '42501');
  await rejects(call(C.staff, 'admin_staff_list'), /슈퍼관리자/, '42501');
  await rejects(call(C.staff, 'admin_save_settings', [{}]), /슈퍼관리자/, '42501');
  await rejects(call(C.staff, 'admin_board'), /슈퍼관리자/, '42501');
  await rejects(call(C.staff, 'admin_logs', [10]), /슈퍼관리자/, '42501');
  await rejects(call(C.staff, 'admin_save_notice', [null, 'x', 'x', true, false]), /슈퍼관리자/, '42501');
});

test('일반 담당자라도 이메일 코드로 로그인한 경우(비밀번호 아님)는 차단', async () => {
  await rejects(call(C.staffOtp, 'admin_applications', [P.open, '', '']), /권한/, '42501');
});

test('관리자 활동 기록: 명단 조회·상세·다운로드·첨부 열람이 함수 안에서 기록된다', async () => {
  const rows = await sys(`SELECT action, user_role FROM public.admin_access_log WHERE user_id = $1`, [U.staff]);
  const actions = rows.map(r => r.action);
  for (const a of ['view_list', 'view_detail', 'download_csv', 'download_file']) assert.ok(actions.includes(a), a + ' 기록 없음');
  assert.ok(rows.every(r => r.user_role === 'staff'));
  // 기록 내용에 이름·연락처가 들어가지 않는다
  const all = await sys(`SELECT detail, target FROM public.admin_access_log`);
  assert.ok(!JSON.stringify(all).includes('가상지원자') && !JSON.stringify(all).includes('010'));
});

test('결과 공개: 담당자가 공개한 결과만 본인에게, 메모는 지원자에게 보이지 않음', async () => {
  const apps = await call(C.super, 'admin_applications', [P.open, '가상지원자', '']);
  assert.strictEqual(apps.length, 1, '이름 검색');
  const ids = `{${apps[0].id}}`;
  await call(C.super, 'admin_set_stage', [ids, 'doc_pass', '내부 메모(가상)']);
  let mine = (await call(C.a1, 'my_applications')).items.find(i => i.posting_id === P.open);
  assert.strictEqual(mine.result, null, '공개 전에는 결과가 보이지 않는다');
  await call(C.super, 'admin_publish_results', [ids, true]);
  mine = (await call(C.a1, 'my_applications')).items.find(i => i.posting_id === P.open);
  assert.strictEqual(mine.result, 'doc_pass');
  assert.ok(!JSON.stringify(mine).includes('내부 메모'));
  // 공개 후 단계를 바꿔도 공개된 결과는 그대로(다시 공개해야 반영)
  await call(C.super, 'admin_set_stage', [ids, 'final_fail', null]);
  mine = (await call(C.a1, 'my_applications')).items.find(i => i.posting_id === P.open);
  assert.strictEqual(mine.result, 'doc_pass');
  const filtered = await call(C.super, 'admin_applications', [P.open, '', 'final_fail']);
  assert.strictEqual(filtered.length, 1, '전형 단계 필터');
});

test('공고 관리: 등록 검증, 지원서가 있는 공고는 삭제 불가, 담당자 지정은 staff만', async () => {
  await rejects(call(C.super, 'admin_save_posting', [null, { title: '' }]), /제목/);
  await rejects(call(C.super, 'admin_save_posting', [null, { title: 'x', opens_at: '2026-01-02T00:00:00+09:00', closes_at: '2026-01-01T00:00:00+09:00' }]), /마감은 시작보다/);
  await rejects(call(C.super, 'admin_save_posting', [null, { title: 'x', opens_at: '2026-01-01T00:00:00+09:00', closes_at: '2026-01-02T00:00:00+09:00',
    form_config: { attachments: [{ key: 'Bad Key', label: 'x' }] } }]), /구분값/);
  const r = await call(C.super, 'admin_save_posting', [null, { title: '[테스트] 새 공고', opens_at: '2026-10-01T09:00:00+09:00', closes_at: '2026-10-10T18:00:00+09:00',
    form_config: { essays: [{ question: 'Q', max_len: 99999 }] } }]);
  const p = await call(C.super, 'admin_posting', [r.id]);
  assert.strictEqual(p.status, 'draft', '새 공고는 초안');
  assert.strictEqual(p.form_config.essays[0].max_len, 5000, '글자 수 상한 보정');
  assert.strictEqual(new Date(p.closes_at).toISOString(), '2026-10-10T09:00:00.000Z', '한국 시간 18:00 = UTC 09:00');
  await rejects(call(C.super, 'admin_delete_posting', [P.open]), /삭제할 수 없습니다/);
  await rejects(call(C.super, 'admin_set_posting_staff', [P.other, `{${U.a1}}`]), /일반 담당자 계정만/);
  await call(C.super, 'admin_delete_posting', [r.id]);
});

test('지원서 삭제(슈퍼관리자): 첨부파일도 삭제 대기 목록으로', async () => {
  const apps = await call(C.super, 'admin_applications', [P.open, '', '']);
  const before = await sys(`SELECT count(*)::int AS n FROM public.attachments t JOIN public.applications a ON a.id = t.application_id WHERE a.id = $1`, [apps[0].id]);
  const r = await call(C.super, 'admin_delete_applications', [`{${apps[0].id}}`]);
  assert.strictEqual(r.deleted, 1);
  assert.strictEqual(r.paths.length, before[0].n);
  const pend = await sys(`SELECT count(*)::int AS n FROM public.pending_file_deletes WHERE storage_path = ANY($1)`, [r.paths]);
  assert.strictEqual(pend[0].n, before[0].n);
});

test('자동 파기: 보관기한이 지난 공고의 지원서·첨부만 삭제, 기한 미정은 유지', async () => {
  const keep = await sys(`SELECT count(*)::int AS n FROM public.applications WHERE posting_id = $1`, [P.edit]);
  await sys(`UPDATE public.postings SET retention_until = (now() AT TIME ZONE 'Asia/Seoul')::date - 1 WHERE id = $1`, [P.other]);
  await sys(`UPDATE public.postings SET retention_until = (now() AT TIME ZONE 'Asia/Seoul')::date WHERE id = $1`, [P.open]); // 오늘까지 보관 → 아직 삭제 안 함
  await sys(`UPDATE public.attachments SET created_at = now() - interval '2 days' WHERE state = 'pending'`);
  const r = await call(C.service, 'purge_expired');
  assert.strictEqual(r.applications, 1, 'P.other 지원서 1건만 삭제');
  assert.ok(r.stale_uploads >= 1, '하루 지난 미완료 업로드 정리');
  const left = await sys(`SELECT count(*)::int AS n FROM public.applications WHERE posting_id = $1`, [P.other]);
  assert.strictEqual(left[0].n, 0);
  const kept = await sys(`SELECT count(*)::int AS n FROM public.applications WHERE posting_id = $1`, [P.edit]);
  assert.strictEqual(kept[0].n, keep[0].n, '보관기한이 비어 있으면 지우지 않는다');
  const open = await sys(`SELECT count(*)::int AS n FROM public.applications WHERE posting_id = $1`, [P.open]);
  assert.ok(open[0].n >= 1, '보관기한 당일은 지우지 않는다');
  const files = await call(C.service, 'pending_files', [100]);
  assert.ok(files.length >= 1);
  const n = await call(C.service, 'files_deleted', [`{${files.join(',')}}`]);
  assert.strictEqual(n, files.length);
  await call(C.service, 'record_purge', ['test', r.applications, n, 0, 0, true, null]);
  const logs = await call(C.super, 'admin_logs', [10]);
  assert.strictEqual(logs.purge[0].applications_deleted, 1);
  assert.strictEqual(logs.pending_files, 0);
});

test('기록 보관 일수: 365일 미만 설정 불가, 정해진 경우만 오래된 기록 삭제', async () => {
  await rejects(call(C.super, 'admin_save_settings', [{ log_retention_days: '30' }]), /365일/);
  await sys(`INSERT INTO public.admin_access_log (action, created_at) VALUES ('old', now() - interval '800 days')`);
  let r = await call(C.service, 'purge_expired');
  assert.strictEqual(r.logs, 0, '미정이면 지우지 않는다');
  await call(C.super, 'admin_save_settings', [{ log_retention_days: '730', contact_phone: '' }]);
  r = await call(C.service, 'purge_expired');
  assert.strictEqual(r.logs, 1);
});
