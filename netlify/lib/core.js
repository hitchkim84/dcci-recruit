// 서버 함수 공통 기능: 환경변수, Supabase 연결, 응답 형식, 로그인 확인, 파일 형식 확인, CSV
// 서버 키(SUPABASE_SERVICE_ROLE_KEY)는 이 파일의 serviceClient()에서만 쓰고 브라우저로 내려보내지 않는다.
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'applicant-files';
const GENERIC_ERROR_MSG = '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function env(name) { return process.env[name] || ''; }

const clientOpts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
let anon = null;
let service = null;
function anonClient() {
  if (!anon && env('SUPABASE_URL') && env('SUPABASE_ANON_KEY')) anon = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), clientOpts);
  return anon;
}
function serviceClient() {
  if (!service && env('SUPABASE_URL') && env('SUPABASE_SERVICE_ROLE_KEY')) service = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), clientOpts);
  return service;
}
// 로그인한 사람의 권한으로 DB 함수를 부른다(DB 함수가 auth.uid()·등급·OTP를 다시 확인)
function userClient(token) {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    ...clientOpts, global: { headers: { Authorization: `Bearer ${token}` } }
  });
}

function corsHeaders() {
  const origin = env('SITE_ORIGIN');
  return origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' } : {};
}

// 기본은 캐시 금지(개인정보). 공개 목록만 extraHeaders로 캐시를 허용한다.
function jsonRes(code, data, extraHeaders = {}) {
  return {
    statusCode: code,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders },
    body: JSON.stringify(data)
  };
}
const ok = (data = {}, extra) => jsonRes(200, { result: 'success', ...data }, extra);
const fail = (code, msg) => jsonRes(code, { result: 'error', msg });

function parseBody(event) {
  if (!event.body) return {};
  if (event.body.length > 300000) return null;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }

// 검증이 끝난 토큰(JWT)의 내용(aal·amr 등)을 읽는다. 서명 검증은 auth.getUser가 먼저 한다.
function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch (e) { return {}; }
}

function bearer(event) {
  const h = event.headers || {};
  const a = h.authorization || h.Authorization || '';
  return a.startsWith('Bearer ') ? a.slice(7).trim() : '';
}

// 로그인 확인: Supabase Auth에 토큰을 보내 진짜인지 확인한다(위조·만료 토큰 거절).
async function authenticate(event) {
  const token = bearer(event);
  if (!token || token.length > 4096) return null;
  const client = anonClient();
  if (!client) return null;
  const { data, error } = await client.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return { user: data.user, token, claims: jwtClaims(token), role: (data.user.app_metadata || {}).role || '' };
}

// DB 함수 오류를 화면용 응답으로 바꾼다. 업무 오류(P0001)·권한 오류(42501)는 DB가 쓴 문구를 그대로 쓰고,
// 나머지는 기록만 하고 일반 문구로 바꾼다(내부 구조 노출 방지).
function dbFail(error, where) {
  if (error && error.code === 'P0001' && error.message) return fail(400, error.message);
  if (error && error.code === '42501') return fail(403, /권한|인증|관리자|슈퍼/.test(error.message || '') ? error.message : '권한이 없습니다.');
  if (error && ['22P02', '22007', '22008', '22023'].includes(error.code)) return fail(400, '입력 형식이 올바르지 않습니다.');
  console.error(`${where || 'db'} failed:`, error && error.code, error && error.message);
  return fail(500, GENERIC_ERROR_MSG);
}

// 'YYYY-MM-DDTHH:mm'(화면의 날짜·시각 입력값, 한국 시간)을 +09:00이 붙은 시각으로 바꾼다.
function kstToIso(v) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/.exec(str(v));
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}${m[3] || ':00'}+09:00`;
  return isNaN(new Date(iso).getTime()) ? null : iso;
}

// 실제 파일 형식 확인(확장자만 바꾼 파일 거절). 첫 부분의 서명(매직 바이트)과 내부 구조 일부를 본다.
function sniffFile(buf, ext) {
  if (!buf || buf.length < 4) return false;
  const head = (n) => buf.subarray(0, n);
  const startsWith = (bytes) => bytes.every((b, i) => buf[i] === b);
  const ZIP = [0x50, 0x4b, 0x03, 0x04];
  const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const text = () => buf.subarray(0, Math.min(buf.length, 65536)).toString('latin1');
  switch (ext) {
    case 'pdf': return head(5).toString('latin1') === '%PDF-';
    case 'png': return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpg': case 'jpeg': return startsWith([0xff, 0xd8, 0xff]);
    case 'hwp': return startsWith(OLE);
    case 'hwpx': return startsWith(ZIP) && /application\/hwp\+zip|Contents\/|mimetype/.test(text());
    case 'docx': return startsWith(ZIP) && /word\//.test(text());
    default: return false;
  }
}

// 다운로드 파일 이름: 영문·숫자·-_. 만 남긴다(헤더 주입·경로 문자 방지)
function safeFileName(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return cleaned || 'file';
}

// CSV 한 칸: 엑셀 수식 실행 방지(=,+,-,@,탭,CR로 시작하면 앞에 ' 를 붙임) + 따옴표 처리
function csvCell(v) {
  let t = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return '"' + t.replace(/"/g, '""') + '"';
}
function toCsv(header, rows) {
  // 엑셀에서 한글이 깨지지 않도록 BOM을 붙인다
  return '﻿' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// 한국 시간 표시 'YYYY-MM-DD HH:mm'
const KST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function kstText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = Object.fromEntries(KST.formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Storage 파일 삭제 후 대기 목록에서 빼기. 실패하면 대기 목록에 남아 다음 자동 실행 때 다시 지운다.
async function removeFiles(paths) {
  const svc = serviceClient();
  const list = (paths || []).filter(Boolean);
  if (!svc || list.length === 0) return { deleted: 0, failed: list.length };
  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const { error } = await svc.storage.from(BUCKET).remove(chunk);
    if (error) { console.error('storage remove failed:', error.message); failed += chunk.length; continue; }
    const { error: e2 } = await svc.rpc('files_deleted', { p_paths: chunk });
    if (e2) { console.error('files_deleted failed:', e2.message); failed += chunk.length; continue; }
    deleted += chunk.length;
  }
  return { deleted, failed };
}

function preflight(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(), body: '' };
  return null;
}

module.exports = {
  BUCKET, GENERIC_ERROR_MSG, UUID_RE, env, anonClient, serviceClient, userClient, jsonRes, ok, fail, parseBody, str,
  jwtClaims, bearer, authenticate, dbFail, kstToIso, sniffFile, safeFileName, csvCell, toCsv, kstText, removeFiles, preflight
};
