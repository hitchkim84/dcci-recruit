// 지원자 API (이메일 일회용 코드로 로그인한 본인만). POST /api/applicant  { action, ... }
// 1) Supabase Auth로 토큰을 확인하고  2) 입력값을 서버에서 검사한 뒤  3) 본인 권한으로 DB 함수를 부른다(DB가 다시 확인).
// 첨부파일은 비공개 Storage에 서버가 발급한 서명 주소로만 올리고, 올린 뒤 서버가 실제 형식·크기를 확인한다.
const rules = require('../../public/js/rules.js');
const {
  BUCKET, UUID_RE, ok, fail, parseBody, str, authenticate, userClient, serviceClient, dbFail, sniffFile, safeFileName, removeFiles, preflight
} = require('../lib/core');

const SIGNED_URL_SECONDS = 60;

async function rpc(ctx, fn, args) {
  const { data, error } = await userClient(ctx.token).rpc(fn, args);
  return { data, error };
}

// 서버에서도 공고 설정을 읽어 입력값을 검사한다(DB 함수도 같은 기준으로 다시 검사)
async function loadPosting(ctx, postingId) {
  const { data, error } = await rpc(ctx, 'my_application', { p_posting_id: postingId });
  if (error) return { error };
  return { posting: data.posting, application: data.application };
}

