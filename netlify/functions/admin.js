// 관리자 API. POST /api/admin  { action, ... }
// 등급: admin = 슈퍼관리자(OTP 통과 aal2 필수, 모든 기능) / staff = 일반 담당자(비밀번호 로그인, 지정 공고 조회·다운로드만)
// 서버에서 등급을 먼저 확인하고, DB 함수가 등급·OTP·지정 공고를 한 번 더 확인한다(이중 잠금).
// 조회·다운로드·변경 기록은 DB 함수가 남기고, 계정 관리처럼 서버에서 하는 작업은 여기서 남긴다.
const rules = require('../../public/js/rules.js');
const {
  BUCKET, UUID_RE, ok, fail, parseBody, str, authenticate, userClient, serviceClient, dbFail, kstToIso, toCsv, kstText,
  safeFileName, removeFiles, env, jsonRes, preflight
} = require('../lib/core');
const { runPurge } = require('../lib/purge');

const SIGNED_URL_SECONDS = 60;
const STAFF_ACTIONS = ['me', 'postings', 'posting', 'applications', 'application', 'export_csv', 'file_url'];
const STAFF_ID_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;

function isSuper(ctx) { return ctx.role === 'admin' && ctx.claims.aal === 'aal2'; }
function isStaff(ctx) {
  return ctx.role === 'staff' && Array.isArray(ctx.claims.amr) && ctx.claims.amr.some(a => a && a.method === 'password');
}
async function rpc(ctx, fn, args) { return userClient(ctx.token).rpc(fn, args); }
function uuidList(v, max) {
  const ids = [...new Set((Array.isArray(v) ? v : []).map(str))];
  if (ids.length === 0 || ids.length > max || !ids.every(id => UUID_RE.test(id))) return null;
  return ids;
}

// 서버에서 하는 관리 작업 기록. 기록하지 못하면 작업을 하지 않는다.
async function logServer(ctx, action, target, detail) {
  const { error } = await serviceClient().rpc('log_server_action', {
    p_user_id: ctx.user.id, p_email: ctx.user.email || '', p_role: ctx.role, p_action: action, p_target: target || null, p_detail: detail || null
  });
  if (error) { console.error('log_server_action failed:', error.message); return false; }
  return true;
}

function postingInput(d) {
  const opens = kstToIso(d.opens_at);
  const closes = kstToIso(d.closes_at);
  if (!str(d.title)) return { error: '공고 제목을 입력해주세요.' };
  if (!opens || !closes) return { error: '접수 시작·마감 일시를 입력해주세요.' };
  if (new Date(closes) <= new Date(opens)) return { error: '접수 마감은 시작보다 뒤여야 합니다.' };
  if (str(d.retention_until) && !/^\d{4}-\d{2}-\d{2}$/.test(str(d.retention_until))) return { error: '보관기한 형식이 올바르지 않습니다.' };
  const text = k => (d[k] === undefined || d[k] === null ? '' : String(d[k]));
  return {
    value: {
      title: str(d.title), employment_type: str(d.employment_type), fields: Array.isArray(d.fields) ? d.fields : [],
      qualifications: text('qualifications'), preferences: text('preferences'), conditions: text('conditions'), process: text('process'),
      documents: text('documents'), contact: text('contact'), etc: text('etc'), opens_at: opens, closes_at: closes,
      form_config: d.form_config && typeof d.form_config === 'object' ? d.form_config : {},
      allow_edit: d.allow_edit === true, allow_cancel: d.allow_cancel === true, consent_text: text('consent_text'),
      retention_until: str(d.retention_until), result_notice: text('result_notice')
    }
  };
}

function summarize(items, keys) {
  return (items || []).map(it => keys.map(k => str(it[k])).filter(Boolean).join(' ')).join(' / ');
}

async function staffAccounts() {
  const svc = serviceClient();
  const users = [];
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const list = (data && data.users) || [];
    users.push(...list);
    if (list.length < 200) break;
  }
  return users.filter(u => (u.app_metadata || {}).role === 'staff');
}

