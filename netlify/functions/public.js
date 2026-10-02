// 공개 조회 API: 공고 목록·상세, 공지사항·FAQ·문의처, 화면 설정값. 개인정보는 다루지 않는다.
//   GET /api/public?r=postings | posting&id=... | board | config
const { anonClient, ok, fail, env, UUID_RE, str, preflight, dbFail } = require('../lib/core');

const CACHE = { 'Cache-Control': 'public, max-age=0, s-maxage=30, stale-while-revalidate=300' };

exports.handler = async function (event) {
  const pre = preflight(event);
  if (pre) return pre;
  if (event.httpMethod !== 'GET') return fail(405, '허용되지 않은 요청입니다.');
  const q = event.queryStringParameters || {};
  const r = str(q.r);

  // 브라우저가 쓰는 공개 설정값(홈페이지 키는 공개용 값이다. 서버 키는 절대 넣지 않는다)
  if (r === 'config') {
    return ok({
      supabaseUrl: env('SUPABASE_URL'),
      supabaseAnonKey: env('SUPABASE_ANON_KEY'),
      turnstileSiteKey: env('TURNSTILE_SITE_KEY'),
      staffEmailDomain: env('STAFF_EMAIL_DOMAIN') || 'staff.dcci-recruit.local',
      bucket: 'applicant-files'
    }, { 'Cache-Control': 'public, max-age=300' });
  }

  const db = anonClient();
  if (!db) return fail(500, '서버 설정이 완료되지 않았습니다.');

  if (r === 'postings') {
    const { data, error } = await db.rpc('public_postings');
    if (error) return dbFail(error, 'public_postings');
    return ok(data, CACHE);
  }
  if (r === 'posting') {
    const id = str(q.id);
    if (!UUID_RE.test(id)) return fail(400, '잘못된 요청입니다.');
    const { data, error } = await db.rpc('public_posting', { p_id: id });
    if (error) return dbFail(error, 'public_posting');
    if (!data || !data.item) return fail(404, '공고를 찾을 수 없습니다.');
    return ok(data, CACHE);
  }
  if (r === 'board') {
    const { data, error } = await db.rpc('public_board');
    if (error) return dbFail(error, 'public_board');
    return ok(data, CACHE);
  }
  return fail(400, '알 수 없는 요청입니다.');
};
