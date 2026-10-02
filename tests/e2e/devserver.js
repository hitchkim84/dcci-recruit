// 로컬 개발·검증 서버: 실제 PostgreSQL(임시) + Supabase 흉내 서버 + Netlify 함수 + 정적 파일
// 실행: npm run dev  →  http://localhost:8888 (관리자: /admin.html, admin@dev.local / dev-admin-password-0000, OTP 246810)
// ⚠ 개발용 가상 데이터만 쓴다. 운영 키·운영 DB에 연결하지 않는다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { startPg } = require('./pgtemp');
const { createMock } = require('./mock-supabase');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

async function start(opts = {}) {
  const webPort = opts.webPort || 8888;
  const mockPort = opts.mockPort || 54321;
  const pg = startPg(opts.pgPort || 55440);
  const pool = new Pool(pg.conn);
  const files = ['tests/db/supabase_stub.sql', 'sql/01_schema.sql', 'sql/02_common_public.sql', 'sql/03_applicant.sql', 'sql/04_admin.sql', 'sql/05_server_only.sql'];
  if (opts.seed !== false) files.push('sql/dev/dev_seed.sql');
  for (const f of files) await pool.query(fs.readFileSync(path.join(ROOT, f), 'utf8'));

  const mock = createMock(pg.conn, opts.mock || {});
  await new Promise(r => mock.server.listen(mockPort, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  Object.assign(process.env, {
    SUPABASE_URL: mockUrl, SUPABASE_ANON_KEY: mock.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: mock.SERVICE_KEY,
    STAFF_EMAIL_DOMAIN: 'staff.dcci-recruit.local', TURNSTILE_SITE_KEY: '', SITE_ORIGIN: ''
  });

  // netlify.toml의 CSP를 그대로 쓰되, Supabase 주소만 흉내 서버로 바꾼다(인라인 스크립트 금지 등은 그대로 확인됨)
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const csp = /Content-Security-Policy = "([^"]+)"/.exec(toml)[1].replace('https://*.supabase.co', mockUrl);
  const fnCache = {};
  const web = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const m = /^\/api\/([a-z-]+)$/.exec(url.pathname);
      if (m) {
        const file = path.join(ROOT, 'netlify', 'functions', m[1] + '.js');
        if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const event = {
          httpMethod: req.method, path: url.pathname, headers: Object.fromEntries(Object.entries(req.headers)),
          queryStringParameters: Object.fromEntries(url.searchParams), body: chunks.length ? Buffer.concat(chunks).toString('utf8') : null, isBase64Encoded: false
        };
        fnCache[m[1]] = fnCache[m[1]] || require(file);
        const out = await fnCache[m[1]].handler(event, {});
        res.writeHead(out.statusCode, out.headers || {});
        return res.end(out.body || '');
      }
      let p = decodeURIComponent(url.pathname);
      if (p === '/') p = '/index.html';
      if (!path.extname(p) && fs.existsSync(path.join(PUBLIC, p + '.html'))) p += '.html';
      const file = path.normalize(path.join(PUBLIC, p));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      console.error('devserver error', e);
      res.writeHead(500); res.end('error');
    }
  });
  await new Promise(r => web.listen(webPort, '127.0.0.1', r));
  const stop = async () => {
    await new Promise(r => web.close(r));
    await new Promise(r => mock.server.close(r));
    await mock.pool.end();
    await pool.end();
    pg.stop();
  };
  return { url: `http://127.0.0.1:${webPort}`, mockUrl, mock, pool, stop };
}

module.exports = { start };

if (require.main === module) {
  start().then(s => {
    console.log(`개발 서버: ${s.url}  (관리자 ${s.url}/admin.html  admin@dev.local / dev-admin-password-0000 / OTP ${s.mock.DEV_TOTP})`);
    console.log(`이메일 인증코드 확인: ${s.mockUrl}/__dev/otp?email=입력한이메일`);
    const bye = () => s.stop().then(() => process.exit(0));
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  }).catch(e => { console.error(e); process.exit(1); });
}
