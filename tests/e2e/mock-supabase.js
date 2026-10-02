// ⚠ 로컬 검증 전용 Supabase 흉내 서버 (운영에 쓰지 않는다)
// 실제 PostgreSQL에 연결해 DB 함수(RPC)는 진짜로 실행하고, Auth(로그인·OTP·MFA)와 Storage(파일)는 메모리로 흉내 낸다.
// 그래서 이 환경의 결과는 'DB 함수·서버 코드·화면'의 동작은 확인하지만, Supabase Auth·Storage 자체의 동작(메일 발송,
// 실제 TOTP 계산, 서명 URL 구현 등)은 확인하지 못한다. 운영 확인은 docs/OPERATIONS.md의 점검표로 한다.
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');

const SECRET = 'local-dev-only-secret';
const DEV_TOTP = '246810'; // 흉내 서버에서 통과시키는 OTP 6자리(실제 Supabase는 인증 앱의 시간 기반 코드)

function b64(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function sign(payload) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(head + '.' + body).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verify(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const sig = crypto.createHmac('sha256', SECRET).update(parts[0] + '.' + parts[1]).digest('base64url');
  if (sig.length !== parts[2].length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(parts[2]))) return null;
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (claims.exp && claims.exp < Date.now() / 1000) return null;
  return claims;
}
const ANON_KEY = sign({ role: 'anon', iss: 'mock' });
const SERVICE_KEY = sign({ role: 'service_role', iss: 'mock' });