const handlers = {
  async my_list(ctx) {
    const { data, error } = await rpc(ctx, 'my_applications', {});
    if (error) return dbFail(error, 'my_applications');
    return ok(data);
  },

  async my_app(ctx, body) {
    const { data, error } = await rpc(ctx, 'my_application', { p_posting_id: body.posting_id });
    if (error) return dbFail(error, 'my_application');
    return ok(data);
  },

  async save(ctx, body) {
    const p = await loadPosting(ctx, body.posting_id);
    if (p.error) return dbFail(p.error, 'load posting');
    const err = rules.validateApplication(p.posting, body.data, false);
    if (err) return fail(400, err.msg);
    const { data, error } = await rpc(ctx, 'save_draft', { p_posting_id: body.posting_id, p_data: body.data });
    if (error) return dbFail(error, 'save_draft');
    return ok(data);
  },

  async submit(ctx, body) {
    if (body.consent !== true) return fail(400, '개인정보 수집·이용에 동의해야 제출할 수 있습니다.');
    const p = await loadPosting(ctx, body.posting_id);
    if (p.error) return dbFail(p.error, 'load posting');
    const err = rules.validateApplication(p.posting, body.data, true);
    if (err) return fail(400, err.msg);
    // 어떤 동의문에 동의했는지 남기기 위해 동의문 내용의 지문(해시)을 함께 저장한다
    const hash = require('crypto').createHash('sha256').update(String(p.posting.consent_text || '')).digest('hex');
    const { data, error } = await rpc(ctx, 'submit_application', { p_posting_id: body.posting_id, p_data: body.data, p_consent: true, p_consent_hash: hash });
    if (error) return dbFail(error, 'submit_application');
    return ok(data);
  },

  async cancel(ctx, body) {
    const { data, error } = await rpc(ctx, 'cancel_submission', { p_posting_id: body.posting_id });
    if (error) return dbFail(error, 'cancel_submission');
    return ok(data);
  },

  async delete_draft(ctx, body) {
    const { data, error } = await rpc(ctx, 'delete_my_draft', { p_posting_id: body.posting_id });
    if (error) return dbFail(error, 'delete_my_draft');
    await removeFiles(data.paths);
    return ok({});
  },

  // 첨부 1단계: 권한·형식·크기 확인 후 서명된 업로드 주소 발급(약 2시간 유효, 같은 경로에 덮어쓰기 불가)
  async upload_begin(ctx, body) {
    const filename = str(body.filename).slice(0, 200);
    const ext = rules.extOf(filename);
    const size = Number(body.size);
    if (!rules.ALLOWED_EXT.includes(ext)) return fail(400, '올릴 수 없는 파일 형식입니다. (PDF, JPG, PNG, HWP, HWPX, DOCX)');
    if (!Number.isInteger(size) || size < 1 || size > 10 * 1048576) return fail(400, '파일은 10MB 이하만 올릴 수 있습니다.');
    if (!/^[a-z0-9_]{1,30}$/.test(str(body.doc_key))) return fail(400, '잘못된 요청입니다.');
    const { data, error } = await rpc(ctx, 'begin_attachment', { p_posting_id: body.posting_id, p_doc_key: body.doc_key, p_filename: filename, p_ext: ext, p_size: size });
    if (error) return dbFail(error, 'begin_attachment');
    const { data: signed, error: e2 } = await serviceClient().storage.from(BUCKET).createSignedUploadUrl(data.path);
    if (e2) { console.error('createSignedUploadUrl failed:', e2.message); return fail(500, '업로드를 준비하지 못했습니다. 잠시 후 다시 시도해주세요.'); }
    return ok({ attachment_id: data.attachment_id, path: data.path, token: signed.token });
  },

  // 첨부 2단계: 올라간 파일의 실제 크기·형식 확인. 통과하지 못하면 파일을 지운다.
  async upload_done(ctx, body) {
    if (!UUID_RE.test(str(body.attachment_id))) return fail(400, '잘못된 요청입니다.');
    const svc = serviceClient();
    const { data: att, error } = await svc.rpc('attachment_for_check', { p_attachment_id: body.attachment_id, p_user_id: ctx.user.id });
    if (error) return dbFail(error, 'attachment_for_check');
    if (!att) return fail(404, '파일을 찾을 수 없습니다.');
    if (att.state === 'ready') return ok({});
    const { data: blob, error: e2 } = await svc.storage.from(BUCKET).download(att.path);
    if (e2 || !blob) return fail(400, '파일이 올라가지 않았습니다. 다시 시도해주세요.');
    const buf = Buffer.from(await blob.arrayBuffer());
    const valid = buf.length >= 1 && buf.length <= att.max_bytes && sniffFile(buf, att.ext);
    const { error: e3 } = await svc.rpc('finalize_attachment', { p_attachment_id: att.id, p_ok: valid, p_size: buf.length });
    if (e3) return dbFail(e3, 'finalize_attachment');
    if (!valid) {
      await removeFiles([att.path]);
      if (buf.length > att.max_bytes) return fail(400, `파일은 ${Math.round(att.max_bytes / 1048576)}MB 이하만 올릴 수 있습니다.`);
      return fail(400, '파일 내용이 확장자와 맞지 않습니다. 원본 파일(PDF, JPG, PNG, HWP, HWPX, DOCX)을 올려주세요.');
    }
    return ok({});
  },

  async remove_file(ctx, body) {
    const { data, error } = await rpc(ctx, 'remove_my_attachment', { p_attachment_id: body.attachment_id });
    if (error) return dbFail(error, 'remove_my_attachment');
    await removeFiles([data.path]);
    return ok({});
  },

  // 본인이 올린 파일 확인용 짧은 주소(60초)
  async file_url(ctx, body) {
    const { data, error } = await rpc(ctx, 'my_attachment', { p_attachment_id: body.attachment_id });
    if (error) return dbFail(error, 'my_attachment');
    const { data: s, error: e2 } = await serviceClient().storage.from(BUCKET).createSignedUrl(data.path, SIGNED_URL_SECONDS, { download: safeFileName(data.download_name) });
    if (e2) { console.error('createSignedUrl failed:', e2.message); return fail(500, '파일 주소를 만들지 못했습니다.'); }
    return ok({ url: s.signedUrl, expires_in: SIGNED_URL_SECONDS });
  }
};

const NEEDS_POSTING = ['my_app', 'save', 'submit', 'cancel', 'delete_draft', 'upload_begin'];
const NEEDS_ATTACHMENT = ['remove_file', 'file_url'];

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
  if (!ctx) return fail(401, '이메일 인증이 필요합니다. 다시 인증해주세요.');
  // 관리자 계정은 지원자 기능을 쓸 수 없다(DB 함수도 같은 확인)
  if (ctx.role) return fail(403, '관리자 계정으로는 지원할 수 없습니다.');
  if (!ctx.user.email) return fail(401, '이메일 인증이 필요합니다.');

  if (NEEDS_POSTING.includes(action) && !UUID_RE.test(str(body.posting_id))) return fail(400, '잘못된 요청입니다.');
  if (NEEDS_ATTACHMENT.includes(action) && !UUID_RE.test(str(body.attachment_id))) return fail(400, '잘못된 요청입니다.');
  try {
    return await handler(ctx, body);
  } catch (e) {
    console.error('applicant handler error:', action, e && e.message);
    return fail(500, '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
  }
};
