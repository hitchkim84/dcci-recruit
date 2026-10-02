// 서버 함수 단위 테스트 — Supabase를 흉내 낸 가짜(fake)로 돌린다. 실행: npm test
// 주의: 여기의 '거절' 결과는 서버 코드의 확인만 증명한다. DB 권한(RLS·함수 권한)은 tests/db(실제 PostgreSQL),
//       화면까지 이어진 흐름은 tests/e2e, 운영 상태는 sql/check_security.sql로 확인한다.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

// ---- 가짜 Supabase --------------------------------------------------------
function jwt(claims) { return 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s'; }
const USERS = {
  applicant: { id: 'u-app', email: 'a@example.com', app_metadata: {} },
  super: { id: 'u-sup', email: 'admin@example.com', app_metadata: { role: 'admin' } },
  staff: { id: 'u-stf', email: 'kim@staff.test', app_metadata: { role: 'staff' } }
};
const T = {
  applicant: jwt({ u: 'applicant', aal: 'aal1', amr: [{ method: 'otp' }] }),
  super: jwt({ u: 'super', aal: 'aal2', amr: [{ method: 'totp' }, { method: 'password' }] }),
  superAal1: jwt({ u: 'super', aal: 'aal1', amr: [{ method: 'password' }] }),
  staff: jwt({ u: 'staff', aal: 'aal1', amr: [{ method: 'password' }] }),
  staffOtp: jwt({ u: 'staff', aal: 'aal1', amr: [{ method: 'otp' }] })
};
let calls, rpcResult, storageFiles, storageFail, createdUsers, logFail;

function fakeClient(url, key, opts) {
  const auth = (opts && opts.global && opts.global.headers && opts.global.headers.Authorization) || '';
  return {
    key,
    auth: {
      async getUser(token) {
        let who;
        try { who = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).u; } catch (e) { who = null; }
        return USERS[who] ? { data: { user: USERS[who] }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } };
      },
      admin: {
        async listUsers() { return { data: { users: [{ id: 'u-stf', app_metadata: { role: 'staff' } }] }, error: null }; },
        async createUser(u) { createdUsers.push(u); return { data: { user: { id: 'new' } }, error: null }; },
        async updateUserById() { return { data: {}, error: null }; },
        async deleteUser() { return { data: {}, error: null }; }
      }
    },
    async rpc(fn, args) {
      calls.push({ fn, args, auth, key });
      if (fn === 'log_server_action' && logFail) return { data: null, error: { message: 'log down' } };
      const r = typeof rpcResult[fn] === 'function' ? rpcResult[fn](args) : rpcResult[fn];
      return r || { data: {}, error: null };
    },
    storage: {
      from() {
        return {
          async createSignedUploadUrl(p) { calls.push({ fn: 'storage.signUpload', p }); return { data: { token: 'up-token', path: p }, error: null }; },
          async createSignedUrl(p, sec, o) { calls.push({ fn: 'storage.signUrl', p, sec, o }); return { data: { signedUrl: 'https://x/sign/' + p + '?token=t&download=' + o.download }, error: null }; },
          async download(p) { const b = storageFiles[p]; return b ? { data: new Blob([b]), error: null } : { data: null, error: { message: 'nf' } }; },
          async remove(paths) { calls.push({ fn: 'storage.remove', paths }); return storageFail ? { error: { message: 'down' } } : { data: [], error: null }; }
        };
      }
    }
  };
}
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: fakeClient };
  return origLoad.apply(this, arguments);
};
Object.assign(process.env, { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-secret', STAFF_EMAIL_DOMAIN: 'staff.test' });
const F = (n) => require(path.join(__dirname, '..', '..', 'netlify', 'functions', n));
const core = require('../../netlify/lib/core');

function ev(fn, token, body, method = 'POST') {
  return F(fn).handler({ httpMethod: method, headers: token ? { authorization: 'Bearer ' + token } : {}, body: body ? JSON.stringify(body) : null, queryStringParameters: {} });
}
const json = (r) => JSON.parse(r.body);
const PID = '11111111-1111-4111-8111-111111111111';
const AID = '22222222-2222-4222-8222-222222222222';
const posting = { id: PID, fields: [{ name: 'A' }, { name: 'B' }], form_config: { basic: { birth: true }, essays: [{ question: 'q', max_len: 10, required: true }] }, consent_text: '동의문' };

beforeEach(() => {
  calls = []; storageFiles = {}; storageFail = false; createdUsers = []; logFail = false;
  rpcResult = { my_application: { data: { posting, application: null }, error: null } };
});

// ---- 공개 API
test('공개 설정값에 서버 키가 들어가지 않는다', async () => {
  const r = await F('public').handler({ httpMethod: 'GET', queryStringParameters: { r: 'config' } });
  assert.strictEqual(r.statusCode, 200);
  assert.ok(!r.body.includes('service-secret'));
});
test('공개 공고 상세: 잘못된 ID는 DB 호출 없이 400', async () => {
  const r = await F('public').handler({ httpMethod: 'GET', queryStringParameters: { r: 'posting', id: "1' or 1=1" } });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(calls.length, 0);
});

// ---- 지원자 API
test('지원자 API: 로그인 없으면 401, 관리자 계정이면 403', async () => {
  assert.strictEqual((await ev('applicant', null, { action: 'my_list' })).statusCode, 401);
  assert.strictEqual((await ev('applicant', 'garbage', { action: 'my_list' })).statusCode, 401);
  assert.strictEqual((await ev('applicant', T.super, { action: 'my_list' })).statusCode, 403);
  assert.strictEqual((await ev('applicant', T.staff, { action: 'my_list' })).statusCode, 403);
});
test('지원자 API: 본인 권한(토큰)으로 DB 함수를 부른다(서버 키 아님)', async () => {
  await ev('applicant', T.applicant, { action: 'my_list' });
  assert.strictEqual(calls[0].fn, 'my_applications');
  assert.strictEqual(calls[0].auth, 'Bearer ' + T.applicant);
  assert.strictEqual(calls[0].key, 'anon');
});
test('지원자 API: 잘못된 형식·알 수 없는 동작 거절', async () => {
  assert.strictEqual((await ev('applicant', T.applicant, { action: 'save', posting_id: 'x' })).statusCode, 400);
  assert.strictEqual((await ev('applicant', T.applicant, { action: '__proto__' })).statusCode, 400);
  assert.strictEqual((await F('applicant').handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + T.applicant }, body: '[1,2]' })).statusCode, 400);
  assert.strictEqual((await ev('applicant', T.applicant, { action: 'my_list' }, 'GET')).statusCode, 405);
});
test('지원자 API: 서버에서 입력값 검증(DB 저장 전 거절)', async () => {
  let r = await ev('applicant', T.applicant, { action: 'save', posting_id: PID, data: { basic: { phone: '010-abcd' } } });
  assert.strictEqual(r.statusCode, 400);
  assert.match(json(r).msg, /휴대폰/);
  r = await ev('applicant', T.applicant, { action: 'submit', posting_id: PID, consent: true, data: { basic: { name: '가', phone: '01012345678' }, field: 'A', essays: ['x'] } });
  assert.match(json(r).msg, /생년월일/);
  r = await ev('applicant', T.applicant, { action: 'submit', posting_id: PID, consent: true, data: { basic: { name: '가', phone: '01012345678', birth: '2000-01-01' }, essays: ['x'] } });
  assert.match(json(r).msg, /지원 분야/);
  r = await ev('applicant', T.applicant, { action: 'submit', posting_id: PID, consent: true, data: { basic: { name: '가', phone: '01012345678', birth: '2000-01-01' }, field: 'A', essays: ['12345678901'] } });
  assert.match(json(r).msg, /10자/);
  r = await ev('applicant', T.applicant, { action: 'submit', posting_id: PID, consent: false, data: {} });
  assert.match(json(r).msg, /동의/);
  assert.ok(!calls.some(c => c.fn === 'submit_application' || c.fn === 'save_draft'));
});
test('지원자 API: 제출 시 동의문 지문(해시)을 함께 저장', async () => {
  rpcResult.submit_application = { data: { receipt_no: '2026-001-0001' }, error: null };
  const r = await ev('applicant', T.applicant, { action: 'submit', posting_id: PID, consent: true, data: { basic: { name: '가', phone: '01012345678', birth: '2000-01-01' }, field: 'A', essays: ['ok'] } });
  assert.strictEqual(json(r).receipt_no, '2026-001-0001');
  const c = calls.find(x => x.fn === 'submit_application');
  assert.match(c.args.p_consent_hash, /^[0-9a-f]{64}$/);
});
test('DB 오류 문구: 업무 오류는 그대로, 내부 오류는 일반 문구(구조 노출 방지)', async () => {
  rpcResult.save_draft = { data: null, error: { code: 'P0001', message: '접수가 마감되었습니다.' } };
  let r = await ev('applicant', T.applicant, { action: 'save', posting_id: PID, data: {} });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(json(r).msg, '접수가 마감되었습니다.');
  rpcResult.save_draft = { data: null, error: { code: '42P01', message: 'relation "public.secret_table" does not exist' } };
  r = await ev('applicant', T.applicant, { action: 'save', posting_id: PID, data: {} });
  assert.strictEqual(r.statusCode, 500);
  assert.ok(!r.body.includes('secret_table'));
});
test('첨부 시작: 확장자·크기 확인 후 서명 업로드 주소', async () => {
  let r = await ev('applicant', T.applicant, { action: 'upload_begin', posting_id: PID, doc_key: 'resume', filename: 'x.exe', size: 10 });
  assert.strictEqual(r.statusCode, 400);
  r = await ev('applicant', T.applicant, { action: 'upload_begin', posting_id: PID, doc_key: 'resume', filename: 'x.pdf', size: 11 * 1048576 });
  assert.strictEqual(r.statusCode, 400);
  r = await ev('applicant', T.applicant, { action: 'upload_begin', posting_id: PID, doc_key: '../x', filename: 'x.pdf', size: 10 });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(calls.length, 0);
  rpcResult.begin_attachment = { data: { attachment_id: AID, path: 'app/att.pdf' }, error: null };
  r = await ev('applicant', T.applicant, { action: 'upload_begin', posting_id: PID, doc_key: 'resume', filename: '이력서.PDF', size: 10 });
  assert.strictEqual(json(r).token, 'up-token');
  assert.strictEqual(calls.find(c => c.fn === 'begin_attachment').args.p_ext, 'pdf');
});
test('첨부 확인: 실제 형식이 다르면 거절하고 파일 삭제, 맞으면 완료', async () => {
  rpcResult.attachment_for_check = { data: { id: AID, path: 'app/att.pdf', ext: 'pdf', state: 'pending', max_bytes: 1048576 }, error: null };
  storageFiles['app/att.pdf'] = Buffer.from('MZ fake exe');
  let r = await ev('applicant', T.applicant, { action: 'upload_done', attachment_id: AID });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(calls.find(c => c.fn === 'finalize_attachment').args.p_ok, false);
  assert.ok(calls.some(c => c.fn === 'storage.remove'));
  assert.strictEqual(calls.find(c => c.fn === 'attachment_for_check').args.p_user_id, 'u-app', '본인 ID로만 조회');
  calls = [];
  storageFiles['app/att.pdf'] = Buffer.from('%PDF-1.7 ...');
  r = await ev('applicant', T.applicant, { action: 'upload_done', attachment_id: AID });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(calls.find(c => c.fn === 'finalize_attachment').args.p_ok, true);
  calls = [];
  rpcResult.attachment_for_check = { data: null, error: null }; // 다른 사람 파일
  r = await ev('applicant', T.applicant, { action: 'upload_done', attachment_id: AID });
  assert.strictEqual(r.statusCode, 404);
});
test('본인 파일 열람: 60초 서명 주소, 다운로드 이름은 안전한 문자만', async () => {
  rpcResult.my_attachment = { data: { path: 'p/x.pdf', download_name: 'my_resume.pdf"\r\nX: y' }, error: null };
  const r = await ev('applicant', T.applicant, { action: 'file_url', attachment_id: AID });
  const sign = calls.find(c => c.fn === 'storage.signUrl');
  assert.strictEqual(sign.sec, 60);
  assert.match(sign.o.download, /^[A-Za-z0-9._-]+$/);
  assert.strictEqual(json(r).expires_in, 60);
});