const handlers = {
  async me(ctx) {
    const { data, error } = await rpc(ctx, 'admin_me', {});
    if (error) return dbFail(error, 'admin_me');
    return ok(data);
  },
  async postings(ctx) {
    const { data, error } = await rpc(ctx, 'admin_postings', {});
    if (error) return dbFail(error, 'admin_postings');
    return ok({ items: data });
  },
  async posting(ctx, b) {
    if (!UUID_RE.test(str(b.id))) return fail(400, '잘못된 요청입니다.');
    const { data, error } = await rpc(ctx, 'admin_posting', { p_id: b.id });
    if (error) return dbFail(error, 'admin_posting');
    return ok({ item: data });
  },
  async save_posting(ctx, b) {
    if (b.id && !UUID_RE.test(str(b.id))) return fail(400, '잘못된 요청입니다.');
    const p = postingInput(b.data || {});
    if (p.error) return fail(400, p.error);
    const { data, error } = await rpc(ctx, 'admin_save_posting', { p_id: b.id || null, p_data: p.value });
    if (error) return dbFail(error, 'admin_save_posting');
    return ok(data);
  },
  async set_status(ctx, b) {
    if (!UUID_RE.test(str(b.id)) || !['draft', 'published', 'closed', 'archived'].includes(b.status)) return fail(400, '잘못된 요청입니다.');
    const { data, error } = await rpc(ctx, 'admin_set_posting_status', { p_id: b.id, p_status: b.status });
    if (error) return dbFail(error, 'admin_set_posting_status');
    return ok(data);
  },
  async delete_posting(ctx, b) {
    if (!UUID_RE.test(str(b.id))) return fail(400, '잘못된 요청입니다.');
    const { data, error } = await rpc(ctx, 'admin_delete_posting', { p_id: b.id });
    if (error) return dbFail(error, 'admin_delete_posting');
    return ok(data);
  },
  async applications(ctx, b) {
    if (!UUID_RE.test(str(b.posting_id))) return fail(400, '잘못된 요청입니다.');
    if (str(b.stage) && !rules.STAGES[str(b.stage)]) return fail(400, '잘못된 전형 단계입니다.');
    const { data, error } = await rpc(ctx, 'admin_applications', { p_posting_id: b.posting_id, p_q: str(b.q).slice(0, 100), p_stage: str(b.stage) });
    if (error) return dbFail(error, 'admin_applications');
    return ok({ items: data });
  },
  async application(ctx, b) {
    if (!UUID_RE.test(str(b.id))) return fail(400, '잘못된 요청입니다.');
    const { data, error } = await rpc(ctx, 'admin_application', { p_id: b.id });
    if (error) return dbFail(error, 'admin_application');
    return ok({ item: data });
  },
  // CSV 다운로드: DB 함수가 기록을 남기면서 데이터를 돌려준다(기록 없이는 데이터도 없음). 엑셀 수식 실행 방지 적용.
  async export_csv(ctx, b) {
    if (!UUID_RE.test(str(b.posting_id))) return fail(400, '잘못된 요청입니다.');
    if (str(b.stage) && !rules.STAGES[str(b.stage)]) return fail(400, '잘못된 전형 단계입니다.');
    const { data, error } = await rpc(ctx, 'admin_export', { p_posting_id: b.posting_id, p_stage: str(b.stage) });
    if (error) return dbFail(error, 'admin_export');
    const header = ['접수번호', '지원분야', '성명', '생년월일', '휴대폰', '이메일', '주소', '병역', '학력', '경력', '자격사항', '전형단계', '공개된 결과', '제출일시'];
    const rows = (data || []).map(r => {
      const d = r.data || {};
      const bsc = d.basic || {};
      return [r.receipt_no, d.field, bsc.name, bsc.birth, bsc.phone, r.email, bsc.address, bsc.military,
        summarize(d.education, ['school', 'major', 'degree', 'state']), summarize(d.career, ['org', 'title', 'from', 'to']),
        summarize(d.certs, ['name', 'date']), rules.STAGES[r.stage] || '', rules.STAGES[r.published_stage] || '', kstText(r.submitted_at)];
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="applicants.csv"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      body: toCsv(header, rows)
    };
  },
  // 첨부파일 열람: DB가 권한 확인·기록 후 경로를 주면, 60초만 유효한 서명 주소를 만든다
  async file_url(ctx, b) {
    if (!UUID_RE.test(str(b.attachment_id))) return fail(400, '잘못된 요청입니다.');
    const { data, error } = await rpc(ctx, 'admin_attachment', { p_attachment_id: b.attachment_id });
    if (error) return dbFail(error, 'admin_attachment');
    // 사진(JPG·PNG)은 화면에 바로 보이도록(inline) 주소를 만들 수 있다. 그 밖의 파일은 항상 내려받기로.
    const inline = b.inline === true && /\.(jpe?g|png)$/i.test(data.download_name || '');
    const { data: s, error: e2 } = await serviceClient().storage.from(BUCKET).createSignedUrl(data.path, SIGNED_URL_SECONDS, inline ? {} : { download: safeFileName(data.download_name) });
    if (e2) { console.error('createSignedUrl failed:', e2.message); return fail(500, '파일 주소를 만들지 못했습니다.'); }
    return ok({ url: s.signedUrl, expires_in: SIGNED_URL_SECONDS });
  },
  async set_stage(ctx, b) {
    const ids = uuidList(b.ids, 500);
    if (!ids || !rules.STAGES[str(b.stage)]) return fail(400, '잘못된 요청입니다.');
    const memo = b.memo === undefined || b.memo === null ? null : String(b.memo).slice(0, 2000);
    const { data, error } = await rpc(ctx, 'admin_set_stage', { p_ids: ids, p_stage: str(b.stage), p_memo: memo });
    if (error) return dbFail(error, 'admin_set_stage');
    return ok(data);
  },
  async publish(ctx, b) {
    const ids = uuidList(b.ids, 500);
    if (!ids) return fail(400, '잘못된 요청입니다.');
    const { data, error } = await rpc(ctx, 'admin_publish_results', { p_ids: ids, p_publish: b.publish === true });
    if (error) return dbFail(error, 'admin_publish_results');
    return ok(data);
  },
  // 지원서 삭제(되돌릴 수 없음): DB 행 삭제 후 첨부파일도 Storage에서 지운다
  async delete_applications(ctx, b) {
    const ids = uuidList(b.ids, 100);
    if (!ids) return fail(400, '삭제할 지원서를 1~100건 선택해주세요.');
    const { data, error } = await rpc(ctx, 'admin_delete_applications', { p_ids: ids });
    if (error) return dbFail(error, 'admin_delete_applications');
    const r = await removeFiles(data.paths);
    return ok({ deleted: data.deleted, files_deleted: r.deleted, files_failed: r.failed });
  },
  async board(ctx) {
    const { data, error } = await rpc(ctx, 'admin_board', {});
    if (error) return dbFail(error, 'admin_board');
    return ok(data);
  },
  async save_notice(ctx, b) {
    if (b.id && !UUID_RE.test(str(b.id))) return fail(400, '잘못된 요청입니다.');
    if (!str(b.title) || str(b.title).length > 200 || String(b.body || '').length > 20000) return fail(400, '제목(200자)·내용(20,000자)을 확인해주세요.');
    const { data, error } = await rpc(ctx, 'admin_save_notice', { p_id: b.id || null, p_title: str(b.title), p_body: String(b.body || ''), p_published: b.published === true, p_pinned: b.pinned === true });
    if (error) return dbFail(error, 'admin_save_notice');
    return ok(data);
  },
  async save_faq(ctx, b) {
    if (b.id && !UUID_RE.test(str(b.id))) return fail(400, '잘못된 요청입니다.');
    if (!str(b.question) || str(b.question).length > 300 || String(b.answer || '').length > 5000) return fail(400, '질문(300자)·답변(5,000자)을 확인해주세요.');
    const { data, error } = await rpc(ctx, 'admin_save_faq', { p_id: b.id || null, p_question: str(b.question), p_answer: String(b.answer || ''), p_sort: parseInt(b.sort, 10) || 0, p_published: b.published === true });
    if (error) return dbFail(error, 'admin_save_faq');
    return ok(data);
  },
  async delete_board_item(ctx, b) {
    if (!['notice', 'faq'].includes(b.kind) || !UUID_RE.test(str(b.id))) return fail(400, '잘못된 요청입니다.');
    const { data, error } = await rpc(ctx, 'admin_delete_board_item', { p_kind: b.kind, p_id: b.id });
    if (error) return dbFail(error, 'admin_delete_board_item');
    return ok(data);
  },
  async save_settings(ctx, b) {
    const { data, error } = await rpc(ctx, 'admin_save_settings', { p_data: b.data && typeof b.data === 'object' ? b.data : {} });
    if (error) return dbFail(error, 'admin_save_settings');
    return ok(data);
  },
  async logs(ctx, b) {
    const { data, error } = await rpc(ctx, 'admin_logs', { p_limit: Math.min(parseInt(b.limit, 10) || 200, 1000) });
    if (error) return dbFail(error, 'admin_logs');
    return ok(data);
  },
  async purge_now(ctx) {
    if (!(await logServer(ctx, 'purge_manual', null, null))) return fail(500, '기록을 남기지 못해 실행하지 않았습니다.');
    const r = await runPurge('manual');
    return ok(r);
  },

  // ---- 일반 담당자 계정 관리 (슈퍼관리자) ----
  async staff_list(ctx) {
    const { data, error } = await rpc(ctx, 'admin_staff_list', {});
    if (error) return dbFail(error, 'admin_staff_list');
    const accounts = await staffAccounts();
    const domain = '@' + (env('STAFF_EMAIL_DOMAIN') || 'staff.dcci-recruit.local');
    const items = data.map(d => {
      const a = accounts.find(x => x.id === d.id) || {};
      return { id: d.id, login_id: String(d.email || '').replace(domain, ''), postings: d.postings, created_at: a.created_at || null, last_sign_in_at: a.last_sign_in_at || null };
    });
    return ok({ items });
  },
  async staff_create(ctx, b) {
    const loginId = str(b.login_id).toLowerCase();
    const pw = String(b.password || '');
    if (!STAFF_ID_RE.test(loginId)) return fail(400, '아이디는 영문 소문자·숫자·.-_ 3~30자로 입력해주세요.');
    if (pw.length < 12 || pw.length > 72) return fail(400, '비밀번호는 12자 이상(72자 이하)으로 정해주세요.');
    if (pw.toLowerCase().includes(loginId)) return fail(400, '비밀번호에 아이디를 넣지 마세요.');
    if (!(await logServer(ctx, 'staff_create', loginId, null))) return fail(500, '기록을 남기지 못해 실행하지 않았습니다.');
    const email = `${loginId}@${env('STAFF_EMAIL_DOMAIN') || 'staff.dcci-recruit.local'}`;
    const { data, error } = await serviceClient().auth.admin.createUser({ email, password: pw, email_confirm: true, app_metadata: { role: 'staff' } });
    if (error) {
      console.error('createUser failed:', error.message);
      return fail(400, /already|registered|exists/i.test(error.message) ? '이미 있는 아이디입니다.' : '계정을 만들지 못했습니다. 비밀번호 규칙을 확인해주세요.');
    }
    return ok({ id: data.user.id });
  },
  async staff_password(ctx, b) {
    const pw = String(b.password || '');
    if (!UUID_RE.test(str(b.id))) return fail(400, '잘못된 요청입니다.');
    if (pw.length < 12 || pw.length > 72) return fail(400, '비밀번호는 12자 이상(72자 이하)으로 정해주세요.');
    const target = (await staffAccounts()).find(u => u.id === b.id);
    if (!target) return fail(404, '일반 담당자 계정을 찾을 수 없습니다.');
    if (!(await logServer(ctx, 'staff_password', b.id, null))) return fail(500, '기록을 남기지 못해 실행하지 않았습니다.');
    const { error } = await serviceClient().auth.admin.updateUserById(b.id, { password: pw });
    if (error) { console.error('updateUser failed:', error.message); return fail(400, '비밀번호를 바꾸지 못했습니다.'); }
    return ok({});
  },
  async staff_delete(ctx, b) {
    if (!UUID_RE.test(str(b.id))) return fail(400, '잘못된 요청입니다.');
    const target = (await staffAccounts()).find(u => u.id === b.id);
    if (!target) return fail(404, '일반 담당자 계정을 찾을 수 없습니다.');
    if (!(await logServer(ctx, 'staff_delete', b.id, null))) return fail(500, '기록을 남기지 못해 실행하지 않았습니다.');
    const { error } = await serviceClient().auth.admin.deleteUser(b.id);
    if (error) { console.error('deleteUser failed:', error.message); return fail(400, '계정을 삭제하지 못했습니다.'); }
    return ok({});
  },
  async set_posting_staff(ctx, b) {
    if (!UUID_RE.test(str(b.posting_id))) return fail(400, '잘못된 요청입니다.');
    const ids = Array.isArray(b.user_ids) && b.user_ids.length === 0 ? [] : uuidList(b.user_ids, 50);
    if (!ids) return fail(400, '잘못된 요청입니다.');
    const { data, error } = await rpc(ctx, 'admin_set_posting_staff', { p_posting_id: b.posting_id, p_user_ids: ids });
    if (error) return dbFail(error, 'admin_set_posting_staff');
    return ok(data);
  }
};

exports.handler = async function (event) {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') return fail(405, '허용되지 않은 요청입니다.');
  if (!serviceClient()) return fail(500, '서버 설정이 완료되지 않았습니다.');
  const body = parseBody(event);
  if (!body) return fail(400, '요청 형식이 올바르지 않습니다.');
  const action = str(body.action);
  const handler = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : null;
  if (!handler) return fail(400, '알 수 없는 요청입니다.');

  const ctx = await authenticate(event);
  if (!ctx) return fail(401, '로그인이 필요합니다.');
  if (ctx.role === 'admin') {
    if (!isSuper(ctx)) return fail(403, '2단계 인증(OTP)이 필요합니다.');
  } else if (ctx.role === 'staff') {
    if (!isStaff(ctx)) return fail(403, '아이디·비밀번호로 다시 로그인해주세요.');
    if (!STAFF_ACTIONS.includes(action)) return fail(403, '슈퍼관리자만 할 수 있는 작업입니다.');
  } else {
    return fail(403, '관리자 권한이 없습니다.');
  }
  try {
    return await handler(ctx, body);
  } catch (e) {
    console.error('admin handler error:', action, e && e.message);
    return jsonRes(500, { result: 'error', msg: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
};