function createMock(pgConn, opts = {}) {
  const pool = new Pool({ ...pgConn, max: 10 });
  const otps = new Map();       // email -> code
  const refresh = new Map();    // refresh token -> { uid, aal, amr }
  const factors = new Map();    // uid -> { id, status }
  const files = new Map();      // bucket/path -> { buf, type }
  const challenges = new Map();
  const stats = { otpSent: 0, captchaTokens: [] };

  async function userRow(uid) {
    const r = await pool.query('SELECT * FROM auth.users WHERE id = $1', [uid]);
    return r.rows[0];
  }
  function userJson(u) {
    const f = factors.get(u.id);
    return {
      id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.created_at, phone: '',
      app_metadata: { provider: 'email', providers: ['email'], ...(u.raw_app_meta_data || {}) }, user_metadata: {},
      identities: [], created_at: u.created_at, updated_at: u.created_at, last_sign_in_at: u.last_sign_in_at,
      factors: f ? [{ id: f.id, factor_type: 'totp', status: f.status, friendly_name: 'dev', created_at: u.created_at, updated_at: u.created_at }] : []
    };
  }
  async function session(u, aal, amr) {
    await pool.query('UPDATE auth.users SET last_sign_in_at = now() WHERE id = $1', [u.id]);
    const now = Math.floor(Date.now() / 1000);
    const ttl = opts.tokenTtl || 3600;
    const claims = {
      aud: 'authenticated', sub: u.id, email: u.email, role: 'authenticated', aal, amr: amr.map(m => ({ method: m, timestamp: now })),
      app_metadata: { provider: 'email', ...(u.raw_app_meta_data || {}) }, user_metadata: {}, session_id: crypto.randomUUID(), iat: now, exp: now + ttl
    };
    const rt = crypto.randomBytes(16).toString('hex');
    refresh.set(rt, { uid: u.id, aal, amr });
    return { access_token: sign(claims), token_type: 'bearer', expires_in: ttl, expires_at: now + ttl, refresh_token: rt, user: userJson(u) };
  }
  function authErr(res, status, code, msg) { send(res, status, { code: status, error_code: code, msg }); }

  function send(res, status, body, headers = {}) {
    const data = body === undefined ? '' : (Buffer.isBuffer(body) ? body : JSON.stringify(body));
    res.writeHead(status, { 'Access-Control-Allow-Origin': '*', 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...headers });
    res.end(data);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', c => { size += c.length; if (size > 12 * 1048576) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  function claimsOf(req) {
    const h = req.headers.authorization || '';
    return verify(h.replace(/^Bearer /, '')) || verify(req.headers.apikey);
  }

  // ---------------- Auth
  async function auth(req, res, url, body) {
    const p = url.pathname.replace('/auth/v1', '');
    const json = body.length ? JSON.parse(body.toString()) : {};
    if (req.method === 'POST' && p === '/otp') {
      const email = String(json.email || '').toLowerCase();
      if (opts.requireCaptcha && !(json.gotrue_meta_security || {}).captcha_token) return authErr(res, 400, 'captcha_failed', 'captcha protection: request disallowed');
      stats.captchaTokens.push((json.gotrue_meta_security || {}).captcha_token || null);
      let r = await pool.query('SELECT * FROM auth.users WHERE email = $1', [email]);
      if (!r.rows.length) {
        if (json.create_user === false) return authErr(res, 422, 'otp_disabled', 'Signups not allowed for otp');
        r = await pool.query("INSERT INTO auth.users (email, raw_app_meta_data) VALUES ($1, '{}') RETURNING *", [email]);
      }
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      otps.set(email, code);
      stats.otpSent++;
      return send(res, 200, {});
    }
    if (req.method === 'POST' && p === '/verify') {
      const email = String(json.email || '').toLowerCase();
      if (!otps.has(email) || otps.get(email) !== String(json.token)) return authErr(res, 403, 'otp_expired', 'Token has expired or is invalid');
      otps.delete(email);
      const u = (await pool.query('SELECT * FROM auth.users WHERE email = $1', [email])).rows[0];
      return send(res, 200, await session(u, 'aal1', ['otp']));
    }
    if (req.method === 'POST' && p === '/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const u = (await pool.query('SELECT * FROM auth.users WHERE email = $1', [String(json.email || '').toLowerCase()])).rows[0];
        if (!u || !u.dev_password || u.dev_password !== json.password) return authErr(res, 400, 'invalid_credentials', 'Invalid login credentials');
        return send(res, 200, await session(u, 'aal1', ['password']));
      }
      if (grant === 'refresh_token') {
        const s = refresh.get(json.refresh_token);
        if (!s) return authErr(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token');
        refresh.delete(json.refresh_token);
        const u = await userRow(s.uid);
        if (!u) return authErr(res, 400, 'user_not_found', 'User not found');
        return send(res, 200, await session(u, s.aal, s.amr));
      }
    }
    if (p === '/logout') return send(res, 204);
    const c = claimsOf(req);
    if (p === '/user' && req.method === 'GET') {
      if (!c || !c.sub) return authErr(res, 401, 'bad_jwt', 'invalid JWT');
      const u = await userRow(c.sub);
      if (!u) return authErr(res, 404, 'user_not_found', 'User not found');
      return send(res, 200, userJson(u));
    }
    if (p === '/factors' && req.method === 'POST') {
      if (!c || !c.sub) return authErr(res, 401, 'bad_jwt', 'invalid JWT');
      const id = crypto.randomUUID();
      factors.set(c.sub, { id, status: 'unverified' });
      return send(res, 200, { id, type: 'totp', friendly_name: json.friendly_name, totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#eee"/><text x="20" y="100">DEV QR</text></svg>', secret: 'DEVSECRETONLY', uri: 'otpauth://totp/dev' } });
    }
    let m = /^\/factors\/([^/]+)\/challenge$/.exec(p);
    if (m && req.method === 'POST') {
      const cid = crypto.randomUUID();
      challenges.set(cid, m[1]);
      return send(res, 200, { id: cid, type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 });
    }
    m = /^\/factors\/([^/]+)\/verify$/.exec(p);
    if (m && req.method === 'POST') {
      if (!c || !c.sub) return authErr(res, 401, 'bad_jwt', 'invalid JWT');
      if (challenges.get(json.challenge_id) !== m[1] || json.code !== DEV_TOTP) return authErr(res, 422, 'mfa_verification_failed', 'Invalid TOTP code entered');
      const f = factors.get(c.sub);
      if (f && f.id === m[1]) f.status = 'verified';
      const u = await userRow(c.sub);
      return send(res, 200, await session(u, 'aal2', ['totp', 'password']));
    }
    // 관리 API (서버 키만)
    if (p.startsWith('/admin/users')) {
      if (!c || c.role !== 'service_role') return authErr(res, 403, 'not_admin', 'User not allowed');
      const id = p.split('/')[3];
      if (req.method === 'GET' && !id) {
        const r = await pool.query('SELECT * FROM auth.users ORDER BY created_at');
        return send(res, 200, { users: r.rows.map(userJson), aud: 'authenticated' });
      }
      if (req.method === 'POST' && !id) {
        const exists = await pool.query('SELECT 1 FROM auth.users WHERE email = $1', [String(json.email).toLowerCase()]);
        if (exists.rows.length) return authErr(res, 422, 'email_exists', 'A user with this email address has already been registered');
        const r = await pool.query('INSERT INTO auth.users (email, raw_app_meta_data, dev_password) VALUES ($1, $2, $3) RETURNING *', [String(json.email).toLowerCase(), json.app_metadata || {}, json.password]);
        return send(res, 200, userJson(r.rows[0]));
      }
      if (req.method === 'PUT' && id) {
        const r = await pool.query('UPDATE auth.users SET dev_password = coalesce($2, dev_password) WHERE id = $1 RETURNING *', [id, json.password || null]);
        return r.rows.length ? send(res, 200, userJson(r.rows[0])) : authErr(res, 404, 'user_not_found', 'User not found');
      }
      if (req.method === 'DELETE' && id) {
        await pool.query('DELETE FROM auth.users WHERE id = $1', [id]);
        return send(res, 200, {});
      }
    }
    return authErr(res, 404, 'not_found', 'not found: ' + p);
  }

  // ---------------- REST (DB 함수만)
  async function rest(req, res, url, body) {
    const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (!m || req.method !== 'POST') return send(res, 404, { code: 'PGRST', message: 'only rpc is mocked' });
    const c = claimsOf(req);
    if (!c) return send(res, 401, { code: 'PGRST301', message: 'JWT invalid' });
    const args = body.length ? JSON.parse(body.toString()) : {};
    const keys = Object.keys(args);
    const values = keys.map(k => {
      const v = args[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(v);
      return v;
    });
    const sql = `SELECT public.${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS r`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${c.role === 'service_role' ? 'service_role' : c.role === 'authenticated' ? 'authenticated' : 'anon'}`);
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(c)]);
      const r = await client.query(sql, values);
      await client.query('COMMIT');
      return send(res, 200, r.rows[0].r);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      const status = e.code === 'P0001' ? 400 : e.code === '42501' ? (c.role === 'anon' ? 401 : 403) : e.code === '42883' ? 404 : 400;
      return send(res, status, { code: e.code, message: e.message, details: null, hint: null });
    } finally {
      client.release();
    }
  }

  // ---------------- Storage
  function storageToken(kind, key, seconds) {
    return sign({ kind, key, exp: Math.floor(Date.now() / 1000) + seconds });
  }
  function parseMultipart(buf, ctype) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype || '');
    if (!m) return null;
    const boundary = Buffer.from('--' + (m[1] || m[2]));
    let pos = 0;
    const parts = [];
    while ((pos = buf.indexOf(boundary, pos)) !== -1) {
      const start = pos + boundary.length + 2;
      const next = buf.indexOf(boundary, start);
      if (next === -1) break;
      const part = buf.subarray(start, next - 2);
      const sep = part.indexOf('\r\n\r\n');
      const head = part.subarray(0, sep).toString();
      parts.push({ head, body: part.subarray(sep + 4) });
      pos = next;
    }
    const filePart = parts.find(p => /filename=/.test(p.head)) || parts.find(p => /name=""/.test(p.head));
    return filePart ? filePart.body : null;
  }
  function storageErr(res, status, error, message) { send(res, status, { statusCode: String(status), error, message }); }
  async function storage(req, res, url, body) {
    const p = decodeURIComponent(url.pathname.replace('/storage/v1', ''));
    const c = claimsOf(req);
    const isService = c && c.role === 'service_role';
    let m = /^\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(p);
    if (m) {
      const key = m[1] + '/' + m[2];
      if (req.method === 'POST') {
        if (!isService) return storageErr(res, 403, 'Unauthorized', 'new row violates row-level security policy');
        if (files.has(key)) return storageErr(res, 409, 'Duplicate', 'The resource already exists');
        return send(res, 200, { url: `/object/upload/sign/${m[1]}/${m[2]}?token=${storageToken('up', key, 7200)}` });
      }
      if (req.method === 'PUT') {
        const t = verify(url.searchParams.get('token'));
        if (!t || t.kind !== 'up' || t.key !== key) return storageErr(res, 400, 'InvalidSignature', 'invalid signature');
        if (files.has(key)) return storageErr(res, 409, 'Duplicate', 'The resource already exists');
        const data = /multipart/.test(req.headers['content-type'] || '') ? parseMultipart(body, req.headers['content-type']) : body;
        if (!data) return storageErr(res, 400, 'InvalidRequest', 'no file');
        if (data.length > 10485760) return storageErr(res, 413, 'Payload too large', 'The object exceeded the maximum allowed size');
        files.set(key, { buf: data, type: req.headers['content-type'] || 'application/octet-stream' });
        return send(res, 200, { Key: key });
      }
    }
    m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(p);
    if (m) {
      const key = m[1] + '/' + m[2];
      if (req.method === 'POST') {
        if (!isService) return storageErr(res, 403, 'Unauthorized', 'new row violates row-level security policy');
        if (!files.has(key)) return storageErr(res, 404, 'not_found', 'Object not found');
        const json = JSON.parse(body.toString() || '{}');
        return send(res, 200, { signedURL: `/object/sign/${m[1]}/${m[2]}?token=${storageToken('dl', key, Number(json.expiresIn) || 60)}` });
      }
      if (req.method === 'GET') {
        const t = verify(url.searchParams.get('token'));
        if (!t || t.kind !== 'dl' || t.key !== key) return storageErr(res, 400, 'InvalidJWT', 'invalid or expired signature');
        const f = files.get(key);
        if (!f) return storageErr(res, 404, 'not_found', 'Object not found');
        const dl = url.searchParams.get('download');
        return send(res, 200, f.buf, dl !== null ? { 'Content-Disposition': `attachment; filename="${dl.replace(/"/g, '')}"` } : {});
      }
    }
    m = /^\/object\/([^/]+)\/(.+)$/.exec(p);
    if (m && req.method === 'GET') {
      if (!isService) return storageErr(res, 400, 'not_found', 'Object not found');
      const f = files.get(m[1] + '/' + m[2]);
      return f ? send(res, 200, f.buf) : storageErr(res, 400, 'not_found', 'Object not found');
    }
    if (m && req.method === 'POST') return storageErr(res, 403, 'Unauthorized', 'new row violates row-level security policy');
    m = /^\/object\/([^/]+)$/.exec(p);
    if (m && req.method === 'DELETE') {
      if (!isService) return storageErr(res, 403, 'Unauthorized', 'new row violates row-level security policy');
      const json = JSON.parse(body.toString() || '{}');
      const removed = (json.prefixes || []).filter(k => files.delete(m[1] + '/' + k)).map(name => ({ name }));
      return send(res, 200, removed);
    }
    return storageErr(res, 404, 'not_found', 'not mocked: ' + p);
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS' });
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');
    try {
      const body = await readBody(req);
      if (url.pathname === '/__dev/otp') return send(res, 200, { code: otps.get(String(url.searchParams.get('email')).toLowerCase()) || null });
      if (url.pathname.startsWith('/auth/v1')) return await auth(req, res, url, body);
      if (url.pathname.startsWith('/rest/v1')) return await rest(req, res, url, body);
      if (url.pathname.startsWith('/storage/v1')) return await storage(req, res, url, body);
      send(res, 404, { message: 'not found' });
    } catch (e) {
      console.error('mock error', req.method, url.pathname, e.message);
      send(res, 500, { message: e.message });
    }
  });
  return { server, pool, ANON_KEY, SERVICE_KEY, DEV_TOTP, files, otps, stats, sign };
}

module.exports = { createMock, ANON_KEY, SERVICE_KEY, DEV_TOTP };