// ---- 관리자 API
test('관리자 API: 등급별 차단(OTP 없는 슈퍼관리자, 이메일코드 로그인 담당자, 지원자)', async () => {
  assert.strictEqual((await ev('admin', T.superAal1, { action: 'postings' })).statusCode, 403);
  assert.strictEqual((await ev('admin', T.staffOtp, { action: 'postings' })).statusCode, 403);
  assert.strictEqual((await ev('admin', T.applicant, { action: 'postings' })).statusCode, 403);
  assert.strictEqual(calls.length, 0, '차단되면 DB를 부르지 않는다');
});
test('관리자 API: 담당자는 조회·다운로드 동작만, 나머지는 서버에서 거절', async () => {
  for (const action of ['save_posting', 'set_status', 'delete_posting', 'set_stage', 'publish', 'delete_applications', 'board', 'save_notice',
    'save_faq', 'delete_board_item', 'save_settings', 'logs', 'purge_now', 'staff_list', 'staff_create', 'staff_password', 'staff_delete', 'set_posting_staff']) {
    assert.strictEqual((await ev('admin', T.staff, { action })).statusCode, 403, action);
  }
  assert.strictEqual(calls.length, 0);
  rpcResult.admin_postings = { data: [], error: null };
  assert.strictEqual((await ev('admin', T.staff, { action: 'postings' })).statusCode, 200);
});
test('CSV: BOM, 수식 실행 방지, 개인정보 캐시 금지', async () => {
  rpcResult.admin_export = { data: [{ receipt_no: '2026-001-0001', email: 'a@x', data: { basic: { name: '=HYPERLINK("http://evil")', phone: '+82 10', birth: '' }, field: '@SUM(1)', education: [{ school: '-1+2' }] }, submitted_at: '2026-10-02T00:00:00Z', stage: 'received' }], error: null };
  const r = await ev('admin', T.staff, { action: 'export_csv', posting_id: PID });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.charCodeAt(0), 0xfeff);
  assert.ok(r.body.includes('"\'=HYPERLINK(""http://evil"")"'));
  assert.ok(r.body.includes('"\'+82 10"') && r.body.includes('"\'@SUM(1)"') && r.body.includes("\"'-1+2"));
  assert.ok(r.body.includes('2026-10-02 09:00'), '제출일시는 한국 시간');
  assert.strictEqual(r.headers['Cache-Control'], 'no-store');
});
test('공고 저장: 화면의 한국 시간 입력을 +09:00으로 변환', async () => {
  rpcResult.admin_save_posting = { data: { id: PID }, error: null };
  await ev('admin', T.super, { action: 'save_posting', data: { title: 't', opens_at: '2026-10-10T09:00', closes_at: '2026-10-20T18:00' } });
  const c = calls.find(x => x.fn === 'admin_save_posting');
  assert.strictEqual(c.args.p_data.closes_at, '2026-10-20T18:00:00+09:00');
  const bad = await ev('admin', T.super, { action: 'save_posting', data: { title: 't', opens_at: '2026-10-20T09:00', closes_at: '2026-10-10T18:00' } });
  assert.strictEqual(bad.statusCode, 400);
});
test('담당자 계정 생성: 규칙 확인, 기록 실패 시 만들지 않음, role=staff 고정', async () => {
  assert.strictEqual((await ev('admin', T.super, { action: 'staff_create', login_id: 'A B', password: 'x'.repeat(12) })).statusCode, 400);
  assert.strictEqual((await ev('admin', T.super, { action: 'staff_create', login_id: 'kim', password: 'short' })).statusCode, 400);
  assert.strictEqual((await ev('admin', T.super, { action: 'staff_create', login_id: 'kim', password: 'kim-password-1' })).statusCode, 400);
  logFail = true;
  assert.strictEqual((await ev('admin', T.super, { action: 'staff_create', login_id: 'lee', password: 'long-password-123' })).statusCode, 500);
  assert.strictEqual(createdUsers.length, 0);
  logFail = false;
  assert.strictEqual((await ev('admin', T.super, { action: 'staff_create', login_id: 'lee', password: 'long-password-123', role: 'admin' })).statusCode, 200);
  assert.deepStrictEqual(createdUsers[0].app_metadata, { role: 'staff' });
  assert.strictEqual(createdUsers[0].email, 'lee@staff.test');
});
test('지원서 삭제: 최대 100건, 삭제 후 첨부파일도 지움', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`);
  assert.strictEqual((await ev('admin', T.super, { action: 'delete_applications', ids })).statusCode, 400);
  rpcResult.admin_delete_applications = { data: { deleted: 1, paths: ['a/b.pdf'] }, error: null };
  const r = await ev('admin', T.super, { action: 'delete_applications', ids: [AID] });
  assert.strictEqual(json(r).files_deleted, 1);
  assert.deepStrictEqual(calls.find(c => c.fn === 'storage.remove').paths, ['a/b.pdf']);
  assert.ok(calls.some(c => c.fn === 'files_deleted'));
});

// ---- 자동 파기
test('자동 파기: 파일 삭제 실패는 결과에 남고(ok=false) 대기 목록에 남는다', async () => {
  const { runPurge } = require('../../netlify/lib/purge');
  let pendingCalls = 0;
  rpcResult.purge_expired = { data: { applications: 2, stale_uploads: 0, logs: 0 }, error: null };
  rpcResult.pending_files = () => (pendingCalls++ === 0 ? { data: ['a/1.pdf', 'a/2.pdf'], error: null } : { data: [], error: null });
  storageFail = true;
  const r = await runPurge('schedule');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.files_failed, 2);
  assert.ok(!calls.some(c => c.fn === 'files_deleted'), '실패한 파일은 대기 목록에서 빼지 않는다');
  const rec = calls.find(c => c.fn === 'record_purge');
  assert.strictEqual(rec.args.p_ok, false);
  assert.strictEqual(rec.args.p_apps, 2);
});

// ---- 공통 함수
test('파일 형식 확인(매직 바이트)', () => {
  assert.ok(core.sniffFile(Buffer.from('%PDF-1.4'), 'pdf'));
  assert.ok(!core.sniffFile(Buffer.from('<html>'), 'pdf'));
  assert.ok(core.sniffFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'png'));
  assert.ok(core.sniffFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'jpg'));
  assert.ok(core.sniffFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'hwp'));
  assert.ok(core.sniffFile(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....word/document.xml')]), 'docx'));
  assert.ok(!core.sniffFile(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....evil.js')]), 'docx'));
  assert.ok(core.sniffFile(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('mimetypeapplication/hwp+zip')]), 'hwpx'));
  assert.ok(!core.sniffFile(Buffer.from('%PDF-'), 'exe'));
});
test('한국 시간 변환·CSV 칸·파일 이름', () => {
  assert.strictEqual(core.kstToIso('2026-10-10T18:00'), '2026-10-10T18:00:00+09:00');
  assert.strictEqual(core.kstToIso('2026-13-10T18:00'), null);
  assert.strictEqual(core.kstToIso('2026-10-10 18:00; drop'), null);
  assert.strictEqual(core.csvCell('=1+1'), '"\'=1+1"');
  assert.strictEqual(core.csvCell('a"b'), '"a""b"');
  assert.strictEqual(core.csvCell('\tx'), '"\'\tx"');
  assert.strictEqual(core.safeFileName('../../etc/passwd'), '_.._etc_passwd');
  assert.strictEqual(core.kstText('2026-10-01T15:00:00Z'), '2026-10-02 00:00');
});
test('입력 규칙(rules.js): 화면·서버 공통', () => {
  const R = require('../../public/js/rules.js');
  assert.strictEqual(R.validateApplication(posting, { basic: {} }, false), null, '임시저장은 빈 값 허용');
  assert.strictEqual(R.validateApplication(posting, { basic: { birth: '2000-02-31x' } }, false).field, 'f-birth');
  assert.strictEqual(R.validateApplication(posting, { education: new Array(11).fill({ school: 'x' }) }, false).field, 'sec-education');
  assert.strictEqual(R.extOf('a.b.HWPX'), 'hwpx');
  assert.strictEqual(R.extOf('noext'), '');
});
